import { readFileSync } from "fs";
import { join } from "path";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run PostgreSQL postdeploy SQL.");
}

const sql = readFileSync(
  join(process.cwd(), "postgres-postdeploy.sql"),
  "utf8",
);

const statements = sql
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

async function main() {
  const client = new Client({
    connectionString: databaseUrl,
    ssl:
      process.env.POSTGRES_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  });

  await client.connect();

  try {
    for (const statement of statements) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
