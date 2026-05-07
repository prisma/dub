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
- `postback-runtime-module`: partner postback lookup, JSON trigger filtering,
  and disable writes.
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
  and aggregations through `Program`, `ProgramCategory`, and `PartnerGroup`
  relation filters.
- `partner-group-runtime-module`: partner group list reads with expanded
  enrollment counters.
- `program-application-runtime-module`: program application reads/review
  writes plus application event funnel counts and relation includes.
- `bounty-runtime-module`: bounty details, grouped submission counts, and
  review writes.
- `partner-runtime-module`: partner profile reads and update writes.
- `program-enrollment-runtime-module`: program enrollment compound-key reads
  and partner includes.
- `customer-runtime-module`: customer cursor and list reads.

Latest run, using Prisma Next tarballs packed from
`feat/created-updated-at-authoring` at
`93be243beea17c8f2a846445b6dd42ba35b7a30b` on 2026-05-07:

- 27 modules, 72 operations: 49 reads and 23 writes.
- Prisma 6 emitted 117 captured queries; Prisma Next emitted 103.
- Same query count: 50/72 operations.
- Result type shape equal: 70/72 operations.
- Result value summary equal: 35/72 operations.
- Before fixture equal: 72/72 operations.
- After fixture equal: 53/72 operations overall, and 4/23 write operations.
- Query parameter kinds differed sharply: Prisma 6 sent no captured `Date`
  parameters and represented timestamp writes as strings, while Prisma Next
  sent 32 captured `Date` parameters.
- The companion DDL compare found 296 expected differences and 0 unexpected
  differences. The new category is 44 `updatedAt` column-type differences:
  `temporal.updatedAt()` currently emits `timestamptz`, while Dub's Prisma 6
  PostgreSQL schema uses `timestamp(3)`.

Known visible result-type differences:

- `analytics.read.all-time-composite-for-link`: Prisma 6 returns
  `Link.saleAmount` aggregate sums as `bigint`; Prisma Next currently returns
  the same safe value as `number`.
- `program-enrollment.read.by-partner-program`: Prisma 6 returns
  `ProgramEnrollment.totalCommissions` as `bigint`; Prisma Next currently
  returns the selected `bigint` column as `string`.

Tracked write-query differences:

- `temporal.updatedAt()` now appears in Prisma Next create and non-empty
  update SQL for the covered high-level ORM writes. Prisma 6 still sends
  generated timestamp values as timestamp strings, while Prisma Next sends
  JavaScript `Date` parameters to the driver.
- Counter increments are not equivalent through the current Prisma Next
  high-level ORM. Prisma 6 emits atomic `SET field = field + $n` updates. The
  Prisma Next high-level fallback currently reads the current value first, then
  writes the computed scalar value plus `updatedAt`.
- Multi-row count writes have different orchestration. For example,
  `commissions.update.mark-paid-count` captures Prisma 6 as
  `BEGIN` + matching-row `SELECT` + `UPDATE ... updatedAt = $n` + `COMMIT`,
  while Prisma Next `updateCount` captures a matching-row `SELECT` followed by
  `UPDATE ... updatedAt = $n` without an explicit transaction.
- Scalar update writes such as `payouts.update.pending-amount` keep matching
  result shapes. Their `updatedAt` values now differ only by execution-time
  milliseconds in ORM results, but raw fixture snapshots still expose the
  timestamp encoding difference described below.
- `notification-email.aggregate.campaign-summary` maps one Prisma 6 raw SQL
  query with `SUM(CASE WHEN ...)` into four Prisma Next high-level count
  aggregates because that CASE aggregate shape is not represented by the
  current high-level ORM API.
- Explicit date writes such as `notification-email.update.delivered-at`,
  `postback.update.disable`, `usage.update.link-click-increment`,
  `program-application.update.reject`, and
  `bounty-submission.update.approve` expose a parameter-encoding difference:
  Prisma 6 sends the `Date` update value as a timestamp string, while Prisma
  Next sends a JavaScript `Date` to the driver. The returned JS value shape
  usually matches, but raw fixture snapshots capture the resulting
  `timestamp(3)` state difference.
- Date values still need follow-up. In the Europe/Rome run from
  2026-05-07, many existing `timestamp(3)` reads differed by one hour in ORM
  results, and raw fixture snapshots for generated May 2026 timestamps differed
  by two hours because the process was in CEST. See
  `docs/prisma-next-date-value-expectations.md` for the expected Prisma 6
  compatibility behavior.
- `postback.read.enabled-for-trigger` keeps the Prisma 6 JSON
  `array_contains` predicate as the baseline. The current Prisma Next
  high-level ORM path fetches enabled partner postbacks and applies the JSON
  trigger membership check in JavaScript.
- `program-application-event.aggregate.funnel-summary` maps one Prisma 6 raw
  SQL query with multiple `COUNT(column)` metrics into five Prisma Next
  high-level count aggregates, one for each funnel step.
- `program-network.aggregate.marketplace-reward-types` maps one Prisma 6 raw
  SQL query with four `COUNT(column)` metrics into four Prisma Next high-level
  filtered count aggregates.
- `bounty.read.details-with-groups` maps a Prisma 6 raw SQL query with a
  lateral-style JSON aggregate into Prisma Next high-level relation includes
  over `Workflow` and `BountyGroup`.
- `partner-group.read.expanded-list` maps a Prisma 6 raw SQL aggregate join
  into a Prisma Next high-level `PartnerGroup` read with included
  `ProgramEnrollment` rows and JavaScript-side counter folding.

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

Latest inventory:

- Raw SQL execution sites: 41.
- Prisma SQL fragments: 146.
- Classification: 12 `orm-api`, 11 `query-builder-api`, 14
  `not-currently-covered`, and 4 `manual-review`.
