import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;

export const prismaEdge = new PrismaClient({
  ...(databaseUrl
    ? {
        adapter: new PrismaPg({
          connectionString: databaseUrl,
        }),
      }
    : {}),
});
