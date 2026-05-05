# Prisma Next Date Value Expectations

This document describes how I would expect Prisma Next to handle date values
when matching Prisma 6 behavior on PostgreSQL. It is based on Prisma 6's
observable JavaScript API, not on raw `pg` driver behavior alone.

The short version: typed `DateTime` fields should round-trip as JavaScript
`Date` instances, and the same database row should produce the same
`Date#toISOString()` value in Prisma 6 and Prisma Next.

## Scope

This applies to Prisma ORM reads and writes for PostgreSQL `DateTime` columns,
including Dub's Prisma Next named type:

```prisma
types {
  Timestamp3 = DateTime @db.Timestamp(3)
}
```

and the Prisma 6 equivalent:

```prisma
createdAt DateTime @default(now()) @db.Timestamp(3)
updatedAt DateTime @updatedAt @db.Timestamp(3)
```

It also applies to date values used in `where` filters, ordering, explicit
mutation data, `@default(now())`, and `@updatedAt`.

It does not imply that JSON string values should become `Date` instances. If a
date-like value is stored inside a JSON column, it remains JSON data unless the
caller parses it.

## Compatibility Target

For the same schema, database value, input value, and runtime operation, Prisma
Next should match Prisma 6 at the application boundary:

- A selected `DateTime` field returns a JavaScript `Date`.
- `value instanceof Date` is true for ORM result values.
- `value.toISOString()` matches Prisma 6 for the same row.
- Explicit `Date` inputs preserve the same instant Prisma 6 would preserve.
- Date filter bounds match the same rows Prisma 6 would match.
- Null optional date fields remain `null`.

The comparison target is Prisma Client's observable result, not the textual form
PostgreSQL happens to display and not the intermediate representation a driver
uses before decoding a row.

## PostgreSQL Type Semantics

PostgreSQL has two relevant timestamp families:

- `timestamp with time zone`, usually written `timestamptz`, represents an
  instant.
- `timestamp without time zone`, usually written `timestamp`, stores date-time
  fields without a zone.

Dub's contract uses many `timestamp(3)` columns. These are `timestamp without
time zone` columns. They do not store an offset, but Prisma 6 still exposes them
as JavaScript `Date` values. Prisma Next therefore needs an explicit
compatibility rule for how to encode and decode those values.

That rule must not accidentally depend on the process timezone, the local
machine timezone, or the PostgreSQL session timezone in a way that makes Prisma
Next shift a value that Prisma 6 would not shift.

## Read Expectations

When reading a typed `DateTime` column through the ORM, Prisma Next should return
a `Date` instance.

For an existing row, these values should match:

```ts
const prisma6Value = await prisma.model.findUnique(...);
const prismaNextValue = await db.orm.Model.where(...).select(...).first();

prisma6Value.createdAt instanceof Date; // true
prismaNextValue.createdAt instanceof Date; // true
prismaNextValue.createdAt.toISOString() === prisma6Value.createdAt.toISOString();
```

This should hold for both `timestamp(3)` and `timestamptz` columns, with the
important distinction that `timestamp(3)` compatibility is a Prisma-level
mapping decision because PostgreSQL itself does not store a timezone.

## Write Expectations

When writing an explicit JavaScript `Date`, Prisma Next should store a value
that reads back the same way Prisma 6 would read it back:

```ts
const input = new Date("2024-01-11T00:00:00.000Z");

const prisma6Row = await prisma.model.create({ data: { createdAt: input } });
const prismaNextRow = await db.orm.Model.create({ createdAt: input });

