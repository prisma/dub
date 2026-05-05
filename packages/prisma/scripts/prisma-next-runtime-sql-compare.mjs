import postgres from "@prisma-next/postgres/runtime";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import contractJson from "../schema/contract.json" with { type: "json" };

const baseDatabaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/dub";
const prisma6RootDatabaseUrl =
  process.env.PRISMA6_DATABASE_URL ?? baseDatabaseUrl;
const prismaNextRootDatabaseUrl =
  process.env.PRISMA_NEXT_DATABASE_URL ?? baseDatabaseUrl;

const outputPath =
  process.env.PRISMA_NEXT_SQL_COMPARE_OUT ??
  join(process.cwd(), ".tmp", "prisma-next-runtime-sql-comparison.json");

const dashboardIds = {
  existing: "dash_runtime_sql_existing",
  create: "dash_runtime_sql_create",
};

const fixtureValues = {
  domainId: "domain_runtime_sql",
  integrationId: "integration_runtime_sql",
  installedIntegrationId: "installed_integration_runtime_sql",
  linkId: "link_runtime_sql",
  folderId: "fold_runtime_sql",
  customerId: "customer_runtime_sql",
  partnerId: "partner_runtime_sql",
  programEnrollmentId: "program_enrollment_runtime_sql",
  partnerGroupId: "partner_group_runtime_sql",
  programWorkspaceId: "proj_runtime_sql_program",
  programWorkspaceSlug: "runtime-sql-program-workspace",
  programId: "prog_runtime_sql",
  projectId: "proj_runtime_sql",
  projectSlug: "runtime-sql-project",
  restrictedTokenId: "restricted_token_runtime_sql",
  tagId: "tag_runtime_sql",
  tagCreateId: "tag_runtime_sql_create",
  userId: "user_runtime_sql",
  webhookId: "webhook_runtime_sql",
};

const edgeLinkScalarFields = [
  "id",
  "domain",
  "key",
  "url",
  "shortLink",
  "proxy",
  "title",
  "description",
  "image",
  "video",
  "rewrite",
  "password",
  "expiresAt",
  "ios",
  "android",
  "geo",
  "projectId",
  "publicStats",
  "expiredUrl",
  "createdAt",
  "trackConversion",
  "programId",
  "partnerId",
];

const edgeWorkspaceScalarFields = [
  "id",
  "name",
  "slug",
  "logo",
  "defaultProgramId",
  "plan",
  "stripeId",
  "billingCycleStart",
  "totalLinks",
  "totalClicks",
  "usage",
  "usageLimit",
  "linksUsage",
  "createdAt",
];

const selectFields = (fields) =>
  Object.fromEntries(fields.map((field) => [field, true]));

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
  const auth = username
    ? `${username}${url.password ? ":<redacted>" : ""}@`
    : "";
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
      items:
        depth >= 3
          ? []
          : value.slice(0, 5).map((item) => describeValue(item, depth + 1)),
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
            entries.map(([key, fieldValue]) => [
              key,
              describeValue(fieldValue, depth + 1),
            ]),
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
  await pool.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1",
    [name],
  );
  await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
}

