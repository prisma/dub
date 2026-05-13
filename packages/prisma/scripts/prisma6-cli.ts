import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const schemaDir = join(process.cwd(), "schema");
const tempRoot = join(process.cwd(), ".tmp");
mkdirSync(tempRoot, { recursive: true });
const tempSchemaDir = mkdtempSync(join(tempRoot, "prisma6-schema-"));
const commandArgs = process.argv.slice(2);

if (commandArgs.length === 0) {
  throw new Error("Usage: tsx scripts/prisma6-cli.ts <prisma args...>");
}

const schemaFiles = readdirSync(schemaDir).filter(
  (file) => file.endsWith(".prisma") && file !== "contract.prisma",
);

for (const file of schemaFiles) {
  copyFileSync(join(schemaDir, file), join(tempSchemaDir, file));
}

const isFormat = commandArgs[0] === "format";

try {
  const result = spawnSync(
    "pnpm",
    ["exec", "prisma", ...commandArgs, "--schema", tempSchemaDir],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    process.exit();
  }

  if (isFormat) {
    for (const file of schemaFiles) {
      copyFileSync(join(tempSchemaDir, basename(file)), join(schemaDir, file));
    }
  }
} finally {
  rmSync(tempSchemaDir, { recursive: true, force: true });
}
