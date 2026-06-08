const assert = require("assert");
const { obfuscateLuau } = require("../src/luau");
const { parse: parseCustom } = require("../src/luau/custom/parser");

const source = [
  "local function f(a, b)",
  "  local c = \"hello runtime\"",
  "  return c, a + b, 7",
  "end",
  "print(f(1, 2))",
].join("\n");

function generatedLocalNames(code) {
  return [...code.matchAll(/\blocal\s+(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => match[1])
    .filter((name) => !name.startsWith("__vm_lift_"));
}

async function obfuscateCase(name, options) {
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    strings: false,
    rename: false,
    cff: false,
    dead: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    vm: { enabled: false },
    seed: `short-runtime-${name}`,
    ...options,
  });
  parseCustom(code);
  return code;
}

async function assertShortGeneratedLocals(name, options) {
  const code = await obfuscateCase(name, options);
  const longNames = [...new Set(generatedLocalNames(code).filter((localName) => localName.length >= 6))];
  assert.deepStrictEqual(longNames, [], `${name} should not emit long generated local names`);
}

async function runAntiHookRuntimeNames() {
  await assertShortGeneratedLocals("anti-hook", {
    antiHook: { enabled: true, lock: true },
  });
}

async function runStringRuntimeNames() {
  await assertShortGeneratedLocals("strings", {
    strings: true,
  });
}

async function runConstArrayRuntimeNames() {
  await assertShortGeneratedLocals("const-array", {
    constArray: true,
    constArrayOptions: {
      encoding: "base64",
      probability: 1,
      wrapper: true,
    },
  });
}

async function runVmRuntimeNames() {
  await assertShortGeneratedLocals("vm", {
    vm: {
      enabled: true,
      include: ["f"],
      mode: "compact",
      fakeOpcodes: 0,
      symbolNoise: false,
      runtimeSplit: false,
    },
  });
}

async function runPackedShellRuntimeNames() {
  await assertShortGeneratedLocals("packed-shell", {
    vm: {
      enabled: true,
      shellStyle: "packed",
    },
  });
}

(async () => {
  await runAntiHookRuntimeNames();
  await runStringRuntimeNames();
  await runConstArrayRuntimeNames();
  await runVmRuntimeNames();
  await runPackedShellRuntimeNames();
  console.log("luau-short-runtime-names: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
