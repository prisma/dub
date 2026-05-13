# Prisma Next Write Transaction Expectations

This document describes how I would expect Prisma Next to handle transaction
shape for multi-statement writes when matching Prisma 6 behavior on PostgreSQL.

The short version: one Prisma mutation should commit as one unit. If Prisma
Next lowers one logical write into a dependent `SELECT` plus `UPDATE`, those
statements should run in one transaction, or Prisma Next should use a single
SQL statement instead.

## Scope

This applies to ORM write operations where Prisma Next cannot express the whole
mutation as one SQL statement and therefore emits dependent statements.

Important examples:

- `updateMany`
- `deleteMany`
- count-returning writes such as Prisma Next `updateCount`
- writes that first discover matching row IDs and then update or delete them
- future nested writes or relation writes that require several SQL statements

This document does not require a transaction around every single SQL `UPDATE`.
If Prisma Next can lower a mutation to one SQL statement, the database already
executes that statement atomically.

## Prisma 6 Observable Behavior

In the Dub runtime comparison, this Prisma 6 call:

```ts
await prisma.commission.updateMany({
  where: {
    id: {
      in: [commissionId],
    },
  },
  data: {
    payoutId: null,
    status: "paid",
  },
});
```

was captured as one transaction:

```sql
BEGIN;

SELECT "Commission"."id"
FROM "Commission"
WHERE "Commission"."id" IN ($1)
OFFSET $2;

UPDATE "Commission"
SET
  "payoutId" = $1,
  "status" = CAST($2::text AS "CommissionStatus"),
  "updatedAt" = $3
WHERE "Commission"."id" IN ($4)
  AND 1 = 1;

COMMIT;
```

The exact SQL does not need to match byte for byte. The important observable
shape is that Prisma 6 treats the dependent `SELECT` and `UPDATE` as one
database transaction.

## Required Transaction Boundary

If a Prisma Next write needs multiple dependent statements, Prisma Next should
start a transaction before the first dependent statement and commit after the
last dependent statement.

Expected shape:

```sql
BEGIN;
SELECT ...;
UPDATE ...;
COMMIT;
```

or:

```sql
BEGIN;
SELECT ...;
DELETE ...;
COMMIT;
```

If any dependent statement fails, Prisma Next should roll back the transaction:

```sql
BEGIN;
SELECT ...;
UPDATE ...; -- fails
ROLLBACK;
```

Prisma Next should not lower one logical mutation to separate autocommit
statements:

```sql
SELECT ...; -- committed immediately
UPDATE ...; -- committed separately
```

That shape changes the failure and concurrency contract of a Prisma write.

## Why Autocommit Is Not Equivalent

Autocommit creates a gap between the dependent statements. Other transactions
can update or delete the selected rows during that gap.

For example:

1. Prisma Next selects IDs for a logical `updateMany`.
2. Another request deletes one selected row.
3. Prisma Next updates by the old selected ID list.
4. Prisma Next returns a count based on stale selected IDs.

A transaction does not make every race impossible under PostgreSQL's default
`READ COMMITTED` isolation. It does, however, make the dependent statements one
atomic unit for commit, rollback, connection state, and error handling. That is
the Prisma 6-compatible baseline.

If Prisma Next needs stronger match-set stability than `READ COMMITTED`
provides, it should either:

- lower to one `UPDATE ... WHERE ...` or `DELETE ... WHERE ...` statement;
- re-check the original predicate in the write statement;
- lock selected rows with an appropriate `FOR UPDATE`-style read; or
- run the transaction at an isolation level that matches the intended Prisma
  behavior.

The simplest compatible lowering is usually one SQL write statement with the
original predicate.

## Prefer Single-Statement Writes

When the mutation does not need a preliminary read, Prisma Next should prefer a
single SQL statement:

```sql
UPDATE "Commission"
SET
  "payoutId" = $1,
  "status" = $2,
  "updatedAt" = $3
WHERE "Commission"."id" IN ($4);
```

For count-returning writes, PostgreSQL can return the affected row count for
that statement. Prisma Next does not need a separate `SELECT` only to count
matching rows if the `UPDATE` or `DELETE` result can provide the count.

For writes that must return rows, PostgreSQL can often use `RETURNING`:

```sql
UPDATE "Commission"
SET "status" = $1
WHERE ...
RETURNING ...;
```

If Prisma Next can satisfy the API with one statement, no explicit transaction
is required for atomicity.

## Count Semantics

For `updateMany` and count-returning writes, Prisma Next should return the
number of rows affected by the logical Prisma mutation.

Acceptable implementations:

- use the affected-row count from one `UPDATE` or `DELETE`;
- use `UPDATE ... RETURNING` and count returned rows;
- use a transaction that locks or otherwise preserves the selected target set;
- use a transaction and derive the count from the actual write result.

Risky implementation:

```sql
SELECT id FROM "Commission" WHERE ...;
UPDATE "Commission" SET ... WHERE id IN (...);
```

then returning the number of rows from the `SELECT` while the `UPDATE` affects a
different number of rows.

If Prisma Next preselects IDs, it should make the returned count match the rows
it actually updates or deletes.

## Rollback Semantics

If a multi-statement write partially succeeds and then fails, Prisma Next should
leave no partial database changes.

Example:

```sql
BEGIN;
UPDATE "Commission" SET "status" = $1 WHERE ...;
INSERT INTO "AuditLog" ...; -- fails
ROLLBACK;
```

After rollback, the `Commission` rows should retain their original state.

This matters for future Prisma Next write expansions. Nested writes, relation
writes, and multi-table updates must not commit half of one logical Prisma
mutation.

