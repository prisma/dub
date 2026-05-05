# Prisma Next Runtime SQL Comparison

This branch compares Prisma 6 Client and Prisma Next one runtime module at a
time, without changing app-wide Prisma imports.

Current modules:

- `dashboard-runtime-module`: Dashboard relation reads plus create, update, and
  delete writes.
- `user-runtime-module`: user existence lookups by `User.id`.
- `link-runtime-module`: short-link existence lookups by the `Link.domain/key`
  compound identity.
- `workspace-product-runtime-module`: workspace product resolution from
  `Project.defaultProgramId`.
- `workspace-runtime-module`: workspace fetchers with membership metadata.
- `folder-runtime-module`: folder access lookups with filtered `FolderUser`
  includes.
- `integration-runtime-module`: verified integrations installed in a workspace.
- `tag-runtime-module`: tag list and search reads.
- `token-runtime-module`: restricted token listing with user includes.
- `webhook-runtime-module`: workspace webhook reads with `LinkWebhook` includes.
- `domain-runtime-module`: workspace domain scalar reads.

## Runtime Capture

`pnpm --filter=@dub/prisma next:sql:compare` runs equivalent module operations
against two isolated scratch PostgreSQL databases with the same minimal schema
and seed data.

The comparison is collected inside the two runtimes, not inferred from server
logs. That keeps it tied to the exact SQL, encoded parameters, and JavaScript
result values observed by the application boundary under test.

- Prisma 6 capture happens at the `pg.Pool.query` boundary used by
  `@prisma/adapter-pg`. This records the SQL and the parameter values after
  Prisma 6 has mapped them for the driver. Prisma Client query events are also
  stored as sidecar metadata.
- Prisma Next capture happens in runtime middleware before driver execution.
  This records the lowered SQL plan, encoded parameters, and plan metadata
  emitted by the high-level `db.orm` API.
- Results are summarized by JavaScript value shape, including constructors such
  as `Date`, so type differences are visible separately from dynamic values.
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
