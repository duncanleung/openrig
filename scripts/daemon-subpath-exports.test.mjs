// Every `@openrig/daemon/<subpath>` that the CLI or TUI source imports must have an entry in
// packages/daemon/package.json `exports`. Without one, Node fails the import at runtime with
// ERR_PACKAGE_PATH_NOT_EXPORTED and build-package.sh fails in rewrite-daemon-imports.mjs.
// A tsconfig `paths` alias makes `tsc` pass anyway, so typecheck alone does not catch it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const daemonDir = join(root, "packages/daemon");
const exportsMap = JSON.parse(readFileSync(join(daemonDir, "package.json"), "utf8")).exports ?? {};
const PACKAGE = "@openrig/daemon";

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

// Module specifiers from import/export declarations and literal import()/require() calls.
function daemonSpecifiers(file) {
  const text = readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const visit = (node) => {
    let literal;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      literal = node.moduleSpecifier;
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      literal = node.arguments[0];
    }
    if (literal && ts.isStringLiteralLike(literal)
      && (literal.text === PACKAGE || literal.text.startsWith(`${PACKAGE}/`))) {
      found.push(literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const consumers = ["packages/cli/src", "packages/tui/src"]
  .flatMap((dir) => sourceFiles(join(root, dir)));
const imports = new Map();
for (const file of consumers) {
  for (const specifier of daemonSpecifiers(file)) {
    if (!imports.has(specifier)) imports.set(specifier, file.slice(root.length + 1));
  }
}

test("the CLI and TUI source import at least one daemon subpath (guard against a broken scan)", () => {
  assert.ok(imports.size > 0);
});

test("every daemon subpath imported by CLI or TUI source has an exports entry", () => {
  const missing = [...imports]
    .filter(([specifier]) => !(`.${specifier.slice(PACKAGE.length)}` in exportsMap))
    .map(([specifier, file]) => `${specifier} (first imported in ${file})`);
  assert.deepEqual(missing, [], `missing from packages/daemon/package.json exports:\n${missing.join("\n")}`);
});

test("every exports target maps to a daemon source module", () => {
  const unbacked = [];
  for (const [key, value] of Object.entries(exportsMap)) {
    const target = typeof value === "string" ? value : value?.import;
    const match = /^\.\/dist\/(.+)\.js$/.exec(target ?? "");
    if (!match || !existsSync(join(daemonDir, "src", `${match[1]}.ts`))) unbacked.push(`${key} -> ${target}`);
  }
  assert.deepEqual(unbacked, []);
});

test("every CLI and TUI tsconfig paths alias for the daemon matches its exports entry", () => {
  const mismatched = [];
  for (const pkg of ["cli", "tui"]) {
    const tsconfigPath = join(root, "packages", pkg, "tsconfig.json");
    if (!existsSync(tsconfigPath)) continue;
    const paths = ts.readConfigFile(tsconfigPath, ts.sys.readFile).config?.compilerOptions?.paths ?? {};
    for (const [alias, targets] of Object.entries(paths)) {
      if (!alias.startsWith(`${PACKAGE}/`)) continue;
      const entry = exportsMap[`.${alias.slice(PACKAGE.length)}`];
      const expected = typeof entry === "object" ? entry?.types?.replace(/^\.\//, "../daemon/") : undefined;
      if (!expected || !targets.includes(expected)) mismatched.push(`${pkg}: ${alias} -> ${targets.join(", ")}`);
    }
  }
  assert.deepEqual(mismatched, []);
});
