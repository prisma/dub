# Prisma Next Atomic Operation Expectations

This document describes the expected Prisma Next work for atomic numeric writes
on PostgreSQL.

The important correction is that Prisma Next's SQL high-level ORM does not
currently support atomic numeric operations. The goal is not to bless Dub's
temporary read-then-write fallback. The goal is to implement the ADR 180
field-operation API shape for SQL/Postgres, then lower those operations to real
database-side arithmetic.

In other words, Prisma 6 expresses the operation like this:

```ts
await prisma.link.update({
  where: { id },
  data: {
    clicks: { increment: 1 },
  },
});
```

Prisma Next should be able to express the same intent through an ADR 180-style
field accessor:

```ts
await db.orm.Link.where({ id }).update((link) => [
  link.clicks.inc(1),
]);
```

or an equivalent field-operation API. The exact method names can be refined,
but the operation must be represented as an atomic field operation in the query
plan, not as JavaScript code that reads the old value and writes a replacement.

## Current State

The current Prisma Next SQL update API accepts scalar replacement objects. It
does not expose a high-level way to say "set this column to its current value
plus this amount."

That is why the Dub runtime comparison currently uses this fallback for some
ported modules:

1. Read the current counter value with Prisma Next.
2. Add the increment amount in JavaScript.
3. Write the computed scalar value back with `.update({ clicks: nextValue })`.

That fallback can make a single-threaded fixture pass, but it is not equivalent
to Prisma 6.

The gap should be tracked as a missing Prisma Next API and lowering feature,
not as an acceptable runtime difference.

## ADR 180 Target

ADR 180 defines a callable/dot-path field accessor used by both reads and
writes. Its mutation examples include targeted field operations:

```ts
db.users.where({ id }).update((u) => [
  u("homeAddress.city").set("LA"),
  u("stats.loginCount").inc(1),
  u("tags").push("premium"),
]);
```

The Mongo implementation already appears to follow this direction in the local
Prisma Next checkout:

- `packages/2-mongo-family/5-query-builders/query-builder/src/update-ops.ts`
  defines typed update operations including `$inc` and `$mul`.
- `packages/2-mongo-family/5-query-builders/query-builder/src/field-accessor.ts`
  exposes `inc()` and `mul()` on field expressions.
- `packages/2-mongo-family/5-query-builders/query-builder/test/writes.test.ts`
  asserts that `f.amount.inc(1)` folds into `{ $inc: { amount: 1 } }`.
- `packages/2-mongo-family/5-query-builders/orm/test/collection.test.ts`
  covers ORM callback writes such as `u.loginCount.inc(1)`.

That is not proof that every Mongo edge case is complete. It is enough to show
the intended architecture: a write callback produces typed field operations,
and the target lowers those operations to native atomic updates.

For SQL/Postgres, the same architecture should apply to top-level numeric
columns. ADR 180 currently says SQL is limited to set/unset for JSONB paths.
That limitation should not block scalar column arithmetic. A normal Postgres
column can represent `SET "clicks" = "clicks" + $1` directly.

## Scope

This document covers PostgreSQL writes for numeric scalar fields that Prisma 6
currently supports through atomic number operations:

- `increment`
- `decrement`
- `multiply`
- `divide`

It applies to:

- `update`;
- `updateMany` / Prisma Next `updateCount`;
- unique and compound-unique `where` filters;
- ordinary scalar assignments in the same mutation;
- implicit and explicit `@updatedAt`;
- returned rows and affected-row counts.

It does not try to settle every connector-specific edge case. Nullable numeric
fields, `Decimal` precision, integer division details, JSONB path arithmetic,
and nested writes need their own tests once the core SQL field-operation
surface exists.

## Prisma 6 Observable Behavior

In Prisma 6, this update:

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

Prisma 6 may issue a preliminary identity lookup for some operation shapes.
That lookup does not compute the new counter value. The numeric
read-modify-write happens inside the database `UPDATE` statement.

## Required API Shape

The preferred Prisma Next API is an ADR 180-style update callback:

```ts
await db.orm.Link.where({ id })
  .select("id", "clicks", "lastClicked", "updatedAt")
  .update((link) => [
    link.clicks.inc(1),
    link.lastClicked.set(new Date("2024-02-01T00:00:00.000Z")),
  ]);
```

For compound filters:

```ts
await db.orm.ProgramEnrollment.where({
  partnerId_programId: {
    partnerId,
    programId,
  },
})
  .select("id", "totalClicks", "updatedAt")
  .update((enrollment) => [
    enrollment.totalClicks.inc(1),
  ]);
```

For multi-row count writes:

```ts
const count = await db.orm.Link.where((link) =>
  link.projectId.eq(projectId),
).updateCount((link) => [
  link.clicks.inc(1),
]);
```

The SQL API does not need to copy Prisma 6's object spelling. It may also
support a compatibility object form later:

