# Prisma Next Atomic Write Expectations

This document describes how I would expect Prisma Next to handle atomic writes
when matching Prisma 6 behavior on PostgreSQL.

The short version: a Prisma-style numeric update such as
`{ clicks: { increment: 1 } }` must lower to a database-side arithmetic
expression, not to an application-side read, addition, and scalar assignment.

## Scope

This applies to Prisma ORM write operations that modify a field relative to its
current database value. In Prisma 6, these are the atomic number operations on
numeric scalar fields:

- `increment`
- `decrement`
- `multiply`
- `divide`

It also applies when these operations appear together with ordinary scalar
assignments and `@updatedAt`.

This document focuses on non-null numeric counters, which are the important Dub
case. Nullable numeric fields, decimal precision, nested writes, and connector
specific details should get separate tests where Prisma Next supports them.

## Prisma 6 Observable Behavior

In Prisma 6, an update like this:

```ts
await prisma.link.update({
  where: { id },
  data: {
    clicks: { increment: 1 },
    lastClicked: new Date("2024-02-01T00:00:00.000Z"),
  },
  select: {
    id: true,
    clicks: true,
    lastClicked: true,
    updatedAt: true,
  },
});
```

lowers semantically like this:

```sql
UPDATE "Link"
SET
  "clicks" = "Link"."clicks" + $1,
  "lastClicked" = $2,
  "updatedAt" = $3
WHERE "Link"."id" = $4
RETURNING "Link"."id", "Link"."clicks", "Link"."lastClicked", "Link"."updatedAt";
```

Prisma 6 may issue a preliminary identity lookup before the `UPDATE`, depending
on the operation shape. That lookup does not compute the new counter value. The
important part is that the numeric read-modify-write happens inside the
database `UPDATE` statement.

## Required Atomicity

The database must compute the new numeric value from the row version it updates.
For `increment`, Prisma Next should lower to:

```sql
"field" = "field" + $n
```

For the other Prisma 6 atomic operations, Prisma Next should lower to the
corresponding database expression:

```sql
"field" = "field" - $n
"field" = "field" * $n
"field" = "field" / $n
```

Prisma Next must not lower an atomic operation by first selecting the current
field value into JavaScript and then writing a computed scalar value:

```sql
SELECT "Link"."clicks" FROM "Link" WHERE "Link"."id" = $1 LIMIT 1;
UPDATE "Link" SET "clicks" = $1 WHERE "Link"."id" = $2;
```

That shape is not equivalent to Prisma 6. It can lose updates under
concurrency:

1. Row starts with `clicks = 5`.
2. Request A reads `5`.
3. Request B reads `5`.
4. Request A writes `6`.
5. Request B writes `6`.

The Prisma 6-compatible result is `7`, not `6`.

PostgreSQL already gives the right behavior for a single arithmetic `UPDATE`:
concurrent updates to the same row serialize through row locking, and each
statement applies its arithmetic to the current committed row version.

## Multiple Atomic Fields

When one update changes multiple counters, all counter expressions should live
in the same `UPDATE` statement.

For Prisma 6:

```ts
await prisma.project.update({
  where: { id },
  data: {
    usage: { increment: 3 },
    totalClicks: { increment: 3 },
  },
  select: {
    id: true,
    usage: true,
    totalClicks: true,
    updatedAt: true,
  },
});
```

the expected lowering is:

```sql
UPDATE "Project"
SET
  "usage" = "Project"."usage" + $1,
  "totalClicks" = "Project"."totalClicks" + $2,
  "updatedAt" = $3
WHERE "Project"."id" = $4
RETURNING "Project"."id", "Project"."usage", "Project"."totalClicks", "Project"."updatedAt";
```

Prisma Next should not read both values into JavaScript and then write absolute
values such as `usage = 28, totalClicks = 13`. Those absolute values are stale
as soon as another transaction updates the same row between the read and the
write.

## Compound Unique Filters

Atomicity should not depend on the shape of the `where` filter.

For Prisma 6:

```ts
await prisma.programEnrollment.update({
  where: {
    partnerId_programId: {
      partnerId,
      programId,
    },
  },
  data: {
    totalClicks: { increment: 1 },
  },
  select: {
    id: true,
    totalClicks: true,
    updatedAt: true,
  },
});
```

Prisma Next should still lower the counter update as database-side arithmetic:

```sql
UPDATE "ProgramEnrollment"
SET
  "totalClicks" = "ProgramEnrollment"."totalClicks" + $1,
  "updatedAt" = $2
WHERE
  "ProgramEnrollment"."partnerId" = $3
  AND "ProgramEnrollment"."programId" = $4
RETURNING "ProgramEnrollment"."id", "ProgramEnrollment"."totalClicks", "ProgramEnrollment"."updatedAt";
```

It may use additional predicates or preliminary identity checks if they are
needed for Prisma-compatible error behavior. It must not pre-read
`totalClicks` to compute the new value in JavaScript.

## `@updatedAt`

When an atomic update touches a model with an `@updatedAt` field and the caller
does not supply that field explicitly, Prisma Next should include `updatedAt` in
the same `UPDATE` statement as the atomic field expression.

Expected shape:

```sql
UPDATE "Link"
SET
  "clicks" = "Link"."clicks" + $1,
  "updatedAt" = $2
WHERE "Link"."id" = $3
RETURNING ...;
```

The generated timestamp should be one value for that mutation. It should not
force Prisma Next to split the counter update into separate read and write
steps.

If the caller supplies `updatedAt` explicitly, Prisma Next should use the
explicit value in the same `UPDATE` statement.

If the update payload is empty, Prisma Next should not manufacture an atomic
write or advance `updatedAt`.

