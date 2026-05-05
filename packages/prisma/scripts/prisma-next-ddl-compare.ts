import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/dub";

type Snapshot = {
  readonly items: Set<string>;
  readonly indexes: Map<string, string>;
  readonly foreignKeys: Set<string>;
};

const syntheticIdTables = new Set([
  "EmailVerificationToken",
  "PartnerIndustryInterest",
  "PartnerInvite",
  "PartnerPreferredEarningStructure",
  "PartnerSalesChannel",
  "PasswordResetToken",
  "ProgramCategory",
  "ProjectInvite",
  "VerificationToken",
]);

const quoteIdent = (value: string) => `"${value.replace(/"/g, '""')}"`;

const databaseUrlFor = (databaseName: string) => {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const adminDatabaseUrl = () => {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
};

const normalize = (value: unknown) =>
  String(value ?? "")
    .replace(/public\\./g, "")
    .replace(/::[a-zA-Z_][a-zA-Z0-9_]*(\\[\\])?/g, "")
    .replace(/\bCURRENT_TIMESTAMP\b/gi, "now()")
    .replace(/timestamp\(3\) without time zone/gi, "timestamp without time zone")
    .replace(/timestamp\(0\) without time zone/gi, "timestamp without time zone")
    .replace(/character\(24\)/gi, "text")
    .replace(/\\s+/g, " ")
    .trim();

const pgArray = (value: unknown) =>
  Array.isArray(value)
    ? value.map(String)
    : String(value ?? "")
        .replace(/^\{|\}$/g, "")
        .split(",")
        .filter(Boolean);

const stripIndexSort = (value: string) =>
  value
    .replace(/\\s+(ASC|DESC)(?=[,\\)])/gi, "")
    .replace(/\\s+NULLS\\s+(FIRST|LAST)(?=[,\\)])/gi, "");

const relationAction = (code: string) => {
  switch (code) {
    case "a":
      return "NoAction";
    case "r":
      return "Restrict";
    case "c":
      return "Cascade";
    case "n":
      return "SetNull";
    case "d":
      return "SetDefault";
    default:
      return code;
  }
};

