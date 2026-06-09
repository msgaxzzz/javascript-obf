const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { obfuscateLuau, MAX_LUAU_OUTPUT_BYTES } = require("../src/luau");
const { normalizeOptions } = require("../src/options");
const { parse: parseCustom } = require("../src/luau/custom/parser");
const { __test: vmInternals } = require("../src/luau/vm");

const source = [
  "local function demo(a, b)",
  "  local c = a + b",
  "  if c > 3 then",
  "    return c",
  "  end",
  "  return a - b",
  "end",
].join("\n");

function hasVmLoop(code) {
  return code.includes("while true do") || /while\s+[A-Za-z_][A-Za-z0-9_]*\s*~=\s*0\s*do/.test(code);
}

function hasRuntimeToolkitBundle(code) {
  return /local\s+\w+\s*=\s*\{\s*[^}]*(?:\.char|\\099\\104\\097\\114)[^}]*(?:\.byte|\\098\\121\\116\\101)[^}]*(?:\.concat|\\099\\111\\110\\099\\097\\116)[^}]*(?:\.pack|\\112\\097\\099\\107)[^}]*(?:\.unpack|\\117\\110\\112\\097\\099\\107)[^}]*(?:\.floor|\\102\\108\\111\\111\\114)[^}]*\}/.test(code);
}

function countRuntimeToolkitBundles(code) {
  const matches = code.match(/local\s+\w+\s*=\s*\{\s*[^}]*(?:\.char|\\099\\104\\097\\114)[^}]*(?:\.byte|\\098\\121\\116\\101)[^}]*(?:\.concat|\\099\\111\\110\\099\\097\\116)[^}]*(?:\.pack|\\112\\097\\099\\107)[^}]*(?:\.unpack|\\117\\110\\112\\097\\099\\107)[^}]*(?:\.floor|\\102\\108\\111\\111\\114)[^}]*\}/g);
  return matches ? matches.length : 0;
}

function hasPackedShellShape(code) {
  return /return\s*\(function\(\.\.\.\)/.test(code)
    && /\[\[/.test(code)
    && /return\s+\w+\(\w+,\w+,\.\.\.\);end\)\(\.\.\.\)\s*$/.test(code);
}

function hasPackedShellObfPrefix(code) {
  return code.includes("__obf_");
}

function hasEscapedNewlineLiteral(code) {
  return code.includes("\\n");
}

function hasPackedLookupTableShape(code) {
  return /local\s+\w+\s*=\s*\{\d+(?:,\d+){8,}\};local\s+\w+\s*=\s*\{\};for\s+\w+\s*=\s*1,\s*#\w+\s*do\s+\w+\[string\.byte\(/.test(code);
}

function hasPackedDecodeTailShape(code) {
  return /for\s+\w+\s*=\s*1,\s*#\w+\s*,\s*5\s*do[\s\S]*table\.concat\(\w+\):sub\(1,\w+\)[\s\S]*loadstring\s+or\s+load/.test(code);
}

function getPackedShellHeadBeforePayload(code) {
  const payloadMarker = code.indexOf("=[");
  if (payloadMarker === -1) {
    return code;
  }
  return code.slice(0, payloadMarker);
}

function hasPackedFrontLoadedDecodeShape(code) {
  const head = getPackedShellHeadBeforePayload(code);
  return /string\.byte\(\w+,1\)[\s\S]*math\.floor\(/.test(head);
}

function hasPackedFrontLoadedLoaderShape(code) {
  const head = getPackedShellHeadBeforePayload(code);
  return /"loa"|dstr|"ad"|getfenv|_ENV|_G/.test(head);
}

function hasOpcodePairsEncodingShape(code) {
  return /local\s+\w+\s*=\s*"[^"]*\\95\\/.test(code);
}

function hasSyncLocalIfChain(code) {
  return /local function \w+\(idx, value\)[\s\S]*if idx == \d+ then/.test(code);
}

function hasSyncLocalSetterTable(code) {
  return /local \w+=\{\}[\s\S]*\[\d+\]=\w+/.test(code) || /local \w+ = \{\}[\s\S]*\[\d+\] = \w+/.test(code);
}

function hasFixedBytecodeStride17(code) {
  return code.includes("mix = mix * 17");
}

function hasTableMoveExpandArgs(code) {
  return code.includes(".move(")
    || code.includes('["table"].move')
    || code.includes("\\109\\111\\118\\101");
}

function createSemanticVmOptions(functionName) {
  return {
    enabled: true,
    include: [functionName],
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

async function obfuscateSemanticVm(sourceText, functionName, seed) {
  const { code } = await obfuscateLuau(sourceText, {
    lang: "luau",
    luauParser: "custom",
    vm: createSemanticVmOptions(functionName),
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed,
  });
  parseCustom(code);
  return code;
}

function compileVmFunctionInstructions(sourceText, functionName) {
  assert(
    vmInternals && typeof vmInternals.VmCompiler === "function",
    "vm internals should expose VmCompiler"
  );
  const ast = parseCustom(sourceText);
  let target = null;
  walkAst(ast, (node) => {
    if (target || !node || node.type !== "FunctionDeclaration") {
      return;
    }
    const name = node.name && node.name.base && node.name.base.name;
    if (name === functionName) {
      target = node;
    }
  });
  assert(target, `expected function ${functionName} in test source`);
  const compiler = new vmInternals.VmCompiler({
    style: "custom",
    options: { vm: {} },
  });
  return compiler.compileFunction(target).instructions;
}

function compileVmFunctionProgram(sourceText, functionName) {
  assert(
    vmInternals && typeof vmInternals.VmCompiler === "function",
    "vm internals should expose VmCompiler"
  );
  const ast = parseCustom(sourceText);
  let target = null;
  walkAst(ast, (node) => {
    if (target || !node || node.type !== "FunctionDeclaration") {
      return;
    }
    const name = node.name && node.name.base && node.name.base.name;
    if (name === functionName) {
      target = node;
    }
  });
  assert(target, `expected function ${functionName} in test source`);
  const compiler = new vmInternals.VmCompiler({
    style: "custom",
    options: { vm: {} },
  });
  return compiler.compileFunction(target);
}

function runLuau(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "js-obf-luau-vm-"));
  const file = path.join(dir, "case.luau");
  const keepFailedArtifacts = process.env.JS_OBF_KEEP_FAILED_LUAU === "1";
  try {
    fs.writeFileSync(file, code, "utf8");
    const result = spawnSync("luau", [file], { encoding: "utf8" });
    if (result.status !== 0) {
      if (keepFailedArtifacts) {
        const preserved = path.join(os.tmpdir(), `js-obf-luau-vm-failed-${Date.now()}.luau`);
        fs.copyFileSync(file, preserved);
        const details = [
          `preserved failing luau case at ${preserved}`,
          result.stderr || result.stdout || `luau exited with code ${result.status}`,
        ].filter(Boolean).join("\n");
        throw new Error(details);
      }
      throw new Error(result.stderr || result.stdout || `luau exited with code ${result.status}`);
    }
    return result.stdout.trim();
  } finally {
    if (!keepFailedArtifacts) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function runCustom() {
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    vm: true,
    cff: false,
    strings: false,
    rename: false,
    seed: "vm-custom",
  });
  parseCustom(code);
  assert.ok(hasVmLoop(code), "custom parser should emit VM loop");
  assert.ok(hasRuntimeToolkitBundle(code), "custom parser should emit runtime toolkit bundle");
  assert.ok(/0[xX][0-9A-Fa-f_]+|0[bB][01_]+/.test(code), "custom parser should emit mixed numeric literal style");
}


async function runCustomLayered() {
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    vm: { enabled: true, layers: 2 },
    cff: false,
    strings: false,
    rename: false,
    seed: "vm-custom-layered",
  });
  parseCustom(code);
}

async function runCustomPolymorph() {
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    vm: {
      enabled: true,
      layers: 1,
      blockDispatch: true,
      dispatchGraph: "sparse",
      stackProtocol: "api",
      isaPolymorph: true,
      fakeEdges: true,
    },
    cff: false,
    strings: false,
    rename: false,
    seed: "vm-custom-polymorph",
  });
  parseCustom(code);
  assert.ok(hasVmLoop(code), "custom parser should emit sparse block dispatch loop");
}

