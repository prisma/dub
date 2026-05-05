import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import postgres from "@prisma-next/postgres/runtime";
import { Pool } from "pg";
import contractJson from "../schema/contract.json" with { type: "json" };

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/dub";
const prisma6RootDatabaseUrl = process.env.PRISMA6_DATABASE_URL ?? baseDatabaseUrl;
const prismaNextRootDatabaseUrl = process.env.PRISMA_NEXT_DATABASE_URL ?? baseDatabaseUrl;

const outputPath =
  process.env.PRISMA_NEXT_SQL_COMPARE_OUT ??
  join(process.cwd(), ".tmp", "prisma-next-runtime-sql-comparison.json");

const dashboardIds = {
  existing: "dash_runtime_sql_existing",
  create: "dash_runtime_sql_create",
};

const fixtureValues = {
  linkId: "link_runtime_sql",
  folderId: "fold_runtime_sql",
  projectId: "proj_runtime_sql",
  userId: "user_runtime_sql",
};

const quoteIdent = (value) => `"${value.replace(/"/g, '""')}"`;

const databaseUrlFor = (rootDatabaseUrl, databaseName) => {
  const url = new URL(rootDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const adminDatabaseUrlFor = (rootDatabaseUrl) => {
  const url = new URL(rootDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
};

const describeDatabaseUrl = (databaseUrl) => {
  const url = new URL(databaseUrl);
  const username = url.username ? decodeURIComponent(url.username) : "";
  const auth = username ? `${username}${url.password ? ":<redacted>" : ""}@` : "";
  return `${url.protocol}//${auth}${url.host}${url.pathname}`;
};

const normalizeSql = (sql) => String(sql).replace(/\s+/g, " ").trim();

const stableJson = (value) =>
  JSON.stringify(
    value,
    (_key, current) => {
      if (typeof current === "bigint") {
        return current.toString();
      }
      return current;
    },
    2,
  );

function describeValue(value, depth = 0) {
  if (value === null) {
    return { kind: "null" };
  }
  if (value === undefined) {
    return { kind: "undefined" };
  }
  if (value instanceof Date) {
    return {
      kind: "date",
      constructor: "Date",
      iso: Number.isNaN(value.getTime()) ? null : value.toISOString(),
    };
  }
  if (Buffer.isBuffer(value)) {
    return {
      kind: "buffer",
      constructor: "Buffer",
      byteLength: value.byteLength,
    };
  }
  if (Array.isArray(value)) {
    return {
      kind: "array",
      constructor: "Array",
      length: value.length,
      items: depth >= 3 ? [] : value.slice(0, 5).map((item) => describeValue(item, depth + 1)),
    };
  }
  const type = typeof value;
  if (type !== "object") {
    return {
      kind: type,
      value,
    };
  }

  const constructor = value?.constructor?.name ?? "Object";
  const entries = Object.entries(value);
  return {
    kind: "object",
    constructor,
    keys: entries.map(([key]) => key),
    fields:
      depth >= 3
        ? undefined
        : Object.fromEntries(
            entries.map(([key, fieldValue]) => [key, describeValue(fieldValue, depth + 1)]),
          ),
  };
}

function summarizeParams(params) {
  return params.map((value, index) => ({
    index,
    ...describeValue(value),
  }));
}

function summarizeResult(result) {
  return describeValue(result);
}

function stableHash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function typeShape(summary) {
  if (!summary || typeof summary !== "object") {
    return summary;
  }

  const base = {
    kind: summary.kind,
    ...(summary.constructor ? { constructor: summary.constructor } : {}),
  };

  if (summary.kind === "array") {
    return {
      ...base,
      items: (summary.items ?? []).map(typeShape),
    };
  }

  if (summary.kind === "object") {
    const fields = summary.fields ?? {};
    return {
      ...base,
      keys: [...(summary.keys ?? [])].sort(),
      fields: Object.fromEntries(
        Object.entries(fields)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [key, typeShape(value)]),
      ),
    };
  }

  return base;
}

function summarizeQuery(entry) {
  return {
    sql: entry.sql,
    normalizedSql: normalizeSql(entry.sql),
    params: summarizeParams(entry.params ?? []),
    meta: entry.meta,
  };
}

class QueryCollector {
  #enabled = false;

  constructor(label) {
    this.label = label;
    this.entries = [];
    this.queryEvents = [];
  }

  get enabled() {
    return this.#enabled;
  }

  start() {
    this.entries = [];
    this.queryEvents = [];
    this.#enabled = true;
  }

  stop() {
    this.#enabled = false;
  }

  record(entry) {
    if (!this.#enabled) {
      return;
    }
    this.entries.push(entry);
  }

  recordQueryEvent(event) {
    if (!this.#enabled) {
      return;
    }
    this.queryEvents.push({
      query: event.query,
      params: event.params,
      duration: event.duration,
      target: event.target,
    });
  }
}

class CapturingPool extends Pool {
  constructor(config, collector) {
    super(config);
    this.collector = collector;
  }

  query(queryConfig, values, callback) {
    const sql =
      typeof queryConfig === "string"
        ? queryConfig
        : typeof queryConfig?.text === "string"
          ? queryConfig.text
          : null;
    const params = Array.isArray(values)
      ? values
      : Array.isArray(queryConfig?.values)
        ? queryConfig.values
        : [];

    if (sql) {
      this.collector.record({ sql, params });
    }

    return super.query(queryConfig, values, callback);
  }
}

async function createDatabase(pool, name) {
  await pool.query(`CREATE DATABASE ${quoteIdent(name)}`);
}

async function dropDatabase(pool, name) {
  await pool.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [
    name,
  ]);
  await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
}

async function createMinimalDashboardSchema(pool) {
  await pool.query("create schema if not exists prisma_contract");
  await pool.query(`
    create table prisma_contract.marker (
      id smallint primary key default 1,
      core_hash text not null,
      profile_hash text not null,
      contract_json jsonb,
      canonical_version int,
      updated_at timestamptz not null default now(),
      app_tag text,
      meta jsonb not null default '{}',
      invariants text[] not null default '{}'
    )
  `);
  await pool.query(`
    create table "User" (
      "id" text primary key
    )
  `);
  await pool.query(`
    create table "Project" (
      "id" text primary key,
      "slug" text unique,
      "plan" text not null default 'pro'
    )
  `);
  await pool.query(`
    create table "Link" (
      "id" text primary key,
      "domain" text not null,
      "key" text not null,
      "url" text not null,
      "folderId" text,
      "projectId" text,
      "userId" text,
      "publicStats" boolean not null default false
    )
  `);
  await pool.query(`
    create table "Folder" (
      "id" text primary key,
      "name" text not null,
      "projectId" text
    )
  `);
  await pool.query(`
    create table "Dashboard" (
      "id" text primary key,
      "linkId" text unique,
      "folderId" text unique,
      "projectId" text,
      "userId" text,
      "doIndex" boolean not null default false,
      "password" text,
      "showConversions" boolean not null default false,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null
    )
  `);
}

async function resetDashboardFixture(pool, options = {}) {
  const { includeDashboard = true } = options;
  await pool.query('truncate table "Dashboard", "Link", "Folder", "Project", "User"');
  await pool.query('insert into "User" ("id") values ($1)', [fixtureValues.userId]);
  await pool.query(
    'insert into "Project" ("id", "slug", "plan") values ($1, $2, $3)',
    [fixtureValues.projectId, "runtime-sql-project", "pro"],
  );
  await pool.query(
    'insert into "Folder" ("id", "name", "projectId") values ($1, $2, $3)',
    [fixtureValues.folderId, "Runtime SQL Folder", fixtureValues.projectId],
  );
  await pool.query(
    'insert into "Link" ("id", "domain", "key", "url", "folderId", "projectId", "userId", "publicStats") values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      fixtureValues.linkId,
      "dub.sh",
      "runtime-sql",
      "https://example.com/runtime-sql",
      fixtureValues.folderId,
      fixtureValues.projectId,
      fixtureValues.userId,
      false,
    ],
  );

  if (includeDashboard) {
    await pool.query(
      'insert into "Dashboard" ("id", "linkId", "projectId", "userId", "password", "showConversions", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        dashboardIds.existing,
        fixtureValues.linkId,
        fixtureValues.projectId,
        fixtureValues.userId,
        "old-password",
        false,
        new Date("2024-01-01T00:00:00.000Z"),
        new Date("2024-01-02T03:04:05.000Z"),
      ],
    );
  }
}

