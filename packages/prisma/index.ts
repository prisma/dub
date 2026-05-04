import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const getPrismaOptions = () => {
  const databaseUrl = process.env.DATABASE_URL;

  return {
    ...(databaseUrl
      ? {
          adapter: new PrismaPg({
            connectionString: databaseUrl,
          }),
        }
      : {}),
    omit: {
      user: { passwordHash: true },
    },
  };
};

const prismaClientSingleton = () => new PrismaClient(getPrismaOptions());

type OmittedPrismaClient = ReturnType<typeof prismaClientSingleton>;

declare global {
  var prisma: OmittedPrismaClient | undefined;
}

export const prisma = global.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

export const sanitizeFullTextSearch = (search: string) => {
  // remove unsupported characters for full text search
  return search.replace(/[*+\-()~@%<>!=?:]/g, "").trim();
};