async function runCustomTopLevel() {
  const topLevelSource = [
    "local function helper(v)",
    "  return v + 1",
    "end",
    "local a = helper(1)",
    "if a > 0 then",
    "  print(\"ok\")",
    "end",
  ].join("\n");
  const { code } = await obfuscateLuau(topLevelSource, {
    lang: "luau",
    luauParser: "custom",
    vm: { enabled: true, topLevel: true },
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-custom-top-level",
  });
  parseCustom(code);
  assert.ok(hasVmLoop(code), "top-level chunk should emit VM loop");
  assert.ok(code.includes("local function helper"), "top-level local function prelude should be preserved");
  assert.ok(hasRuntimeToolkitBundle(code), "top-level chunk should emit runtime toolkit bundle");
}

function runPackedShellNormalizationDefaults() {
  const options = normalizeOptions({
    lang: "luau",
    luauParser: "custom",
    vm: {
      enabled: true,
      shellStyle: "packed",
    },
  });

  assert.strictEqual(options.vm.shellStyle, "packed", "packed shell style should be normalized");
}

function runPackedShellNormalizationOverride() {
  const options = normalizeOptions({
    lang: "luau",
    luauParser: "custom",
    vm: {
      enabled: true,
      shellStyle: "packed",
      include: ["beta"],
      topLevel: false,
    },
  });

  assert.strictEqual(options.vm.shellStyle, "packed", "packed shell style should remain enabled");
  assert.deepStrictEqual(options.vm.include, ["beta"], "packed shell should respect explicit include overrides");
}

function runVmModeNormalizationDefaults() {
  const options = normalizeOptions({
    lang: "luau",
    luauParser: "custom",
    vm: true,
  });

  assert.strictEqual(options.vm.mode, "compact", "vm: true should default to compact mode");
  assert.strictEqual(options.vm.fakeOpcodes, 0, "compact mode should default fake opcodes off");
  assert.strictEqual(options.vm.decoyRuntime, false, "compact mode should default decoy runtime off");
  assert.strictEqual(options.vm.symbolNoise, false, "compact mode should default symbol noise off");
  assert.strictEqual(options.vm.instructionFusion, false, "compact mode should default instruction fusion off");
  assert.strictEqual(options.vm.semanticMisdirection, false, "compact mode should default semantic misdirection off");
  assert.strictEqual(options.vm.dynamicCoupling, false, "compact mode should default dynamic coupling off");
  assert.strictEqual(options.vm.constsSplit, false, "compact mode should default const splitting off");
}

function runVmModeNormalizationOverride() {
  const options = normalizeOptions({
    lang: "luau",
    luauParser: "custom",
    vm: {
      enabled: true,
      mode: "max",
      fakeOpcodes: 0,
      decoyRuntime: false,
      symbolNoise: false,
    },
  });

  assert.strictEqual(options.vm.mode, "max", "explicit vm mode should be preserved");
  assert.strictEqual(options.vm.fakeOpcodes, 0, "explicit fake opcode override should win");
  assert.strictEqual(options.vm.decoyRuntime, false, "explicit decoy override should win");
  assert.strictEqual(options.vm.symbolNoise, false, "explicit symbol-noise override should win");
  assert.strictEqual(options.vm.instructionFusion, true, "max mode should keep heavy defaults when not overridden");
}

function runLuauOutputSizeLimit() {
  assert.strictEqual(
    MAX_LUAU_OUTPUT_BYTES,
    5 * 1024 * 1024,
    "Luau output size limit should allow up to 5 MB before fallback or failure"
  );
}

function runSeedRangeFix() {
  assert(vmInternals && typeof vmInternals.computeSeedFromPieces === "function", "vm internals should expose computeSeedFromPieces");
  const seen = new Set();
  for (let a = 1; a <= 32; a += 1) {
    for (let b = 1; b <= 32; b += 1) {
      for (let bc = 0; bc <= 32; bc += 1) {
        const seed = vmInternals.computeSeedFromPieces([a, b], bc, a + b);
        assert(seed >= 0 && seed <= 255, "seed should stay in byte range");
        seen.add(seed);
      }
    }
  }
  assert.strictEqual(
    vmInternals.computeSeedFromPieces([1], 255, 0),
    255,
    "seed generation should be able to reach 255 after widening beyond mod 255"
  );
}

function runVmPreboundLocalCaptureNarrowing() {
  assert(
    vmInternals && typeof vmInternals.collectPreboundLocalsForFunction === "function",
    "vm internals should expose collectPreboundLocalsForFunction"
  );

  const hardProjectSource = fs.readFileSync(
    path.join(__dirname, "luau-hard-project.lua"),
    "utf8"
  );
  const ast = parseCustom(hardProjectSource);
  const byName = new Map();
  walkAst(ast, (node) => {
    if (node && node.type === "FunctionDeclaration") {
      const name = node.name && node.name.base && node.name.base.name;
      if (typeof name === "string") {
        byName.set(name, node);
      }
    }
  });

  assert.deepStrictEqual(
    vmInternals.collectPreboundLocalsForFunction(ast, byName.get("stableHash")),
    [],
    "top-level local functions should not prebind earlier sibling locals they do not reference"
  );
  assert.deepStrictEqual(
    vmInternals.collectPreboundLocalsForFunction(ast, byName.get("withRetry")),
    [],
    "top-level local functions should not prebind unrelated earlier sibling locals"
  );
}

function runVmProtoUpvalueDescriptorMetadata() {
  const nestedSource = [
    "local function outer()",
    "  local x = 1",
    "  local function mid()",
    "    local function inner()",
    "      x += 1",
    "      return x",
    "    end",
    "    return inner",
    "  end",
    "  return mid",
    "end",
  ].join("\n");

  const program = compileVmFunctionProgram(nestedSource, "outer");
  assert.strictEqual(program.closures.length, 1, "outer should serialize mid as a child prototype");
  const midClosure = program.closures[0];
  assert.strictEqual(midClosure.upvalueDescriptors.length, 1, "mid should have one explicit upvalue descriptor");
  assert.deepStrictEqual(
    {
      type: midClosure.upvalueDescriptors[0].type,
      captureType: midClosure.upvalueDescriptors[0].captureType,
      inStack: midClosure.upvalueDescriptors[0].inStack,
      name: midClosure.upvalueDescriptors[0].debugName,
      childIndex: midClosure.upvalueDescriptors[0].childIndex,
    },
    {
      type: "local",
      captureType: "ref",
      inStack: true,
      name: "x",
      childIndex: 1,
    },
    "capturing a parent stack local should use an explicit REF descriptor"
  );

  const midProgram = midClosure.program;
  assert.strictEqual(midProgram.closures.length, 1, "mid should serialize inner as a nested child prototype");
  const innerDescriptor = midProgram.closures[0].upvalueDescriptors[0];
  assert.deepStrictEqual(
    {
      type: innerDescriptor.type,
      captureType: innerDescriptor.captureType,
      inStack: innerDescriptor.inStack,
      name: innerDescriptor.debugName,
      childIndex: innerDescriptor.childIndex,
      sourceType: innerDescriptor.source && innerDescriptor.source.type,
    },
    {
      type: "upvalue",
      captureType: "upvalue",
      inStack: false,
      name: "x",
      childIndex: 1,
      sourceType: "local",
    },
    "forwarding a parent upvalue should use an explicit UPVAL descriptor"
  );

  assert(
    vmInternals.renderVmProtoTree(program).includes('{ 1, 1, 2, "x", 1, 2, 1 }'),
    "serialized proto tree should include deterministic REF descriptor metadata"
  );
  assert(
    vmInternals.renderVmProtoTree(program).includes('{ 2, 1, 1, "x", 0, 1, 2 }'),
    "serialized proto tree should include deterministic UPVAL descriptor metadata"
  );
}

