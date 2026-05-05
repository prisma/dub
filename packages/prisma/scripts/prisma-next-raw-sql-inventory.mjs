import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const repoRoot = join(process.cwd(), "..", "..");
const outputPath =
  process.env.PRISMA_NEXT_RAW_SQL_INVENTORY_OUT ??
  join(process.cwd(), ".tmp", "prisma-next-raw-sql-inventory.json");

const scanRoots = ["apps", "packages"].map((root) => join(repoRoot, root));
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredPathParts = new Set(["node_modules", ".next", "dist", "build", "coverage"]);

const executionPatterns = [
  { kind: "prisma-query-raw", pattern: /\.\$queryRaw(?:Unsafe)?\b/g },
  { kind: "prisma-execute-raw", pattern: /\.\$executeRaw(?:Unsafe)?\b/g },
  { kind: "postgres-helper-execute", pattern: /\bconn\.execute\s*\(/g },
];

const fragmentPatterns = [
  { kind: "prisma-sql-fragment", pattern: /\bPrisma\.sql`/g },
  { kind: "prisma-join-fragment", pattern: /\bPrisma\.join\s*\(/g },
  { kind: "prisma-raw-fragment", pattern: /\bPrisma\.raw\s*\(/g },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredPathParts.has(entry.name) || entry.isSymbolicLink()) {
      continue;
    }

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }

    const extension = fullPath.slice(fullPath.lastIndexOf("."));
    if (sourceExtensions.has(extension)) {
      files.push(fullPath);
    }
  }
  return files;
}

function lineAndColumn(source, index) {
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: lines.at(-1).length + 1,
  };
}

function contextSnippet(source, index) {
  const before = source.slice(0, index).split("\n");
  const contextLineCount = 4;
  const contextStartLine = Math.max(0, before.length - contextLineCount - 1);
  const lineStarts = [];
  let cursor = 0;
  for (const line of source.split("\n")) {
    lineStarts.push(cursor);
    cursor += line.length + 1;
  }

  const start = lineStarts[contextStartLine] ?? 0;
  const statementEnd = source.indexOf(";", index);
  const end = statementEnd === -1 ? Math.min(source.length, index + 4_000) : statementEnd + 1;
  return source.slice(start, Math.min(end, index + 8_000));
}

function lineWindowSnippet(source, index) {
  const lines = source.split("\n");
  const { line } = lineAndColumn(source, index);
  const start = Math.max(0, line - 8);
  const end = Math.min(lines.length, line + 80);
  return lines.slice(start, end).join("\n");
}

function detectFeatures(snippet) {
  const lower = snippet.toLowerCase();
  const features = [];
  const checks = [
    ["cte", /\bwith\b/],
    ["join", /\bjoin\b/],
    ["group-by", /\bgroup\s+by\b/],
    ["order-by", /\border\s+by\b/],
    ["aggregate", /\b(count|sum|avg|min|max|array_agg|string_agg)\s*\(/],
    ["date-bucketing", /\b(to_char|date_trunc)\s*\(|\bat\s+time\s+zone\b/],
    ["json", /\bjsonb?[_\s(]|->>|->/],
    ["exists", /\bexists\s*\(/],
    ["case", /\bcase\b/],
    ["union", /\bunion\b/],
    ["window", /\bover\s*\(/],
    ["dynamic-list", /\bprisma\.join\s*\(/],
    ["dynamic-sql", /\bprisma\.raw\s*\(/],
    ["unsafe-raw", /\$queryrawunsafe|\$executerawunsafe/],
    ["ilike", /\bilike\b/],
    ["delete", /\bdelete\s+from\b/],
    ["update", /\bupdate\s+["\w.]+\s+set\b/],
    ["insert", /\binsert\s+into\b/],
    ["select-star", /\bselect\s+\*/],
  ];

  for (const [feature, pattern] of checks) {
    if (pattern.test(lower)) {
      features.push(feature);
    }
  }

  return features;
}

function classifyUsage(kind, snippet, features) {
  if (features.includes("unsafe-raw") || features.includes("dynamic-sql")) {
    return {
      supportedBy: "manual-review",
      confidence: "low",
      reason:
        "Uses unsafe or dynamic raw SQL construction; exact Prisma Next coverage depends on the constructed SQL.",
    };
  }

  if (kind === "postgres-helper-execute" && !/conn\.execute\s*\(\s*`/m.test(snippet)) {
    return {
      supportedBy: "manual-review",
      confidence: "low",
      reason:
        "The SQL is passed through a variable or non-template call; static classification cannot see the full query.",
    };
  }

  const complexFeatures = [
    "cte",
    "date-bucketing",
    "json",
    "case",
    "union",
    "window",
    "dynamic-list",
  ];
  const hasComplexFeature = complexFeatures.some((feature) => features.includes(feature));
  if (hasComplexFeature) {
    return {
      supportedBy: "not-currently-covered",
      confidence: "medium",
      reason:
        "Uses SQL constructs that are outside the current high-level ORM surface and should not be assumed to lower through the current SQL builder without a dedicated port.",
    };
  }

  if (features.includes("join") || features.includes("group-by") || features.includes("aggregate")) {
    return {
      supportedBy: "query-builder-api",
      confidence: "medium",
      reason:
        "Uses relational SQL shape beyond simple model CRUD; candidate for Prisma Next lower-level SQL builder or ORM aggregate/grouping after a focused port.",
    };
  }

  if (features.includes("delete") || features.includes("update") || features.includes("insert")) {
    return {
      supportedBy: "orm-api",
      confidence: "medium",
      reason: "Looks like single-table write SQL that maps to ORM create/update/delete APIs.",
    };
  }

  if (/select\b/i.test(snippet)) {
    return {
      supportedBy: "orm-api",
      confidence: "medium",
      reason:
        "Looks like a single-table read/filter query that maps to ORM where/select/order/take APIs.",
    };
  }

  return {
    supportedBy: "manual-review",
    confidence: "low",
    reason: "The execution site is raw SQL, but the local snippet does not expose enough SQL shape.",
  };
}

function collectMatches(file, source, patternDefinitions) {
  const matches = [];

  for (const definition of patternDefinitions) {
    definition.pattern.lastIndex = 0;
    let match;
    while ((match = definition.pattern.exec(source)) !== null) {
      const location = lineAndColumn(source, match.index);
      let snippet = contextSnippet(source, match.index);
      let features = detectFeatures(snippet);

      if (
        features.length === 0 &&
        definition.kind !== "postgres-helper-execute" &&
        source.slice(match.index, match.index + 2_000).includes("`")
      ) {
        snippet = lineWindowSnippet(source, match.index);
        features = detectFeatures(snippet);
      }

      matches.push({
        kind: definition.kind,
        file: relative(repoRoot, file),
        line: location.line,
        column: location.column,
        snippet,
        features,
        classification:
          patternDefinitions === executionPatterns
            ? classifyUsage(definition.kind, snippet, features)
            : undefined,
      });
    }
  }

  return matches;
}

function summarize(executions) {
  const bySupport = new Map();
  const byKind = new Map();
  const byFeature = new Map();

  for (const execution of executions) {
    const support = execution.classification.supportedBy;
    bySupport.set(support, (bySupport.get(support) ?? 0) + 1);
    byKind.set(execution.kind, (byKind.get(execution.kind) ?? 0) + 1);
    for (const feature of execution.features) {
      byFeature.set(feature, (byFeature.get(feature) ?? 0) + 1);
    }
  }

  const toObject = (map) =>
    Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));

  return {
    totalExecutionSites: executions.length,
    bySupport: toObject(bySupport),
    byKind: toObject(byKind),
    byFeature: toObject(byFeature),
  };
}

function main() {
  const files = scanRoots.flatMap((root) => walk(root));
  const executions = [];
  const fragments = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    executions.push(...collectMatches(file, source, executionPatterns));
    fragments.push(...collectMatches(file, source, fragmentPatterns));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    strategy: {
      scope:
        "Static inventory of raw SQL execution sites in apps/ and packages/. Prisma.sql fragments are counted separately from executed raw SQL calls.",
      classification:
        "Conservative heuristic: simple model CRUD is classified as ORM API; joins/aggregates as lower-level query builder candidates; CTEs/date bucketing/JSON/window/dynamic SQL as not currently covered or manual review.",
    },
    summary: summarize(executions),
    executions,
    fragments: {
      total: fragments.length,
      byKind: summarize(fragments.map((fragment) => ({ ...fragment, classification: { supportedBy: "fragment" } }))).byKind,
      items: fragments,
    },
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Raw SQL execution sites: ${report.summary.totalExecutionSites}`);
  for (const [support, count] of Object.entries(report.summary.bySupport)) {
    console.log(`  - ${support}: ${count}`);
  }
  console.log(`Prisma SQL fragments: ${report.fragments.total}`);
  console.log(`Raw SQL inventory written to ${outputPath}`);
}

main();
