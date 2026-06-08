const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { obfuscateLuau } = require("../src/luau");
const { parse: parseCustom } = require("../src/luau/custom/parser");

function runLuau(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "js-obf-luau-vm-coverage-"));
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

function runLuauNamed(name, code) {
  try {
    return runLuau(code);
  } catch (err) {
    err.message = `${name}: ${err.message}`;
    throw err;
  }
}

function hasVmLoop(code) {
  return code.includes("while true do") || /while\s+[A-Za-z_][A-Za-z0-9_]*\s*~=\s*0\s*do/.test(code);
}

function createCoverageVmOptions(functionName) {
  return {
    enabled: true,
    include: [functionName],
    minStatements: 0,
    opcodeShuffle: false,
    fakeOpcodes: 0,
    bytecodeEncrypt: false,
    constsEncrypt: false,
    constsSplit: false,
    runtimeKey: false,
    runtimeSplit: false,
    decoyRuntime: false,
    symbolNoise: false,
    instructionFusion: false,
    semanticMisdirection: false,
    dynamicCoupling: false,
    isaPolymorph: false,
    fakeEdges: false,
  };
}

const cases = [
  {
    name: "locals-const-assignment-arithmetic",
    source: [
      "local function test(a, b)",
      "  const k = 3",
      "  local x, y = a + b, a * b",
      "  x, y = y - x, x + y + k",
      "  return x, y",
      "end",
      "print(test(2, 5))",
    ],
    expected: "3\t20",
  },
  {
    name: "if-elseif-else-if-expression",
    source: [
      "local function test(a)",
      "  local x = if a > 3 then 10 else 20",
      "  if a < 0 then",
      "    x = x + 1",
      "  elseif a == 5 then",
      "    x = x + 2",
      "  else",
      "    x = x + 3",
      "  end",
      "  return x",
      "end",
      "print(test(5))",
    ],
    expected: "12",
  },
  {
    name: "while-repeat-break-continue",
    source: [
      "local function test()",
      "  local i = 0",
      "  local s = 0",
      "  while i < 6 do",
      "    i += 1",
      "    if i == 2 then continue end",
      "    if i == 5 then break end",
      "    s += i",
      "  end",
      "  repeat",
      "    s += 1",
      "    if s < 10 then continue end",
      "  until s >= 10",
      "  return s",
      "end",
      "print(test())",
    ],
    expected: "10",
  },
  {
    name: "numeric-and-generic-for",
    source: [
      "local function test()",
      "  local s = 0",
      "  for i = 1, 4 do s += i end",
      "  for _, v in pairs({1, 2, 3}) do s += v end",
      "  for _, v in {4, 5} do s += v end",
      "  return s",
      "end",
      "print(test())",
    ],
    expected: "25",
  },
  {
    name: "generic-for-iter-metamethod",
    source: [
      "local iterable = setmetatable({}, {",
      "  __iter = function()",
      "    local i = 0",
      "    return function()",
      "      i += 1",
      "      if i <= 3 then return i, i * 2 end",
      "    end",
      "  end",
      "})",
      "local function test()",
      "  local s = 0",
      "  for _, v in iterable do",
      "    s += v",
      "  end",
      "  return s",
      "end",
      "print(test())",
    ],
    expected: "12",
  },
  {
    name: "compound-and-arithmetic-operators",
    source: [
      "local function test()",
      "  local x = 7",
      "  x += 3",
      "  x -= 1",
      "  x *= 2",
      "  x //= 3",
      "  x %= 5",
      "  local y = 2",
      "  y ^= 3",
      "  local s = 'a'",
      "  s ..= 'b'",
      "  return x, y, s",
      "end",
      "print(test())",
    ],
    expected: "1\t8\tab",
  },
  {
    name: "logical-short-circuit-and-concat",
    source: [
      "local function test()",
      "  local n = 0",
      "  local function tick() n += 1 return true end",
      "  local a = false and tick()",
      "  local b = true or tick()",
      "  local c = tick() and 'x' or 'y'",
      "  return tostring(a) .. tostring(b) .. c .. n",
      "end",
      "print(test())",
    ],
    expected: "falsetruex1",
  },
  {
    name: "method-call-self",
    source: [
      "local object = {}",
      "function object:add(v)",
      "  self.total = (self.total or 0) + v",
      "  return self.total",
      "end",
      "local function test()",
      "  return object:add(3), object:add(4)",
      "end",
      "print(test())",
    ],
    expected: "3\t7",
  },
  {
    name: "varargs-and-multiple-return",
    source: [
      "local function helper(...)",
      "  return select('#', ...), ...",
      "end",
      "local function test(...)",
      "  local a, b = ...",
      "  local packed = {0, ...}",
      "  local hn, ha, hb = helper(a, b)",
      "  return hn, ha, hb, #packed",
      "end",
      "print(test(4, 5))",
    ],
    expected: "2\t4\t5\t3",
  },
  {
    name: "recursion-and-tail-call",
    source: [
      "local function test(n, acc)",
      "  acc = acc or 1",
      "  if n <= 1 then return acc end",
      "  return test(n - 1, acc * n)",
      "end",
      "print(test(5))",
    ],
    expected: "120",
  },
  {
    name: "table-constructor-forms",
    source: [
      "local function values() return 4, 5 end",
      "local function test()",
      "  local t = {a = 1, [2] = 3, values()}",
      "  return t.a, t[1], t[2]",
      "end",
      "print(test())",
    ],
    expected: "1\t4\t5",
  },
  {
    name: "string-interpolation",
    source: [
      "local function test(a)",
      "  return `value={a + 1}`",
      "end",
      "print(test(2))",
    ],
    expected: "value=3",
  },
  {
    name: "types-generics-typepacks",
    source: [
      "export type Pair = { first: number, second: number }",
      "type Callback = (number, ...number) -> (boolean, ...number)",
      "local function test<T>(value: T): T",
      "  local copy: T = value",
      "  return copy",
      "end",
      "print(test(7))",
    ],
    expected: "7",
  },
  {
    name: "coroutine-and-pcall-globals",
    source: [
      "local function worker(v)",
      "  coroutine.yield(v + 1)",
      "  return v + 2",
      "end",
      "local function test()",
      "  local co = coroutine.create(worker)",
      "  local ok, a = coroutine.resume(co, 4)",
      "  local ok2, b = coroutine.resume(co)",
      "  local ok3 = pcall(function() return 1 end)",
      "  return ok, a, ok2, b, ok3",
      "end",
      "print(test())",
    ],
    expected: "true\t5\ttrue\t6\ttrue",
  },
  {
    name: "nested-function-expression-closure-read",
    source: [
      "local function test()",
      "  local x = 2",
      "  local f = function(y)",
      "    return x + y",
      "  end",
      "  return f(3)",
      "end",
      "print(test())",
    ],
    expected: "5",
  },
  {
    name: "nested-function-expression-closure-write",
    source: [
      "local function test()",
      "  local x = 2",
      "  local f = function(y)",
      "    x += 1",
      "    return x + y",
      "  end",
      "  local a = f(3)",
      "  return a, x",
      "end",
      "print(test())",
    ],
    expected: "6\t3",
  },
  {
    name: "closed-upvalue-returned-closure",
    source: [
      "local function test()",
      "  local x = 10",
      "  return function(d)",
      "    x += d",
      "    return x",
      "  end",
      "end",
      "local f = test()",
      "print(f(1), f(2))",
    ],
    expected: "11\t13",
  },
  {
    name: "numeric-loop-capture",
    source: [
      "local function test()",
      "  local fs = {}",
      "  for i = 1, 3 do",
      "    fs[i] = function() return i end",
      "  end",
      "  return fs[1](), fs[2](), fs[3]()",
      "end",
      "print(test())",
    ],
    expected: "1\t2\t3",
  },
  {
    name: "generic-loop-capture",
    source: [
      "local function test()",
      "  local gs = {}",
      "  for _, v in {10, 20, 30} do",
      "    gs[#gs + 1] = function() return v end",
      "  end",
      "  return gs[1](), gs[2](), gs[3]()",
      "end",
      "print(test())",
    ],
    expected: "10\t20\t30",
  },
  {
    name: "multi-level-upvalue-forwarding",
    source: [
      "local function test()",
      "  local x = 1",
      "  local function a()",
      "    local function b()",
      "      x += 1",
      "      return x",
      "    end",
      "    return b",
      "  end",
      "  local b = a()",
      "  return b(), b(), x",
      "end",
      "print(test())",
    ],
    expected: "2\t3\t3",
  },
];

