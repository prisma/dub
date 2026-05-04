import { Pool, type QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var pgPool: Pool | undefined;
}

const getPool = () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to connect to PostgreSQL.");
  }

  if (!global.pgPool) {
    global.pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.POSTGRES_POOL_MAX ?? 10),
      ssl:
        process.env.POSTGRES_SSL === "true"
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }

  return global.pgPool;
};

const replacePlaceholders = (query: string) => {
  let index = 0;
  return query.replace(/\?/g, () => `$${++index}`);
};

export const conn = {
  async execute<T extends QueryResultRow = QueryResultRow>(
    query: string,
    params: unknown[] = [],
  ) {
    const result = await getPool().query<T>(replacePlaceholders(query), params);

    return {
      rows: result.rows,
      fields: result.fields,
      rowsAffected: result.rowCount,
      rowCount: result.rowCount,
    };
  },
};