```ts
await db.orm.Link.where({ id }).update({
  clicks: { increment: 1 },
});
```

But the field-operation callback is the better fit for Prisma Next because it
matches ADR 180 and the Mongo implementation shape.

## Operation Mapping

The SQL field-operation surface should cover the Prisma 6 operation set.

| Prisma 6 operation | ADR 180-style operation | Required PostgreSQL lowering |
| --- | --- | --- |
| `{ increment: n }` | `field.inc(n)` | `"field" = "field" + $n` |
| `{ decrement: n }` | `field.inc(-n)` or `field.dec(n)` | `"field" = "field" - $n` |
| `{ multiply: n }` | `field.mul(n)` | `"field" = "field" * $n` |
| `{ divide: n }` | `field.div(n)` or equivalent | `"field" = "field" / $n` |

`inc()` and `mul()` already match the Mongo/ADR naming. `dec()` and `div()` can
be aliases or separate SQL-capability-gated operations. The important point is
that Prisma Next must represent all four Prisma 6 atomic number operations
without making the application pre-read the current field value.

## Required Lowering

The database must compute the new numeric value from the row version it
updates.

For a single increment:

```sql
UPDATE "Link"
SET "clicks" = "Link"."clicks" + $1
WHERE "Link"."id" = $2
RETURNING "Link"."id", "Link"."clicks";
```

For multiple fields:

```sql
UPDATE "Project"
SET
  "usage" = "Project"."usage" + $1,
  "totalClicks" = "Project"."totalClicks" + $2,
  "updatedAt" = $3
WHERE "Project"."id" = $4
RETURNING "Project"."id", "Project"."usage", "Project"."totalClicks", "Project"."updatedAt";
```

For division:

```sql
UPDATE "SomeModel"
SET "score" = "SomeModel"."score" / $1
WHERE "SomeModel"."id" = $2
RETURNING "SomeModel"."score";
```

If the current relational AST only allows update assignments to be parameters
or column references, it must grow an assignment-expression node. Atomic SQL
updates need an AST representation for binary arithmetic over a target column
and an encoded parameter.

## Required Atomicity

Prisma Next must not lower an atomic operation by selecting the current value
into JavaScript and then writing an absolute replacement value:

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

PostgreSQL already gives the right behavior for a single arithmetic `UPDATE`.
Concurrent updates to the same row serialize through row locking, and each
statement applies its arithmetic to the current committed row version.

An explicit transaction is not a substitute for database-side arithmetic. A
transaction can preserve commit and rollback shape for multi-statement writes,
but it does not make an application-side read-compute-write equivalent to
`SET field = field + $n` under PostgreSQL's default `READ COMMITTED`
isolation.

See `docs/prisma-next-write-transactions.md` for the separate transaction
expectations.

## Type Expectations

Atomic numeric operators should be trait-gated.

They should be available on numeric fields and unavailable on strings, dates,
booleans, JSON, relations, and value-object subtrees that do not resolve to a
numeric leaf.

The operand type should preserve the field's write type:

- `Int` operands should accept Prisma-compatible integer inputs.
- `BigInt` operands should not be coerced through JavaScript `number`.
- `Decimal` operands should preserve decimal precision if and when Decimal
  atomic operations are supported.

Prisma Next should encode the operand as a query parameter using the same codec
path it uses for ordinary writes to that field. The operand should appear in
the SQL parameter list. The current database value should not appear in the
JavaScript parameter list because JavaScript should not read it.

## `@updatedAt`

When an atomic update touches a model with an `@updatedAt` field and the caller
does not supply that field explicitly, Prisma Next should include `updatedAt`
in the same `UPDATE` statement as the arithmetic expression.

Expected shape:

```sql
UPDATE "Link"
SET
  "clicks" = "Link"."clicks" + $1,
  "updatedAt" = $2
WHERE "Link"."id" = $3
RETURNING ...;
```

If the caller supplies `updatedAt` explicitly, Prisma Next should use that
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

If Prisma Next needs a preliminary `SELECT` to preserve Prisma-compatible
count, error, or authorization behavior, the dependent statements should run
inside one explicit transaction. The arithmetic still belongs in the database
`UPDATE`; the preliminary `SELECT` must not compute the new numeric values.

## Return Values

For `update`, Prisma Next should return the post-update row. Returned numeric
fields should reflect the value produced by the database-side arithmetic.

For `updateCount`, Prisma Next should return the number of rows affected by the
Prisma mutation. If zero rows match, the count should be zero and no row should
change.

If no row exists for `update`, Prisma Next should preserve Prisma-compatible
not-found behavior. A preliminary identity lookup may help implement that
behavior, but it must not compute atomic scalar values.

## Acceptable Internal Differences

Prisma Next does not need byte-for-byte identical SQL. These differences are
acceptable if observable behavior matches Prisma 6:

- schema-qualified names versus unqualified table names;
- different placeholder numbers;
- equivalent casts for numeric, enum, or timestamp values;
- a preliminary identity lookup for Prisma-compatible not-found behavior;
- `UPDATE ... RETURNING` instead of a later post-update read;
- a stricter transaction wrapper when the implementation truly needs multiple
  dependent statements.

These differences are not acceptable:

- no high-level API for atomic numeric field operations;
- reading the current numeric field value into JavaScript and writing an
  absolute replacement value;
- exposing only raw SQL as the solution for normal ORM counter updates;
- splitting one dependent Prisma mutation across multiple autocommit
  statements;
- updating counters without applying required `@updatedAt` behavior;
- returning a value computed in JavaScript instead of the database's
  post-update value;
- silently degrading concurrent increments into last-write-wins assignments.

## Dub Runtime Gap

The latest Dub comparison showed Prisma 6 lowering counter writes to
database-side arithmetic:

```sql
UPDATE "Link"
SET "clicks" = ("Link"."clicks" + $1), "lastClicked" = $2, "updatedAt" = $3
WHERE ...
RETURNING ...;
```

The current Prisma Next SQL high-level ORM port cannot express that operation,
so the comparison script uses an application-side fallback:

```sql
SELECT "Link"."clicks" FROM "Link" WHERE "Link"."id" = $1 LIMIT 1;
UPDATE "Link"
SET "clicks" = $1, "lastClicked" = $2, "updatedAt" = $3
WHERE "Link"."id" = $4
RETURNING ...;
```

That fallback matches the single-threaded fixture result, but it does not match
Prisma 6's concurrency semantics. It should be removed once SQL/Postgres
implements ADR 180-style field operations.

Covered Dub cases that should move to the new API include:

- `usage.update.link-click-increment`;
- `usage.update.workspace-clicks-increment`;
- `usage.update.workspace-links-increment`;
- `usage.update.program-enrollment-clicks-increment`.

## Implementation Notes For Prisma Next

The SQL/Postgres implementation should reuse the ADR 180 field-operation model
instead of adding a separate Prisma-6-shaped special case.

The likely implementation path is:

1. Add an update-callback overload to the SQL high-level ORM:

   ```ts
   db.orm.Link.where({ id }).update((link) => [
     link.clicks.inc(1),
     link.lastClicked.set(date),
   ]);
   ```

2. Expose a SQL field accessor with direct scalar properties and, where
   applicable, callable dot-path access.
3. Gate `inc`, `mul`, and any `dec`/`div` aliases to numeric scalar fields and
   to targets that can lower them correctly.
4. Lower field operations into update-assignment AST nodes, not into resolved
   scalar values.
5. Extend the relational AST and SQL renderer if update assignments cannot
   currently hold arithmetic expressions.
6. Encode operation operands through the field's write codec.
7. Compose ordinary `.set()` assignments, atomic operations, and `@updatedAt`
   in one `UPDATE` whenever possible.
8. Keep `updateCount` count semantics and transaction shape compatible with
   Prisma 6 when more than one dependent statement is required.

Raw SQL remains a useful escape hatch, but it is not the target API for normal
Prisma Client parity.

## Compatibility Tests To Add

Prisma Next should have PostgreSQL tests for these cases:

1. The SQL high-level ORM exposes an ADR 180-style update callback with field
   operations.
2. A single `inc()` lowers to `column = column + $n` and returns the
   post-update value.
3. A decrement operation lowers to database-side subtraction, either through
   `inc(-n)` or a `dec(n)` alias.
4. `mul()` lowers to `column = column * $n`.
5. A divide operation lowers to `column = column / $n`.
6. Multiple atomic fields in one update lower to one `UPDATE` statement.
7. Atomic operations combine with ordinary scalar assignments in one `UPDATE`.
8. Atomic operations combine with implicit `@updatedAt` in one `UPDATE`.
9. Explicit `updatedAt` is preserved when an atomic operation is present.
10. A compound unique `where` filter keeps the arithmetic database-side.
11. `updateCount` with atomic operations updates all matching rows with
    database-side arithmetic and returns the expected count.
12. `updateCount` with a required preliminary `SELECT` runs the dependent work
    in one transaction.
13. Concurrent increments on the same row do not lose updates. For example,
    start with `clicks = 0`, run 50 concurrent `inc(1)` mutations, then assert
    that the stored value is `50`.
14. Concurrent multi-field increments keep both counters consistent. For
    example, 50 concurrent updates with `usage += 3` and `totalClicks += 3`
    should add `150` to both fields.
15. No-row `update` preserves Prisma-compatible not-found behavior.
16. Zero-match `updateCount` returns `0` and changes no state.
17. Type tests reject `inc()` and `mul()` on non-numeric fields.
18. Operand type tests preserve `BigInt` and `Decimal` input types instead of
    forcing everything through `number`.

The essential assertion is not only the final value. Captured SQL should prove
that Prisma Next implemented the operation as a high-level field operation
lowered to database-side arithmetic.