function runVmCloseUpvalueInstructionCoverage() {
  const escapingSource = [
    "local function factory()",
    "  local x = 0",
    "  return function()",
    "    x += 1",
    "    return x",
    "  end",
    "end",
  ].join("\n");
  const escapingProgram = compileVmFunctionProgram(escapingSource, "factory");
  assert.ok(
    escapingProgram.instructions.some((inst) => inst[0] === "CLOSE_UPVALUES"),
    "returning an escaping closure should emit CLOSE_UPVALUES before leaving the frame"
  );

  const repeatSource = [
    "local function test(flag)",
    "  local out = {}",
    "  repeat",
    "    local x = 1",
    "    out[#out + 1] = function() return x end",
    "    if flag then",
    "      continue",
    "    end",
    "    flag = true",
    "  until function() return flag and out[1]() == 1 end",
    "  return out[1]()",
    "end",
  ].join("\n");
  const repeatProgram = compileVmFunctionProgram(repeatSource, "test");
  assert.ok(
    repeatProgram.instructions.some((inst) => inst[0] === "CLOSE_UPVALUES"),
    "repeat/until paths that capture body locals should emit CLOSE_UPVALUES"
  );
}

async function runSyncLocalLeakHardening() {
  const capturedNameSource = [
    "local exposedSecretValue = 1",
    "local function inc()",
    "  exposedSecretValue = exposedSecretValue + 1",
    "  return exposedSecretValue",
    "end",
    "print(inc())",
  ].join("\n");

  const code = await obfuscateSemanticVm(capturedNameSource, "inc", "vm-sync-local-shield");
  assert.ok(!hasSyncLocalIfChain(code), "syncLocal should no longer emit a visible if idx == N chain");
  assert.ok(hasSyncLocalSetterTable(code), "syncLocal should use an indirect setter table");
}

async function runBytecodeStrideHardening() {
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    vm: {
      enabled: true,
      mode: "compact",
      include: ["demo"],
      opcodeShuffle: false,
      runtimeKey: false,
      runtimeSplit: true,
      bytecodeEncrypt: true,
      constsEncrypt: false,
      fakeOpcodes: 0,
    },
    cff: false,
    strings: false,
    rename: false,
    seed: "vm-bytecode-hardening",
  });

  parseCustom(code);
  assert.ok(!hasFixedBytecodeStride17(code), "bytecode runtime should not expose the fixed stride 17 decoder anymore");
}

async function runExpandArgsOptimization() {
  const expandSource = [
    "local function pair()",
    "  return 1, 2",
    "end",
    "local function f(...)",
    "  return select('#', ...), ...",
    "end",
    "local function test()",
    "  return f(pair())",
    "end",
    "local n, a, b = test()",
    "print(n, a, b)",
  ].join("\n");

  const code = await obfuscateSemanticVm(expandSource, "test", "vm-expand-args-optimized");
  assert.strictEqual(runLuau(code), "2\t1\t2", "optimized expandArgs path should preserve vararg expansion behavior");
  assert.ok(hasTableMoveExpandArgs(code), "expandArgs should use table.move when available");
}

async function runVarargVmRegression() {
  const varargSource = [
    "local function f(...)",
    "  return select('#', ...), ...",
    "end",
    "local function test(...)",
    "  local n = select('#', ...)",
    "  local a, b = ...",
    "  local packed = {0, ...}",
    "  local x, y, z = f(7, ...)",
    "  return n, a, b, #packed, packed[1], packed[2], packed[3], x, y, z",
    "end",
    "local n, a, b, len, p0, p1, p2, x, y, z = test(4, 5)",
    "print(n, a, b, len, p0, p1, p2, x, y, z)",
  ].join("\n");

  const code = await obfuscateSemanticVm(varargSource, "test", "vm-vararg-regression");
  assert.ok(hasVmLoop(code), "vararg functions should be virtualized instead of skipped");
  assert.strictEqual(
    runLuau(code),
    "2\t4\t5\t3\t0\t4\t5\t3\t7\t4",
    "VM should preserve vararg count, fixed reads, call-tail expansion, and table-tail expansion"
  );
}

async function runGeneralizedIterationVmRegression() {
  const iterSource = [
    "local function test()",
    "  local sum = 0",
    "  for _, v in {1, 2, 3} do",
    "    sum += v",
    "  end",
    "  return sum",
    "end",
    "print(test())",
  ].join("\n");

  const code = await obfuscateSemanticVm(iterSource, "test", "vm-generalized-iteration");
  assert.strictEqual(
    runLuau(code),
    "6",
    "VM generic-for should support Luau direct table iteration"
  );
}

async function runBlockDispatchSemanticRegression() {
  const blockSource = [
    "local function test(a, b)",
    "  local c = a + b",
    "  return c * 2",
    "end",
    "print(test(2, 5))",
  ].join("\n");

  const { code } = await obfuscateLuau(blockSource, {
    lang: "luau",
    luauParser: "custom",
    vm: {
      ...createSemanticVmOptions("test"),
      blockDispatch: true,
    },
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-block-dispatch-semantic",
  });

  assert.strictEqual(
    runLuau(code),
    "14",
    "block dispatch should execute ordinary stack opcodes instead of treating unknown direct-block opcodes as nops"
  );
}

async function runAlternateOpcodeEncodingMode() {
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    vm: {
      enabled: true,
      mode: "compact",
      opcodeEncoding: "pairs",
      opcodeShuffle: false,
      bytecodeEncrypt: false,
      constsEncrypt: false,
      runtimeKey: false,
      runtimeSplit: false,
    },
    cff: false,
    strings: false,
    rename: false,
    seed: "vm-opcode-pairs",
  });

  parseCustom(code);
  assert.ok(hasOpcodePairsEncodingShape(code), "alternate opcode encoding should emit escaped pair payload fragments");
}

async function runMinimalSemanticVmRegression() {
  const semanticSource = [
    "local function demo(a, b)",
    "  local sum = a + b",
    "  return sum * 2",
    "end",
    "print(demo(2, 5))",
  ].join("\n");

  const code = await obfuscateSemanticVm(
    semanticSource,
    "demo",
    "vm-minimal-semantic-regression"
  );

  assert.strictEqual(
    runLuau(code),
    "14",
    "minimal semantic VM function should preserve local loads, stores, const pushes, and arithmetic"
  );
  assert.ok(code.includes("\\112\\114\\105\\110\\116"), "masked global print lookup should use escaped byte key");
  assert.ok(!code.includes('["print"]') && !code.includes('"print"'), "masked global print lookup should not expose plaintext print key");
}

async function runSharedRuntimePreludeHoistRegression() {
  const sourceText = [
    "local function add1(a, b)",
    "  local sum = a + b",
    "  return sum + 1",
    "end",
    "local function add2(a, b)",
    "  local sum = a + b",
    "  return sum + 2",
    "end",
    "print(add1(2, 5), add2(2, 5))",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceText, {
    lang: "luau",
    luauParser: "custom",
    vm: {
      ...createSemanticVmOptions("add1"),
      include: ["add1", "add2"],
    },
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    seed: "vm-shared-runtime-prelude",
  });

  assert.strictEqual(runLuau(code), "8\t9", "shared runtime prelude should preserve multi-function VM semantics");
  assert.strictEqual(
    countRuntimeToolkitBundles(code),
    1,
    "multiple VM functions should share a single runtime toolkit prelude"
  );
}

function runRegisterLocalCompilerFastPaths() {
  const registerizedSource = [
    "local function sumTo(n)",
    "  local sum = 0",
    "  for i = 1, n do",
    "    sum = sum + i",
    "    sum += 1",
    "  end",
    "  return sum",
    "end",
  ].join("\n");

  const instructions = compileVmFunctionInstructions(registerizedSource, "sumTo");
  const opNames = instructions.map((inst) => inst[0]);
  assert.ok(
    opNames.includes("ADD_REG_LOCAL"),
    "compiler should emit local-register add for hot local-to-local updates"
  );
  assert.ok(
    opNames.includes("ADD_REG_CONST"),
    "compiler should emit local-register add for hot local-to-const updates"
  );
  assert.ok(
    opNames.includes("JMP_IF_LOCAL_LE") && opNames.includes("JMP_IF_LOCAL_GE"),
    "compiler should emit local-register compare jumps for numeric for-loop bounds"
  );
}

