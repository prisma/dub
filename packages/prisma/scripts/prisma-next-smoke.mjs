import { Pool } from "pg";
import { prismaNext } from "../next.mjs";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/dub";

const quoteIdent = (value) => `"${value.replace(/"/g, '""')}"`;

const databaseUrlFor = (databaseName) => {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const adminDatabaseUrl = () => {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
};

async function createDatabase(pool, name) {
  await pool.query(`CREATE DATABASE ${quoteIdent(name)}`);
}

async function dropDatabase(pool, name) {
  await pool.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [
    name,
  ]);
  await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
}

async function prepareSmokeSchema(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query("create schema if not exists prisma_contract");
    await pool.query(`
      create table if not exists prisma_contract.marker (
        space text not null primary key default 'app',
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
        "id" char(24) primary key
      )
    `);
    await pool.query(`
      create table "Dashboard" (
        "id" char(24) primary key,
        "password" text,
        "doIndex" boolean not null default false,
        "showConversions" boolean not null default false,
        "createdAt" timestamptz not null default now(),
        "updatedAt" timestamptz not null
      )
    `);
  } finally {
    await pool.end();
  }
}

const asDate = (value) => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Expected a timestamp, got ${String(value)}`);
  }
  return date;
};

const getRoot = (roots, name) => {
  const root = roots[name] ?? roots[name[0].toLowerCase() + name.slice(1)];
  if (!root) {
    throw new Error(`Prisma Next SQL root not found for ${name}`);
  }
  return root;
};

async function main() {
  const databaseName = `dub_next_smoke_${process.pid}_${Date.now()}`;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl() });
  const databaseUrl = databaseUrlFor(databaseName);
  let runtime;
  const marker = `prisma-next-smoke-${Date.now()}`;
  let dashboardId;

  try {
    await createDatabase(adminPool, databaseName);
    await prepareSmokeSchema(databaseUrl);

    runtime = await prismaNext.connect({ url: databaseUrl });
    const user = getRoot(prismaNext.sql, "User");
    const dashboard = getRoot(prismaNext.sql, "Dashboard");

    await runtime.execute(user.select("id").limit(1).build());

    const createdRows = await runtime.execute(
      dashboard
        .insert({ password: marker })
        .returning("id", "password", "createdAt", "updatedAt")
        .build(),
    );
    const created = createdRows[0];
    if (!created) {
      throw new Error("Dashboard create did not return a row");
    }
    dashboardId = created.id;

    const createdAt = asDate(created.createdAt);
    const createdUpdatedAt = asDate(created.updatedAt);
    if (createdUpdatedAt.getTime() < createdAt.getTime() - 5_000) {
      throw new Error("@updatedAt create default was not populated as expected");
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    const updatedRows = await runtime.execute(
      dashboard
        .update({ password: `${marker}:updated` })
        .where((fields, fns) => fns.eq(fields.id, dashboardId))
        .returning("id", "password", "updatedAt")
        .build(),
    );
    const updated = updatedRows[0];
    if (!updated) {
      throw new Error("Dashboard update did not return a row");
    }
    const updatedAt = asDate(updated.updatedAt);
    if (updatedAt.getTime() < createdUpdatedAt.getTime()) {
      throw new Error("@updatedAt update default did not advance");
    }

    const explicitUpdatedAt = new Date("2001-02-03T04:05:06.000Z");
    const explicitRows = await runtime.execute(
      dashboard
        .update({
          password: `${marker}:explicit`,
          updatedAt: explicitUpdatedAt,
        })
        .where((fields, fns) => fns.eq(fields.id, dashboardId))
        .returning("id", "password", "updatedAt")
        .build(),
    );
    const explicit = explicitRows[0];
    if (!explicit) {
      throw new Error("Dashboard explicit updatedAt update did not return a row");
    }
    if (asDate(explicit.updatedAt).getTime() !== explicitUpdatedAt.getTime()) {
      throw new Error("Explicit updatedAt value was overwritten");
    }

    console.log("Prisma Next smoke passed.");
  } finally {
    if (dashboardId && runtime) {
      const dashboard = getRoot(prismaNext.sql, "Dashboard");
      try {
        await runtime.execute(
          dashboard
            .delete()
            .where((fields, fns) => fns.eq(fields.id, dashboardId))
            .build(),
        );
      } catch {
        // The scratch database is dropped below; cleanup here is best-effort.
      }
    }
    await runtime?.close();
    await dropDatabase(adminPool, databaseName).catch(() => undefined);
    await adminPool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
