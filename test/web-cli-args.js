const assert = require("assert");
const { buildCliArgs } = require("../src/lib/web-cli-args");

function includesPair(args, flag, value) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] === value;
}

const args = buildCliArgs({
  scheme: "stealth",
  lang: "luau",
  cffOptions: {
    mode: "woven",
    hideTopReturnExpr: true,
  },
  vm: {
    enabled: true,
    mode: "max",
    opcodeEncoding: "pairs",
    shellStyle: "packed",
    symbolNoise: true,
    instructionFusion: true,
    semanticMisdirection: true,
    dynamicCoupling: true,
    decoyRuntime: true,
    decoyProbability: 0.7,
    decoyStrings: 21,
    dispatchGraph: "sparse",
    stackProtocol: "api",
    numericStyle: "chaos",
  },
});

assert(includesPair(args, "--scheme", "stealth"), "expected --scheme stealth");
assert(includesPair(args, "--cff-mode", "woven"), "expected --cff-mode woven");
assert(args.includes("--cff-hide-top-return-expr"), "expected --cff-hide-top-return-expr");
assert(args.includes("--vm"), "expected --vm");
assert(includesPair(args, "--vm-mode", "max"), "expected --vm-mode max");
assert(includesPair(args, "--vm-opcode-encoding", "pairs"), "expected --vm-opcode-encoding pairs");
assert(includesPair(args, "--vm-shell-style", "packed"), "expected --vm-shell-style packed");
assert(args.includes("--vm-symbol-noise"), "expected --vm-symbol-noise");
assert(args.includes("--vm-instruction-fusion"), "expected --vm-instruction-fusion");
assert(args.includes("--vm-semantic-misdirection"), "expected --vm-semantic-misdirection");
assert(args.includes("--vm-dynamic-coupling"), "expected --vm-dynamic-coupling");
assert(includesPair(args, "--vm-decoy-probability", "0.7"), "expected --vm-decoy-probability 0.7");
assert(includesPair(args, "--vm-decoy-strings", "21"), "expected --vm-decoy-strings 21");
assert(includesPair(args, "--vm-dispatch-graph", "sparse"), "expected --vm-dispatch-graph sparse");
assert(includesPair(args, "--vm-stack-protocol", "api"), "expected --vm-stack-protocol api");
assert(includesPair(args, "--vm-numeric-style", "chaos"), "expected --vm-numeric-style chaos");

console.log("web-cli-args: ok");