function runRegisterLocalBranchCompilerFastPaths() {
  const branchSource = [
    "local function scan(a, b)",
    "  while a < b do",
    "    a += 1",
    "  end",
    "  if a >= b then",
    "    a -= 1",
    "  end",
    "  if a <= b then",
    "    a += 2",
    "  end",
    "  return a",
    "end",
  ].join("\n");

  const instructions = compileVmFunctionInstructions(branchSource, "scan");
  const opNames = instructions.map((inst) => inst[0]);
  assert.ok(
    opNames.includes("JMP_IF_LOCAL_GE"),
    "compiler should use direct local compare jump for while local < local conditions"
  );
  assert.ok(
    opNames.includes("JMP_IF_LOCAL_LT"),
    "compiler should use direct local compare jump for if local >= local conditions"
  );
  assert.ok(
    opNames.includes("JMP_IF_LOCAL_GT"),
    "compiler should use direct local compare jump for if local <= local conditions"
  );
}

async function runRegisterLocalVmRegression() {
  const registerizedSource = [
    "local function sumTo(n)",
    "  local sum = 0",
    "  for i = 1, n do",
    "    sum = sum + i",
    "    sum += 1",
    "  end",
    "  return sum",
    "end",
    "print(sumTo(4))",
  ].join("\n");

  const code = await obfuscateSemanticVm(
    registerizedSource,
    "sumTo",
    "vm-register-local-regression"
  );

  assert.strictEqual(
    runLuau(code),
    "14",
    "register/local fast paths should preserve loop semantics"
  );
}

async function runRegisterLocalBranchVmRegression() {
  const branchSource = [
    "local function scan(a, b)",
    "  local total = 0",
    "  while a < b do",
    "    total += a",
    "    a += 1",
    "  end",
    "  if a >= b then",
    "    total += 2",
    "  end",
    "  if a <= b then",
    "    total += 3",
    "  end",
    "  return total",
    "end",
    "print(scan(1, 4))",
  ].join("\n");

  const code = await obfuscateSemanticVm(
    branchSource,
    "scan",
    "vm-register-local-branch-regression"
  );

  assert.strictEqual(
    runLuau(code),
    "11",
    "register/local compare jumps should preserve while/if semantics"
  );
}

async function runPackedShellWholeProgramDefault() {
  const packedSource = [
    "local function demo(a, b)",
    "  local sum = a + b",
    "  return sum * 2",
    "end",
    "print(demo(2, 5))",
  ].join("\n");

  const { code } = await obfuscateLuau(packedSource, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: true,
    dead: false,
    cff: false,
    wrap: true,
    vm: {
      enabled: true,
      shellStyle: "packed",
    },
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: true,
    },
    seed: "vm-packed-whole-program",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "14", "packed shell whole-program output should still execute");
  assert.ok(hasPackedShellShape(code), "packed shell mode should emit a packed loader shape");
}

async function runPackedShellPayloadConcealment() {
  const packedSource = [
    "local function demo()",
    "  local lines = {",
    "    'alpha',",
    "    'beta',",
    "  }",
    "  return table.concat(lines, '|')",
    "end",
    "print(demo())",
  ].join("\n");

  const { code } = await obfuscateLuau(packedSource, {
    lang: "luau",
    luauParser: "custom",
    strings: false,
    rename: false,
    dead: false,
    cff: false,
    wrap: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    vm: {
      enabled: true,
      shellStyle: "packed",
    },
    seed: "vm-packed-loader-surface",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "alpha|beta", "packed payload shell should still execute");
  assert.ok(hasPackedShellShape(code), "packed payload shell should keep a loader shape");
  assert.ok(!hasPackedShellObfPrefix(code), "packed payload shell should not expose __obf_* loader locals");
  assert.ok(!hasEscapedNewlineLiteral(code), "packed shell should not materialize source chunks through \\n escape literals");
  assert.ok(!code.includes("loadstring"), "packed payload shell should not expose a visible loadstring name");
  assert.ok(!code.includes("local function demo"), "packed payload shell should not expose plaintext function bodies");
  assert.ok(!hasPackedFrontLoadedDecodeShape(code), "packed payload shell should not front-load the decode helper before payload data");
  assert.ok(!hasPackedFrontLoadedLoaderShape(code), "packed payload shell should not front-load loader selection hints before payload data");
  assert.ok(!hasPackedLookupTableShape(code), "packed payload shell should not expose explicit numeric key tables and reverse lookup maps");
  assert.ok(!hasPackedDecodeTailShape(code), "packed payload shell should not expose a straight-line decode tail at the end");
}

async function runPackedShellExplicitIncludeOverride() {
  const packedOverrideSource = [
    "local function alpha()",
    "  return 4",
    "end",
    "local function beta()",
    "  return alpha() + 3",
    "end",
    "print(beta())",
  ].join("\n");

  const { code } = await obfuscateLuau(packedOverrideSource, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: true,
    dead: false,
    cff: false,
    wrap: true,
    vm: {
      enabled: true,
      shellStyle: "packed",
      include: ["beta"],
      topLevel: false,
    },
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: true,
    },
    seed: "vm-packed-explicit-include",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "7", "packed shell explicit include output should still execute");
  assert.ok(hasPackedShellShape(code), "packed shell mode should keep its packed loader shape with explicit include overrides");
}

async function runPackedShellHardProjectRegression() {
  const hardProjectSource = fs.readFileSync(
    path.join(__dirname, "luau-hard-project.lua"),
    "utf8"
  );
  const expectedLines = [
    "trace=4 hottest=expand",
    "[$TOP] delta => 480 (burst)",
    "[$TOP] beta => 421 (burst)",
    "[$REST] alpha => 240 (mixed)",
    "[$REST] gamma => 158 (burst)",
  ];
  const createSharedOptions = () => ({
    lang: "luau",
    luauParser: "custom",
    filename: "luau-hard-project.lua",
    preset: "high",
    strings: true,
    cff: true,
    dead: true,
    rename: true,
    wrap: true,
    numbers: true,
    constArray: true,
    padFooter: true,
    proxifyLocals: false,
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: true,
      homoglyphs: false,
    },
    seed: "hard-project-sourcemap",
  });

  const { code: nonPackedCode } = await obfuscateLuau(hardProjectSource, {
    ...createSharedOptions(),
    vm: {
      enabled: true,
      all: true,
      topLevel: true,
    },
  });
  parseCustom(nonPackedCode);
  const nonPackedOutput = runLuau(nonPackedCode);
  expectedLines.forEach((line) => {
    assert.ok(
      nonPackedOutput.includes(line),
      `non-packed hard project output should include ${line}`
    );
  });

  const { code: packedCode } = await obfuscateLuau(hardProjectSource, {
    ...createSharedOptions(),
    vm: {
      enabled: true,
      shellStyle: "packed",
    },
  });
  assert.ok(
    hasPackedShellShape(packedCode),
    "packed hard project regression should emit a packed loader before execution"
  );
  parseCustom(packedCode);
  const packedOutput = runLuau(packedCode);
  expectedLines.forEach((line) => {
    assert.ok(
      packedOutput.includes(line),
      `packed hard project output should include ${line}`
    );
  });
  assert.ok(
    !packedCode.includes("authorize_purchase_flow") &&
      !packedCode.includes("refresh_payment_session"),
    "packed hard project output should not expose fixed VM helper aliases"
  );
}

async function runWrappedVm() {
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    wrap: true,
    vm: true,
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-wrap",
  });
  parseCustom(code);
  assert.ok(hasVmLoop(code), "wrap should not prevent VM virtualization");
}

async function runNestedCallbackLift() {
  const sourceWithNestedCallback = [
    "local function setupLeaderstats(player)",
    "  local coins = Instance.new(\"IntValue\")",
    "  task.spawn(function()",
    "    while player.Parent do",
    "      task.wait(5)",
    "      coins.Value += 10",
    "    end",
    "  end)",
    "end",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithNestedCallback, {
    lang: "luau",
    luauParser: "custom",
    vm: { enabled: true, include: ["setupLeaderstats"] },
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-nested-callback-lift",
  });
  parseCustom(code);
  assert.ok(!code.includes("task.spawn(function()"), "nested callback should be lifted before VM");
  assert.ok(code.includes("local function __vm_lift_"), "lifted callback helper should be emitted");
  assert.ok(hasVmLoop(code), "host function should be virtualized after lifting");
}

