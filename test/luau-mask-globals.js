const assert = require("assert");
const rename = require("../src/luau/rename");
const maskGlobals = require("../src/luau/maskGlobals");
const strings = require("../src/luau/strings");
const { obfuscateLuau } = require("../src/luau");
const { parseLuau: parseFromAst } = require("../src/luau/ast");
const { parseLuau: parseCanonical } = require("../src/luau/custom");
const { parse: parseCustom } = require("../src/luau/custom/parser");
const { walk } = require("../src/luau/ast");
const { decodeRawString } = require("../src/luau/strings");
const { RNG } = require("../src/utils/rng");

assert.ok(rename, "rename transform should still load");
assert.ok(maskGlobals, "maskGlobals transform should still load");
assert.ok(strings, "strings transform should still load");

const source = [
  "local function foo()",
  "  foo()",
  "  print(\"hi\")",
  "end",
  "",
  "foo()",
].join("\n");

function hasEnvIndex(ast, name) {
  let found = false;
  walk(ast, (node) => {
    if (found || !node || node.type !== "IndexExpression") {
      return;
    }
    const index = node.index;
    if (!index || index.type !== "StringLiteral") {
      return;
    }
    const value = typeof index.value === "string"
      ? index.value
      : (typeof index.raw === "string" ? decodeRawString(index.raw) : null);
    if (value === name) {
      found = true;
    }
  });
  return found;
}

function hasCallBase(ast, name) {
  let found = false;
  walk(ast, (node) => {
    if (found || !node || node.type !== "CallExpression") {
      return;
    }
    if (node.base && node.base.type === "Identifier" && node.base.name === name) {
      found = true;
    }
  });
  return found;
}

function getLeadingLocalNames(ast, count) {
  const names = [];
  for (const stmt of ast.body || []) {
    if (!stmt || stmt.type !== "LocalStatement") {
      break;
    }
    for (const variable of stmt.variables || []) {
      if (variable && variable.type === "Identifier") {
        names.push(variable.name);
      }
    }
    if (names.length >= count) {
      break;
    }
  }
  return names.slice(0, count);
}

function runAstCompatContract() {
  const ast = parseFromAst([
    "type Pair<T> = { value: T }",
    "local x: Pair<number> = { value = 1 }",
    "return x.value",
  ].join("\n"));

  assert.ok(ast && ast.type === "Chunk", "ast.parseLuau should return a custom-style chunk");
  assert.strictEqual(ast.body[0].type, "TypeAliasStatement", "ast.parseLuau should translate official type aliases back to legacy shape");
  assert.strictEqual(ast.body[0].typeParameters[0].name, "T", "legacy compat should preserve generic parameters");
  assert.strictEqual(ast.body[1].type, "LocalStatement", "ast.parseLuau should keep transform-facing statement shapes consumable");
}

function runAstCompatOptions() {
  const ast = parseFromAst("local x = 1", { locations: false, ranges: false });
  let sawLocationData = false;

  walk(ast, (node) => {
    if (sawLocationData || !node) {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(node, "loc") || Object.prototype.hasOwnProperty.call(node, "range")) {
      sawLocationData = true;
    }
  });

  assert.ok(!sawLocationData, "ast.parseLuau should honor locations/ranges compatibility flags");

  assert.throws(
    () => parseFromAst("local x = 1", { luaVersion: "5.4" }),
    /unsupported luaVersion 5\.4/,
    "ast.parseLuau should reject unsupported legacy luaVersion values explicitly"
  );
}

function runCanonicalMaskGlobalsContract() {
  const ast = parseCanonical("print(foo)");
  maskGlobals.maskGlobalsLuau(ast, {
    options: { renameOptions: { maskGlobals: true } },
    rng: new RNG("mask-globals-canonical"),
  });
  assert.ok(ast && ast.type === "Chunk", "maskGlobals should accept canonical official-shape AST");
}

async function run() {
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    rename: false,
    strings: false,
    cff: false,
    dead: false,
    vm: false,
    renameOptions: { maskGlobals: true },
    seed: "mask-globals-custom",
  });

  const ast = parseCustom(code);

  assert.ok(hasEnvIndex(ast, "print"), "custom: print should be masked via env alias");
  assert.ok(!hasEnvIndex(ast, "foo"), "custom: local foo should not be masked");
  assert.ok(hasCallBase(ast, "foo"), "custom: local foo calls should remain identifiers");
  assert.ok(!hasCallBase(ast, "print"), "custom: print calls should not remain bare identifiers");
}

async function runRepeatUntilScopeRegression() {
  const repeatSource = [
    "local function test()",
    "  local n = 0",
    "  repeat",
    "    local x = n + 1",
    "    n = x",
    "  until x > 1",
    "  return n",
    "end",
    "print(test())",
  ].join("\n");

  const { code } = await obfuscateLuau(repeatSource, {
    lang: "luau",
    luauParser: "custom",
    rename: false,
    strings: false,
    cff: false,
    dead: false,
    vm: false,
    renameOptions: { maskGlobals: true },
    seed: "mask-globals-repeat-scope",
  });

  const ast = parseCustom(code);
  assert.ok(!hasEnvIndex(ast, "x"), "repeat-until locals should remain visible in the condition");
}

async function runShortAliasAndGlobalAssignmentRegression() {
  const globalWriteSource = [
    "x = 1",
    "print(x)",
  ].join("\n");

  const { code } = await obfuscateLuau(globalWriteSource, {
    lang: "luau",
    luauParser: "custom",
    rename: false,
    strings: false,
    cff: false,
    dead: false,
    vm: false,
    renameOptions: { maskGlobals: true },
    seed: "mask-globals-short-global-write",
  });

  const ast = parseCustom(code);
  const aliases = getLeadingLocalNames(ast, 2);
  assert.deepStrictEqual(aliases, ["a", "b"], "maskGlobals should use shortest env/getfenv aliases first");
  assert.ok(hasEnvIndex(ast, "x"), "global assignment/read should be masked through env alias");
  assert.ok(hasEnvIndex(ast, "print"), "global print call should be masked through env alias");
  assert.ok(!/[^A-Za-z0-9_]x\s*=/.test(code), "global assignment should not remain a bare identifier target");
}

(async () => {
  runAstCompatContract();
  runAstCompatOptions();
  runCanonicalMaskGlobalsContract();
  await run();
  await runRepeatUntilScopeRegression();
  await runShortAliasAndGlobalAssignmentRegression();
  console.log("luau-mask-globals: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
