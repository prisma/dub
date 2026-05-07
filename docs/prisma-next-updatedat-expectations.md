# Prisma Next `temporal.updatedAt()` Expectations

This document describes the `temporal.updatedAt()` behavior I would expect
Prisma Next to match when porting Dub from Prisma 6 Client semantics.

The short version: Prisma 6 `@updatedAt` and Prisma Next
`temporal.updatedAt()` should mean the same runtime thing. It is an
application-side mutation default, not a database default, trigger, generated
column, or migration-time DDL feature. For ORM writes, Prisma should populate
it when the user omits it on create and on non-empty update mutations. If the
user supplies an explicit value, that value must win.

## Baseline Schema

In Dub's Prisma 6 schema this pattern appears repeatedly:

```prisma
model Dashboard {
  id String @id @default(cuid())

  password        String?
  doIndex         Boolean @default(false)
  showConversions Boolean @default(false)

  createdAt DateTime @default(now()) @db.Timestamp(3)
  updatedAt DateTime @updatedAt @db.Timestamp(3)
}
```

The Prisma Next contract equivalent is:

```prisma
types {
  Timestamp3 = DateTime @db.Timestamp(3)
}

model Dashboard {
  id String @id @default(cuid(2))

  password        String?
  doIndex         Boolean @default(false)
  showConversions Boolean @default(false)

  createdAt Timestamp3 @default(now())
  updatedAt temporal.updatedAt()
}
```

## Contract And DDL Expectations

`temporal.updatedAt()` should lower to execution metadata without losing the
storage semantics of the Prisma 6 field it replaces. For Dub, that means the
column remains PostgreSQL `timestamp(3)`.

Expected contract meaning:

- `onCreate`: if the field is omitted, generate the current application
  timestamp.
- `onUpdate`: if the field is omitted and the update payload is non-empty,
  generate the current application timestamp.
- Explicit user values override both defaults.

Expected PostgreSQL DDL meaning:

- No `DEFAULT now()` should be added for `updatedAt` just because the field has
  `@updatedAt`.
- No trigger should be generated.
- No `ON UPDATE` clause should be simulated in DDL.
- If the PSL field is required, the column should still be `NOT NULL`; Prisma's
  runtime must provide a value on create.

`createdAt @default(now())` and `updatedAt @updatedAt` are different concepts.
`createdAt` may be represented as a storage default. `updatedAt` is an ORM
mutation default.

## Create Semantics

When the user omits `updatedAt` in a create, Prisma should insert one.

Prisma 6 API:

```ts
await prisma.dashboard.create({
  data: {
    id: "dash_1",
    password: "secret",
  },
});
```

Expected Prisma Next high-level API:

```ts
await db.orm.Dashboard.create({
  id: "dash_1",
  password: "secret",
});
```

Expected semantic SQL shape:

```sql
INSERT INTO "Dashboard" ("id", "password", "updatedAt")
VALUES ($1, $2, $3)
RETURNING ...
```

`$3` should be the current application timestamp.

If `createdAt @default(now())` is also omitted, Prisma Next may let the database
fill `createdAt`, but `updatedAt` must still be present unless the target has a
separate, explicitly supported way to satisfy the same app-level mutation
default.

The returned JavaScript value for `updatedAt` should be a `Date` for normal ORM
queries, matching Prisma 6's user-facing result shape.

## Explicit Create Value

When the user supplies `updatedAt`, Prisma must not overwrite it.

Prisma 6 API:

```ts
const explicitUpdatedAt = new Date("2001-02-03T04:05:06.000Z");

await prisma.dashboard.create({
  data: {
    id: "dash_1",
    password: "secret",
    updatedAt: explicitUpdatedAt,
  },
});
```

Expected Prisma Next high-level API:

```ts
const explicitUpdatedAt = new Date("2001-02-03T04:05:06.000Z");

await db.orm.Dashboard.create({
  id: "dash_1",
  password: "secret",
  updatedAt: explicitUpdatedAt,
});
```

