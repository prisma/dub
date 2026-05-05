import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const contractPath = join(process.cwd(), "schema", "contract.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as any;

for (const table of Object.values(contract.storage?.tables ?? {}) as any[]) {
  for (const column of Object.values(table.columns ?? {}) as any[]) {
    if (column.default?.kind === "literal" && !("value" in column.default)) {
      column.default.value = false;
    }
  }
}

for (const type of Object.values(contract.storage?.types ?? {}) as any[]) {
  if (!("typeParams" in type)) {
    type.typeParams = {};
  }
}

writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