const run = (
  args: string[],
  databaseUrl: string,
  options: { allowDbInitVerificationFailure?: boolean } = {},
) => {
  const result = spawnSync("pnpm", args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    if (
      options.allowDbInitVerificationFailure &&
      result.stdout.includes('"code": "PN-RUN-3020"') &&
      result.stdout.includes("Database schema does not satisfy contract")
    ) {
      console.warn("Prisma Next db init applied DDL but failed self-verification; continuing to snapshot.");
      return;
    }

    throw new Error(
      [
        `Command failed: pnpm ${args.join(" ")}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\\n"),
    );
  }
};

async function applyPrismaNextDryRunPlan(databaseUrl: string) {
  const stdoutPath = join(tmpdir(), `dub-prisma-next-plan-${process.pid}-${Date.now()}.json`);
  const stdoutFd = openSync(stdoutPath, "w");
  const prismaNextBin = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "prisma-next.cmd" : "prisma-next",
  );
  const result = spawnSync(
    prismaNextBin,
    [
      "db",
      "init",
      "--config",
      "./prisma-next.config.ts",
      "--db",
      databaseUrl,
      "--dry-run",
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
      stdio: ["ignore", stdoutFd, "pipe"],
      encoding: "utf8",
    },
  );
  closeSync(stdoutFd);
  const stdout = readFileSync(stdoutPath, "utf8");
  unlinkSync(stdoutPath);

  if (result.status !== 0) {
    throw new Error(
      [
        "Command failed: prisma-next db init --dry-run --json",
        stdout.trim(),
        String(result.stderr).trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(`Prisma Next dry-run did not return JSON:\n${stdout}`);
  }

  const output = JSON.parse(stdout.slice(jsonStart)) as {
    plan?: {
      preview?: {
        statements?: Array<{ language: string; text: string }>;
      };
    };
  };
  const statements =
    output.plan?.preview?.statements?.filter((statement) => statement.language === "sql") ?? [];

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    for (const statement of statements) {
      try {
        await pool.query(statement.text);
      } catch (error) {
        throw new Error(`Failed to apply Prisma Next DDL statement:\n${statement.text}`, {
          cause: error,
        });
      }
    }
  } finally {
    await pool.end();
  }
}

async function createDatabase(pool: Pool, name: string) {
  await pool.query(`CREATE DATABASE ${quoteIdent(name)}`);
}

async function dropDatabase(pool: Pool, name: string) {
  await pool.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [
    name,
  ]);
  await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
}

async function snapshot(databaseUrl: string): Promise<Snapshot> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const items = new Set<string>();

    const enums = await pool.query<{
      name: string;
      values: string[];
    }>(`
      select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as values
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
      group by t.typname
      order by t.typname
    `);
    for (const row of enums.rows) {
      items.add(`enum:${row.name}:${pgArray(row.values).join(",")}`);
    }

    const tables = await pool.query<{ table_name: string }>(`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `);
    for (const row of tables.rows) {
      items.add(`table:${row.table_name}`);
    }

    const columns = await pool.query<{
      table_name: string;
      column_name: string;
      formatted_type: string;
      not_null: boolean;
      default_value: string | null;
    }>(`
      select
        c.relname as table_name,
        a.attname as column_name,
        format_type(a.atttypid, a.atttypmod) as formatted_type,
        a.attnotnull as not_null,
        pg_get_expr(d.adbin, d.adrelid) as default_value
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = 'public'
        and c.relkind = 'r'
        and a.attnum > 0
        and not a.attisdropped
      order by c.relname, a.attnum
    `);
    for (const row of columns.rows) {
      items.add(
        [
          "column",
          row.table_name,
          row.column_name,
          normalize(row.formatted_type),
          row.not_null ? "notNull" : "nullable",
          `default=${normalize(row.default_value)}`,
        ].join(":"),
      );
    }

    const constraints = await pool.query<{
      table_name: string;
      type: "p" | "u";
      columns: string[];
    }>(`
      select
        c.relname as table_name,
        con.contype as type,
        array_agg(a.attname order by ord.ordinality) as columns
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join unnest(con.conkey) with ordinality as ord(attnum, ordinality) on true
      join pg_attribute a on a.attrelid = c.oid and a.attnum = ord.attnum
      where n.nspname = 'public' and con.contype in ('p', 'u')
      group by c.relname, con.contype, con.conname
      order by c.relname, con.contype, array_agg(a.attname order by ord.ordinality)::text
    `);
    for (const row of constraints.rows) {
      items.add(
        `${row.type === "p" ? "primary" : "unique"}:${row.table_name}(${pgArray(row.columns).join(",")})`,
      );
    }

    const indexes = new Map<string, string>();
    const indexRows = await pool.query<{
      table_name: string;
      index_name: string;
      index_def: string;
      is_unique: boolean;
      columns: string[];
    }>(`
      select
        table_cls.relname as table_name,
        index_cls.relname as index_name,
        pg_get_indexdef(index_cls.oid) as index_def,
        idx.indisunique as is_unique,
        array_agg(attr.attname order by ord.ordinality) as columns
      from pg_index idx
      join pg_class index_cls on index_cls.oid = idx.indexrelid
      join pg_class table_cls on table_cls.oid = idx.indrelid
      join pg_namespace n on n.oid = table_cls.relnamespace
      join unnest(idx.indkey) with ordinality as ord(attnum, ordinality) on ord.attnum > 0
      join pg_attribute attr on attr.attrelid = table_cls.oid and attr.attnum = ord.attnum
      left join pg_constraint con on con.conindid = index_cls.oid
      where n.nspname = 'public'
        and not idx.indisprimary
        and con.oid is null
      group by table_cls.relname, index_cls.relname, index_cls.oid, idx.indisunique
      order by table_cls.relname, index_cls.relname
    `);
    for (const row of indexRows.rows) {
      const columns = pgArray(row.columns);
      if (row.is_unique) {
        items.add(`unique:${row.table_name}(${columns.join(",")})`);
        continue;
      }

      const key = `${row.table_name}:${row.index_name}`;
      const value = columns.join(",");
      indexes.set(key, value);
      items.add(`index:${key}:${value}`);
    }

    const foreignKeys = new Set<string>();
    const fkRows = await pool.query<{
      table_name: string;
      columns: string[];
      foreign_table_name: string;
      foreign_columns: string[];
      on_delete: string;
      on_update: string;
    }>(`
      select
        src.relname as table_name,
        array_agg(src_attr.attname order by src_ord.ordinality) as columns,
        dst.relname as foreign_table_name,
        array_agg(dst_attr.attname order by dst_ord.ordinality) as foreign_columns,
        con.confdeltype as on_delete,
        con.confupdtype as on_update
      from pg_constraint con
      join pg_class src on src.oid = con.conrelid
      join pg_namespace n on n.oid = src.relnamespace
      join pg_class dst on dst.oid = con.confrelid
      join unnest(con.conkey) with ordinality as src_ord(attnum, ordinality) on true
      join unnest(con.confkey) with ordinality as dst_ord(attnum, ordinality)
        on dst_ord.ordinality = src_ord.ordinality
      join pg_attribute src_attr on src_attr.attrelid = src.oid and src_attr.attnum = src_ord.attnum
      join pg_attribute dst_attr on dst_attr.attrelid = dst.oid and dst_attr.attnum = dst_ord.attnum
      where n.nspname = 'public' and con.contype = 'f'
      group by src.relname, dst.relname, con.conname, con.confdeltype, con.confupdtype
      order by src.relname, con.conname
    `);
    for (const row of fkRows.rows) {
      const columns = pgArray(row.columns);
      const foreignColumns = pgArray(row.foreign_columns);
      foreignKeys.add(
        `foreignKey:${row.table_name}(${columns.join(",")})->${row.foreign_table_name}(${foreignColumns.join(",")}):onDelete=${relationAction(row.on_delete)}:onUpdate=${relationAction(row.on_update)}`,
      );
    }

    return { items, indexes, foreignKeys };
  } finally {
    await pool.end();
  }
}

const without = (left: Set<string>, right: Set<string>) =>
  [...left].filter((item) => !right.has(item)).sort();

function classifyIndexSortDiffs(prisma6Only: string[], nextOnly: string[]) {
  const expected: string[] = [];
  const consumedNext = new Set<number>();
  const remainingPrisma6: string[] = [];
  const parseIndex = (item: string) => {
    const match = item.match(/^index:([^:]+):([^:]+):(.+)$/);
    if (!match) {
      return null;
    }
    return {
      table: match[1]!,
      name: match[2]!,
      columns: match[3]!.split(",").filter(Boolean),
    };
  };

  for (const item of prisma6Only) {
    if (!item.startsWith("index:")) {
      remainingPrisma6.push(item);
      continue;
    }

    const stripped = stripIndexSort(item);
    const parsed = parseIndex(item);
    const nextIndex = nextOnly.findIndex(
      (candidate, index) => {
        if (consumedNext.has(index) || !candidate.startsWith("index:")) {
          return false;
        }
        if (stripIndexSort(candidate) === stripped) {
          return true;
        }
        const candidateParsed = parseIndex(candidate);
        return (
          parsed !== null &&
          candidateParsed !== null &&
          candidateParsed.table === parsed.table &&
          candidateParsed.name === parsed.name &&
          candidateParsed.columns.slice().sort().join(",") ===
            parsed.columns.slice().sort().join(",")
        );
      },
    );

    if (nextIndex === -1) {
      remainingPrisma6.push(item);
      continue;
    }

    consumedNext.add(nextIndex);
    expected.push(`index sort/order not preserved: ${item}`);
  }

  const remainingNext = nextOnly.filter((_, index) => !consumedNext.has(index));
  return { expected, remainingPrisma6, remainingNext };
}

function classifySyntheticIdDiffs(nextOnly: string[]) {
  const expected: string[] = [];
  const remainingNext: string[] = [];

  for (const item of nextOnly) {
    const columnMatch = item.match(/^column:([^:]+):id:/);
    const primaryMatch = item.match(/^primary:([^(]+)\(id\)$/);
    const table = columnMatch?.[1] ?? primaryMatch?.[1];

    if (table && syntheticIdTables.has(table)) {
      expected.push(`Prisma Next synthetic id for no-id Prisma 6 table: ${item}`);
      continue;
    }

    remainingNext.push(item);
  }

  return { expected, remainingNext };
}

function classifyForeignKeyIndexDiffs(nextOnly: string[], foreignKeys: Set<string>) {
  const expected: string[] = [];
  const remainingNext: string[] = [];
  const foreignKeyColumnKeys = new Set<string>();

  for (const foreignKey of foreignKeys) {
    const match = foreignKey.match(/^foreignKey:([^(]+)\(([^)]*)\)->/);
    if (match) {
      foreignKeyColumnKeys.add(`${match[1]}:${match[2]}`);
    }
  }

  for (const item of nextOnly) {
    const match = item.match(/^index:([^:]+):[^:]+:(.+)$/);
    if (match && foreignKeyColumnKeys.has(`${match[1]}:${match[2]}`)) {
      expected.push(
        `Prisma Next FK-derived index expected while Prisma 6 uses relationMode=prisma: ${item}`,
      );
      continue;
    }

    remainingNext.push(item);
  }

  return { expected, remainingNext };
}

async function main() {
  const suffix = `${process.pid}_${Date.now()}`;
  const prisma6Db = `dub_prisma6_${suffix}`;
  const nextDb = `dub_next_${suffix}`;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl() });

  try {
    await createDatabase(adminPool, prisma6Db);
    await createDatabase(adminPool, nextDb);

    const prisma6Url = databaseUrlFor(prisma6Db);
    const nextUrl = databaseUrlFor(nextDb);

    run(["exec", "tsx", "./scripts/prisma6-cli.ts", "db", "push", "--skip-generate"], prisma6Url);
    await applyPrismaNextDryRunPlan(nextUrl);

    const prisma6 = await snapshot(prisma6Url);
    const next = await snapshot(nextUrl);

    const prisma6Only = without(prisma6.items, next.items);
    const nextOnly = without(next.items, prisma6.items);
    const indexDiffs = classifyIndexSortDiffs(prisma6Only, nextOnly);
    const syntheticIdDiffs = classifySyntheticIdDiffs(indexDiffs.remainingNext);
    const foreignKeyIndexDiffs = classifyForeignKeyIndexDiffs(
      syntheticIdDiffs.remainingNext,
      next.foreignKeys,
    );

    const expected = [
      ...indexDiffs.expected,
      ...syntheticIdDiffs.expected,
      ...foreignKeyIndexDiffs.expected,
      ...without(next.foreignKeys, prisma6.foreignKeys).map(
        (fk) => `Prisma Next FK DDL expected while Prisma 6 uses relationMode=prisma: ${fk}`,
      ),
    ].sort();
    const unexpected = [
      ...indexDiffs.remainingPrisma6.map((item) => `Only in Prisma 6: ${item}`),
      ...foreignKeyIndexDiffs.remainingNext.map((item) => `Only in Prisma Next: ${item}`),
      ...without(prisma6.foreignKeys, next.foreignKeys).map(
        (fk) => `Only in Prisma 6 foreign keys: ${fk}`,
      ),
    ].sort();

    console.log(`Expected DDL differences: ${expected.length}`);
    for (const diff of expected) {
      console.log(`  - ${diff}`);
    }

    if (unexpected.length > 0) {
      console.error(`Unexpected DDL differences: ${unexpected.length}`);
      for (const diff of unexpected.slice(0, 200)) {
        console.error(`  - ${diff}`);
      }
      if (unexpected.length > 200) {
        console.error(`  ... ${unexpected.length - 200} more`);
      }
      process.exitCode = 1;
      return;
    }

    console.log("No unexpected Prisma Next DDL differences.");
  } finally {
    await dropDatabase(adminPool, prisma6Db).catch(() => undefined);
    await dropDatabase(adminPool, nextDb).catch(() => undefined);
    await adminPool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