function walkAst(node, visit) {
  if (!node || typeof node !== "object") {
    return;
  }
  visit(node);
  Object.keys(node).forEach((key) => {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((item) => walkAst(item, visit));
      return;
    }
    walkAst(value, visit);
  });
}

async function runNestedCallbackLiftWithParams() {
  const sourceWithParamCallback = [
    "local function scheduleTick(player)",
    "  local coins = player.leaderstats.Coins",
    "  task.spawn(function(dt)",
    "    if dt then",
    "      coins.Value += 1",
    "    end",
    "  end)",
    "end",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithParamCallback, {
    lang: "luau",
    luauParser: "custom",
    vm: { enabled: true, include: ["scheduleTick"] },
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-nested-callback-lift-param",
  });

  const ast = parseCustom(code);
  assert.ok(!code.includes("task.spawn(function("), "parameterized callback should also be lifted");
  let foundLift = false;
  walkAst(ast, (node) => {
    if (foundLift || node.type !== "FunctionDeclaration") {
      return;
    }
    const fnName = node.name && node.name.base && node.name.base.name;
    if (typeof fnName === "string" && fnName.startsWith("__vm_lift_")) {
      const params = Array.isArray(node.parameters) ? node.parameters : [];
      foundLift = params.length >= 2;
    }
  });
  assert.ok(foundLift, "lifted helper should keep callback params and append captures");
  assert.ok(hasVmLoop(code), "host function should remain virtualized");
}

async function runNestedCallbackInnerLocalGuard() {
  const sourceWithNestedLocal = [
    "ghost = 77",
    "local function host()",
    "  local function inner()",
    "    local ghost = 123",
    "    return ghost",
    "  end",
    "  task.spawn(function()",
    "    print(ghost)",
    "  end)",
    "  return inner()",
    "end",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithNestedLocal, {
    lang: "luau",
    luauParser: "custom",
    vm: { enabled: true, include: ["host"] },
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-nested-local-guard",
  });

  const ast = parseCustom(code);
  let helperParamCount = null;
  walkAst(ast, (node) => {
    if (helperParamCount !== null || node.type !== "FunctionDeclaration") {
      return;
    }
    const fnName = node.name && node.name.base && node.name.base.name;
    if (typeof fnName === "string" && fnName.startsWith("__vm_lift_")) {
      const params = Array.isArray(node.parameters) ? node.parameters : [];
      helperParamCount = params.length;
    }
  });
  assert.strictEqual(helperParamCount, 0, "lifted callback should not capture names declared only in nested functions");
}

async function runCompoundAssignmentTargets() {
  const sourceWithCompoundTargets = [
    "local function adjust(tbl, key, delta)",
    "  tbl.value += delta",
    "  tbl[key] += 1",
    "  return tbl.value + tbl[key]",
    "end",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithCompoundTargets, {
    lang: "luau",
    luauParser: "custom",
    vm: { enabled: true, include: ["adjust"] },
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-compound-targets",
  });

  parseCustom(code);
  assert.ok(hasVmLoop(code), "compound assignment member/index targets should not skip VM");
}

async function runRenamedMemberCompoundAssignment() {
  const sourceWithRenamedMetrics = [
    "local function withRetry(metrics)",
    "  metrics.attempts += 1",
    "  metrics.retries += 2",
    "  return metrics.attempts + metrics.retries",
    "end",
    "local metrics = { attempts = 0, retries = 0 }",
    "print(withRetry(metrics))",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithRenamedMetrics, {
    lang: "luau",
    luauParser: "custom",
    vm: { enabled: true, include: ["withRetry"] },
    cff: false,
    strings: false,
    rename: true,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    renameOptions: {
      renameMembers: true,
      maskGlobals: false,
    },
    seed: "vm-renamed-member-compound",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "3", "virtualized functions should preserve renamed member compound assignments");
}

async function runRenamedInsertedRecordFields() {
  const sourceWithInsertedRecords = [
    "local function demo()",
    "  local ranked = {}",
    "  table.insert(ranked, { score = 5, id = 'a' })",
    "  return ranked[1].score, ranked[1].id",
    "end",
    "print(demo())",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithInsertedRecords, {
    lang: "luau",
    luauParser: "custom",
    vm: {
      enabled: true,
      include: ["demo"],
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
    },
    cff: false,
    strings: false,
    rename: true,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: false,
      homoglyphs: false,
    },
    seed: "vm-renamed-inserted-record-fields",
  });

  parseCustom(code);
  assert.strictEqual(
    runLuau(code),
    "5\ta",
    "virtualized functions should preserve renamed record fields inserted into local arrays"
  );
}

async function runRenamedIpairsRecordFields() {
  const sourceWithIpairsRecords = [
    "local function demo()",
    "  local rows = {}",
    "  table.insert(rows, { id = 'a', weight = 4, flags = { hot = true, cold = false } })",
    "  local out = {}",
    "  for _, row in ipairs(rows) do",
    "    table.insert(out, row.id .. ':' .. tostring(row.weight) .. ':' .. tostring(row.flags.hot))",
    "  end",
    "  return table.concat(out, '|')",
    "end",
    "print(demo())",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithIpairsRecords, {
    lang: "luau",
    luauParser: "custom",
    cff: false,
    strings: false,
    rename: true,
    constArray: false,
    numbers: false,
    wrap: false,
    dead: false,
    proxifyLocals: false,
    padFooter: false,
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: false,
      homoglyphs: false,
    },
    seed: "rename-ipairs-record-fields",
  });

  parseCustom(code);
  assert.strictEqual(
    runLuau(code),
    "a:4:true",
    "renamed local record fields should stay consistent when iterating inserted rows with ipairs"
  );
}

