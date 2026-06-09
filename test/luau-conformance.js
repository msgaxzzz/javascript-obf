const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parse } = require("../src/luau/custom/parser");
const { printChunk } = require("../src/luau/custom/printer");

const repoRoot = path.resolve(__dirname, "..");
const conformanceDir = path.join(repoRoot, "third_party", "luau", "tests", "conformance");

const ROUND_TRIP_FILES = [
  "apicalls.luau",
  "assert.luau",
  "attrib.luau",
  "bitwise.luau",
  "buffers.luau",
  "calls.luau",
  "clear.luau",
  "closure.luau",
  "coroutine.luau",
  "coverage.luau",
  "cyield.luau",
  "datetime.luau",
  "debug.luau",
  "debugger.luau",
  "errors.luau",
  "events.luau",
  "exceptions.luau",
  "gc.luau",
  "ifelseexpr.luau",
  "interrupt.luau",
  "iter.luau",
  "iter_fenv.luau",
  "literals.luau",
  "locals.luau",
  "move.luau",
  "native_integer_spills.luau",
  "native_types.luau",
  "native_userdata.luau",
  "ndebug_upvalues.luau",
  "pcall.luau",
  "pm.luau",
  "safeenv.luau",
  "sort.luau",
  "strconv.luau",
  "strings.luau",
  "tables.luau",
  "tmerror.luau",
  "tpack.luau",
  "types.luau",
  "udata_direct.luau",
  "userdata.luau",
  "utf8.luau",
  "vararg.luau",
  "vector.luau",
  "vector_library.luau",
];

const RUNTIME_STABLE_FILES = [
  "apicalls.luau",
  "assert.luau",
  "bitwise.luau",
  "buffers.luau",
  "calls.luau",
  "clear.luau",
  "datetime.luau",
  "exceptions.luau",
  "ifelseexpr.luau",
  "interrupt.luau",
  "iter.luau",
  "iter_fenv.luau",
  "locals.luau",
  "move.luau",
  "native_integer_spills.luau",
  "safeenv.luau",
  "strconv.luau",
  "strings.luau",
  "tpack.luau",
  "utf8.luau",
];

const EXPECTED_PARSE_GAPS = new Map([
  ["basic.luau", "expression typeof / legacy conformance edge cases"],
  ["constructs.luau", "statement attributes in nested expression-sensitive contexts"],
  ["explicit_type_instantiations.luau", "explicit type instantiation call syntax"],
  ["integers.luau", "local attribute integer conformance constructs"],
  ["math.luau", "unary plus in official conformance input"],
  ["native.luau", "native/type attribute conformance constructs"],
  ["stringinterp.luau", "expression typeof inside interpolation conformance input"],
]);

function readCase(name) {
  return fs.readFileSync(path.join(conformanceDir, name), "utf8");
}

function runLuau(source, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luau-conformance-"));
  const file = path.join(dir, name);
  try {
    fs.writeFileSync(file, source, "utf8");
    const result = cp.spawnSync("luau", [file], {
      encoding: "utf8",
      timeout: 20000,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: result.stdout,
      error: result.stderr || result.stdout,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertRoundTrip(name) {
  const source = readCase(name);
  const ast = parse(source);
  const printed = printChunk(ast);
  parse(printed);
  return printed;
}

for (const name of ROUND_TRIP_FILES) {
  assertRoundTrip(name);
}

for (const [name] of EXPECTED_PARSE_GAPS) {
  assert.throws(
    () => assertRoundTrip(name),
    undefined,
    `${name} should stay listed as an expected parser conformance gap until implemented`
  );
}

for (const name of RUNTIME_STABLE_FILES) {
  const source = readCase(name);
  const printed = assertRoundTrip(name);
  const baseline = runLuau(source, name);
  assert.ok(baseline.ok, `${name}: official baseline should execute: ${baseline.error}`);
  const roundTrip = runLuau(printed, name);
  assert.ok(roundTrip.ok, `${name}: printed source should execute: ${roundTrip.error}`);
  assert.strictEqual(roundTrip.output, baseline.output, `${name}: printed output should match official output`);
}

console.log("luau-conformance: ok");
