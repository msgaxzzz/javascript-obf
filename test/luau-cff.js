const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { obfuscateLuau } = require("../src/luau");
const { parse: parseCustom } = require("../src/luau/custom/parser");

const source = [
  "local function demo()",
  "  local a = 1",
  "  local b = 2",
  "  a = a + b",
  "  print(a)",
  "end",
].join("\n");

function runLuau(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "js-obf-luau-cff-"));
  const file = path.join(dir, "case.luau");
  try {
    fs.writeFileSync(file, code, "utf8");
    const result = spawnSync("luau", [file], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `luau exited with code ${result.status}`);
    }
    return result.stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runLuauModuleReturn(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "js-obf-luau-cff-module-"));
  const moduleFile = path.join(dir, "case.luau");
  const runnerFile = path.join(dir, "runner.luau");
  try {
    fs.writeFileSync(moduleFile, code, "utf8");
    fs.writeFileSync(runnerFile, "print(require(\"./case\"))\n", "utf8");
    const result = spawnSync("luau", [runnerFile], { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `luau exited with code ${result.status}`);
    }
    return result.stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function countNodeTypes(node, counts = {}) {
  if (!node || typeof node !== "object") {
    return counts;
  }
  if (Array.isArray(node)) {
    node.forEach((item) => countNodeTypes(item, counts));
    return counts;
  }
  if (typeof node.type === "string") {
    counts[node.type] = (counts[node.type] || 0) + 1;
  }
  Object.keys(node).forEach((key) => {
    if (key === "loc" || key === "range" || key.startsWith("__")) {
      return;
    }
    countNodeTypes(node[key], counts);
  });
  return counts;
}

function hasNode(node, predicate) {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((item) => hasNode(item, predicate));
  }
  if (predicate(node)) {
    return true;
  }
  return Object.keys(node).some((key) => {
    if (key === "loc" || key === "range" || key.startsWith("__")) {
      return false;
    }
    return hasNode(node[key], predicate);
  });
}

async function runCustom() {
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    cff: true,
    cffOptions: { mode: "classic" },
    strings: false,
    seed: "cff-custom",
  });
  parseCustom(code);
  assert.ok(code.includes("while"), "custom parser should emit while loop");
}

async function runLocalReturnScopeRegression() {
  const scopeSource = [
    "local function pair()",
    "  return 1, 2",
    "end",
    "local function f(...)",
    "  local n = select('#', ...)",
    "  local a, b = ...",
    "  return n, a, b",
    "end",
    "local n, a, b = f(pair())",
    "print(n, a, b)",
  ].join("\n");

  const { code } = await obfuscateLuau(scopeSource, {
    lang: "luau",
    luauParser: "custom",
    cff: true,
    cffOptions: { mode: "classic" },
    strings: false,
    rename: false,
    dead: false,
    numbers: false,
    seed: "cff-local-scope",
  });
  parseCustom(code);
  assert.strictEqual(runLuau(code), "2\t1\t2", "classic CFF should keep flattened locals visible to later returns");
}

async function runEnhancedShapeRegression() {
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    cff: true,
    cffOptions: { mode: "classic" },
    strings: false,
    rename: false,
    dead: false,
    numbers: false,
    seed: "cff-enhanced-shape",
  });
  const ast = parseCustom(code);
  const fn = ast.body.find((node) => node.type === "FunctionDeclaration");
  assert.ok(fn, "expected flattened local function in output");
  const body = fn.body && Array.isArray(fn.body.body) ? fn.body.body : [];
  const tableLocals = body.filter((stmt) =>
    stmt.type === "LocalStatement" &&
    Array.isArray(stmt.init) &&
    stmt.init[0] &&
    stmt.init[0].type === "TableConstructorExpression"
  );
  assert.ok(tableLocals.length >= 4, "enhanced CFF should emit values, next, dispatch, and handler tables");
  const handlerTable = tableLocals.find((stmt) => {
    const init = stmt.init[0];
    return Array.isArray(init.fields) && init.fields.some((field) => field && field.value && field.value.type === "FunctionExpression");
  });
  assert.ok(handlerTable, "enhanced CFF should indirect through a handler table");
  const loop = body.find((stmt) => stmt.type === "WhileStatement");
  assert.ok(loop, "enhanced CFF should still lower to a looped dispatcher");
  const loopBody = loop.body && Array.isArray(loop.body.body) ? loop.body.body : [];
  const handlerLocal = loopBody.find((stmt) =>
    stmt.type === "LocalStatement" &&
    Array.isArray(stmt.init) &&
    stmt.init[0] &&
    (stmt.init[0].type === "IndexExpression" ||
      ((stmt.init[0].type === "LogicalExpression" || stmt.init[0].type === "BinaryExpression") &&
        stmt.init[0].operator === "or"))
  );
  assert.ok(handlerLocal, "enhanced CFF should load an indirect handler each iteration");
  const dispatcher = loopBody.find((stmt) => stmt.type === "IfStatement");
  assert.ok(dispatcher, "enhanced CFF should emit a dispatcher if-chain");
  const clauses = Array.isArray(dispatcher.clauses) ? dispatcher.clauses : [];
  assert.ok(clauses.length >= 1, "enhanced CFF should keep a guarded dispatcher fallback");
}