async function runMetatableConstructorGuard() {
  const sourceWithMetatableConstructor = [
    "local Engine = {}",
    "Engine.__index = Engine",
    "function Engine.new()",
    "  local self = { nodes = {} }",
    "  return setmetatable(self, Engine)",
    "end",
    "function Engine:register(name)",
    "  self.nodes[name] = true",
    "end",
    "function Engine:has(name)",
    "  return self.nodes[name] == true",
    "end",
    "local engine = Engine.new()",
    "engine:register(\"ok\")",
    "print(engine:has(\"ok\") and \"ok\" or \"bad\")",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithMetatableConstructor, {
    lang: "luau",
    luauParser: "custom",
    vm: { enabled: true, include: ["Engine.new", "register", "has"] },
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-metatable-constructor-guard",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "ok", "metatable constructors should preserve instance method dispatch");
}

async function runWrappedVmMethodRoundtrip() {
  const wrappedMethodSource = [
    "local function shallowClone(input)",
    "  local out = {}",
    "  for key, value in pairs(input) do",
    "    out[key] = value",
    "  end",
    "  return out",
    "end",
    "local Engine = {}",
    "Engine.__index = Engine",
    "function Engine.new()",
    "  local self = { nodes = {}, order = {} }",
    "  return setmetatable(self, Engine)",
    "end",
    "function Engine:register(name, deps)",
    "  self.nodes[name] = { deps = shallowClone(deps) }",
    "  table.insert(self.order, name)",
    "end",
    "function Engine:run()",
    "  return #self.nodes.a.deps .. '|' .. self.order[1]",
    "end",
    "local engine = Engine.new()",
    "engine:register('a', { 'x' })",
    "print(engine:run())",
  ].join("\n");

  const { code } = await obfuscateLuau(wrappedMethodSource, {
    lang: "luau",
    luauParser: "custom",
    wrap: true,
    vm: { enabled: true, include: [] },
    cff: false,
    strings: true,
    rename: true,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: true,
      homoglyphs: false,
    },
    seed: "vm-wrap-method-roundtrip",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "1|a", "synthetic wrap helpers should not break VM method virtualization");
}

async function runWholeProgramNormalizeGraph() {
  const wholeProgramSource = [
    "local function shallowClone(input)",
    "  local out = {}",
    "  for key, value in pairs(input) do",
    "    out[key] = value",
    "  end",
    "  return out",
    "end",
    "local function withRetry(label, limit, thunk)",
    "  local lastError = 'unknown'",
    "  for attempt = 1, limit do",
    "    local ok, result = pcall(thunk, attempt)",
    "    if ok then",
    "      return result",
    "    end",
    "    lastError = result",
    "  end",
    "  error(`step {label} failed after {limit} attempts: {lastError}`)",
    "end",
    "local Engine = {}",
    "Engine.__index = Engine",
    "function Engine.new()",
    "  local self = { nodes = {}, order = {}, cache = {} }",
    "  return setmetatable(self, Engine)",
    "end",
    "function Engine:register(name, deps, handler)",
    "  self.nodes[name] = { deps = shallowClone(deps), handler = handler }",
    "  table.insert(self.order, name)",
    "end",
    "function Engine:_ready(node, state)",
    "  for _, dep in ipairs(node.deps) do",
    "    if state[dep] == nil then",
    "      return false",
    "    end",
    "  end",
    "  return true",
    "end",
    "function Engine:_resolve(node, state)",
    "  local resolved = {}",
    "  for _, dep in ipairs(node.deps) do",
    "    resolved[dep] = state[dep]",
    "  end",
    "  return resolved",
    "end",
    "function Engine:run(payload)",
    "  local state = { input = shallowClone(payload) }",
    "  local pending = shallowClone(self.order)",
    "  repeat",
    "    local progress = false",
    "    local nextPending = {}",
    "    for _, name in ipairs(pending) do",
    "      local node = self.nodes[name]",
    "      if not self:_ready(node, state) then",
    "        table.insert(nextPending, name)",
    "      else",
    "        local deps = self:_resolve(node, state)",
    "        state[name] = withRetry(name, 3, function(attempt)",
    "          return node.handler(deps, payload, attempt, self)",
    "        end)",
    "        progress = true",
    "      end",
    "    end",
    "    pending = nextPending",
    "    if not progress then",
    "      break",
    "    end",
    "  until #pending == 0",
    "  return state",
    "end",
    "local engine = Engine.new()",
    "engine:register('normalize', { 'input' }, function(deps, payload, attempt, runtime)",
    "  if attempt == 1 and not runtime.cache.normalizeRetried then",
    "    runtime.cache.normalizeRetried = true",
    "    error('synthetic warmup fault')",
    "  end",
    "  local rows = {}",
    "  for _, item in ipairs(deps.input.items) do",
    "    local weight = item.weight",
    "    if payload.mode == 'amplify' then",
    "      weight *= 2",
    "    end",
    "    table.insert(rows, { id = item.id, weight = weight })",
    "  end",
    "  return { rows = rows, mode = payload.mode }",
    "end)",
    "local payload = {",
    "  mode = 'amplify',",
    "  items = {",
    "    { id = 'alpha', weight = 3 },",
    "    { id = 'beta', weight = 6 },",
    "  },",
    "}",
    "local state = engine:run(payload)",
    "print(#state.normalize.rows .. ':' .. state.normalize.mode .. ':' .. state.normalize.rows[1].id)",
  ].join("\n");

  const { code } = await obfuscateLuau(wholeProgramSource, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: true,
    dead: true,
    cff: true,
    wrap: true,
    numbers: true,
    constArray: true,
    proxifyLocals: false,
    padFooter: true,
    vm: {
      enabled: true,
      all: true,
      topLevel: true,
    },
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: true,
      homoglyphs: false,
    },
    seed: "vm-whole-program-normalize-graph",
  });

  parseCustom(code);
  assert.strictEqual(
    runLuau(code),
    "2:amplify:alpha",
    "whole-program VM should preserve normalize graph payload and deps field access"
  );
}

async function runWholeProgramStateGraphRegression() {
  const stateGraphSource = [
    "local function shallowClone(input)",
    "  local out = {}",
    "  for key, value in pairs(input) do",
    "    out[key] = value",
    "  end",
    "  return out",
    "end",
    "local function stableHash(text, salt)",
    "  local acc = salt or 17",
    "  for i = 1, #text do",
    "    local byte = string.byte(text, i)",
    "    acc = (acc * 131 + byte + i * 7) % 2147483647",
    "  end",
    "  return acc",
    "end",
    "local function makeWindow(size)",
    "  local values = {}",
    "  local cursor = 1",
    "  local length = 0",
    "  local window = {}",
    "  function window:push(value)",
    "    values[cursor] = value",
    "    cursor += 1",
    "    if cursor > size then",
    "      cursor = 1",
    "    end",
    "    if length < size then",
    "      length += 1",
    "    end",
    "  end",
    "  function window:snapshot()",
    "    local out = {}",
    "    for i = 1, length do",
    "      out[i] = values[i]",
    "    end",
    "    table.sort(out, function(a, b)",
    "      return a.name < b.name",
    "    end)",
    "    return out",
    "  end",
    "  return window",
    "end",
    "local Engine = {}",
    "Engine.__index = Engine",
    "function Engine.new(seed)",
    "  local self = {",
    "    seed = seed,",
    "    nodes = {},",
    "    order = {},",
    "    cache = {},",
    "    trace = {},",
    "    window = makeWindow(6),",
    "  }",
    "  return setmetatable(self, Engine)",
    "end",
    "function Engine:register(name, deps, handler)",
    "  self.nodes[name] = {",
    "    name = name,",
    "    deps = shallowClone(deps),",
    "    handler = handler,",
    "  }",
    "  table.insert(self.order, name)",
    "end",
    "function Engine:_ready(node, state)",
    "  for _, dep in ipairs(node.deps) do",
    "    if state[dep] == nil then",
    "      return false",
    "    end",
    "  end",
    "  return true",
    "end",
    "function Engine:_resolve(node, state)",
    "  local resolved = {}",
    "  for _, dep in ipairs(node.deps) do",
    "    resolved[dep] = state[dep]",
    "  end",
    "  return resolved",
    "end",
    "function Engine:_record(name, value)",
    "  local digest = stableHash(name .. ':' .. tostring(value.score or value.value or value.digest), self.seed)",
    "  table.insert(self.trace, { name = name, digest = digest, tag = value.tag or value.mode or 'plain' })",
    "  self.window:push({ name = name, digest = digest })",
    "end",
    "function Engine:run(payload)",
    "  local state = { input = shallowClone(payload) }",
    "  local pending = shallowClone(self.order)",
    "  local progress = true",
    "  repeat",
    "    progress = false",
    "    local nextPending = {}",
    "    for _, name in ipairs(pending) do",
    "      if state[name] ~= nil then",
    "        continue",
    "      end",
    "      local node = self.nodes[name]",
    "      if not self:_ready(node, state) then",
    "        table.insert(nextPending, name)",
    "      else",
    "        local deps = self:_resolve(node, state)",
    "        local value = node.handler(deps, payload, 1, self)",
    "        state[name] = value",
    "        self:_record(name, value)",
    "        progress = true",
    "      end",
    "    end",
    "    pending = nextPending",
    "  until not progress",
    "  return state",
    "end",
    "local engine = Engine.new(77)",
    "engine:register('normalize', { 'input' }, function(deps, payload)",
    "  local rows = {}",
    "  for _, item in ipairs(deps.input.items) do",
    "    table.insert(rows, { id = item.id, weight = item.weight })",
    "  end",
    "  return { value = #rows, rows = rows, mode = payload.mode }",
    "end)",
    "engine:register('expand', { 'normalize' }, function(deps, payload)",
    "  local rows = {}",
    "  for _, row in ipairs(deps.normalize.rows) do",
    "    table.insert(rows, { id = row.id, tag = 'warm', samples = { 1 } })",
    "  end",
    "  return { rows = rows, digest = stableHash('expand:' .. tostring(#rows), payload.seed) }",
    "end)",
    "local out = engine:run({ seed = 77, mode = 'amplify', items = { { id = 'alpha', weight = 3 } } })",
    "print((out.normalize and out.normalize.rows[1].id or 'nil') .. '|' .. (out.expand and out.expand.rows[1].id or 'nil'))",
  ].join("\n");

  const { code } = await obfuscateLuau(stateGraphSource, {
    lang: "luau",
    luauParser: "custom",
    rename: false,
    strings: false,
    dead: false,
    cff: false,
    wrap: false,
    numbers: false,
    constArray: false,
    proxifyLocals: false,
    padFooter: false,
    vm: {
      enabled: true,
      all: true,
      topLevel: true,
    },
    seed: "vm-whole-program-state-graph",
  });

  parseCustom(code);
  assert.strictEqual(
    runLuau(code),
    "alpha|alpha",
    "whole-program VM should preserve state table writes and downstream deps graph reads"
  );
}

