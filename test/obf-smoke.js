const assert = require("assert");
const vm = require("vm");
const api = require("../src");
const { normalizeOptions } = require("../src/options");
const { obfuscate } = api;

assert.ok(typeof api.obfuscate === "function", "top-level obfuscate API should still be exported");

function runCode(code, timeoutMs = 5000) {
  const logs = [];
  const context = {
    console: {
      log: (...args) => logs.push(args.join(" ")),
    },
    Buffer,
    TextDecoder,
    Uint8Array,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: timeoutMs });
  const result =
    context.__result === undefined
      ? undefined
      : JSON.parse(JSON.stringify(context.__result));
  return { result, logs };
}

const source = `
function sum(arr) {
  let total = 0;
  for (let i = 0; i < arr.length; i++) {
    total += arr[i];
  }
  return total;
}

function vmTarget(x) {
  let y = x + 1;
  for (let i = 0; i < 3; i++) {
    y += i;
  }
  if (y % 2 === 0) {
    y += 5;
  } else {
    y -= 5;
  }
  switch (y % 3) {
    case 0:
      y += 7;
      break;
    case 1:
      y += 11;
      break;
    default:
      y += 13;
  }
  return y;
}

function superTarget() {
  const base = { value: 10, get() { return this.value; } };
  const obj = {
    get() {
      return super.get() + 1;
    },
  };
  Object.setPrototypeOf(obj, base);
  return obj.get();
}

function main(input) {
  const map = { a: 1, b: 2 };
  let label = "len:" + input.length;
  let res =
    sum(input) + map.a + map.b + vmTarget(input.length) + superTarget();
  if (res > 10) {
    res -= 3;
  } else {
    res += 3;
  }
  switch (res % 3) {
    case 0:
      res += 7;
      break;
    case 1:
      res += 11;
      break;
    default:
      res += 13;
  }
  try {
    if (input[0] === 99) {
      throw new Error("boom");
    }
  } catch (err) {
    res += err.message.length;
  }
  const out = { res, label };
  globalThis.__result = out;
  console.log(label);
  return out;
}

main([1, 2, 3, 4]);
`;

const runtimeSource = `
function runtimeTarget(x) {
  var y = x + 1;
  for (var i = 0; i < 3; i++) {
    y += i;
  }
  if (y > 5) {
    y *= 2;
  }
  return y;
}

globalThis.__result = { value: runtimeTarget(4) };
`;

async function main() {
  const classicOptions = normalizeOptions({ lang: "js" });
  assert.strictEqual(classicOptions.scheme, "classic");
  assert.strictEqual(classicOptions.vm.enabled, false);

  const stealthOptions = normalizeOptions({ lang: "js", scheme: "stealth" });
  assert.strictEqual(stealthOptions.scheme, "stealth");
  assert.strictEqual(stealthOptions.stringsOptions.minLength, 2);
  assert.strictEqual(stealthOptions.stringsOptions.segmentSize, 96);
  assert.strictEqual(stealthOptions.deadCodeOptions.probability, 0.1);

  const runtimeOptions = normalizeOptions({ lang: "js", scheme: "runtime" });
  assert.strictEqual(runtimeOptions.scheme, "runtime");
  assert.strictEqual(runtimeOptions.vm.enabled, true);
  assert.strictEqual(runtimeOptions.vm.all, true);
  assert.strictEqual(runtimeOptions.vm.downlevel, true);
  assert.strictEqual(runtimeOptions.vm.fakeOpcodes, 0.2);

  const runtimeDisabled = normalizeOptions({
    lang: "js",
    scheme: "runtime",
    vm: false,
  });
  assert.strictEqual(runtimeDisabled.vm.enabled, false);

  const luauSchemeIgnored = normalizeOptions({
    lang: "luau",
    scheme: "runtime",
  });
  assert.strictEqual(luauSchemeIgnored.scheme, "classic");

  const luauWovenCff = normalizeOptions({
    lang: "luau",
    cffOptions: { mode: "woven" },
  });
  assert.strictEqual(luauWovenCff.cffOptions.mode, "woven");

  const baseline = runCode(source);

  const obfHigh = await obfuscate(source, { preset: "high", seed: "test-seed" });
  const obfHighResult = runCode(obfHigh.code);

  assert.deepStrictEqual(obfHighResult.result, baseline.result);
  assert.deepStrictEqual(obfHighResult.logs, baseline.logs);
  assert(!obfHigh.code.includes("__obf_val"), "string runtime should not expose fixed value local");
  assert(!obfHigh.code.includes("__obf_bytes"), "string runtime should not expose fixed byte local");
  assert(!obfHigh.code.includes("Decoder unavailable"), "string runtime should not expose fixed decoder error");
  assert(!obfHigh.code.includes("本文件受到保护"), "string pool should not expose fixed bait text");

  const obfVm = await obfuscate(source, {
    preset: "low",
    seed: "test-seed",
    vm: { enabled: true, include: ["vmTarget", "superTarget"] },
  });
  const obfVmResult = runCode(obfVm.code, 20000);

  assert.deepStrictEqual(obfVmResult.result, baseline.result);
  assert.deepStrictEqual(obfVmResult.logs, baseline.logs);
  assert(!obfVm.code.includes("__vm_rt_"), "VM runtime cache key should not expose fixed prefix");
  assert(!obfVm.code.includes("__vm_this_"), "VM env this key should not expose fixed prefix");
  assert(!obfVm.code.includes("__vm_args_"), "VM env args key should not expose fixed prefix");
  assert(!obfVm.code.includes("__vm_new_target_"), "VM env new.target key should not expose fixed prefix");
  assert(!obfVm.code.includes("_vm$tmp"), "VM compiler temps should not expose fixed prefix");

  const runtimeBaseline = runCode(runtimeSource);
  const obfRuntime = await obfuscate(runtimeSource, {
    preset: "low",
    scheme: "runtime",
    seed: "test-seed",
  });
  const obfRuntimeResult = runCode(obfRuntime.code, 20000);

  assert.deepStrictEqual(obfRuntimeResult.result, runtimeBaseline.result);
  assert(!obfRuntime.code.includes("__vm_rt_"), "runtime scheme should hide VM cache prefix");

  console.log("obfuscation smoke test passed");
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