async function runWovenCoverageRegression() {
  const wovenSource = [
    "local function calc(x)",
    "  local function bump(v)",
    "    return v + 1",
    "  end",
    "  local a = bump(0)",
    "  local b = 2",
    "  if x > 2 then",
    "    a = a + x",
    "  else",
    "    a = a - x",
    "  end",
    "  for i = 1, 3 do",
    "    b += i",
    "  end",
    "  while b < 10 do",
    "    b += 1",
    "  end",
    "  return a, b",
    "end",
    "local a, b = calc(4)",
    "print(a, b)",
  ].join("\n");

  const { code } = await obfuscateLuau(wovenSource, {
    lang: "luau",
    luauParser: "custom",
    cff: true,
    cffOptions: { mode: "woven" },
    strings: false,
    rename: false,
    dead: false,
    numbers: false,
    seed: "cff-woven-coverage",
  });
  const ast = parseCustom(code);
  assert.strictEqual(runLuau(code), runLuau(wovenSource), "woven CFF should preserve local/if/loop/return behavior");
  const counts = countNodeTypes(ast);
  assert.ok((counts.WhileStatement || 0) >= 1, "woven CFF should emit a while dispatcher");
  assert.ok((counts.IfStatement || 0) >= 4, "woven CFF should emit nested if dispatch");
  assert.ok(
    (counts.RepeatStatement || 0) + (counts.ForNumericStatement || 0) + (counts.DoStatement || 0) >= 2,
    "woven CFF should wrap cases in noisy repeat/for/do blocks"
  );
}

async function runWovenLoopControlRegression() {
  const loopSource = [
    "local function walk(t)",
    "  local sum = 0",
    "  for _, v in ipairs(t) do",
    "    if v == 3 then",
    "      continue",
    "    end",
    "    if v > 4 then",
    "      break",
    "    end",
    "    sum += v",
    "  end",
    "  return sum",
    "end",
    "print(walk({1, 2, 3, 4, 5}))",
  ].join("\n");

  const { code } = await obfuscateLuau(loopSource, {
    lang: "luau",
    luauParser: "custom",
    cff: true,
    cffOptions: { mode: "woven" },
    strings: false,
    rename: false,
    dead: false,
    numbers: false,
    seed: "cff-woven-loop-control",
  });
  const ast = parseCustom(code);
  assert.strictEqual(runLuau(code), runLuau(loopSource), "woven CFF should preserve loop break/continue behavior");
  const counts = countNodeTypes(ast);
  assert.ok((counts.ForGenericStatement || 0) >= 1, "woven CFF should keep generic for loops as covered steps");
  assert.ok((counts.ContinueStatement || 0) >= 1, "woven CFF should allow continue inside original loops");
  assert.ok((counts.BreakStatement || 0) >= 1, "woven CFF should allow break inside original loops");
}

async function runWovenMicroAssignmentRegression() {
  const microSource = [
    "local function calc(t)",
    "  local a = 2",
    "  local b = 3",
    "  a += b",
    "  t[1] = a",
    "  t[2] += t[1]",
    "  t.x = t[2]",
    "  return a, t[1], t[2], t.x",
    "end",
    "print(calc({ 1, 4, x = 0 }))",
  ].join("\n");

  const { code } = await obfuscateLuau(microSource, {
    lang: "luau",
    luauParser: "custom",
    cff: true,
    cffOptions: { mode: "woven" },
    strings: false,
    rename: false,
    dead: false,
    numbers: false,
    seed: "cff-woven-micro-assignment",
  });
  const ast = parseCustom(code);
  assert.strictEqual(runLuau(code), runLuau(microSource), "woven micro-CFF should preserve assignment behavior");
  const counts = countNodeTypes(ast);
  assert.ok((counts.WhileStatement || 0) >= 2, "woven micro-CFF should add internal while state machines");
  assert.ok((counts.IndexExpression || 0) >= 4, "woven micro-CFF should add table/index indirection");
  assert.ok(
    hasNode(ast, (node) =>
      node.type === "TableField" &&
      node.kind === "index" &&
      node.key &&
      node.key.type === "Identifier" &&
      node.value &&
      node.value.type === "Identifier"
    ),
    "woven CFF should use a runtime anchor table keyed by a local object"
  );
  assert.ok(
    hasNode(ast, (node) =>
      (node.type === "BinaryExpression" || node.type === "LogicalExpression") &&
      node.operator === "or" &&
      node.left &&
      node.left.type === "IndexExpression"
    ),
    "woven micro-CFF should use table-driven internal state transitions"
  );
}