async function createRuntimeComparisonSchema(pool) {
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
      "id" text primary key,
      "name" text,
      "image" text,
      "isMachine" boolean not null default false
    )
  `);
  await pool.query(`
    create table "Project" (
      "id" text primary key,
      "name" text,
      "slug" text unique,
      "logo" text,
      "defaultProgramId" text unique,
      "plan" text not null default 'pro',
      "stripeId" text,
      "billingCycleStart" integer not null default 1,
      "totalLinks" integer not null default 0,
      "totalClicks" integer not null default 0,
      "usage" integer not null default 0,
      "usageLimit" integer not null default 1000,
      "linksUsage" integer not null default 0,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null
    )
  `);
  await pool.query(`
    create table "Link" (
      "id" text primary key,
      "domain" text not null,
      "key" text not null,
      "url" text not null,
      "shortLink" varchar(400),
      "archived" boolean not null default false,
      "expiresAt" timestamp(3),
      "expiredUrl" text,
      "disabledAt" timestamp(3),
      "password" text,
      "trackConversion" boolean not null default false,
      "proxy" boolean not null default false,
      "title" text,
      "description" varchar(280),
      "image" text,
      "video" text,
      "rewrite" boolean not null default false,
      "ios" text,
      "android" text,
      "geo" jsonb,
      "folderId" text,
      "projectId" text,
      "userId" text,
      "programId" text,
      "partnerId" text,
      "externalId" text,
      "tenantId" text,
      "publicStats" boolean not null default false,
      "clicks" integer not null default 0,
      "leads" integer not null default 0,
      "conversions" integer not null default 0,
      "sales" integer not null default 0,
      "saleAmount" bigint not null default 0,
      "lastClicked" timestamp(3),
      "lastLeadAt" timestamp(3),
      "lastConversionAt" timestamp(3),
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null,
      "comments" text,
      "partnerGroupDefaultLinkId" text,
      unique ("shortLink"),
      unique ("domain", "key")
    )
  `);
  await pool.query(`
    create table "Folder" (
      "id" text primary key,
      "name" text not null,
      "description" text,
      "projectId" text,
      "type" text not null default 'default',
      "accessLevel" text,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null
    )
  `);
  await pool.query(`
    create table "FolderUser" (
      "id" text primary key,
      "folderId" text not null,
      "userId" text not null,
      "role" text,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null,
      unique ("folderId", "userId")
    )
  `);
  await pool.query(`
    create table "ProjectUsers" (
      "id" text primary key,
      "role" text not null default 'member',
      "userId" text not null,
      "projectId" text not null,
      "workspacePreferences" jsonb,
      "defaultFolderId" text,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null,
      unique ("userId", "projectId")
    )
  `);
  await pool.query(`
    create table "Integration" (
      "id" text primary key,
      "userId" text,
      "projectId" text not null,
      "name" text not null,
      "slug" text unique not null,
      "developer" text not null,
      "website" text not null,
      "verified" boolean not null default false,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null
    )
  `);
  await pool.query(`
    create table "InstalledIntegration" (
      "id" text primary key,
      "userId" text not null,
      "integrationId" text not null,
      "projectId" text not null,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null,
      "credentials" jsonb,
      "settings" jsonb,
      unique ("userId", "integrationId", "projectId")
    )
  `);
  await pool.query(`
    create table "Tag" (
      "id" text primary key,
      "name" text not null,
      "color" text not null default 'blue',
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null,
      "projectId" text not null,
      unique ("name", "projectId")
    )
  `);
  await pool.query(`
    create table "LinkTag" (
      "id" text primary key,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null,
      "linkId" text not null,
      "tagId" text not null,
      unique ("linkId", "tagId")
    )
  `);
  await pool.query(`
    create table "RestrictedToken" (
      "id" text primary key,
      "name" text not null,
      "hashedKey" text unique not null,
      "partialKey" text not null,
      "scopes" text,
      "expires" timestamp(3),
      "lastUsed" timestamp(3),
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null,
      "userId" text not null,
      "projectId" text not null,
      "installationId" text
    )
  `);
  await pool.query(`
    create table "OAuthRefreshToken" (
      "id" text primary key,
      "installationId" text not null,
      "accessTokenId" text not null,
      "hashedRefreshToken" text unique not null,
      "expiresAt" timestamp(3) not null,
      "createdAt" timestamp(3) not null default current_timestamp
    )
  `);
  await pool.query(`
    create table "Webhook" (
      "id" text primary key,
      "projectId" text not null,
      "installationId" text,
      "receiver" text not null default 'user',
      "name" text not null,
      "url" text not null,
      "secret" text not null,
      "triggers" jsonb not null,
      "consecutiveFailures" integer not null default 0,
      "lastFailedAt" timestamp(3),
      "disabledAt" timestamp(3),
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null
    )
  `);
  await pool.query(`
    create table "LinkWebhook" (
      "id" text primary key,
      "linkId" text not null,
      "webhookId" text not null,
      unique ("linkId", "webhookId")
    )
  `);
  await pool.query(`
    create table "Domain" (
      "id" text primary key,
      "slug" text unique not null,
      "verified" boolean not null default false,
      "placeholder" text,
      "expiredUrl" text,
      "notFoundUrl" text,
      "primary" boolean not null default false,
      "archived" boolean not null default false,
      "lastChecked" timestamp(3) not null default current_timestamp,
      "logo" text,
      "appleAppSiteAssociation" jsonb,
      "assetLinks" jsonb,
      "deepviewData" jsonb,
      "linkRetentionDays" integer,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null,
      "projectId" text
    )
  `);
  await pool.query(`
    create table "RegisteredDomain" (
      "id" text primary key,
      "slug" text not null,
      "projectId" text not null,
      "domainId" text unique,
      "autoRenewalDisabledAt" timestamp(3),
      "renewalFee" integer not null default 1200,
      "expiresAt" timestamp(3) not null,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null
    )
  `);
  await pool.query(`
    create table "Program" (
      "id" text primary key,
      "workspaceId" text not null,
      "defaultFolderId" text not null,
      "defaultGroupId" text not null,
      "name" text not null,
      "slug" text unique not null,
      "domain" text unique,
      "url" text,
      "logo" text,
      "description" text,
      "primaryRewardEvent" text not null default 'sale',
      "minPayoutAmount" integer not null default 0,
      "payoutMode" text not null default 'internal',
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null,
      "addedToMarketplaceAt" timestamp(3)
    )
  `);
  await pool.query(`
    create table "Partner" (
      "id" text primary key,
      "name" text not null,
      "username" text unique,
      "companyName" text,
      "profileType" text not null default 'individual',
      "email" text unique,
      "image" text,
      "description" text,
      "country" text,
      "payoutsEnabledAt" timestamp(3),
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null
    )
  `);
  await pool.query(`
    create type "ProgramEnrollmentStatus" as enum (
      'pending',
      'approved',
      'rejected',
      'invited',
      'declined',
      'deactivated',
      'banned',
      'archived'
    )
  `);
  await pool.query(`
    create table "ProgramEnrollment" (
      "id" text primary key,
      "partnerId" text not null,
      "programId" text not null,
      "tenantId" text,
      "groupId" text,
      "status" "ProgramEnrollmentStatus" not null default 'pending',
      "totalClicks" integer not null default 0,
      "totalLeads" integer not null default 0,
      "totalConversions" integer not null default 0,
      "totalSales" integer not null default 0,
      "totalSaleAmount" bigint not null default 0,
      "totalCommissions" bigint not null default 0,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null,
      unique ("partnerId", "programId"),
      unique ("tenantId", "programId")
    )
  `);
  await pool.query(`
    create table "Customer" (
      "id" text primary key,
      "name" text,
      "email" text,
      "avatar" text,
      "externalId" text,
      "stripeCustomerId" text unique,
      "linkId" text,
      "clickId" text,
      "clickedAt" timestamp(3),
      "country" text,
      "sales" integer not null default 0,
      "saleAmount" bigint not null default 0,
      "projectId" text not null,
      "projectConnectId" text,
      "programId" text,
      "partnerId" text,
      "createdAt" timestamp(3) not null default current_timestamp,
      "updatedAt" timestamp(3) not null,
      unique ("projectId", "externalId"),
      unique ("projectConnectId", "externalId")
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

async function resetRuntimeFixture(pool, options = {}) {
  const { includeDashboard = true } = options;
  await pool.query(
    'truncate table "Dashboard", "Customer", "ProgramEnrollment", "Partner", "Program", "RegisteredDomain", "Domain", "LinkWebhook", "Webhook", "OAuthRefreshToken", "RestrictedToken", "LinkTag", "Tag", "InstalledIntegration", "Integration", "FolderUser", "ProjectUsers", "Link", "Folder", "Project", "User"',
  );
  await pool.query(
    'insert into "User" ("id", "name", "image", "isMachine") values ($1, $2, $3, $4)',
    [
      fixtureValues.userId,
      "Runtime SQL User",
      "https://example.com/avatar.png",
      false,
    ],
  );
  await pool.query(
    'insert into "Project" ("id", "name", "slug", "logo", "defaultProgramId", "plan", "stripeId", "billingCycleStart", "totalLinks", "totalClicks", "usage", "usageLimit", "linksUsage", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
    [
      fixtureValues.projectId,
      "Runtime SQL Project",
      fixtureValues.projectSlug,
      "https://example.com/logo.png",
      null,
      "pro",
      "sub_runtime_sql",
      7,
      1,
      10,
      25,
      1000,
      1,
      new Date("2024-01-03T00:00:00.000Z"),
      new Date("2024-01-03T00:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "Project" ("id", "name", "slug", "logo", "defaultProgramId", "plan", "stripeId", "billingCycleStart", "totalLinks", "totalClicks", "usage", "usageLimit", "linksUsage", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
    [
      fixtureValues.programWorkspaceId,
      "Runtime SQL Program Workspace",
      fixtureValues.programWorkspaceSlug,
      null,
      fixtureValues.programId,
      "business",
      null,
      1,
      0,
      3,
      9,
      5000,
      0,
      new Date("2024-01-04T00:00:00.000Z"),
      new Date("2024-01-04T00:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "Program" ("id", "workspaceId", "defaultFolderId", "defaultGroupId", "name", "slug", "domain", "url", "logo", "description", "primaryRewardEvent", "minPayoutAmount", "payoutMode", "createdAt", "updatedAt", "addedToMarketplaceAt") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
    [
      fixtureValues.programId,
      fixtureValues.programWorkspaceId,
      fixtureValues.folderId,
      fixtureValues.partnerGroupId,
      "Runtime SQL Program",
      "runtime-sql-program",
      null,
      "https://example.com/program",
      null,
      "Runtime SQL program",
      "sale",
      1000,
      "internal",
      new Date("2024-01-04T02:00:00.000Z"),
      new Date("2024-01-04T02:00:00.000Z"),
      new Date("2024-01-04T03:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "Partner" ("id", "name", "username", "companyName", "profileType", "email", "image", "description", "country", "payoutsEnabledAt", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
    [
      fixtureValues.partnerId,
      "Runtime SQL Partner",
      "runtime-sql-partner",
      null,
      "individual",
      "partner@example.com",
      "https://example.com/partner.png",
      "Partner used by runtime SQL comparisons",
      "US",
      new Date("2024-01-04T04:00:00.000Z"),
      new Date("2024-01-04T04:00:00.000Z"),
      new Date("2024-01-04T04:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "ProgramEnrollment" ("id", "partnerId", "programId", "tenantId", "groupId", "status", "totalClicks", "totalLeads", "totalConversions", "totalSales", "totalSaleAmount", "totalCommissions", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
    [
      fixtureValues.programEnrollmentId,
      fixtureValues.partnerId,
      fixtureValues.programId,
      "tenant_runtime_sql",
      fixtureValues.partnerGroupId,
      "approved",
      11,
      3,
      2,
      1,
      "5000",
      "1200",
      new Date("2024-01-04T05:00:00.000Z"),
      new Date("2024-01-04T05:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "ProjectUsers" ("id", "role", "userId", "projectId", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6)',
    [
      "project_user_runtime_sql",
      "owner",
      fixtureValues.userId,
      fixtureValues.projectId,
      new Date("2024-01-03T01:00:00.000Z"),
      new Date("2024-01-03T01:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "Folder" ("id", "name", "description", "projectId", "type", "accessLevel", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      fixtureValues.folderId,
      "Runtime SQL Folder",
      "Folder used by runtime SQL comparisons",
      fixtureValues.projectId,
      "default",
      "write",
      new Date("2024-01-05T00:00:00.000Z"),
      new Date("2024-01-05T01:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "FolderUser" ("id", "folderId", "userId", "role", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6)',
    [
      "folder_user_runtime_sql",
      fixtureValues.folderId,
      fixtureValues.userId,
      "owner",
      new Date("2024-01-05T02:00:00.000Z"),
      new Date("2024-01-05T02:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "Link" ("id", "domain", "key", "url", "shortLink", "proxy", "title", "description", "image", "video", "rewrite", "password", "expiresAt", "ios", "android", "geo", "folderId", "projectId", "userId", "programId", "partnerId", "publicStats", "trackConversion", "clicks", "leads", "conversions", "sales", "saleAmount", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)',
    [
      fixtureValues.linkId,
      "dub.sh",
      "runtime-sql",
      "https://example.com/runtime-sql",
      "https://dub.sh/runtime-sql",
      false,
      "Runtime SQL Link",
      "Link used by runtime SQL comparisons",
      "https://example.com/link.png",
      null,
      false,
      null,
      null,
      null,
      null,
      JSON.stringify({ US: "https://example.com/us" }),
      fixtureValues.folderId,
      fixtureValues.projectId,
      fixtureValues.userId,
      fixtureValues.programId,
      fixtureValues.partnerId,
      false,
      true,
      5,
      2,
      1,
      1,
      "5000",
      new Date("2024-01-05T03:00:00.000Z"),
      new Date("2024-01-05T03:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "Customer" ("id", "name", "email", "externalId", "linkId", "country", "sales", "saleAmount", "projectId", "programId", "partnerId", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
    [
      fixtureValues.customerId,
      "Runtime SQL Customer",
      "customer@example.com",
      "external_runtime_sql",
      fixtureValues.linkId,
      "US",
      1,
      "5000",
      fixtureValues.projectId,
      fixtureValues.programId,
      fixtureValues.partnerId,
      new Date("2024-01-11T00:00:00.000Z"),
      new Date("2024-01-11T00:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "Integration" ("id", "userId", "projectId", "name", "slug", "developer", "website", "verified", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [
      fixtureValues.integrationId,
      fixtureValues.userId,
      fixtureValues.projectId,
      "Runtime SQL Integration",
      "runtime-sql-integration",
      "Dub",
      "https://dub.co",
      true,
      new Date("2024-01-06T00:00:00.000Z"),
      new Date("2024-01-06T00:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "InstalledIntegration" ("id", "userId", "integrationId", "projectId", "createdAt", "updatedAt", "credentials", "settings") values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      fixtureValues.installedIntegrationId,
      fixtureValues.userId,
      fixtureValues.integrationId,
      fixtureValues.projectId,
      new Date("2024-01-06T01:00:00.000Z"),
      new Date("2024-01-06T01:00:00.000Z"),
      JSON.stringify({ token: "runtime-sql" }),
      JSON.stringify({ enabled: true }),
    ],
  );
  await pool.query(
    'insert into "Tag" ("id", "name", "color", "createdAt", "updatedAt", "projectId") values ($1, $2, $3, $4, $5, $6)',
    [
      fixtureValues.tagId,
      "Runtime SQL Tag",
      "blue",
      new Date("2024-01-07T00:00:00.000Z"),
      new Date("2024-01-07T00:00:00.000Z"),
      fixtureValues.projectId,
    ],
  );
  await pool.query(
    'insert into "RestrictedToken" ("id", "name", "hashedKey", "partialKey", "scopes", "lastUsed", "createdAt", "updatedAt", "userId", "projectId", "installationId") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
    [
      fixtureValues.restrictedTokenId,
      "Runtime SQL Token",
      "hashed_runtime_sql",
      "dub_1234",
      "links.read domains.read",
      new Date("2024-01-08T00:00:00.000Z"),
      new Date("2024-01-08T00:00:00.000Z"),
      new Date("2024-01-08T00:00:00.000Z"),
      fixtureValues.userId,
      fixtureValues.projectId,
      null,
    ],
  );
  await pool.query(
    'insert into "Webhook" ("id", "projectId", "installationId", "receiver", "name", "url", "secret", "triggers", "disabledAt", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
    [
      fixtureValues.webhookId,
      fixtureValues.projectId,
      null,
      "user",
      "Runtime SQL Webhook",
      "https://example.com/webhook",
      "secret_runtime_sql",
      JSON.stringify(["link.created", "link.updated"]),
      null,
      new Date("2024-01-09T00:00:00.000Z"),
      new Date("2024-01-09T00:00:00.000Z"),
    ],
  );
  await pool.query(
    'insert into "LinkWebhook" ("id", "linkId", "webhookId") values ($1, $2, $3)',
    ["link_webhook_runtime_sql", fixtureValues.linkId, fixtureValues.webhookId],
  );
  await pool.query(
    'insert into "Domain" ("id", "slug", "verified", "placeholder", "expiredUrl", "notFoundUrl", "primary", "archived", "lastChecked", "logo", "appleAppSiteAssociation", "assetLinks", "deepviewData", "linkRetentionDays", "createdAt", "updatedAt", "projectId") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)',
    [
      fixtureValues.domainId,
      "runtime-sql.example.com",
      true,
      "https://example.com",
      null,
      null,
      true,
      false,
      new Date("2024-01-10T00:00:00.000Z"),
      null,
      JSON.stringify({ applinks: { apps: [] } }),
      JSON.stringify([
        { relation: ["delegate_permission/common.handle_all_urls"] },
      ]),
      JSON.stringify({}),
      30,
      new Date("2024-01-10T00:00:00.000Z"),
      new Date("2024-01-10T00:00:00.000Z"),
      fixtureValues.projectId,
    ],
  );
  await pool.query(
    'insert into "RegisteredDomain" ("id", "slug", "projectId", "domainId", "autoRenewalDisabledAt", "renewalFee", "expiresAt", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [
      "registered_domain_runtime_sql",
      "runtime-sql.example.com",
      fixtureValues.projectId,
      fixtureValues.domainId,
      null,
      1200,
      new Date("2025-01-10T00:00:00.000Z"),
      new Date("2024-01-10T00:00:00.000Z"),
      new Date("2024-01-10T00:00:00.000Z"),
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

async function snapshotRuntimeFixture(pool) {
  const [
    users,
    projects,
    projectUsers,
    integrations,
    installedIntegrations,
    tags,
    restrictedTokens,
    webhooks,
    linkWebhooks,
    domains,
    registeredDomains,
    programs,
    partners,
    programEnrollments,
    customers,
    folders,
    folderUsers,
    links,
    dashboards,
  ] = await Promise.all([
    pool.query('select * from "User" order by "id"'),
    pool.query('select * from "Project" order by "id"'),
    pool.query('select * from "ProjectUsers" order by "id"'),
    pool.query('select * from "Integration" order by "id"'),
    pool.query('select * from "InstalledIntegration" order by "id"'),
    pool.query('select * from "Tag" order by "id"'),
    pool.query('select * from "RestrictedToken" order by "id"'),
    pool.query('select * from "Webhook" order by "id"'),
    pool.query('select * from "LinkWebhook" order by "id"'),
    pool.query('select * from "Domain" order by "id"'),
    pool.query('select * from "RegisteredDomain" order by "id"'),
    pool.query('select * from "Program" order by "id"'),
    pool.query('select * from "Partner" order by "id"'),
    pool.query('select * from "ProgramEnrollment" order by "id"'),
    pool.query('select * from "Customer" order by "id"'),
    pool.query('select * from "Folder" order by "id"'),
    pool.query('select * from "FolderUser" order by "id"'),
    pool.query('select * from "Link" order by "id"'),
    pool.query('select * from "Dashboard" order by "id"'),
  ]);

  return {
    User: users.rows,
    Project: projects.rows,
    ProjectUsers: projectUsers.rows,
    Integration: integrations.rows,
    InstalledIntegration: installedIntegrations.rows,
    Tag: tags.rows,
    RestrictedToken: restrictedTokens.rows,
    Webhook: webhooks.rows,
    LinkWebhook: linkWebhooks.rows,
    Domain: domains.rows,
    RegisteredDomain: registeredDomains.rows,
    Program: programs.rows,
    Partner: partners.rows,
    ProgramEnrollment: programEnrollments.rows,
    Customer: customers.rows,
    Folder: folders.rows,
    FolderUser: folderUsers.rows,
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
    typeShapeEqual:
      stableJson(prisma6TypeShape) === stableJson(prismaNextTypeShape),
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
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: true }),
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
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
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
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: true }),
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
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: true }),
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
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: true }),
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

const userModule = {
  id: "user-runtime-module",
  description:
    "Module-sized comparison for user existence lookups, representative of request/auth helper reads.",
  operations: [
    {
      id: "user.read.exists-by-id",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: async ({ prisma }) =>
        Boolean(
          await prisma.user.findUnique({
            where: { id: fixtureValues.userId },
            select: { id: true },
          }),
        ),
      prismaNext: async ({ db }) =>
        Boolean(
          await db.orm.User.where({ id: fixtureValues.userId })
            .select("id")
            .first(),
        ),
    },
    {
      id: "user.read.missing-by-id",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: async ({ prisma }) =>
        Boolean(
          await prisma.user.findUnique({
            where: { id: "missing_runtime_sql_user" },
            select: { id: true },
          }),
        ),
      prismaNext: async ({ db }) =>
        Boolean(
          await db.orm.User.where({ id: "missing_runtime_sql_user" })
            .select("id")
            .first(),
        ),
    },
  ],
};

const linkModule = {
  id: "link-runtime-module",
  description:
    "Module-sized comparison for short-link existence lookups by domain/key compound identity.",
  operations: [
    {
      id: "link.read.exists-by-domain-key",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: async ({ prisma }) =>
        Boolean(
          await prisma.link.findUnique({
            where: {
              domain_key: {
                domain: "dub.sh",
                key: "runtime-sql",
              },
            },
            select: { id: true },
          }),
        ),
      prismaNext: async ({ db }) =>
        Boolean(
          await db.orm.Link.where({
            domain: "dub.sh",
            key: "runtime-sql",
          })
            .select("id")
            .first(),
        ),
    },
    {
      id: "link.read.missing-by-domain-key",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: async ({ prisma }) =>
        Boolean(
          await prisma.link.findUnique({
            where: {
              domain_key: {
                domain: "dub.sh",
                key: "missing-runtime-sql",
              },
            },
            select: { id: true },
          }),
        ),
      prismaNext: async ({ db }) =>
        Boolean(
          await db.orm.Link.where({
            domain: "dub.sh",
            key: "missing-runtime-sql",
          })
            .select("id")
            .first(),
        ),
    },
  ],
};

const edgeLinkModule = {
  id: "edge-link-runtime-module",
  description:
    "Module-sized comparison for edge link reads currently backed by direct Postgres queries.",
  operations: [
    {
      id: "edge-link.read.by-shortlink",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.link.findUnique({
          where: {
            shortLink: "https://dub.sh/runtime-sql",
          },
          select: selectFields(edgeLinkScalarFields),
        }),
      prismaNext: ({ db }) =>
        db.orm.Link.where({
          shortLink: "https://dub.sh/runtime-sql",
        })
          .select(...edgeLinkScalarFields)
          .first(),
    },
    {
      id: "edge-link.read.by-domain-key-with-webhooks",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.link.findUnique({
          where: {
            domain_key: {
              domain: "dub.sh",
              key: "runtime-sql",
            },
          },
          select: {
            ...selectFields(edgeLinkScalarFields),
            webhooks: {
              select: {
                webhookId: true,
              },
              orderBy: {
                webhookId: "asc",
              },
            },
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Link.where({
          domain: "dub.sh",
          key: "runtime-sql",
        })
          .select(...edgeLinkScalarFields)
          .include("webhooks", (webhooks) =>
            webhooks
              .select("webhookId")
              .orderBy((webhook) => webhook.webhookId.asc()),
          )
          .first(),
    },
  ],
};

const analyticsModule = {
  id: "analytics-runtime-module",
  description:
    "Module-sized comparison for the all-time link analytics aggregate shortcut.",
  operations: [
    {
      id: "analytics.read.all-time-clicks-for-link",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: async ({ prisma }) => {
        const result = await prisma.link.aggregate({
          where: {
            id: {
              in: [fixtureValues.linkId],
            },
          },
          _sum: {
            clicks: true,
          },
        });
        return {
          clicks: result._sum.clicks ?? 0,
        };
      },
      prismaNext: ({ db }) =>
        db.orm.Link.where((link) =>
          link.id.in([fixtureValues.linkId]),
        ).aggregate((aggregate) => ({
          clicks: aggregate.sum("clicks"),
        })),
    },
    {
      id: "analytics.read.all-time-composite-for-link",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: async ({ prisma }) => {
        const result = await prisma.link.aggregate({
          where: {
            id: {
              in: [fixtureValues.linkId],
            },
          },
          _sum: {
            clicks: true,
            leads: true,
            sales: true,
            saleAmount: true,
          },
        });
        return {
          clicks: result._sum.clicks ?? 0,
          leads: result._sum.leads ?? 0,
          sales: result._sum.sales ?? 0,
          saleAmount: result._sum.saleAmount ?? 0n,
        };
      },
      prismaNext: ({ db }) =>
        db.orm.Link.where((link) =>
          link.id.in([fixtureValues.linkId]),
        ).aggregate((aggregate) => ({
          clicks: aggregate.sum("clicks"),
          leads: aggregate.sum("leads"),
          sales: aggregate.sum("sales"),
          saleAmount: aggregate.sum("saleAmount"),
        })),
    },
  ],
};

const usageCounterModule = {
  id: "usage-counter-runtime-module",
  description:
    "Module-sized comparison for click/link usage counter updates currently backed by direct Postgres writes.",
  operations: [
    {
      id: "usage.read.workspace-webhook-limit",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.project.findUnique({
          where: {
            id: fixtureValues.projectId,
          },
          select: {
            usage: true,
            usageLimit: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Project.where({
          id: fixtureValues.projectId,
        })
          .select("usage", "usageLimit")
          .first(),
    },
    {
      id: "usage.update.link-click-increment",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.link.update({
          where: {
            id: fixtureValues.linkId,
          },
          data: {
            clicks: {
              increment: 1,
            },
            lastClicked: new Date("2024-02-01T00:00:00.000Z"),
          },
          select: {
            id: true,
            clicks: true,
            lastClicked: true,
            updatedAt: true,
          },
        }),
      prismaNext: async ({ db }) => {
        const link = await db.orm.Link.where({
          id: fixtureValues.linkId,
        })
          .select("clicks")
          .first();
        return db.orm.Link.where({
          id: fixtureValues.linkId,
        })
          .select("id", "clicks", "lastClicked", "updatedAt")
          .update({
            clicks: (link?.clicks ?? 0) + 1,
            lastClicked: new Date("2024-02-01T00:00:00.000Z"),
          });
      },
    },
    {
      id: "usage.update.workspace-clicks-increment",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.project.update({
          where: {
            id: fixtureValues.projectId,
          },
          data: {
            usage: {
              increment: 3,
            },
            totalClicks: {
              increment: 3,
            },
          },
          select: {
            id: true,
            usage: true,
            totalClicks: true,
            updatedAt: true,
          },
        }),
      prismaNext: async ({ db }) => {
        const workspace = await db.orm.Project.where({
          id: fixtureValues.projectId,
        })
          .select("usage", "totalClicks")
          .first();
        return db.orm.Project.where({
          id: fixtureValues.projectId,
        })
          .select("id", "usage", "totalClicks", "updatedAt")
          .update({
            usage: (workspace?.usage ?? 0) + 3,
            totalClicks: (workspace?.totalClicks ?? 0) + 3,
          });
      },
    },
    {
      id: "usage.update.workspace-links-increment",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.project.update({
          where: {
            id: fixtureValues.projectId,
          },
          data: {
            linksUsage: {
              increment: 2,
            },
            totalLinks: {
              increment: 2,
            },
          },
          select: {
            id: true,
            linksUsage: true,
            totalLinks: true,
            updatedAt: true,
          },
        }),
      prismaNext: async ({ db }) => {
        const workspace = await db.orm.Project.where({
          id: fixtureValues.projectId,
        })
          .select("linksUsage", "totalLinks")
          .first();
        return db.orm.Project.where({
          id: fixtureValues.projectId,
        })
          .select("id", "linksUsage", "totalLinks", "updatedAt")
          .update({
            linksUsage: (workspace?.linksUsage ?? 0) + 2,
            totalLinks: (workspace?.totalLinks ?? 0) + 2,
          });
      },
    },
    {
      id: "usage.update.program-enrollment-clicks-increment",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.programEnrollment.update({
          where: {
            partnerId_programId: {
              partnerId: fixtureValues.partnerId,
              programId: fixtureValues.programId,
            },
          },
          data: {
            totalClicks: {
              increment: 1,
            },
          },
          select: {
            id: true,
            totalClicks: true,
            updatedAt: true,
          },
        }),
      prismaNext: async ({ db }) => {
        const enrollment = await db.orm.ProgramEnrollment.where({
          partnerId: fixtureValues.partnerId,
          programId: fixtureValues.programId,
        })
          .select("totalClicks")
          .first();
        return db.orm.ProgramEnrollment.where({
          partnerId: fixtureValues.partnerId,
          programId: fixtureValues.programId,
        })
          .select("id", "totalClicks", "updatedAt")
          .update({
            totalClicks: (enrollment?.totalClicks ?? 0) + 1,
          });
      },
    },
  ],
};

const workspaceProductModule = {
  id: "workspace-product-runtime-module",
  description:
    "Module-sized comparison for resolving workspace product mode from Project.defaultProgramId.",
  operations: [
    {
      id: "workspace-product.read.links-workspace",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: async ({ prisma }) => {
        const workspace = await prisma.project.findUnique({
          where: { slug: fixtureValues.projectSlug },
          select: { defaultProgramId: true },
        });
        return workspace?.defaultProgramId ? "program" : "links";
      },
      prismaNext: async ({ db }) => {
        const workspace = await db.orm.Project.where({
          slug: fixtureValues.projectSlug,
        })
          .select("defaultProgramId")
          .first();
        return workspace?.defaultProgramId ? "program" : "links";
      },
    },
    {
      id: "workspace-product.read.program-workspace",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: async ({ prisma }) => {
        const workspace = await prisma.project.findUnique({
          where: { slug: fixtureValues.programWorkspaceSlug },
          select: { defaultProgramId: true },
        });
        return workspace?.defaultProgramId ? "program" : "links";
      },
      prismaNext: async ({ db }) => {
        const workspace = await db.orm.Project.where({
          slug: fixtureValues.programWorkspaceSlug,
        })
          .select("defaultProgramId")
          .first();
        return workspace?.defaultProgramId ? "program" : "links";
      },
    },
  ],
};

const workspaceModule = {
  id: "workspace-runtime-module",
  description:
    "Module-sized comparison for common workspace fetchers that include membership metadata.",
  operations: [
    {
      id: "workspace.read.default-for-user",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.project.findFirst({
          where: {
            users: {
              some: {
                userId: fixtureValues.userId,
              },
            },
          },
          select: {
            slug: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Project.where((project) =>
          project.users.some({ userId: fixtureValues.userId }),
        )
          .select("slug")
          .first(),
    },
    {
      id: "workspace.read.by-slug-with-user-role",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.project.findUnique({
          where: {
            slug: fixtureValues.projectSlug,
          },
          select: {
            id: true,
            name: true,
            slug: true,
            logo: true,
            usage: true,
            usageLimit: true,
            plan: true,
            stripeId: true,
            billingCycleStart: true,
            createdAt: true,
            users: {
              where: {
                userId: fixtureValues.userId,
              },
              select: {
                role: true,
              },
            },
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Project.where({
          slug: fixtureValues.projectSlug,
        })
          .select(
            "id",
            "name",
            "slug",
            "logo",
            "usage",
            "usageLimit",
            "plan",
            "stripeId",
            "billingCycleStart",
            "createdAt",
          )
          .include("users", (users) =>
            users.where({ userId: fixtureValues.userId }).select("role"),
          )
          .first(),
    },
  ],
};

const edgeWorkspaceModule = {
  id: "edge-workspace-runtime-module",
  description:
    "Module-sized comparison for edge workspace reads currently backed by direct Postgres queries.",
  operations: [
    {
      id: "edge-workspace.read.by-id",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.project.findUnique({
          where: {
            id: fixtureValues.projectId,
          },
          select: selectFields(edgeWorkspaceScalarFields),
        }),
      prismaNext: ({ db }) =>
        db.orm.Project.where({
          id: fixtureValues.projectId,
        })
          .select(...edgeWorkspaceScalarFields)
          .first(),
    },
    {
      id: "edge-workspace.read.by-id-with-domains",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.project.findUnique({
          where: {
            id: fixtureValues.projectId,
          },
          select: {
            ...selectFields(edgeWorkspaceScalarFields),
            domains: {
              select: {
                slug: true,
              },
              orderBy: {
                slug: "asc",
              },
            },
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Project.where({
          id: fixtureValues.projectId,
        })
          .select(...edgeWorkspaceScalarFields)
          .include("domains", (domains) =>
            domains.select("slug").orderBy((domain) => domain.slug.asc()),
          )
          .first(),
    },
  ],
};

const normalizeFolderAccessResult = (folder, workspaceId) => {
  if (!folder || folder.projectId !== workspaceId) {
    return null;
  }

  return {
    id: folder.id,
    name: folder.name,
    description: folder.description,
    type: folder.type,
    accessLevel: folder.accessLevel,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    user: folder.users.length > 0 ? folder.users[0] : null,
  };
};

const folderModule = {
  id: "folder-runtime-module",
  description:
    "Module-sized comparison for folder access lookups with filtered FolderUser includes.",
  operations: [
    {
      id: "folder.read.by-id-with-user",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: async ({ prisma }) => {
        const folder = await prisma.folder.findUnique({
          where: {
            id: fixtureValues.folderId,
          },
          select: {
            id: true,
            name: true,
            description: true,
            type: true,
            accessLevel: true,
            createdAt: true,
            updatedAt: true,
            projectId: true,
            users: {
              where: {
                userId: fixtureValues.userId,
              },
              take: 1,
            },
          },
        });
        return normalizeFolderAccessResult(folder, fixtureValues.projectId);
      },
      prismaNext: async ({ db }) => {
        const folder = await db.orm.Folder.where({
          id: fixtureValues.folderId,
        })
          .select(
            "id",
            "name",
            "description",
            "type",
            "accessLevel",
            "createdAt",
            "updatedAt",
            "projectId",
          )
          .include("users", (users) =>
            users.where({ userId: fixtureValues.userId }).take(1),
          )
          .first();
        return normalizeFolderAccessResult(folder, fixtureValues.projectId);
      },
    },
    {
      id: "folder.read.missing-by-id",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: async ({ prisma }) => {
        const folder = await prisma.folder.findUnique({
          where: {
            id: "missing_runtime_sql_folder",
          },
          select: {
            id: true,
            name: true,
            description: true,
            type: true,
            accessLevel: true,
            createdAt: true,
            updatedAt: true,
            projectId: true,
            users: {
              where: {
                userId: fixtureValues.userId,
              },
              take: 1,
            },
          },
        });
        return normalizeFolderAccessResult(folder, fixtureValues.projectId);
      },
      prismaNext: async ({ db }) => {
        const folder = await db.orm.Folder.where({
          id: "missing_runtime_sql_folder",
        })
          .select(
            "id",
            "name",
            "description",
            "type",
            "accessLevel",
            "createdAt",
            "updatedAt",
            "projectId",
          )
          .include("users", (users) =>
            users.where({ userId: fixtureValues.userId }).take(1),
          )
          .first();
        return normalizeFolderAccessResult(folder, fixtureValues.projectId);
      },
    },
  ],
};

const integrationModule = {
  id: "integration-runtime-module",
  description:
    "Module-sized comparison for verified integrations installed in a workspace.",
  operations: [
    {
      id: "integration.read.verified-installed-for-workspace",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.integration.findMany({
          select: {
            id: true,
            name: true,
            slug: true,
          },
          where: {
            verified: true,
            installations: {
              some: {
                projectId: fixtureValues.projectId,
              },
            },
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Integration.where({ verified: true })
          .where((integration) =>
            integration.installations.some({
              projectId: fixtureValues.projectId,
            }),
          )
          .select("id", "name", "slug")
          .all(),
    },
  ],
};

const tagModule = {
  id: "tag-runtime-module",
  description: "Module-sized comparison for tag list and search reads.",
  operations: [
    {
      id: "tag.read.list-for-workspace",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.tag.findMany({
          where: {
            projectId: fixtureValues.projectId,
          },
          select: {
            id: true,
            name: true,
            color: true,
          },
          orderBy: {
            name: "asc",
          },
          take: 100,
          skip: 0,
        }),
      prismaNext: ({ db }) =>
        db.orm.Tag.where({ projectId: fixtureValues.projectId })
          .select("id", "name", "color")
          .orderBy((tag) => tag.name.asc())
          .take(100)
          .skip(0)
          .all(),
    },
    {
      id: "tag.read.search-for-workspace",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.tag.findMany({
          where: {
            projectId: fixtureValues.projectId,
            name: {
              contains: "Runtime",
            },
          },
          select: {
            id: true,
            name: true,
            color: true,
          },
          orderBy: {
            name: "asc",
          },
          take: 100,
          skip: 0,
        }),
      prismaNext: ({ db }) =>
        db.orm.Tag.where({ projectId: fixtureValues.projectId })
          .where((tag) => tag.name.like("%Runtime%"))
          .select("id", "name", "color")
          .orderBy((tag) => tag.name.asc())
          .take(100)
          .skip(0)
          .all(),
    },
    {
      id: "tag.create.for-workspace",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.tag.create({
          data: {
            id: fixtureValues.tagCreateId,
            name: "Created Runtime SQL Tag",
            color: "red",
            projectId: fixtureValues.projectId,
          },
          select: {
            id: true,
            name: true,
            color: true,
            projectId: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Tag.create({
          id: fixtureValues.tagCreateId,
          name: "Created Runtime SQL Tag",
          color: "red",
          projectId: fixtureValues.projectId,
        }),
    },
    {
      id: "tag.update.name",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.tag.update({
          where: {
            id: fixtureValues.tagId,
          },
          data: {
            name: "Updated Runtime SQL Tag",
          },
          select: {
            id: true,
            name: true,
            color: true,
            projectId: true,
            updatedAt: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Tag.where({ id: fixtureValues.tagId })
          .select("id", "name", "color", "projectId", "updatedAt")
          .update({
            name: "Updated Runtime SQL Tag",
          }),
    },
    {
      id: "tag.delete.by-id",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.tag.delete({
          where: {
            id: fixtureValues.tagId,
          },
          select: {
            id: true,
            name: true,
            color: true,
            projectId: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Tag.where({ id: fixtureValues.tagId })
          .select("id", "name", "color", "projectId")
          .delete(),
    },
  ],
};

const tokenModule = {
  id: "token-runtime-module",
  description:
    "Module-sized comparison for restricted token listing with user includes.",
  operations: [
    {
      id: "token.read.workspace-restricted-tokens",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.restrictedToken.findMany({
          where: {
            projectId: fixtureValues.projectId,
            installationId: null,
          },
          select: {
            id: true,
            name: true,
            partialKey: true,
            scopes: true,
            lastUsed: true,
            createdAt: true,
            updatedAt: true,
            user: {
              select: {
                id: true,
                name: true,
                image: true,
                isMachine: true,
              },
            },
          },
          orderBy: [{ lastUsed: "desc" }, { createdAt: "desc" }],
          take: 100,
        }),
      prismaNext: ({ db }) =>
        db.orm.RestrictedToken.where({
          projectId: fixtureValues.projectId,
          installationId: null,
        })
          .select(
            "id",
            "name",
            "partialKey",
            "scopes",
            "lastUsed",
            "createdAt",
            "updatedAt",
          )
          .include("user", (user) =>
            user.select("id", "name", "image", "isMachine"),
          )
          .orderBy([
            (token) => token.lastUsed.desc(),
            (token) => token.createdAt.desc(),
          ])
          .take(100)
          .all(),
    },
    {
      id: "token.update.name",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.restrictedToken.update({
          where: {
            id: fixtureValues.restrictedTokenId,
          },
          data: {
            name: "Updated Runtime SQL Token",
          },
          select: {
            id: true,
            name: true,
            partialKey: true,
            updatedAt: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.RestrictedToken.where({
          id: fixtureValues.restrictedTokenId,
        })
          .select("id", "name", "partialKey", "updatedAt")
          .update({
            name: "Updated Runtime SQL Token",
          }),
    },
    {
      id: "token.delete.by-id",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.restrictedToken.delete({
          where: {
            id: fixtureValues.restrictedTokenId,
          },
          select: {
            id: true,
            name: true,
            partialKey: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.RestrictedToken.where({
          id: fixtureValues.restrictedTokenId,
        })
          .select("id", "name", "partialKey")
          .delete(),
    },
  ],
};

const webhookModule = {
  id: "webhook-runtime-module",
  description:
    "Module-sized comparison for workspace webhook reads with LinkWebhook includes.",
  operations: [
    {
      id: "webhook.read.enabled-user-webhooks",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.webhook.findMany({
          where: {
            projectId: fixtureValues.projectId,
            disabledAt: null,
            installationId: null,
          },
          select: {
            id: true,
            name: true,
            url: true,
            secret: true,
            triggers: true,
            disabledAt: true,
            links: true,
            receiver: true,
            installationId: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Webhook.where({
          projectId: fixtureValues.projectId,
          disabledAt: null,
          installationId: null,
        })
          .select(
            "id",
            "name",
            "url",
            "secret",
            "triggers",
            "disabledAt",
            "receiver",
            "installationId",
          )
          .include("links")
          .orderBy((webhook) => webhook.createdAt.desc())
          .all(),
    },
    {
      id: "webhook.update.url",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.webhook.update({
          where: {
            id: fixtureValues.webhookId,
          },
          data: {
            url: "https://example.com/updated-webhook",
          },
          select: {
            id: true,
            url: true,
            updatedAt: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Webhook.where({ id: fixtureValues.webhookId })
          .select("id", "url", "updatedAt")
          .update({
            url: "https://example.com/updated-webhook",
          }),
    },
    {
      id: "webhook.delete.by-id",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.webhook.delete({
          where: {
            id: fixtureValues.webhookId,
          },
          select: {
            id: true,
            url: true,
            projectId: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Webhook.where({ id: fixtureValues.webhookId })
          .select("id", "url", "projectId")
          .delete(),
    },
  ],
};

const installedIntegrationModule = {
  id: "installed-integration-runtime-module",
  description:
    "Module-sized comparison for installed integration lookup and deletion.",
  operations: [
    {
      id: "installed-integration.read.by-id-with-integration",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.installedIntegration.findUnique({
          where: {
            id: fixtureValues.installedIntegrationId,
          },
          select: {
            id: true,
            projectId: true,
            userId: true,
            integration: {
              select: {
                id: true,
                slug: true,
                name: true,
              },
            },
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.InstalledIntegration.where({
          id: fixtureValues.installedIntegrationId,
        })
          .select("id", "projectId", "userId")
          .include("integration", (integration) =>
            integration.select("id", "slug", "name"),
          )
          .first(),
    },
    {
      id: "installed-integration.delete.by-id",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.installedIntegration.delete({
          where: {
            id: fixtureValues.installedIntegrationId,
          },
          select: {
            id: true,
            projectId: true,
            integrationId: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.InstalledIntegration.where({
          id: fixtureValues.installedIntegrationId,
        })
          .select("id", "projectId", "integrationId")
          .delete(),
    },
  ],
};

const domainModule = {
  id: "domain-runtime-module",
  description: "Module-sized comparison for workspace domain scalar reads.",
  operations: [
    {
      id: "domain.read.workspace-domain-scalars",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.domain.findMany({
          where: {
            projectId: fixtureValues.projectId,
            archived: false,
          },
          select: {
            id: true,
            slug: true,
            verified: true,
            placeholder: true,
            expiredUrl: true,
            notFoundUrl: true,
            primary: true,
            archived: true,
            lastChecked: true,
            logo: true,
            appleAppSiteAssociation: true,
            assetLinks: true,
            deepviewData: true,
            linkRetentionDays: true,
            createdAt: true,
            updatedAt: true,
            projectId: true,
          },
          take: 100,
          skip: 0,
        }),
      prismaNext: ({ db }) =>
        db.orm.Domain.where({
          projectId: fixtureValues.projectId,
          archived: false,
        })
          .select(
            "id",
            "slug",
            "verified",
            "placeholder",
            "expiredUrl",
            "notFoundUrl",
            "primary",
            "archived",
            "lastChecked",
            "logo",
            "appleAppSiteAssociation",
            "assetLinks",
            "deepviewData",
            "linkRetentionDays",
            "createdAt",
            "updatedAt",
            "projectId",
          )
          .take(100)
          .skip(0)
          .all(),
    },
  ],
};

const programModule = {
  id: "program-runtime-module",
  description: "Module-sized comparison for basic program fetcher reads.",
  operations: [
    {
      id: "program.read.by-slug",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.program.findUnique({
          where: {
            slug: "runtime-sql-program",
          },
          select: {
            id: true,
            workspaceId: true,
            defaultFolderId: true,
            defaultGroupId: true,
            name: true,
            slug: true,
            minPayoutAmount: true,
            payoutMode: true,
            createdAt: true,
            addedToMarketplaceAt: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Program.where({ slug: "runtime-sql-program" })
          .select(
            "id",
            "workspaceId",
            "defaultFolderId",
            "defaultGroupId",
            "name",
            "slug",
            "minPayoutAmount",
            "payoutMode",
            "createdAt",
            "addedToMarketplaceAt",
          )
          .first(),
    },
    {
      id: "program.read.marketplace-by-slug",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.program.findUnique({
          where: {
            slug: "runtime-sql-program",
            addedToMarketplaceAt: {
              not: null,
            },
          },
          select: {
            id: true,
            slug: true,
            addedToMarketplaceAt: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Program.where({ slug: "runtime-sql-program" })
          .where((program) => program.addedToMarketplaceAt.isNotNull())
          .select("id", "slug", "addedToMarketplaceAt")
          .first(),
    },
  ],
};

const partnerModule = {
  id: "partner-runtime-module",
  description: "Module-sized comparison for partner profile reads.",
  operations: [
    {
      id: "partner.read.by-id",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.partner.findUnique({
          where: {
            id: fixtureValues.partnerId,
          },
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            country: true,
            payoutsEnabledAt: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Partner.where({ id: fixtureValues.partnerId })
          .select("id", "name", "email", "image", "country", "payoutsEnabledAt")
          .first(),
    },
    {
      id: "partner.update.name",
      kind: "write",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.partner.update({
          where: {
            id: fixtureValues.partnerId,
          },
          data: {
            name: "Updated Runtime SQL Partner",
          },
          select: {
            id: true,
            name: true,
            email: true,
            updatedAt: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Partner.where({
          id: fixtureValues.partnerId,
        })
          .select("id", "name", "email", "updatedAt")
          .update({
            name: "Updated Runtime SQL Partner",
          }),
    },
  ],
};

const programEnrollmentModule = {
  id: "program-enrollment-runtime-module",
  description:
    "Module-sized comparison for program enrollment compound-key reads.",
  operations: [
    {
      id: "program-enrollment.read.by-partner-program",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.programEnrollment.findUnique({
          where: {
            partnerId_programId: {
              partnerId: fixtureValues.partnerId,
              programId: fixtureValues.programId,
            },
          },
          select: {
            id: true,
            partnerId: true,
            programId: true,
            tenantId: true,
            groupId: true,
            status: true,
            totalClicks: true,
            totalCommissions: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.ProgramEnrollment.where({
          partnerId: fixtureValues.partnerId,
          programId: fixtureValues.programId,
        })
          .select(
            "id",
            "partnerId",
            "programId",
            "tenantId",
            "groupId",
            "status",
            "totalClicks",
            "totalCommissions",
          )
          .first(),
    },
    {
      id: "program-enrollment.read.approved-with-partner",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.programEnrollment.findMany({
          where: {
            programId: fixtureValues.programId,
            status: "approved",
          },
          select: {
            id: true,
            partnerId: true,
            programId: true,
            status: true,
            partner: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.ProgramEnrollment.where({
          programId: fixtureValues.programId,
          status: "approved",
        })
          .select("id", "partnerId", "programId", "status")
          .include("partner", (partner) =>
            partner.select("id", "name", "email", "image"),
          )
          .all(),
    },
  ],
};

const customerModule = {
  id: "customer-runtime-module",
  description: "Module-sized comparison for customer cursor and list reads.",
  operations: [
    {
      id: "customer.read.cursor-validation",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.customer.findUnique({
          where: {
            id: fixtureValues.customerId,
          },
          select: {
            id: true,
            projectId: true,
          },
        }),
      prismaNext: ({ db }) =>
        db.orm.Customer.where({ id: fixtureValues.customerId })
          .select("id", "projectId")
          .first(),
    },
    {
      id: "customer.read.list-for-workspace-program-partner",
      kind: "read",
      setup: ({ pool }) =>
        resetRuntimeFixture(pool, { includeDashboard: false }),
      prisma6: ({ prisma }) =>
        prisma.customer.findMany({
          where: {
            projectId: fixtureValues.projectId,
            programId: fixtureValues.programId,
            partnerId: fixtureValues.partnerId,
          },
          select: {
            id: true,
            name: true,
            email: true,
            externalId: true,
            country: true,
            projectId: true,
            programId: true,
            partnerId: true,
            createdAt: true,
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 100,
        }),
      prismaNext: ({ db }) =>
        db.orm.Customer.where({
          projectId: fixtureValues.projectId,
          programId: fixtureValues.programId,
          partnerId: fixtureValues.partnerId,
        })
          .select(
            "id",
            "name",
            "email",
            "externalId",
            "country",
            "projectId",
            "programId",
            "partnerId",
            "createdAt",
          )
          .orderBy((customer) => customer.createdAt.desc())
          .take(100)
          .all(),
    },
  ],
};

const runtimeModules = [
  dashboardModule,
  userModule,
  linkModule,
  edgeLinkModule,
  analyticsModule,
  usageCounterModule,
  workspaceProductModule,
  workspaceModule,
  edgeWorkspaceModule,
  folderModule,
  integrationModule,
  tagModule,
  tokenModule,
  webhookModule,
  installedIntegrationModule,
  domainModule,
  programModule,
  partnerModule,
  programEnrollmentModule,
  customerModule,
];

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
    resultTypeShapeEqual:
      stableJson(prisma6ResultTypeShape) ===
      stableJson(prismaNextResultTypeShape),
    resultValueSummaryEqual:
      stableJson(prisma6.result) === stableJson(prismaNext.result),
    prisma6ResultTypeShape,
    prismaNextResultTypeShape,
    sqlEqualByPosition: prisma6.queries.map((query, index) => ({
      index,
      equal:
        query.normalizedSql === prismaNext.queries[index]?.normalizedSql &&
        stableJson(query.params) ===
          stableJson(prismaNext.queries[index]?.params),
    })),
  };
}

async function runModuleComparison(
  moduleDefinition,
  prisma6Context,
  prismaNextContext,
) {
  const operations = [];

  for (const operation of moduleDefinition.operations) {
    await operation.setup({ pool: prisma6Context.seedPool });
    await operation.setup({ pool: prismaNextContext.seedPool });
    const fixtureBefore = {
      prisma6: await snapshotRuntimeFixture(prisma6Context.seedPool),
      prismaNext: await snapshotRuntimeFixture(prismaNextContext.seedPool),
    };

    const prisma6 = await capture("prisma6", prisma6Context.collector, () =>
      operation.prisma6({ prisma: prisma6Context.client }),
    );
    const prismaNext = await capture(
      "prismaNext",
      prismaNextContext.collector,
      () => operation.prismaNext({ db: prismaNextContext.db }),
    );
    const fixtureAfter = {
      prisma6: await snapshotRuntimeFixture(prisma6Context.seedPool),
      prismaNext: await snapshotRuntimeFixture(prismaNextContext.seedPool),
    };

    operations.push({
      id: operation.id,
      kind: operation.kind,
      fixtureBefore: compareSnapshots(
        fixtureBefore.prisma6,
        fixtureBefore.prismaNext,
      ),
      fixtureAfter: compareSnapshots(
        fixtureAfter.prisma6,
        fixtureAfter.prismaNext,
      ),
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
  const prisma6AdminPool = new Pool({
    connectionString: adminDatabaseUrlFor(prisma6RootDatabaseUrl),
  });
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
    const prismaNextUrl = databaseUrlFor(
      prismaNextRootDatabaseUrl,
      prismaNextDb,
    );
    prisma6SeedPool = new Pool({ connectionString: prisma6Url });
    prismaNextSeedPool = new Pool({ connectionString: prismaNextUrl });

    await createRuntimeComparisonSchema(prisma6SeedPool);
    await createRuntimeComparisonSchema(prismaNextSeedPool);

    const prisma6Collector = new QueryCollector("prisma6");
    const prisma6Client = createPrisma6Client(prisma6Url, prisma6Collector);
    prisma6 = prisma6Client.client;
    prisma6Pool = prisma6Client.pool;
    await prisma6.$connect();

    const prismaNextCollector = new QueryCollector("prismaNext");
    prismaNext = createPrismaNextClient(prismaNextUrl, prismaNextCollector);
    prismaNextRuntime = await prismaNext.connect();

    const moduleReports = [];
    for (const moduleDefinition of runtimeModules) {
      moduleReports.push(
        await runModuleComparison(
          moduleDefinition,
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
      );
    }

    const report = {
      generatedAt: new Date().toISOString(),
      isolation: {
        mode:
          prisma6RootDatabaseUrl === prismaNextRootDatabaseUrl
            ? "two-scratch-databases-on-one-postgres-root"
            : "two-scratch-databases-on-separate-postgres-roots",
        prisma6RootDatabaseUrl: describeDatabaseUrl(prisma6RootDatabaseUrl),
        prismaNextRootDatabaseUrl: describeDatabaseUrl(
          prismaNextRootDatabaseUrl,
        ),
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
      modules: moduleReports,
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${stableJson(report)}\n`);

    for (const moduleReport of report.modules) {
      console.log(
        `${moduleReport.id}: ${moduleReport.operations.length} operations`,
      );
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
    await dropDatabase(prismaNextAdminPool, prismaNextDb).catch(
      () => undefined,
    );
    await prisma6AdminPool.end();
    await prismaNextAdminPool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