Expected behavior:

- The inserted `updatedAt` value is `explicitUpdatedAt`.
- No generated timestamp replaces it.
- The returned value represents the same instant.

## Update Semantics

When the user performs a non-empty update and omits `updatedAt`, Prisma should
set `updatedAt` to the current application timestamp.

Prisma 6 API:

```ts
await prisma.dashboard.update({
  where: { id: "dash_1" },
  data: {
    password: "new-secret",
  },
});
```

Expected Prisma Next high-level API:

```ts
await db.orm.Dashboard.where({ id: "dash_1" }).update({
  password: "new-secret",
});
```

Expected semantic SQL shape:

```sql
UPDATE "Dashboard"
SET "password" = $1, "updatedAt" = $2
WHERE "Dashboard"."id" = $3
RETURNING ...
```

`$2` should be the current application timestamp.

This should apply to all non-empty ORM update paths that mutate rows of a model
with an `@updatedAt` field:

- `update`
- `updateMany`
- `updateManyAndReturn`, where supported
- the update branch of `upsert`
- nested updates, for each nested model row that is actually updated

Prisma should not compare old and new values. Setting a field to its existing
value is still a non-empty update payload and should advance `updatedAt` if the
runtime emits an update.

## Explicit Update Value

When the user supplies `updatedAt` in an update payload, Prisma must use that
value and must not replace it with the current timestamp.

Prisma 6 API:

```ts
const explicitUpdatedAt = new Date("2001-02-03T04:05:06.000Z");

await prisma.dashboard.update({
  where: { id: "dash_1" },
  data: {
    password: "new-secret",
    updatedAt: explicitUpdatedAt,
  },
});
```

Expected Prisma Next high-level API:

```ts
const explicitUpdatedAt = new Date("2001-02-03T04:05:06.000Z");

await db.orm.Dashboard.where({ id: "dash_1" }).update({
  password: "new-secret",
  updatedAt: explicitUpdatedAt,
});
```

Expected semantic SQL shape:

```sql
UPDATE "Dashboard"
SET "password" = $1, "updatedAt" = $2
WHERE "Dashboard"."id" = $3
RETURNING ...
```

`$2` should be `explicitUpdatedAt`, not a generated timestamp.

## Empty Update Semantics

An empty update payload should not advance `updatedAt`.

Prisma 6 API:

```ts
await prisma.dashboard.update({
  where: { id: "dash_1" },
  data: {},
});
```

Expected behavior:

- `updatedAt` remains unchanged.
- Prisma Next should not apply the `onUpdate` mutation default.
- Ideally Prisma Next should avoid emitting an unnecessary SQL update. If it
  does emit one for API compatibility, it must not change `updatedAt`.

"Empty" means empty after input normalization. Fields omitted by JavaScript
`undefined` or an equivalent skip marker should not make the update non-empty.
Explicit `null`, scalar operations such as `increment`, and relation operations
that actually mutate rows are non-empty.

## Upsert Semantics

For `upsert`, each branch should behave like the corresponding standalone
operation.

Create branch:

- If `updatedAt` is omitted from `create`, generate it.
- If `updatedAt` is supplied in `create`, preserve the explicit value.

Update branch:

- If `update` is non-empty and omits `updatedAt`, generate it.
- If `update` supplies `updatedAt`, preserve the explicit value.
- If `update` is empty, leave `updatedAt` unchanged.

## Bulk Write Semantics

For `createMany`, each inserted row should receive an `updatedAt` value when the
row omits it.

For `updateMany`, every row matched and updated by a non-empty payload should
receive the same generated `updatedAt` value for that operation unless Prisma
Next has a clear target-level reason to do otherwise.

The generated value should be stable within a single lowered mutation. Avoid
calling `new Date()` separately per row when one ORM operation maps to one bulk
mutation.

## Raw SQL And Lower-Level APIs