## `updateMany` And Count Writes

For `updateMany`, Prisma 6 returns a count and updates all matching rows. When
the payload contains atomic operations, Prisma Next should use database-side
expressions for every matching row:

```sql
UPDATE "Link"
SET
  "clicks" = "Link"."clicks" + $1,
  "updatedAt" = $2
WHERE ...
```

If Prisma Next can implement the operation as one `UPDATE`, that is the
preferred shape.

If Prisma Next needs a preliminary `SELECT` to preserve Prisma-compatible count,
error, or authorization behavior, the `SELECT` and `UPDATE` should run inside an
explicit transaction. Prisma 6 uses a transaction for the captured
`updateMany`-style count path:

```sql
BEGIN;
SELECT "Commission"."id" ...
UPDATE "Commission"
SET
  "payoutId" = $1,
  "status" = $2,
  "updatedAt" = $3
WHERE "Commission"."id" IN ($4);
COMMIT;
```

Prisma Next should not perform a matching-row `SELECT` and a dependent `UPDATE`
as separate autocommit statements if the result is meant to match one Prisma
mutation.

## Return Values

For `update`, Prisma Next should return the post-update row, as Prisma 6 does.
Returned numeric fields should reflect the database-side arithmetic result.

For `updateMany`, Prisma Next should return the count of rows affected by the
Prisma mutation. If zero rows match, the count should be zero and no row should
change.

If no row exists for `update`, Prisma Next should preserve Prisma-compatible
not-found behavior. A preliminary identity lookup may help implement that
behavior, but it must not be used to compute atomic scalar values.

## Acceptable Internal Differences

Prisma Next does not need byte-for-byte identical SQL. These differences are
acceptable if the observable behavior matches Prisma 6:

- schema-qualified names versus unqualified table names;
- different placeholder numbers;
- a preliminary identity lookup for `update`;
- equivalent casts for enum or numeric values;
- different timestamp parameter representation, subject to the date-value
  compatibility expectations in
  `docs/prisma-next-date-value-expectations.md`.

These differences are not acceptable:

- reading the current numeric field value into JavaScript and writing an
  absolute replacement value;
- splitting one dependent Prisma mutation across multiple autocommit statements;
- updating counters without also applying required `@updatedAt` behavior;
- returning a value computed in JavaScript instead of the database's
  post-update value;
- silently degrading concurrent increments into last-write-wins assignments.

## Prisma Next API Expectation

The exact Prisma Next API spelling can differ from Prisma 6. It may use
Prisma-style update objects, field-operation helpers, or a query-builder
expression.

Whatever the API spelling is, it should let application code express this
intent without a manual pre-read:

```ts
await db.orm.Link.where({ id })
  .select("id", "clicks", "lastClicked", "updatedAt")
  .update({
    clicks: { increment: 1 },
    lastClicked: new Date("2024-02-01T00:00:00.000Z"),
  });
```

or an equivalent expression-builder form:

```ts
await db.orm.Link.where({ id })
  .select("id", "clicks", "lastClicked", "updatedAt")
  .update((link) => ({
    clicks: link.clicks.plus(1),
    lastClicked: new Date("2024-02-01T00:00:00.000Z"),
  }));
```

The second form is fine only if it lowers to `clicks = clicks + $1`.

The lower-level SQL builder can already express this class of update directly.
That is useful, but it is not a substitute for high-level ORM support if Prisma
Next intends to replace Prisma Client call sites that use atomic number
operations.

## Dub Runtime Gap

The latest Dub comparison showed Prisma 6 lowering counter writes to
database-side arithmetic:

```sql
UPDATE "Link"
SET "clicks" = ("Link"."clicks" + $1), "lastClicked" = $2, "updatedAt" = $3
WHERE ...
RETURNING ...;
```

The current Prisma Next high-level ORM port uses an application-side fallback:

```sql
SELECT "Link"."clicks" FROM "Link" WHERE "Link"."id" = $1 LIMIT 1;
UPDATE "Link"
SET "clicks" = $1, "lastClicked" = $2, "updatedAt" = $3
WHERE "Link"."id" = $4
RETURNING ...;
```

That fallback matches the single-threaded fixture result, but it does not match
the concurrency semantics Prisma 6 gives the application.

## Compatibility Tests To Add

Prisma Next should have PostgreSQL tests for these cases:

1. A single `increment` lowers to `column = column + $n` and returns the
   post-update value.
2. A single `decrement`, `multiply`, and `divide` lower to database-side
   arithmetic.
3. Multiple atomic fields in one update lower to one `UPDATE` statement.
4. Atomic operations combine with ordinary scalar assignments in one `UPDATE`.
5. Atomic operations combine with implicit `@updatedAt` in one `UPDATE`.
6. Explicit `updatedAt` is preserved when an atomic operation is present.
7. A compound unique `where` filter keeps the arithmetic database-side.
8. `updateMany` with atomic operations updates all matching rows with
   database-side arithmetic and returns the expected count.
9. `updateMany` with a required preliminary `SELECT` runs the dependent work in
   one transaction.
10. Concurrent increments on the same row do not lose updates. For example,
    start with `clicks = 0`, run 50 concurrent `increment: 1` mutations, then
    assert that the stored value is `50`.
11. Concurrent multi-field increments keep both counters consistent. For
    example, 50 concurrent updates with `usage += 3` and `totalClicks += 3`
    should add `150` to both fields.
12. No-row `update` preserves Prisma-compatible not-found behavior.
13. Zero-match `updateMany` returns `{ count: 0 }` and changes no state.

The essential assertion is not only the final value. The captured SQL should
also prove that Prisma Next did not implement the operation as
read-in-JavaScript, compute, then assign.
