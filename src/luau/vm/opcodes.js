const OPCODES = [
  "NOP",
  "PUSH_CONST",
  "PUSH_VARARG",
  "PUSH_VARARGS",
  "PUSH_LOCAL",
  "PUSH_CLOSURE",
  "CLOSE_UPVALUES",
  "SET_LOCAL",
  "DECLARE_LOCAL",
  "PUSH_GLOBAL",
  "SET_GLOBAL",
  "NEW_TABLE",
  "DUP",
  "SWAP",
  "POP",
  "GET_TABLE",
  "SET_TABLE",
  "CALL",
  "CALL_EXPAND",
  "RETURN",
  "RETURN_VARARGS",
  "RETURN_CALL",
  "RETURN_CALL_EXPAND",
  "APPEND_CALL",
  "APPEND_CALL_EXPAND",
  "APPEND_VARARGS",
  "JMP",
  "JMP_IF_FALSE",
  "JMP_IF_TRUE",
  "ADD",
  "SUB",
  "MUL",
  "DIV",
  "IDIV",
  "MOD",
  "POW",
  "CONCAT",
  "EQ",
  "NE",
  "LT",
  "LE",
  "GT",
  "GE",
  "BAND",
  "BOR",
  "BXOR",
  "SHL",
  "SHR",
  "UNM",
  "NOT",
  "LEN",
  "BNOT",
  "PREP_ITER",
];

const NOISE_OPCODES = [
  "NOISE_NOP",
  "NOISE_READ",
  "NOISE_WRITE",
  "NOISE_BRANCH",
];

const OPCODE_ARITY_ONE = new Set([
  "PUSH_CONST",
  "PUSH_VARARG",
  "PUSH_LOCAL",
  "PUSH_CLOSURE",
  "CLOSE_UPVALUES",
  "SET_LOCAL",
  "DECLARE_LOCAL",
  "PUSH_GLOBAL",
  "SET_GLOBAL",
  "CALL_EXPAND",
  "RETURN",
  "RETURN_VARARGS",
  "RETURN_CALL_EXPAND",
  "APPEND_CALL_EXPAND",
  "APPEND_VARARGS",
  "JMP",
  "JMP_IF_FALSE",
  "JMP_IF_TRUE",
  "NOISE_BRANCH",
]);

const OPCODE_ARITY_TWO = new Set([
  "CALL",
  "RETURN_CALL",
  "APPEND_CALL",
  "ADD_REG_LOCAL",
  "ADD_REG_CONST",
  "SUB_REG_LOCAL",
  "SUB_REG_CONST",
  "JMP_IF_LOCAL_LT",
  "JMP_IF_LOCAL_GT",
  "JMP_IF_LOCAL_LE",
  "JMP_IF_LOCAL_GE",
  "PUSH_LOCAL_ADD_LOCAL",
  "PUSH_LOCAL_SUB_LOCAL",
  "PUSH_CONST_ADD_CONST",
  "PREP_ITER",
  "NOISE_READ",
  "NOISE_WRITE",
]);

function getOpcodeArity(op) {
  if (typeof op !== "string") {
    return 2;
  }
  const base = op.endsWith("_X") ? op.slice(0, -2) : op;
  if (OPCODE_ARITY_TWO.has(base)) {
    return 2;
  }
  if (OPCODE_ARITY_ONE.has(base)) {
    return 1;
  }
  return 0;
}

function trimInstructionOperands(inst, arity) {
  if (!Array.isArray(inst) || !inst.length) {
    return inst;
  }
  const width = Math.max(0, Math.min(2, Number(arity) || 0));
  const out = [inst[0]];
  if (width >= 1) {
    out.push(inst[1] || 0);
  }
  if (width >= 2) {
    out.push(inst[2] || 0);
  }
  return out;
}

function compactInstructionByOpcode(inst) {
  return trimInstructionOperands(inst, getOpcodeArity(inst && inst[0]));
}

function compactInstructionList(instructions) {
  if (!Array.isArray(instructions)) {
    return instructions;
  }
  return instructions.map((inst) => compactInstructionByOpcode(inst));
}

const BINARY_OP_MAP = new Map([
  ["+", "ADD"],
  ["-", "SUB"],
  ["*", "MUL"],
  ["/", "DIV"],
  ["//", "IDIV"],
  ["%", "MOD"],
  ["^", "POW"],
  ["..", "CONCAT"],
  ["==", "EQ"],
  ["~=", "NE"],
  ["<", "LT"],
  ["<=", "LE"],
  [">", "GT"],
  [">=", "GE"],
  ["&", "BAND"],
  ["|", "BOR"],
  ["~", "BXOR"],
  ["<<", "SHL"],
  [">>", "SHR"],
]);

const UNARY_OP_MAP = new Map([
  ["-", "UNM"],
  ["not", "NOT"],
  ["#", "LEN"],
  ["~", "BNOT"],
]);

function buildOpcodeMap(rng, shuffle, opcodeList = OPCODES) {
  const codes = opcodeList.map((_, idx) => idx + 1);
  if (shuffle && rng) {
    rng.shuffle(codes);
  }
  const mapping = {};
  opcodeList.forEach((name, idx) => {
    mapping[name] = codes[idx];
  });
  return mapping;
}

module.exports = {
  OPCODES,
  NOISE_OPCODES,
  BINARY_OP_MAP,
  UNARY_OP_MAP,
  getOpcodeArity,
  trimInstructionOperands,
  compactInstructionByOpcode,
  compactInstructionList,
  buildOpcodeMap,
};
