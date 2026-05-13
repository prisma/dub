import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const contractPath = join(process.cwd(), "schema", "contract.json");
const contractTypesPath = join(process.cwd(), "schema", "contract.d.ts");
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as any;

function isJsonCodec(value: any) {
  if (value?.codecId !== "pg/json@1" && value?.codecId !== "pg/jsonb@1") {
    return false;
  }
  return true;
}

function normalizeJsonColumn(column: any) {
  if (!isJsonCodec(column)) {
    return;
  }
  delete column.typeParams;
  delete column.typeRef;
}

function normalizeJsonStorageType(type: any) {
  if (!isJsonCodec(type)) {
    return;
  }
  type.typeParams = {};
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeContractTypes() {
  if (!existsSync(contractTypesPath)) {
    return;
  }

  const jsonTypeRefs = Object.entries(contract.storage?.types ?? {})
    .filter(([, type]) => isJsonCodec(type))
    .map(([name]) => name);

  if (jsonTypeRefs.length === 0) {
    return;
  }

  let contractTypes = readFileSync(contractTypesPath, "utf8");
  for (const typeRef of jsonTypeRefs) {
    contractTypes = contractTypes.replace(
      new RegExp(`^\\s+readonly typeRef: '${escapeRegExp(typeRef)}';\\n`, "gm"),
      "",
    );
  }
  writeFileSync(contractTypesPath, contractTypes);
}

for (const table of Object.values(contract.storage?.tables ?? {}) as any[]) {
  for (const column of Object.values(table.columns ?? {}) as any[]) {
    if (column.default?.kind === "literal" && !("value" in column.default)) {
      column.default.value = false;
    }
    normalizeJsonColumn(column);
  }
}

for (const type of Object.values(contract.storage?.types ?? {}) as any[]) {
  if (!("typeParams" in type)) {
    type.typeParams = {};
  }
  normalizeJsonStorageType(type);
}

writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
normalizeContractTypes();