`@updatedAt` is a Prisma ORM behavior. It should not silently affect raw SQL.

These calls should not receive automatic `updatedAt` handling unless the caller
explicitly opts into an ORM mutation-default layer:

- Prisma 6 `$executeRaw`
- Prisma 6 `$queryRaw`
- Prisma Next low-level SQL builders that directly express SQL
- Direct `pg` calls
- External database writes

If a low-level Prisma Next query builder is intended to be a typed SQL builder
rather than an ORM mutation API, it should not add `updatedAt` implicitly.

## Timestamp Source And Encoding

The generated timestamp is an application timestamp. In practice, this means the
runtime should build a JavaScript `Date` or an equivalent target timestamp value
at execution time, then encode it through the target adapter.

For PostgreSQL `timestamp(3)` columns, the observable user-facing behavior should
match Prisma 6:

- ORM query results should expose `Date` instances.
- The returned `Date` should represent the stored value consistently.
- Explicit `Date` inputs should round-trip without being shifted by the database
  session time zone.
- Automatically generated values should use the same precision as the target
  column can store; for Dub's `Timestamp3`, millisecond precision is enough.

Avoid mixing a UTC app timestamp with a database-local `timestamp without time
zone` encoding in a way that makes Prisma Next return a value that differs from
the value Prisma 6 would return for the same ORM call.

## Failure And No-Row Cases

If an update throws because no row exists, no `updatedAt` value is observable.

If `updateMany` matches zero rows, the returned count should be zero and no row
state should change.

If an update fails after the timestamp is generated but before commit, the
timestamp should not leak into database state.

## Validation Expectations

For this Dub port, the important supported shape is a required timestamp field
with an update-time execution default:

```prisma
updatedAt temporal.updatedAt()
```

Invalid or out-of-scope forms should fail during authoring or contract
validation rather than at execution time:

- non-timestamp fields, such as `String @updatedAt` in Prisma 6 syntax
- list fields
- relation fields
- `@updatedAt` with arguments in Prisma 6 syntax
- ambiguous Prisma 6 combinations that also define a field default, such as
  `DateTime @updatedAt @default(now())`

Optional update-time fields are not needed for Dub. If Prisma Next chooses to
support them later, they should still follow the same mutation-default
semantics: omitted create/update values get a timestamp, explicit `null` must
be specified and tested deliberately.

## Compatibility Tests To Add

At minimum, Prisma Next should have tests for these cases against PostgreSQL:

1. `create` omits `updatedAt`: returned row has `updatedAt instanceof Date`.
2. `create` supplies `updatedAt`: returned row equals the explicit value.
3. `update` with non-empty data omits `updatedAt`: returned row has a newer
   `updatedAt`.
4. `update` supplies `updatedAt`: returned row equals the explicit value.
5. `update` with empty data leaves `updatedAt` unchanged.
6. `updateMany` with non-empty data updates `updatedAt` on all matched rows.
7. `updateMany` with zero matched rows changes no state.
8. `upsert` create branch omits `updatedAt`: generated value is present.
9. `upsert` update branch omits `updatedAt`: generated value is present when
   `update` is non-empty.
10. `upsert` update branch with `update: {}` leaves `updatedAt` unchanged.
11. A raw SQL update does not receive implicit `updatedAt` handling.
12. PSL and TS authoring produce byte-equivalent contract execution defaults.

For Dub specifically, the high-level ORM update:

```ts
await db.orm.Tag.where({ id }).update({ name: "Updated" });
```

should lower semantically like this:

```sql
UPDATE "Tag"
SET "name" = $1, "updatedAt" = $2
WHERE "Tag"."id" = $3
RETURNING ...
```

The latest Dub comparison showed Prisma 6 doing this for analogous updates,
while Prisma Next high-level ORM updates were still returning the old
`updatedAt` for several modules. That is the compatibility gap this expectation
file is meant to make explicit.