async function runWovenTopReturnCallHideRegression() {
  const returnSource = [
    "local function score(items, limit)",
    "  local total = 0",
    "  for i = 1, #items do",
    "    total += items[i]",
    "  end",
    "  return total + limit",
    "end",
    "return score({4, 9, 20, 31}, 10)",
  ].join("\n");

  const { code } = await obfuscateLuau(returnSource, {
    lang: "luau",
    luauParser: "custom",
    cff: true,
    cffOptions: { mode: "woven", hideTopReturnExpr: true },
    strings: false,
    rename: false,
    dead: false,
    numbers: false,
    seed: "cff-woven-top-return-call-hide",
  });
  const ast = parseCustom(code);
  const last = ast.body[ast.body.length - 1];
  const keyLocal = ast.body[ast.body.length - 3];
  const boxLocal = ast.body[ast.body.length - 2];
  const returned = last && last.type === "ReturnStatement" ? last.arguments[0] : null;
  assert.strictEqual(runLuauModuleReturn(code), "74", "woven top return call hiding should preserve module return value");
  assert.ok(last && last.type === "ReturnStatement", "top-level return should remain the last top-level statement");
  assert.ok(keyLocal && keyLocal.type === "LocalStatement", "top-level return key should be stored in a local");
  assert.ok(boxLocal && boxLocal.type === "LocalStatement", "top-level return call target should be stored in a local table");
  assert.strictEqual(keyLocal.variables[0].name.length, 1, "woven CFF generated names should prefer one-character names");
  assert.strictEqual(boxLocal.variables[0].name.length, 1, "woven CFF generated names should prefer one-character names");
  assert.ok(returned && returned.type === "CallExpression", "top-level return should still return a call expression");
  assert.ok(returned.base && returned.base.type === "IndexExpression", "return call target should be hidden through table index indirection");
  assert.ok(!/return\s+score\s*\(/.test(code), "top-level return should not directly call score");
}

async function runWovenTopReturnCallHideRenamePreserveRegression() {
  const returnSource = [
    "local function score(items, limit)",
    "  local total = 0",
    "  for i = 1, #items do",
    "    total += items[i]",
    "  end",
    "  return total + limit",
    "end",
    "return score({4, 9, 20, 31}, 10)",
  ].join("\n");

  const { code } = await obfuscateLuau(returnSource, {
    lang: "luau",
    luauParser: "custom",
    cff: true,
    cffOptions: { mode: "woven", hideTopReturnExpr: true },
    strings: false,
    rename: true,
    dead: false,
    numbers: false,
    vm: false,
    constArray: false,
    proxifyLocals: false,
    padFooter: false,
    renameOptions: {
      maskGlobals: false,
    },
    seed: "cff-woven-top-return-call-hide-rename-preserve",
  });

  parseCustom(code);
  assert.strictEqual(runLuauModuleReturn(code), "74", "woven top return call hiding with rename should preserve module return value");
  assert.ok(/\blocal function score\b/.test(code), "top-level return target should be preserved during rename");
  assert.ok(/\bscore\b/.test(code), "hidden return call table should still reference the preserved target name");
  assert.ok(!/return\s+score\s*\(/.test(code), "top-level return call target should remain hidden after rename");
}

(async () => {
  await runCustom();
  await runLocalReturnScopeRegression();
  await runEnhancedShapeRegression();
  await runWovenCoverageRegression();
  await runWovenLoopControlRegression();
  await runWovenMicroAssignmentRegression();
  await runWovenTopReturnCallHideRegression();
  await runWovenTopReturnCallHideRenamePreserveRegression();
  console.log("luau-cff: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