async function snapshotDashboardFixture(pool) {
  const [users, projects, folders, links, dashboards] = await Promise.all([
    pool.query('select * from "User" order by "id"'),
    pool.query('select * from "Project" order by "id"'),
    pool.query('select * from "Folder" order by "id"'),
    pool.query('select * from "Link" order by "id"'),
    pool.query('select * from "Dashboard" order by "id"'),
  ]);

  return {
    User: users.rows,
    Project: projects.rows,
    Folder: folders.rows,
    Link: links.rows,
    Dashboard: dashboards.rows,
  };
}

function compareSnapshots(prisma6Snapshot, prismaNextSnapshot) {
  const prisma6Summary = summarizeResult(prisma6Snapshot);
  const prismaNextSummary = summarizeResult(prismaNextSnapshot);
  const prisma6TypeShape = typeShape(prisma6Summary);
  const prismaNextTypeShape = typeShape(prismaNextSummary);

  return {
    prisma6Hash: stableHash(prisma6Snapshot),
    prismaNextHash: stableHash(prismaNextSnapshot),
    valueEqual: stableJson(prisma6Snapshot) === stableJson(prismaNextSnapshot),
    typeShapeEqual: stableJson(prisma6TypeShape) === stableJson(prismaNextTypeShape),
    prisma6Summary,
    prismaNextSummary,
    prisma6TypeShape,
    prismaNextTypeShape,
  };
}

