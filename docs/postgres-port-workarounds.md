# PostgreSQL Port Workarounds

This branch ports the project from PlanetScale / MySQL Vitess to PostgreSQL 16
while keeping Prisma 6.19.x. The items below track places where behavior could
not be carried over exactly as-is, and the compatible alternative used instead.

## Prisma Schema And Indexes

- MySQL `@db.LongText` fields were converted to PostgreSQL `@db.Text`.
- MySQL `@@fulltext` indexes were removed because Prisma 6.19 does not expose
  a provider-portable full-text abstraction for the existing MySQL indexes.
- MySQL prefix indexes such as `url(length: 500)` were removed. PostgreSQL does
  not support MySQL-style prefix indexes through Prisma schema attributes.
- PostgreSQL-specific search indexes now live in
  `packages/prisma/postgres-postdeploy.sql`, using `pg_trgm` and GIN indexes.
  This script must run after `prisma db push` or production DDL application.

## Search Semantics

- Prisma MySQL full-text `search` filters were replaced with
  case-insensitive `contains` filters.
- `sanitizeFullTextSearch` remains as a compatibility helper, but its output is
  now used for substring-style matching rather than MySQL full-text query syntax.
- The trigram indexes are intended to keep these lookups practical on
  PostgreSQL, but ranking/tokenization semantics are not identical to MySQL
  full-text search.

## Raw SQL

- MySQL JSON/date/string functions were rewritten to PostgreSQL equivalents:
  `jsonb_*`, `->`, `->>`, `jsonb_array_length`, `string_agg`, `to_char`, and
  `AT TIME ZONE`.
- MySQL `UPDATE ... JOIN`, `FORCE INDEX`, backtick aliases, and `LIKE` patterns
  that needed case-insensitive behavior were rewritten for PostgreSQL.
- The former PlanetScale query helper is now `apps/web/lib/postgres`. It keeps
  the `execute(query, params)` shape and translates `?` placeholders to
  PostgreSQL positional placeholders.

## Runtime

- The old PlanetScale HTTP driver could run in Edge-like contexts. The
  PostgreSQL `pg` driver is Node-only, so DB-backed routes/helpers were moved to
  Node runtime where required.
- Some helper names still include `ViaEdge` for API compatibility, but they now
  access PostgreSQL from Node runtime.
- Edge routes that only needed non-DB code were kept on Edge and adjusted to
  avoid importing barrels that pull in PostgreSQL code.

## Backups

- The PlanetScale backup API flow was removed.
- `POSTGRES_BACKUP_WEBHOOK_URL` can be set for the backup cron to trigger an
  external PostgreSQL backup job. Without it, the cron logs that PostgreSQL
  backups are managed externally.

## Validation Notes

- `prisma db push` and `postdeploy:postgres` were validated against a fresh
  `postgres:16` Docker container.
- The development seed and Playwright seed were run against that container.
- Smoke queries covered direct SQL, Prisma raw queries, and the PostgreSQL
  helper layer.
- `pnpm turbo build --filter=web` compiles and passes TypeScript, then stops
  during Next page-data collection on an unrelated existing
  `@dub/utils` `optimizePackageImports` virtual module issue.