prismaNextRow.createdAt instanceof Date; // true
prismaNextRow.createdAt.toISOString() === prisma6Row.createdAt.toISOString();
```

The same rule applies to update data:

```ts
await db.orm.NotificationEmail.where({ id }).update({
  deliveredAt: new Date("2024-01-15T04:00:00.000Z"),
});
```

If Prisma 6 encodes the value as a timestamp string and Prisma Next passes a
JavaScript `Date` to the driver, that parameter-type difference is worth
recording. It should not change the stored value or the ORM result value.

## Filter Expectations

Date values in filters should use the same encoding rule as date values in
writes. A range query should match the same rows in Prisma 6 and Prisma Next:

```ts
where: {
  visitedAt: {
    gte: new Date("2024-01-17T00:00:00.000Z"),
    lt: new Date("2024-01-18T00:00:00.000Z"),
  },
}
```

This matters for `timestamp without time zone` columns. If encode and decode use
different timezone assumptions, equality and range filters can appear correct in
one local timezone and fail in another.

## Defaults And `@updatedAt`

`@default(now())` and `@updatedAt` should return `Date` instances through normal
ORM reads and mutation returns.

For generated values:

- The value should be close to the operation time.
- The value should use the target column's precision.
- For `timestamp(3)`, millisecond precision is the relevant precision.
- The returned `Date#toISOString()` value should match Prisma 6's observable
  value for the same generated database value.

For explicit `updatedAt` values, Prisma Next should preserve the caller's value
and should not replace it with the current time.

## Precision

Dub's `Timestamp3` maps to PostgreSQL `timestamp(3)`. Sub-millisecond precision
is out of scope for this contract.

Prisma Next should either round or truncate in the same observable way Prisma 6
does for PostgreSQL `timestamp(3)`. Tests should compare millisecond-precision
ISO strings, not higher precision PostgreSQL internals.

## Parameter Metadata

The runtime SQL comparison should capture parameter metadata separately from
result values.

For each date parameter, record at least:

- whether the runtime passed a JavaScript `Date`, a string, or another value
  kind;
- the JavaScript constructor when applicable;
- the ISO value for `Date` parameters;
- the exact string for string parameters;
- the SQL placeholder position and target column when that is available.

Prisma 6 and Prisma Next may use different intermediate parameter types. That is
not automatically a compatibility bug. It becomes a bug if the database state,
the selected result value, or the matched row set differs.

## Observed Dub Issue

In the local Europe/Rome runtime comparison, both sides usually returned
JavaScript `Date` instances. However, many `timestamp(3)` values differed by one
hour between Prisma 6 and Prisma Next.

That is the important symptom to fix. It suggests that at least one side of the
Prisma Next encode/decode path is interpreting a `timestamp without time zone`
value with a different timezone rule than Prisma 6.

Be careful when debugging this with raw database snapshots. The Dub comparison
also uses direct `pg` snapshots to prove fixture equality. Those snapshots are
useful, but the application compatibility target is still the Prisma ORM result:
same row, same typed field, same `Date#toISOString()` as Prisma 6.

## Test Matrix

Prisma Next should have focused PostgreSQL tests for these cases:

1. Read a `timestamp(3)` row written by Prisma 6; the Prisma Next result is a
   `Date` with the same ISO string.
2. Write an explicit `Date` to a `timestamp(3)` column through Prisma Next; read
   it through Prisma 6 and Prisma Next; both ISO strings match.
3. Read and write the same values under `TZ=UTC` and `TZ=Europe/Rome`.
4. Repeat the read/write tests for winter and summer timestamps, such as
   `2024-01-11T00:00:00.000Z` and `2024-07-11T00:00:00.000Z`.
5. Include daylight-saving boundary values, such as
   `2024-03-31T00:30:00.000Z` and `2024-10-27T00:30:00.000Z`.
6. Use date equality and range filters against `timestamp(3)` columns and verify
   that Prisma 6 and Prisma Next match the same rows.
7. Verify `@default(now())` values return `Date` instances and do not shift when
   read back.
8. Verify `@updatedAt` values return `Date` instances, explicit values are
   preserved, and generated values do not shift when read back.
9. Repeat the relevant tests for a `timestamptz` column to keep instant semantics
   separate from `timestamp without time zone` compatibility.

The expected result is boring but strict: Prisma Next can differ internally, but
the application should see the same date kinds and ISO values that Prisma 6
would expose.
