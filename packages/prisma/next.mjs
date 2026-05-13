import postgres from "@prisma-next/postgres/runtime";
import contractJson from "./schema/contract.json" with { type: "json" };

const databaseUrl = process.env.DATABASE_URL;

export const prismaNext = postgres({
  contractJson,
  ...(databaseUrl ? { url: databaseUrl } : {}),
});

export const db = prismaNext;

export default prismaNext;
