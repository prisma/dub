# Prisma Next Runtime SQL Comparison

This branch compares Prisma 6 Client and Prisma Next one runtime module at a
time, without changing app-wide Prisma imports.

Current modules:

- `dashboard-runtime-module`: Dashboard relation reads plus create, update, and
  delete writes.
- `user-runtime-module`: user existence lookups by `User.id`.
- `link-runtime-module`: short-link existence lookups by the `Link.domain/key`
  compound identity.
- `edge-link-runtime-module`: edge link reads by `shortLink` and by
  `domain/key` with webhook ids.
- `analytics-runtime-module`: all-time link analytics aggregates for the raw
  shortcut in `getAnalytics`.
- `commissions-payouts-runtime-module`: commissions and payouts reads,
  aggregates, grouped aggregates, relation filters, includes, and update-count
  writes.
- `notification-email-runtime-module`: notification email webhook reads/writes
  plus campaign summary aggregation.
- `usage-counter-runtime-module`: link, workspace, and program-enrollment
  usage counter reads and writes.
- `workspace-product-runtime-module`: workspace product resolution from
  `Project.defaultProgramId`.
- `workspace-runtime-module`: workspace fetchers with membership metadata.
- `edge-workspace-runtime-module`: edge workspace reads by id, with and
  without domain slugs.
- `folder-runtime-module`: folder access lookups with filtered `FolderUser`
  includes.
- `integration-runtime-module`: verified integrations installed in a workspace.
- `tag-runtime-module`: tag list/search reads plus create, update, and delete
  writes.
- `token-runtime-module`: restricted token listing with user includes plus
  update and delete writes.
- `webhook-runtime-module`: workspace webhook reads with `LinkWebhook` includes
  plus update and delete writes.
- `installed-integration-runtime-module`: installed integration lookup and
  delete writes.
- `domain-runtime-module`: workspace domain scalar reads.
- `program-runtime-module`: basic program fetcher reads.
- `program-network-runtime-module`: marketplace program availability counting
  through `Program`/`PartnerGroup` relation filters.
- `partner-runtime-module`: partner profile reads and update writes.
- `program-enrollment-runtime-module`: program enrollment compound-key reads
  and partner includes.
- `customer-runtime-module`: customer cursor and list reads.

Known visible result-type differences:

- `analytics.read.all-time-composite-for-link`: Prisma 6 returns
  `Link.saleAmount` aggregate sums as `bigint`; Prisma Next currently returns
  the same safe value as `number`.
- `program-enrollment.read.by-partner-program`: Prisma 6 returns
  `ProgramEnrollment.totalCommissions` as `bigint`; Prisma Next currently
  returns the selected `bigint` column as `string`.

Tracked write-query differences:

- Counter increments are not equivalent through the current Prisma Next
  high-level ORM. Prisma 6 emits atomic `SET field = field + $n` updates and
  writes `updatedAt`; the Prisma Next high-level fallback currently reads the
  current value first, writes the computed scalar value, and leaves `updatedAt`
  unchanged.
- Multi-row count writes have different orchestration. For example,
  `commissions.update.mark-paid-count` captures Prisma 6 as
  `BEGIN` + matching-row `SELECT` + `UPDATE ... updatedAt = $n` + `COMMIT`,
  while Prisma Next `updateCount` captures a matching-row `SELECT` followed by
  `UPDATE` without an automatic `updatedAt` assignment.
- Scalar update writes such as `payouts.update.pending-amount` keep matching
  result shapes, but Prisma 6 advances `updatedAt` and Prisma Next currently
  leaves it unchanged unless the application passes an explicit value.
- `notification-email.aggregate.campaign-summary` maps one Prisma 6 raw SQL
  query with `SUM(CASE WHEN ...)` into four Prisma Next high-level count
  aggregates because that CASE aggregate shape is not represented by the
  current high-level ORM API.
- `notification-email.update.delivered-at` exposes a parameter-encoding
  difference: Prisma 6 sends the `Date` update value as a timestamp string,
  while Prisma Next sends a JavaScript `Date` to the driver. The returned JS
  value shape matches, but the raw fixture snapshot captures the resulting
  `timestamp(3)` state difference.

## Runtime Capture

`pnpm --filter=@dub/prisma next:sql:compare` runs equivalent module operations
against two isolated scratch PostgreSQL databases with the same minimal schema
and seed data.

The comparison is collected inside the two runtimes, not inferred from server
logs. That keeps it tied to the exact SQL, encoded parameters, and JavaScript
result values observed by the application boundary under test.

- Prisma 6 capture happens at the `pg` pool/client query boundary used by
  `@prisma/adapter-pg`. The collector wraps pool-level calls and acquired
  clients, so transactional update/delete paths are captured along with normal
  reads. This records the SQL and the parameter values after Prisma 6 has
  mapped them for the driver. Prisma Client query events are also stored as
  sidecar metadata.
- Prisma Next capture happens in runtime middleware before driver execution.
  This records the lowered SQL plan, encoded parameters, and plan metadata
  emitted by the high-level `db.orm` API.
- Results are summarized by JavaScript value shape, including constructors such
  as `Date`, so type differences are visible separately from dynamic values.
  Known mismatches stay visible in the report instead of being normalized away.
- Every operation records before/after database snapshots for both runtimes.
  The before snapshot proves the fixture is identical before running a read or
  write; the after snapshot shows how each runtime changed its own database.

By default both scratch databases are created on the Postgres server pointed at
by `DATABASE_URL`. To run the comparison against two separate Postgres
instances, pass different roots:

```sh
PRISMA6_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dub \
PRISMA_NEXT_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dub \
pnpm --filter=@dub/prisma next:sql:compare
```

The JSON report is written to
`packages/prisma/.tmp/prisma-next-runtime-sql-comparison.json`.

## Raw SQL Inventory

`pnpm --filter=@dub/prisma next:raw:inventory` statically scans raw SQL
execution sites in `apps/` and `packages/`.

The classifier is intentionally conservative:

- `orm-api`: likely single-model CRUD/read shape.
- `query-builder-api`: likely needs the lower-level Prisma Next SQL builder or
  a focused ORM aggregate/grouping port.
- `not-currently-covered`: uses constructs such as CTEs, JSON operators,
  window functions, dynamic lists, or custom SQL expressions.
- `manual-review`: dynamic/unsafe SQL or a call site where the scanner cannot
  see the full query.

The JSON report is written to
`packages/prisma/.tmp/prisma-next-raw-sql-inventory.json`.
