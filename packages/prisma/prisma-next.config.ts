import { defineConfig } from "@prisma-next/postgres/config";

export default defineConfig({
  contract: "./schema/contract.prisma",
  ...(process.env.DATABASE_URL
    ? {
        db: {
          connection: process.env.DATABASE_URL,
        },
      }
    : {}),
});