function createPrisma6Client(databaseUrl, collector) {
  const pool = new CapturingPool({ connectionString: databaseUrl }, collector);
  const client = new PrismaClient({
    adapter: new PrismaPg(pool),
    log: [{ emit: "event", level: "query" }],
    omit: {
      user: { passwordHash: true },
    },
  });
  client.$on("query", (event) => collector.recordQueryEvent(event));
  return { client, pool };
}

function createPrismaNextClient(databaseUrl, collector) {
  const middleware = {
    name: "dub-runtime-sql-collector",
    familyId: "sql",
    targetId: "postgres",
    beforeExecute(exec) {
      collector.record({
        sql: exec.sql,
        params: exec.params ?? [],
        meta: exec.meta,
      });
    },
  };

  return postgres({
    contractJson,
    url: databaseUrl,
    verify: { mode: "onFirstUse", requireMarker: false },
    middleware: [middleware],
  });
}

const dashboardModule = {
  id: "dashboard-runtime-module",
  description:
    "First module-sized comparison for Dashboard read/write operations used by dashboard routes.",
  operations: [
    {
      id: "dashboard.read.selected-relations",
      kind: "read",
      setup: ({ pool }) => resetDashboardFixture(pool, { includeDashboard: true }),
      prisma6: ({ prisma }) =>
        prisma.dashboard.findUnique({
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
        }),
      prismaNext: ({ db }) =>
        db.orm.Dashboard.where({ id: dashboardIds.existing })
          .select("id", "doIndex", "password", "showConversions")
          .include("link", (link) => link.select("id", "domain", "key", "url"))
          .include("folder", (folder) => folder.select("id", "name"))
          .include("project", (project) => project.select("plan"))
          .first(),
    },
    {
      id: "dashboard.create.link-dashboard",
      kind: "write",
      setup: ({ pool }) => resetDashboardFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.dashboard.create({
          data: {
            id: dashboardIds.create,
            linkId: fixtureValues.linkId,
            projectId: fixtureValues.projectId,
            userId: fixtureValues.userId,
            showConversions: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Dashboard.create({
          id: dashboardIds.create,
          linkId: fixtureValues.linkId,
          projectId: fixtureValues.projectId,
          userId: fixtureValues.userId,
          showConversions: true,
        }),
    },
    {
      id: "dashboard.update.password",
      kind: "write",
      setup: ({ pool }) => resetDashboardFixture(pool, { includeDashboard: true }),
      prisma6: ({ prisma }) =>
        prisma.dashboard.update({
          where: { id: dashboardIds.existing },
          data: { password: "new-password" },
        }),
      prismaNext: ({ db }) =>
        db.orm.Dashboard.where({ id: dashboardIds.existing }).update({
          password: "new-password",
        }),
    },
    {
      id: "dashboard.update.explicit-updated-at",
      kind: "write",
      setup: ({ pool }) => resetDashboardFixture(pool, { includeDashboard: true }),
      prisma6: ({ prisma }) =>
        prisma.dashboard.update({
          where: { id: dashboardIds.existing },
          data: {
            password: "explicit-date-password",
            updatedAt: new Date("2001-02-03T04:05:06.000Z"),
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Dashboard.where({ id: dashboardIds.existing }).update({
          password: "explicit-date-password",
          updatedAt: new Date("2001-02-03T04:05:06.000Z"),
        }),
    },
    {
      id: "dashboard.delete",
      kind: "write",
      setup: ({ pool }) => resetDashboardFixture(pool, { includeDashboard: true }),
      prisma6: ({ prisma }) =>
        prisma.dashboard.delete({
          where: {
            id: dashboardIds.existing,
            projectId: fixtureValues.projectId,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Dashboard.where({
          id: dashboardIds.existing,
          projectId: fixtureValues.projectId,
        }).delete(),
    },
  ],
};

async function capture(label, collector, runOperation) {
  collector.start();
  try {
    const result = await runOperation();
    return {
      ok: true,
      result: summarizeResult(result),
      queries: collector.entries.map(summarizeQuery),
      queryEvents: collector.queryEvents,
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
      },
      queries: collector.entries.map(summarizeQuery),
      queryEvents: collector.queryEvents,
    };
  } finally {
    collector.stop();
  }
}

function compareOperation(prisma6, prismaNext) {
  const prisma6ResultTypeShape = typeShape(prisma6.result);
  const prismaNextResultTypeShape = typeShape(prismaNext.result);

  return {
    prisma6QueryCount: prisma6.queries.length,
    prismaNextQueryCount: prismaNext.queries.length,
    sameQueryCount: prisma6.queries.length === prismaNext.queries.length,
    resultTypeShapeEqual: stableJson(prisma6ResultTypeShape) === stableJson(prismaNextResultTypeShape),
    resultValueSummaryEqual: stableJson(prisma6.result) === stableJson(prismaNext.result),
    prisma6ResultTypeShape,
    prismaNextResultTypeShape,
    sqlEqualByPosition: prisma6.queries.map((query, index) => ({
      index,
      equal:
        query.normalizedSql === prismaNext.queries[index]?.normalizedSql &&
        stableJson(query.params) === stableJson(prismaNext.queries[index]?.params),
    })),
  };
}

async function runModuleComparison(moduleDefinition, prisma6Context, prismaNextContext) {
  const operations = [];

  for (const operation of moduleDefinition.operations) {
    await operation.setup({ pool: prisma6Context.seedPool });
    await operation.setup({ pool: prismaNextContext.seedPool });
    const fixtureBefore = {
      prisma6: await snapshotDashboardFixture(prisma6Context.seedPool),
      prismaNext: await snapshotDashboardFixture(prismaNextContext.seedPool),
    };

    const prisma6 = await capture("prisma6", prisma6Context.collector, () =>
      operation.prisma6({ prisma: prisma6Context.client }),
    );
    const prismaNext = await capture("prismaNext", prismaNextContext.collector, () =>
      operation.prismaNext({ db: prismaNextContext.db }),
    );
    const fixtureAfter = {
      prisma6: await snapshotDashboardFixture(prisma6Context.seedPool),
      prismaNext: await snapshotDashboardFixture(prismaNextContext.seedPool),
    };

    operations.push({
      id: operation.id,
      kind: operation.kind,
      fixtureBefore: compareSnapshots(fixtureBefore.prisma6, fixtureBefore.prismaNext),
      fixtureAfter: compareSnapshots(fixtureAfter.prisma6, fixtureAfter.prismaNext),
      prisma6,
      prismaNext,
      comparison: compareOperation(prisma6, prismaNext),
    });
  }

  return {
    id: moduleDefinition.id,
    description: moduleDefinition.description,
    operations,
  };
}

async function main() {
  const suffix = `${process.pid}_${Date.now()}`;
  const prisma6Db = `dub_runtime_sql_p6_${suffix}`;
  const prismaNextDb = `dub_runtime_sql_pn_${suffix}`;
  const prisma6AdminPool = new Pool({ connectionString: adminDatabaseUrlFor(prisma6RootDatabaseUrl) });
  const prismaNextAdminPool = new Pool({
    connectionString: adminDatabaseUrlFor(prismaNextRootDatabaseUrl),
  });

  let prisma6;
  let prisma6Pool;
  let prisma6SeedPool;
  let prismaNext;
  let prismaNextRuntime;
  let prismaNextSeedPool;

  try {
    await createDatabase(prisma6AdminPool, prisma6Db);
    await createDatabase(prismaNextAdminPool, prismaNextDb);

    const prisma6Url = databaseUrlFor(prisma6RootDatabaseUrl, prisma6Db);
    const prismaNextUrl = databaseUrlFor(prismaNextRootDatabaseUrl, prismaNextDb);
    prisma6SeedPool = new Pool({ connectionString: prisma6Url });
    prismaNextSeedPool = new Pool({ connectionString: prismaNextUrl });

    await createMinimalDashboardSchema(prisma6SeedPool);
    await createMinimalDashboardSchema(prismaNextSeedPool);

    const prisma6Collector = new QueryCollector("prisma6");
    const prisma6Client = createPrisma6Client(prisma6Url, prisma6Collector);
    prisma6 = prisma6Client.client;
    prisma6Pool = prisma6Client.pool;
    await prisma6.$connect();

    const prismaNextCollector = new QueryCollector("prismaNext");
    prismaNext = createPrismaNextClient(prismaNextUrl, prismaNextCollector);
    prismaNextRuntime = await prismaNext.connect();

    const report = {
      generatedAt: new Date().toISOString(),
      isolation: {
        mode:
          prisma6RootDatabaseUrl === prismaNextRootDatabaseUrl
            ? "two-scratch-databases-on-one-postgres-root"
            : "two-scratch-databases-on-separate-postgres-roots",
        prisma6RootDatabaseUrl: describeDatabaseUrl(prisma6RootDatabaseUrl),
        prismaNextRootDatabaseUrl: describeDatabaseUrl(prismaNextRootDatabaseUrl),
        prisma6Database: prisma6Db,
        prismaNextDatabase: prismaNextDb,
      },
      strategy: {
        prisma6:
          "Capture exact SQL and driver parameters at the pg Pool boundary used by @prisma/adapter-pg, plus Prisma Client query events.",
        prismaNext:
          "Capture exact lowered SQL, encoded parameters, and plan metadata in Prisma Next middleware before driver execution.",
        resultShapes:
          "Execute equivalent module operations against isolated scratch databases seeded from the same fixture, then summarize JS result constructors and field shapes.",
        databaseState:
          "Record before/after fixture snapshots for both databases so write operations can be compared without either runtime influencing the other dataset.",
      },
      modules: [
        await runModuleComparison(
          dashboardModule,
          {
            client: prisma6,
            collector: prisma6Collector,
            seedPool: prisma6SeedPool,
          },
          {
            db: prismaNext,
            collector: prismaNextCollector,
            seedPool: prismaNextSeedPool,
          },
        ),
      ],
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${stableJson(report)}\n`);

    for (const moduleReport of report.modules) {
      console.log(`${moduleReport.id}: ${moduleReport.operations.length} operations`);
      for (const operation of moduleReport.operations) {
        const { comparison } = operation;
        console.log(
          `  - ${operation.id}: Prisma 6 queries=${comparison.prisma6QueryCount}, Prisma Next queries=${comparison.prismaNextQueryCount}, resultTypeShapeEqual=${comparison.resultTypeShapeEqual}, fixtureBeforeEqual=${operation.fixtureBefore.valueEqual}, fixtureAfterEqual=${operation.fixtureAfter.valueEqual}`,
        );
        if (!operation.fixtureBefore.valueEqual) {
          console.log(
            `    fixtureBefore differs: Prisma 6=${operation.fixtureBefore.prisma6Hash}, Prisma Next=${operation.fixtureBefore.prismaNextHash}`,
          );
        }
      }
    }
    console.log(`Runtime SQL comparison written to ${outputPath}`);
  } finally {
    await prisma6?.$disconnect().catch(() => undefined);
    await prisma6Pool?.end().catch(() => undefined);
    await prismaNextRuntime?.close().catch(() => undefined);
    await prisma6SeedPool?.end().catch(() => undefined);
    await prismaNextSeedPool?.end().catch(() => undefined);
    await dropDatabase(prisma6AdminPool, prisma6Db).catch(() => undefined);
    await dropDatabase(prismaNextAdminPool, prismaNextDb).catch(() => undefined);
    await prisma6AdminPool.end();
    await prismaNextAdminPool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