## Connection And Session State

All statements inside one logical transaction should run on the same database
connection.

That matters for:

- transaction state;
- temporary settings such as transaction isolation;
- advisory locks if a future lowering uses them;
- consistent error handling;
- rollback.

Prisma Next should not send the `SELECT` through one pooled connection and the
dependent `UPDATE` through another connection when those statements implement
one mutation.

## Interaction With `@updatedAt`

When a multi-row write touches a model with `@updatedAt`, the generated
timestamp should be part of the same logical mutation as the other updates.

For one-statement lowerings:

```sql
UPDATE "Commission"
SET
  "status" = $1,
  "updatedAt" = $2
WHERE ...;
```

For multi-statement lowerings:

```sql
BEGIN;
SELECT ...;
UPDATE "Commission"
SET
  "status" = $1,
  "updatedAt" = $2
WHERE ...;
COMMIT;
```

Prisma Next should not generate `updatedAt`, commit some unrelated part of the
write, then fail before applying the rest of the mutation.

## Interaction With Atomic Field Operations

Atomic numeric operations, such as `increment`, should still lower to
database-side arithmetic. A transaction is not a substitute for database-side
arithmetic if Prisma Next first reads a value into JavaScript and then writes an
absolute replacement value.

Wrong shape:

```sql
BEGIN;
SELECT "Link"."clicks" FROM "Link" WHERE "Link"."id" = $1;
UPDATE "Link" SET "clicks" = $2 WHERE "Link"."id" = $3;
COMMIT;
```

Better shape:

```sql
UPDATE "Link"
SET "clicks" = "Link"."clicks" + $1
WHERE "Link"."id" = $2;
```

If Prisma Next needs a transaction for other reasons, the arithmetic update can
still run inside that transaction:

```sql
BEGIN;
UPDATE "Link"
SET "clicks" = "Link"."clicks" + $1
WHERE "Link"."id" = $2;
COMMIT;
```

See `docs/prisma-next-write-atomic-expectations.md` for the atomic field
operation contract.

## Error Behavior

Prisma Next should preserve Prisma-compatible error behavior for multi-statement
writes:

- if the mutation fails before any write, no state changes;
- if the mutation fails after one write statement, the transaction rolls back;
- if zero rows match an `updateMany`, the result is `{ count: 0 }` and no state
  changes;
- if a single-row `update` finds no row, Prisma-compatible not-found behavior
  applies;
- if commit fails, Prisma Next should report failure and not claim the mutation
  succeeded.

The caller should not observe a half-applied Prisma mutation.

## Acceptable Internal Differences

These differences are acceptable if observable behavior matches Prisma 6:

- one `UPDATE ... WHERE ...` instead of Prisma 6's `BEGIN` plus `SELECT` plus
  `UPDATE` plus `COMMIT`;
- `UPDATE ... RETURNING` instead of a separate read;
- equivalent casts and placeholder ordering;
- a stricter transaction shape than Prisma 6 where needed for correctness;
- an explicit transaction around a single statement if Prisma Next's execution
  layer requires it.

These differences are not acceptable:

- dependent `SELECT` and `UPDATE` statements in separate autocommit
  transactions;
- returning a count based on stale preselected rows instead of affected rows;
- committing one part of a logical mutation before a later dependent statement
  fails;
- running dependent transaction statements on different pooled connections;
- swallowing rollback or commit errors.

## Dub Runtime Gap

The latest Dub comparison showed this shape for Prisma 6:

```sql
BEGIN;
SELECT "Commission"."id" ...
UPDATE "Commission"
SET "payoutId" = $1, "status" = $2, "updatedAt" = $3
WHERE "Commission"."id" IN ($4);
COMMIT;
```

The current Prisma Next high-level `updateCount` path was captured as:

```sql
SELECT "Commission"."id" AS "id"
FROM "Commission"
WHERE "Commission"."id" IN ($1);

UPDATE "Commission"
SET "payoutId" = $1, "status" = $2, "updatedAt" = $3
WHERE "Commission"."id" IN ($4);
```

The single-threaded fixture result matches, but the transaction shape does not.
If Prisma Next keeps the preliminary `SELECT`, it should wrap the dependent
statements in one transaction. If it can remove the `SELECT`, it should prefer a
single `UPDATE`.

## Compatibility Tests To Add

Prisma Next should have PostgreSQL tests for these cases:

1. `updateMany` that lowers to multiple statements emits `BEGIN` before the
   dependent `SELECT` and `COMMIT` after the dependent `UPDATE`.
2. If the dependent `UPDATE` fails, Prisma Next emits `ROLLBACK` and leaves no
   partial changes.
3. If commit fails or the connection drops before commit, Prisma Next does not
   report success.
4. A one-statement `updateMany` returns the affected-row count from the write
   result.
5. A preselected-ID implementation returns a count that matches the rows
   actually updated.
6. A row deleted between preselection and update does not produce a stale
   success count.
7. A row that no longer matches the original predicate between preselection and
   update is either not updated, or the behavior is explicitly matched to Prisma
   6 and covered by a test.
8. Multi-row writes with `@updatedAt` apply the timestamp inside the same
   transaction.
9. Multi-statement nested writes roll back all changes if a later statement
   fails.
10. Transaction statements run on one physical database connection.
11. Concurrent `updateMany` calls do not produce partial commits or stale
   counts.
12. Explicit transaction APIs, if exposed by Prisma Next, preserve the same
   all-or-nothing behavior when multiple ORM writes are composed by user code.

The key assertion is not only the final fixture state. The SQL capture should
prove that dependent statements for one logical Prisma mutation are either one
SQL statement or one explicit transaction.
