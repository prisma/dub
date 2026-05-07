# Prisma Next emits unnecessary relation query for null optional FK

## Title

Prisma Next high-level ORM should skip optional relation include queries when all parent foreign keys are null

## Summary

When a Prisma Next high-level ORM query includes an optional relation whose parent foreign key is `null`, Prisma Next still emits a child relation query with `WHERE id IN ($1)` and `$1 = null`.

Prisma 6 Client skips that child relation query. Both runtimes return the same result, but Prisma Next performs an unnecessary database round trip.

This was observed in Dub's Prisma Next hybrid runtime SQL comparison harness for `dashboard.read.selected-relations`.

## Base PSL schema

The relevant shape is an optional one-to-one relation from `Dashboard` to `Folder` through a nullable unique foreign key:

```prisma
types {
  Timestamp3 = DateTime @db.Timestamp(3)
}

model Dashboard {
  id String @id @default(cuid(2))

  link   Link?   @relation(fields: [linkId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  linkId String? @unique

  folder   Folder? @relation(fields: [folderId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  folderId String? @unique

  project   Project? @relation(fields: [projectId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  projectId String?

  doIndex         Boolean @default(false)
  password        String?
  showConversions Boolean @default(false)

  createdAt Timestamp3 @default(now())
  updatedAt temporal.updatedAt()

  @@index([projectId])
  @@map("Dashboard")
}

model Folder {
  id        String @id @default(cuid(2))
  name      String
  projectId String

  @@map("Folder")
}

model Link {
  id        String @id @default(cuid(2))
  domain    String
  key       String
  url       String
  projectId String?

  @@map("Link")
}

model Project {
  id   String @id @default(cuid(2))
  slug String @unique
  plan String @default("free")

  @@map("Project")
}
```

The seeded `Dashboard` row has a related `Link` and `Project`, but no related `Folder`:

```txt
Dashboard.id        = "dash_runtime_sql_existing"
Dashboard.linkId    = "link_runtime_sql"
Dashboard.folderId  = null
Dashboard.projectId = "proj_runtime_sql"
```

## TypeScript query API comparison

| Prisma 6 Client | Prisma Next high-level ORM |
|---|---|
| `prisma.dashboard.findUnique(...)` | `db.orm.Dashboard.where(...).select(...).include(...).first()` |

```ts
// Prisma 6 Client
await prisma.dashboard.findUnique({
  where: { id: dashboardIds.existing },
  select: {
    id: true,
    doIndex: true,
    password: true,
    showConversions: true,
    link: {
      select: {
        id: true,
        domain: true,
        key: true,
        url: true,
      },
    },
    folder: {
      select: {
        id: true,
        name: true,
      },
    },
    project: {
      select: {
        plan: true,
      },
    },
  },
});
```

```ts
// Prisma Next high-level ORM
await db.orm.Dashboard.where({ id: dashboardIds.existing })
  .select("id", "doIndex", "password", "showConversions")
  .include("link", (link) => link.select("id", "domain", "key", "url"))
  .include("folder", (folder) => folder.select("id", "name"))
  .include("project", (project) => project.select("plan"))
  .first();
```

## Observed SQL

Prisma 6 emits three queries. It fetches `Dashboard`, then fetches the non-null `Link` and `Project` relations. It does not query `Folder` because `Dashboard.folderId` is `null`.

```sql
SELECT "public"."Dashboard"."id",
       "public"."Dashboard"."doIndex",
       "public"."Dashboard"."password",
       "public"."Dashboard"."showConversions",
       "public"."Dashboard"."linkId",
       "public"."Dashboard"."folderId",
       "public"."Dashboard"."projectId"
FROM "public"."Dashboard"
WHERE ("public"."Dashboard"."id" = $1 AND 1=1)
LIMIT $2 OFFSET $3;

-- params: ["dash_runtime_sql_existing", 1, 0]
```

```sql
SELECT "public"."Link"."id",
       "public"."Link"."domain",
       "public"."Link"."key",
       "public"."Link"."url"
FROM "public"."Link"
WHERE "public"."Link"."id" IN ($1)
OFFSET $2;

-- params: ["link_runtime_sql", 0]
```

```sql
SELECT "public"."Project"."id",
       "public"."Project"."plan"
FROM "public"."Project"
WHERE "public"."Project"."id" IN ($1)
OFFSET $2;

-- params: ["proj_runtime_sql", 0]
```

Prisma Next emits four queries. The additional query fetches `Folder` with a null parameter:

```sql
SELECT "Dashboard"."id" AS "id",
       "Dashboard"."doIndex" AS "doIndex",
       "Dashboard"."password" AS "password",
       "Dashboard"."showConversions" AS "showConversions",
       "Dashboard"."linkId" AS "linkId",
       "Dashboard"."folderId" AS "folderId",
       "Dashboard"."projectId" AS "projectId"
FROM "Dashboard"
WHERE "Dashboard"."id" = $1
LIMIT 1;

-- params: ["dash_runtime_sql_existing"]
```

```sql
SELECT "Link"."id" AS "id",
       "Link"."domain" AS "domain",
       "Link"."key" AS "key",
       "Link"."url" AS "url"
FROM "Link"
WHERE "Link"."id" IN ($1);

-- params: ["link_runtime_sql"]
```

```sql
SELECT "Folder"."id" AS "id",
       "Folder"."name" AS "name"
FROM "Folder"
WHERE "Folder"."id" IN ($1);

-- params: [null]
```

```sql
SELECT "Project"."plan" AS "plan",
       "Project"."id" AS "id"
FROM "Project"
WHERE "Project"."id" IN ($1);

-- params: ["proj_runtime_sql"]
```

## Observed result

Both runtimes return the same JavaScript result value and type shape for this read:

```txt
fixtureBeforeEqual      true
fixtureAfterEqual       true
resultTypeShapeEqual    true
resultValueSummaryEqual true

Prisma 6 query count     3
Prisma Next query count  4
```

The extra Prisma Next query does not change the result. It only adds work:

```ts
{
  id: "dash_runtime_sql_existing",
  doIndex: false,
  password: "old-password",
  showConversions: false,
  link: { /* selected Link fields */ },
  folder: null,
  project: { /* selected Project fields */ },
}
```

## Expected behavior

Before issuing a batched child relation query, Prisma Next should filter out null foreign-key values collected from parent rows.

If the filtered key set is empty, Prisma Next should skip the child relation query and resolve the included optional relation to `null` for those parent rows.

For this case, Prisma Next should emit three queries, not four.

## Impact

This is not a correctness bug for the observed query. It is an efficiency issue.

The extra query adds one database round trip for every included optional relation where all parent foreign keys are null. In hot paths, this can increase latency, database load, and query trace noise.

The issue can compound when a query includes several optional relations or when many parent rows have null relation keys.

## Reproduction command in Dub

```sh
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" \
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dub" \
pnpm --filter=@dub/prisma next:sql:compare
```

The generated JSON report is written to:

```txt
packages/prisma/.tmp/prisma-next-runtime-sql-comparison.json
```

The relevant operation is:

```txt
dashboard.read.selected-relations
```

## Environment

```txt
Prisma 6 runtime: @prisma/client with @prisma/adapter-pg
Prisma Next runtime: @prisma-next/postgres/runtime from local prisma-next-clean tarballs
Database: PostgreSQL 16
Node: 24
Dub branch: port/prisma-next-hybrid
```