async function runVmDisablesClassicConstArrayAndCff() {
  const passthroughSource = [
    "local function shallowClone(input)",
    "  local out = {}",
    "  for key, value in pairs(input) do",
    "    out[key] = value",
    "  end",
    "  return out",
    "end",
    "local function stableHash(text, salt)",
    "  local acc = salt or 17",
    "  for i = 1, #text do",
    "    local byte = string.byte(text, i)",
    "    acc = (acc * 131 + byte + i * 7) % 2147483647",
    "  end",
    "  return acc",
    "end",
    "local function withRetry(label, limit, thunk)",
    "  local lastError = 'unknown'",
    "  for attempt = 1, limit do",
    "    local ok, result = pcall(thunk, attempt)",
    "    if ok then",
    "      return result",
    "    end",
    "    lastError = result",
    "  end",
    "  error(`step {label} failed after {limit} attempts: {lastError}`)",
    "end",
    "local payload = shallowClone({ a = 1, b = 2 })",
    "print(payload.a, payload.b, stableHash('ab', 3), withRetry('x', 2, function() return 'ok' end))",
  ].join("\n");

  const { code } = await obfuscateLuau(passthroughSource, {
    lang: "luau",
    luauParser: "custom",
    wrap: true,
    rename: true,
    strings: true,
    dead: true,
    cff: true,
    numbers: true,
    constArray: true,
    padFooter: true,
    proxifyLocals: false,
    vm: {
      enabled: true,
      include: ["shallowClone", "stableHash", "withRetry"],
      topLevel: false,
    },
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: true,
      homoglyphs: false,
    },
    seed: "vm-disable-classic-const-cff",
  });

  parseCustom(code);
  assert.strictEqual(
    runLuau(code),
    "1\t2\t65219\tok",
    "vm-targeted functions should stay correct when classic const-array and classic cff are requested"
  );
}

async function runGotoLabelSupport() {
  const sourceWithGoto = [
    "local function spin(limit)",
    "  ::start::",
    "  if limit > 0 then",
    "    goto done",
    "  end",
    "  goto start",
    "  ::done::",
    "  return limit",
    "end",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithGoto, {
    lang: "luau",
    luauParser: "custom",
    vm: { enabled: true, include: ["spin"] },
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-goto-label",
  });

  parseCustom(code);
  assert.ok(hasVmLoop(code), "goto/label should be virtualized");
}

async function runRecursiveLocalFunction() {
  const recursiveSource = [
    "local function fact(n)",
    "  if n == 0 then",
    "    return 1",
    "  end",
    "  return fact(n - 1) * n",
    "end",
    "print(fact(5))",
  ].join("\n");

  const code = await obfuscateSemanticVm(recursiveSource, "fact", "vm-recursive-local");
  assert.strictEqual(runLuau(code), "120", "local recursive functions should keep self-binding inside the VM");
}

async function runMutualRecursiveClosures() {
  const mutualSource = [
    "local function test()",
    "  local A",
    "  local B",
    "  function A(n)",
    "    if n <= 0 then return 'A' end",
    "    return B(n - 1)",
    "  end",
    "  function B(n)",
    "    if n <= 0 then return 'B' end",
    "    return A(n - 1)",
    "  end",
    "  return A(3), B(3)",
    "end",
    "print(test())",
  ].join("\n");

  const code = await obfuscateSemanticVm(mutualSource, "test", "vm-mutual-recursive-closures");
  assert.strictEqual(runLuau(code), "B\tA", "mutually recursive closures should share open upvalue cells");
}

async function runNestedShadowedCapture() {
  const shadowSource = [
    "local function test()",
    "  local x = 1",
    "  local function outer()",
    "    local x = 2",
    "    return function()",
    "      return x",
    "    end",
    "  end",
    "  local f = outer()",
    "  return x, f()",
    "end",
    "print(test())",
  ].join("\n");

  const code = await obfuscateSemanticVm(shadowSource, "test", "vm-nested-shadowed-capture");
  assert.strictEqual(runLuau(code), "1\t2", "nested closures should capture the nearest shadowed local");
}

async function runMethodClosureSharedCaptures() {
  const windowSource = [
    "local function make(size)",
    "  local values = {}",
    "  local cursor = 1",
    "  local length = 0",
    "  local window = {}",
    "  function window:push(value)",
    "    values[cursor] = value",
    "    cursor += 1",
    "    if cursor > size then cursor = 1 end",
    "    if length < size then length += 1 end",
    "  end",
    "  function window:snapshot()",
    "    local out = {}",
    "    for i = 1, length do out[i] = values[i] end",
    "    return out",
    "  end",
    "  return window",
    "end",
    "local w = make(2)",
    "w:push('b')",
    "w:push('a')",
    "local t = w:snapshot()",
    "print(t[1], t[2])",
  ].join("\n");

  const code = await obfuscateSemanticVm(windowSource, "make", "vm-method-closure-shared-captures");
  assert.strictEqual(runLuau(code), "b\ta", "method closures should share captured locals across returned table methods");
}

async function runRepeatUntilCapturedLocalCloseRuntime() {
  const repeatSource = [
    "local function test()",
    "  local fs = {}",
    "  local n = 0",
    "  repeat",
    "    n += 1",
    "    local x = n",
    "    fs[#fs + 1] = function() return x end",
    "    if n < 2 then",
    "      continue",
    "    end",
    "  until (function() return n >= 2 and fs[1]() == 1 and fs[2]() == 2 end)()",
    "  return fs[1](), fs[2]()",
    "end",
    "print(test())",
  ].join("\n");

  const code = await obfuscateSemanticVm(repeatSource, "test", "vm-repeat-until-captured-close-runtime");
  assert.strictEqual(runLuau(code), "1\t2", "repeat/until captures should keep each escaped closure bound to its own local cell");
}

async function runMultiReturnAssignment() {
  const multiAssignSource = [
    "local function pair()",
    "  return 4, 9",
    "end",
    "local function test()",
    "  local a, b = pair()",
    "  return a, b",
    "end",
    "local x, y = test()",
    "print(tostring(x) .. '|' .. tostring(y))",
  ].join("\n");

  const code = await obfuscateSemanticVm(multiAssignSource, "test", "vm-multi-assign");
  assert.strictEqual(runLuau(code), "4|9", "last-call multi assignment should preserve multiple return values");
}

async function runTailReturnExpansion() {
  const tailReturnSource = [
    "local function pair()",
    "  return 'b', 'c', 'd'",
    "end",
    "local function test()",
    "  return 'a', pair()",
    "end",
    "local w, x, y, z = test()",
    "print(table.concat({w, x, y, z}, '|'))",
  ].join("\n");

  const code = await obfuscateSemanticVm(tailReturnSource, "test", "vm-tail-return");
  assert.strictEqual(runLuau(code), "a|b|c|d", "tail-call returns should preserve all results");
}

async function runTableTailCallExpansion() {
  const tableTailSource = [
    "local function pair()",
    "  return 'x', 'y', 'z'",
    "end",
    "local function test()",
    "  local values = { pair() }",
    "  return table.concat(values, '|')",
    "end",
    "print(test())",
  ].join("\n");

  const code = await obfuscateSemanticVm(tableTailSource, "test", "vm-table-tail");
  assert.strictEqual(runLuau(code), "x|y|z", "table constructors should expand tail call results");
}

async function runNestedTableTailCallExpansion() {
  const nestedTableTailSource = [
    "local function test()",
    "  local total = 3",
    "  local result = { lines = { tostring(total) } }",
    "  return result.lines[1]",
    "end",
    "print(test())",
  ].join("\n");

  const code = await obfuscateSemanticVm(nestedTableTailSource, "test", "vm-nested-table-tail");
  assert.strictEqual(
    runLuau(code),
    "3",
    "nested table constructors should preserve tail-call list entries without corrupting outer field assignment"
  );
}

