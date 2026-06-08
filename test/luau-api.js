const assert = require("assert");
const { obfuscateLuau } = require("../src/luau");
const { parse: parseCustom } = require("../src/luau/custom/parser");
const { normalizeOptions } = require("../src/options");

function runVmDefaultOptionRegression() {
  const options = normalizeOptions({
    lang: "luau",
    vm: { enabled: true },
  });

  assert.strictEqual(options.vm.mode, "compact", "Luau VM should default to compact mode");
  assert.strictEqual(options.vm.decoyRuntime, false, "compact Luau VM should default decoy runtime off");
  assert.strictEqual(options.vm.symbolNoise, false, "compact Luau VM should default symbol noise off");
  assert.strictEqual(options.vm.semanticMisdirection, false, "compact Luau VM should default semantic misdirection off");
  assert.strictEqual(options.vm.dynamicCoupling, false, "compact Luau VM should default dynamic coupling off");
}

async function runRawOptionsRegression() {
  const source = [
    "local secret = \"raw api sentinel\"",
    "print(secret)",
  ].join("\n");

  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    strings: true,
    rename: false,
    cff: false,
    dead: false,
    vm: false,
    seed: "raw-api",
  });

  parseCustom(code);
  assert.ok(code.length > 0, "direct Luau API should return code");
  assert.ok(!code.includes("\"raw api sentinel\""), "raw API calls should still encode string literals");
  assert.ok(!code.includes("'raw api sentinel'"), "raw API calls should hide the original string literal");
}

async function runCompactFalseRegression() {
  const source = [
    "local function demo()",
    "  local a = 1",
    "  local b = 2",
    "  return a + b",
    "end",
    "print(demo())",
  ].join("\n");

  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    strings: false,
    rename: false,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    compact: false,
    seed: "luau-compact-false",
  });

  parseCustom(code);
  assert.ok(code.split("\n").length > 3, "compact=false should preserve multi-line Luau output");
}

async function runLuauSourceMapRegression() {
  const source = [
    "local function demo()",
    "  local answer = 42",
    "  return answer",
    "end",
    "print(demo())",
  ].join("\n");

  const result = await obfuscateLuau(source, {
    lang: "luau",
    sourceMap: true,
    strings: false,
    rename: false,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    compact: true,
    filename: "demo.lua",
    seed: "luau-sourcemap",
  });

  parseCustom(result.code);
  assert.ok(result.map, "Luau sourceMap should return a map object");
  assert.strictEqual(result.map.version, 3, "Luau sourceMap should emit a v3 source map");
  assert.deepStrictEqual(result.map.sources, ["demo.lua"], "Luau sourceMap should preserve the input filename");
  assert.deepStrictEqual(result.map.sourcesContent, [source], "Luau sourceMap should embed source content");
  assert.ok(typeof result.map.mappings === "string" && result.map.mappings.length > 0, "Luau sourceMap should emit mappings");
  assert.ok(result.map.mappings.includes(","), "Luau sourceMap should include intra-line expression segments, not just statement starts");
  assert.ok(result.code.split("\n").length > 1, "Luau sourceMap output should stay non-compact so mappings remain valid");
}

(async () => {
  runVmDefaultOptionRegression();
  await runRawOptionsRegression();
  await runCompactFalseRegression();
  await runLuauSourceMapRegression();
  console.log("luau-api: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