async function obfuscateCase(testCase) {
  const fn = testCase.functionName || "test";
  const { code } = await obfuscateLuau(testCase.source.join("\n"), {
    lang: "luau",
    luauParser: "custom",
    vm: createCoverageVmOptions(fn),
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: `vm-coverage-${testCase.name}`,
  });
  parseCustom(code);
  return code;
}

async function assertVmSandbox() {
  const source = [
    "local function test()",
    "  local g = _G",
    "  local a = debug",
    "  local b = getfenv",
    "  local c = g and g.debug",
    "  local d = rawget and rawget(g, 'getfenv')",
    "  return a == nil, b == nil, c == nil, d == nil",
    "end",
    "print(test())",
  ].join("\n");
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    vm: createCoverageVmOptions("test"),
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-coverage-sandbox",
  });
  parseCustom(code);
  assert.strictEqual(
    runLuauNamed("vm-sandbox", code),
    "true\ttrue\ttrue\ttrue",
    "VM sandbox should hide debug/getfenv through globals and _G/rawget"
  );
}

(async () => {
  for (const testCase of cases) {
    const source = testCase.source.join("\n");
    assert.strictEqual(runLuauNamed(testCase.name, source), testCase.expected, `${testCase.name}: baseline should match fixture`);
    const code = await obfuscateCase(testCase);
    const shouldVirtualize = testCase.expectVirtualized !== false;
    assert.strictEqual(
      hasVmLoop(code),
      shouldVirtualize,
      `${testCase.name}: virtualization status should match coverage expectation`
    );
    assert.strictEqual(runLuauNamed(testCase.name, code), testCase.expected, `${testCase.name}: VM output should match Luau`);
  }
  await assertVmSandbox();
  console.log("luau-vm-coverage: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