async function runAssignmentTargetOrdering() {
  const assignmentSource = [
    "local function test()",
    "  local t = { [1] = 'one', value = 'v' }",
    "  local i = 1",
    "  t.value = 'x'",
    "  t[i] = 'y'",
    "  i, t[i] = 2, 'z'",
    "  return t.value .. '|' .. t[1] .. '|' .. (t[2] or 'nil') .. '|' .. i",
    "end",
    "print(test())",
  ].join("\n");

  const code = await obfuscateSemanticVm(assignmentSource, "test", "vm-assign-targets");
  assert.strictEqual(runLuau(code), "x|z|nil|2", "assignment targets should keep Luau evaluation order");
}

async function runElseScopeIsolation() {
  const sourceWithElseLocal = [
    "x = 99",
    "local function test(flag)",
    "  if flag then",
    "  else",
    "    local x = 1",
    "  end",
    "  return x",
    "end",
    "print(test(true), test(false))",
  ].join("\n");

  const code = await obfuscateSemanticVm(sourceWithElseLocal, "test", "vm-else-scope");
  assert.strictEqual(runLuau(code), "99\t99", "else branch locals should not leak into the outer scope");
}

async function runRepeatConditionScope() {
  const repeatScopeSource = [
    "local function test()",
    "  local n = 0",
    "  local first = true",
    "  repeat",
    "    local x = first",
    "    first = false",
    "    n += 1",
    "  until not x",
    "  return n",
    "end",
    "print(test())",
  ].join("\n");

  const code = await obfuscateSemanticVm(repeatScopeSource, "test", "vm-repeat-scope");
  assert.strictEqual(runLuau(code), "2", "repeat-until conditions should see locals declared in the loop body");
}

async function runCallArgumentExpansion() {
  const callArgSource = [
    "local function pair()",
    "  return 1, 2",
    "end",
    "local function f(...)",
    "  local n = select('#', ...)",
    "  local a, b = ...",
    "  return n, a, b",
    "end",
    "local function test()",
    "  return f(pair())",
    "end",
    "local n, a, b = test()",
    "print(n, a, b)",
  ].join("\n");

  const code = await obfuscateSemanticVm(callArgSource, "test", "vm-call-arg-expand");
  assert.strictEqual(runLuau(code), "2\t1\t2", "last call arguments should expand all return values");
}

async function runSingleAssignmentOrdering() {
  const singleAssignSource = [
    "local function test()",
    "  local out = {}",
    "  local function idx()",
    "    out[#out + 1] = 'idx'",
    "    return 'k'",
    "  end",
    "  local function rhs()",
    "    out[#out + 1] = 'rhs'",
    "    return 'v'",
    "  end",
    "  local t = {}",
    "  t[idx()] = rhs()",
    "  return table.concat(out, ',')",
    "end",
    "print(test())",
  ].join("\n");

  const code = await obfuscateSemanticVm(singleAssignSource, "test", "vm-single-assign-order");
  assert.strictEqual(runLuau(code), "idx,rhs", "single table assignments should evaluate index expressions before the RHS");
}

async function runCapturedLocalWriteback() {
  const upvalueWriteSource = [
    "local x = 0",
    "local function inc()",
    "  x = x + 1",
    "  return x",
    "end",
    "print(inc(), x)",
  ].join("\n");

  const code = await obfuscateSemanticVm(upvalueWriteSource, "inc", "vm-upvalue-writeback");
  assert.strictEqual(runLuau(code), "1\t1", "writes to captured outer locals should be reflected outside the VM");
}

async function runCapturedAnonymousClosureRead() {
  const capturedClosureSource = [
    "local function outer()",
    "  local x = { value = 'ok' }",
    "  local fn = function()",
    "    return x.value",
    "  end",
    "  return fn()",
    "end",
    "print(outer())",
  ].join("\n");

  const { code } = await obfuscateLuau(capturedClosureSource, {
    lang: "luau",
    luauParser: "custom",
    vm: {
      enabled: true,
      include: [],
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
    },
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-captured-anon-read",
  });

  assert.strictEqual(
    runLuau(code),
    "ok",
    "virtualized anonymous closures should preserve captured outer locals"
  );
}

async function runFakeOpcodeRetryTableReturnRegression() {
  const retrySource = [
    "local function withRetry(limit, thunk)",
    "  local lastError = 'unknown'",
    "  for attempt = 1, limit do",
    "    local ok, result = pcall(thunk, attempt)",
    "    if ok then",
    "      return result",
    "    end",
    "    lastError = result",
    "  end",
    "  error(lastError)",
    "end",
    "local function outer()",
    "  local value = withRetry(3, function(attempt)",
    "    if attempt == 1 then",
    "      error('x')",
    "    end",
    "    return { score = attempt + 5 }",
    "  end)",
    "  return value.score",
    "end",
    "print(outer())",
  ].join("\n");

  const { code } = await obfuscateLuau(retrySource, {
    lang: "luau",
    luauParser: "custom",
    vm: {
      enabled: true,
      include: ["withRetry"],
      topLevel: false,
      instructionFusion: false,
      fakeOpcodes: 6,
      opcodeShuffle: false,
      bytecodeEncrypt: false,
      constsEncrypt: false,
      constsSplit: false,
      runtimeKey: false,
      runtimeSplit: false,
      decoyRuntime: false,
      symbolNoise: false,
      semanticMisdirection: false,
      dynamicCoupling: false,
      isaPolymorph: false,
      fakeEdges: false,
    },
    cff: false,
    strings: false,
    rename: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    seed: "vm-fake-opcode-retry-table-return",
  });

  assert.strictEqual(
    runLuau(code),
    "7",
    "fake opcode insertion should preserve pcall retry table returns"
  );
}

(async () => {
  await runCustom();
  await runCustomLayered();
  await runCustomPolymorph();
  await runCustomTopLevel();
  runVmModeNormalizationDefaults();
  runVmModeNormalizationOverride();
  runSeedRangeFix();
  runVmPreboundLocalCaptureNarrowing();
  runVmProtoUpvalueDescriptorMetadata();
  runVmCloseUpvalueInstructionCoverage();
  runPackedShellNormalizationDefaults();
  runPackedShellNormalizationOverride();
  runLuauOutputSizeLimit();
  await runAlternateOpcodeEncodingMode();
  await runMinimalSemanticVmRegression();
  await runSharedRuntimePreludeHoistRegression();
  runRegisterLocalCompilerFastPaths();
  runRegisterLocalBranchCompilerFastPaths();
  await runRegisterLocalVmRegression();
  await runRegisterLocalBranchVmRegression();
  await runSyncLocalLeakHardening();
  await runBytecodeStrideHardening();
  await runPackedShellWholeProgramDefault();
  await runPackedShellPayloadConcealment();
  await runPackedShellExplicitIncludeOverride();
  await runPackedShellHardProjectRegression();
  await runWrappedVm();
  await runNestedCallbackLift();
  await runNestedCallbackLiftWithParams();
  await runNestedCallbackInnerLocalGuard();
  await runCompoundAssignmentTargets();
  await runRenamedMemberCompoundAssignment();
  await runRenamedInsertedRecordFields();
  await runRenamedIpairsRecordFields();
  await runMetatableConstructorGuard();
  await runWrappedVmMethodRoundtrip();
  await runWholeProgramNormalizeGraph();
  await runVmDisablesClassicConstArrayAndCff();
  await runGotoLabelSupport();
  await runRecursiveLocalFunction();
  await runMutualRecursiveClosures();
  await runNestedShadowedCapture();
  await runMultiReturnAssignment();
  await runTailReturnExpansion();
  await runTableTailCallExpansion();
  await runNestedTableTailCallExpansion();
  await runAssignmentTargetOrdering();
  await runElseScopeIsolation();
  await runRepeatConditionScope();
  await runCallArgumentExpansion();
  await runExpandArgsOptimization();
  await runVarargVmRegression();
  await runGeneralizedIterationVmRegression();
  await runBlockDispatchSemanticRegression();
  await runSingleAssignmentOrdering();
  await runCapturedLocalWriteback();
  await runCapturedAnonymousClosureRead();
  await runMethodClosureSharedCaptures();
  await runRepeatUntilCapturedLocalCloseRuntime();
  await runFakeOpcodeRetryTableReturnRegression();
  console.log("luau-vm: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
