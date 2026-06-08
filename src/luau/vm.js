const { walk, traverse } = require("./ast");
const {
  OPCODES,
  NOISE_OPCODES,
  getOpcodeArity,
  compactInstructionList,
  buildOpcodeMap,
} = require("./vm/opcodes");
const {
  makeVmNameFactory,
  makeVmCharExpr,
  createSharedVmRuntime,
  buildSharedVmRuntimePreludeSource,
} = require("./vm/runtime");
const { VmCompiler } = require("./vm/compiler");
const { renameLuau } = require("./rename-impl");

const DEFAULT_MIN_STATEMENTS = 1;

function tracePass(ctx, event) {
  if (ctx && typeof ctx.debugTrace === "function") {
    ctx.debugTrace(event);
  }
}

function luaString(value) {
  const text = String(value);
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/"/g, "\\\"");
  return `"${escaped}"`;
}

function luaByteString(bytes) {
  if (!bytes || !bytes.length) {
    return "\"\"";
  }
  let out = "\"";
  for (const value of bytes) {
    const num = Math.max(0, Math.min(255, Number(value) || 0));
    out += `\\${String(num).padStart(3, "0")}`;
  }
  out += "\"";
  return out;
}

function makeVmByteStringLiteral(value) {
  const bytes = Array.from(Buffer.from(String(value), "utf8"));
  return {
    type: "StringLiteral",
    value: String(value),
    raw: luaByteString(bytes),
  };
}

function addIdentifierNames(root, target) {
  if (!target) {
    return target;
  }
  if (Array.isArray(root)) {
    root.forEach((node) => addIdentifierNames(node, target));
    return target;
  }
  if (!root || typeof root !== "object") {
    return target;
  }
  walk(root, (node) => {
    if (node && node.type === "Identifier" && typeof node.name === "string") {
      target.add(node.name);
    }
  });
  return target;
}

function renameGeneratedVmAst(vmAst, rng, reservedNames = null, renameOptions = null) {
  if (!vmAst || !rng) {
    return;
  }
  const reserved = new Set();
  if (reservedNames && typeof reservedNames.forEach === "function") {
    reservedNames.forEach((name) => {
      if (name) {
        reserved.add(name);
      }
    });
  }
  renameLuau(vmAst, {
    rng,
    options: {
      renameOptions: {
        renameGlobals: false,
        renameMembers: Boolean(renameOptions && renameOptions.renameMembers),
        homoglyphs: Boolean(renameOptions && renameOptions.homoglyphs),
        preserveTopReturnNames: false,
        reserved: [...reserved],
      },
    },
  });
  if (renameOptions && renameOptions.renameMembers) {
    traverse(vmAst, (node, parent, key, index, context) => {
      if (!node || !parent || key === null || key === undefined || !context) {
        return;
      }
      if (node.type === "MemberExpression") {
        if (node.indexer === ":" || (parent.type === "FunctionDeclaration" && key === "identifier")) {
          return;
        }
        const memberName = node.identifier && node.identifier.name;
        if (typeof memberName !== "string") {
          return;
        }
        const replacement = {
          type: "IndexExpression",
          base: node.base,
          index: makeVmByteStringLiteral(memberName),
        };
        context.replace(replacement);
        return;
      }
      if (node.type === "TableKeyString") {
        const memberName = node.key && node.key.name;
        if (typeof memberName !== "string") {
          return;
        }
        const replacement = {
          type: "TableKey",
          key: makeVmByteStringLiteral(memberName),
          value: node.value,
        };
        context.replace(replacement);
        return;
      }
      if (node.kind === "name" && node.name && typeof node.name.name === "string") {
        const replacement = {
          type: "TableField",
          kind: "index",
          key: makeVmByteStringLiteral(node.name.name),
          value: node.value,
        };
        context.replace(replacement);
      }
    });
  }
}

function computeSeedFromPieces(pieces, bcLength, constCount) {
  let seed = 0;
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    seed = (seed + piece) ^ ((piece << (i % 3)) & 0xff);
    seed &= 0xff;
  }
  seed = (seed + bcLength + constCount) % 256;
  return seed;
}

function buildSeedState(rng, bcLength, constCount) {
  const pieceCount = rng.int(2, 4);
  const pieces = Array.from({ length: pieceCount }, () => rng.int(5, 240));
  const seed = computeSeedFromPieces(pieces, bcLength, constCount);
  return { pieces, seed };
}

function buildKeySchedule(rng, seedState) {
  const rounds = rng.int(3, 6);
  const base = seedState.pieces[0] || 0;
  const words = Array.from({ length: 4 }, (_, idx) => (
    (rng.int(1, 0x7fffffff) + seedState.seed + base * (idx + 1)) >>> 0
  ));
  const maskPieces = [rng.int(1, 0xffff), rng.int(1, 0xffff)];
  const mask = ((maskPieces[0] ^ maskPieces[1]) + seedState.seed + 0x9e37) >>> 0;
  const encoded = words.map((word, idx) => (
    word ^ ((mask + (idx * 0x9e37)) >>> 0)
  ));
  return { encoded, maskPieces, words, rounds };
}

function computeInstructionKey(position, seed, words, rounds) {
  const pc = Number(position) >>> 0;
  const w = Array.isArray(words) && words.length >= 4
    ? words
    : [0x13579bdf, 0x2468ace1, 0x10213243, 0x55667788];
  let v0 = (((pc + (seed >>> 0) + (w[0] >>> 0)) >>> 0) ^ (w[1] >>> 0)) >>> 0;
  let v1 = ((((seed >>> 0) + (w[2] >>> 0)) >>> 0) ^ ((pc + (w[3] >>> 0)) >>> 0)) >>> 0;
  let sum = ((w[0] >>> 0) + (w[3] >>> 0) + pc) >>> 0;
  const totalRounds = Math.max(1, Number(rounds) || 1);
  for (let i = 0; i < totalRounds; i += 1) {
    sum = (sum + 0x9e37) >>> 0;
    let mix1 = ((((v1 << 4) >>> 0) ^ (v1 >>> 5)) >>> 0);
    mix1 = (mix1 ^ ((v1 + sum) >>> 0)) >>> 0;
    v0 = (v0 + ((mix1 ^ (w[sum & 3] >>> 0)) >>> 0)) >>> 0;
    let mix2 = ((((v0 << 4) >>> 0) ^ (v0 >>> 5)) >>> 0);
    mix2 = (mix2 ^ ((v0 + sum) >>> 0)) >>> 0;
    v1 = (v1 + ((mix2 ^ (w[(sum >>> 11) & 3] >>> 0)) >>> 0)) >>> 0;
  }
  let out = (v0 ^ v1) >>> 0;
  out = (out ^ ((pc + sum) >>> 0)) >>> 0;
  return out >>> 0;
}

function deriveInstructionMasks(key) {
  const k = key >>> 0;
  const aMask = (k ^ ((k << 5) >>> 0)) >>> 0;
  const bMask = ((k ^ (k >>> 3) ^ 0xA5A5A5A5) >>> 0);
  return { aMask, bMask };
}

function buildOpcodeEncoding(opcodeMap, rng, seedState, opcodeList = OPCODES) {
  const encodingMode = "mask";
  const keyPieces = [rng.int(1, 200), rng.int(1, 200)];
  const key = ((keyPieces[0] + keyPieces[1] + seedState.seed) % 255) + 1;
  const encoded = opcodeList.map((name, idx) => (
    opcodeMap[name] ^ ((key + idx * 7) % 255)
  ));
  return { encoded, keyPieces, encodingMode };
}

function buildOpcodePairsEncoding(opcodeMap, rng, seedState, opcodeList = OPCODES) {
  const keyPieces = [rng.int(1, 200), rng.int(1, 200)];
  const key = ((keyPieces[0] + keyPieces[1] + seedState.seed) % 255) + 1;
  const encoded = opcodeList.map((name, idx) => {
    const code = opcodeMap[name] >>> 0;
    const left = (code ^ ((key + idx * 11) % 255)) % 255;
    const right = (code ^ left) % 255;
    return `${left}\\95\\${right}`;
  });
  return { encoded, keyPieces, encodingMode: "pairs" };
}

function buildIndexExpression(index, rng) {
  if (!rng) {
    return String(index);
  }
  const salt = rng.int(1, 9);
  return `(${index + salt} - ${salt})`;
}

function splitInstructions(instructions, rng) {
  const total = instructions.length;
  if (!rng || total < 6) {
    return null;
  }
  const maxParts = Math.min(4, total);
  const partCount = rng.int(2, maxParts);
  const parts = [];
  const offsets = [];
  let offset = 0;
  for (let i = 0; i < partCount; i += 1) {
    const remaining = total - offset;
    const remainingParts = partCount - i;
    const minSize = Math.max(1, remaining - (remainingParts - 1));
    const size = i === partCount - 1 ? remaining : rng.int(1, minSize);
    parts.push(instructions.slice(offset, offset + size));
    offsets.push(offset + 1);
    offset += size;
  }
  const order = Array.from({ length: partCount }, (_, i) => i + 1);
  rng.shuffle(order);
  return { parts, offsets, order };
}

const ISA_XOR_VARIANT_OPS = new Set([
  "PUSH_CONST",
  "PUSH_LOCAL",
  "SET_LOCAL",
  "PUSH_GLOBAL",
  "SET_GLOBAL",
  "JMP",
  "JMP_IF_FALSE",
  "JMP_IF_TRUE",
  "CALL",
]);

function normalizeVmMode(value, allowed, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.toLowerCase();
  if (allowed.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function applyPolymorphicBlockISA(program, rng, vmOptions = {}) {
  let isaMode = "auto";
  if (typeof vmOptions.isaPolymorph === "boolean") {
    isaMode = vmOptions.isaPolymorph ? "on" : "off";
  } else {
    isaMode = normalizeVmMode(vmOptions.isaPolymorph, new Set(["off", "on", "auto"]), "auto");
  }
  const enabled = isaMode === "on" || (isaMode === "auto" && rng.bool(0.85));
  const stackModeRaw = normalizeVmMode(vmOptions.stackProtocol, new Set(["auto", "direct", "api"]), "auto");
  const stackProtocol = stackModeRaw === "auto" ? (rng.bool(0.5) ? "api" : "direct") : stackModeRaw;
  const dispatchGraph = normalizeVmMode(vmOptions.dispatchGraph, new Set(["auto", "tree", "sparse"]), "auto");
  const fakeEdges = vmOptions.fakeEdges !== false;
  const profile = {
    enabled,
    keyA: rng.int(1, 255),
    keyB: rng.int(1, 255),
    stackProtocol,
    dispatchGraph,
    fakeEdges,
  };
  if (!enabled || !program || !Array.isArray(program.instructions)) {
    return profile;
  }
  program.instructions = program.instructions.map((inst) => {
    const op = inst[0];
    const a = inst[1] || 0;
    const b = inst[2] || 0;
    if (!ISA_XOR_VARIANT_OPS.has(op) || !rng.bool(0.72)) {
      return inst;
    }
    if (op === "CALL") {
      return [`${op}_X`, a ^ profile.keyA, b ^ profile.keyB];
    }
    return [`${op}_X`, a ^ profile.keyA, b];
  });
  return profile;
}

function encodeU32(value) {
  const v = value >>> 0;
  return [
    v & 0xff,
    (v >>> 8) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 24) & 0xff,
  ];
}

function renameVmCoreIdentifiers(vmAst, aliases) {
  if (!vmAst || !aliases) {
    return;
  }
  const visit = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item));
      return;
    }
    if (node.type === "Identifier" && typeof node.name === "string") {
      const next = aliases[node.name];
      if (next && next !== node.name) {
        node.name = next;
      }
    }
    Object.keys(node).forEach((key) => {
      visit(node[key]);
    });
  };
  visit(vmAst);
}

function encodeBytecodeStream(instructions, rng, seedState, splitInfo) {
  const keyPieces = [rng.int(1, 200), rng.int(1, 200)];
  const seedValue = seedState ? seedState.seed : 0;
  const key = ((keyPieces[0] + keyPieces[1] + seedValue) % 256) & 0xff;
  const multipliers = [13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53];
  const multiplier = rng.pick(multipliers);
  const blockSpan = rng.int(7, 31);
  const twist = rng.int(1, 255);
  const parts = splitInfo && Array.isArray(splitInfo.parts) && splitInfo.parts.length
    ? splitInfo.parts
    : [instructions];
  const encodedParts = new Array(parts.length);
  let offset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const bytes = [];
    for (const inst of part) {
      const argc = Math.max(0, Math.min(2, (Array.isArray(inst) ? inst.length : 0) - 1));
      const width = argc + 1;
      bytes.push(width & 0xff);
      bytes.push(...encodeU32(inst[0] || 0));
      if (argc >= 1) {
        bytes.push(...encodeU32(inst[1] || 0));
      }
      if (argc >= 2) {
        bytes.push(...encodeU32(inst[2] || 0));
      }
    }
    const encoded = bytes.map((byte, idx) => (
      byte ^ (
        (
          key
          + (((offset + idx + 1) * multiplier) % 256)
          + (((Math.floor((offset + idx) / blockSpan) + 1) * twist) % 256)
        ) % 256
      )
    ));
    encodedParts[i] = encoded;
    offset += bytes.length;
  }

  let storageOrder = parts.map((_, idx) => idx + 1);
  if (splitInfo && Array.isArray(splitInfo.order) && splitInfo.order.length === parts.length) {
    storageOrder = splitInfo.order.slice();
  } else if (parts.length > 1) {
    rng.shuffle(storageOrder);
  }

  const storedParts = storageOrder.map((idx) => encodedParts[idx - 1]);
  const order = new Array(parts.length);
  storageOrder.forEach((partIndex, storageIndex) => {
    order[partIndex - 1] = storageIndex + 1;
  });

  return {
    keyPieces,
    multiplier,
    blockSpan,
    twist,
    parts: storedParts,
    order,
    totalBytes: offset,
  };
}

function bytesToLuaString(bytes, chunkSize = 60) {
  if (!bytes.length) {
    return "\"\"";
  }
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.slice(i, i + chunkSize);
    chunks.push(`string.char(${slice.join(", ")})`);
  }
  return chunks.join(" .. ");
}

function ensureConst(program, value) {
  const idx = program.consts.findIndex((entry) => entry === value);
  if (idx >= 0) {
    return idx + 1;
  }
  program.consts.push(value);
  return program.consts.length;
}

function encodeConstPool(program, rng, seedState) {
  const keyLength = rng.int(6, 14);
  const key = Array.from({ length: keyLength }, () => rng.int(1, 255));
  const maskPieces = [rng.int(1, 200), rng.int(1, 200)];
  const seedValue = seedState ? seedState.seed : 0;
  const mask = ((maskPieces[0] ^ maskPieces[1]) + seedValue) % 256;
  const entries = program.consts.map((value, entryIndex) => {
    let tag = 4;
    let text = "";
    if (value === null || value === undefined) {
      tag = 0;
      text = "";
    } else if (typeof value === "boolean") {
      tag = value ? 2 : 1;
      text = value ? "1" : "0";
    } else if (typeof value === "number") {
      tag = 3;
      text = String(value);
    } else {
      tag = 4;
      text = String(value);
    }
    const bytes = Buffer.from(text, "utf8");
    const out = new Array(bytes.length);
    const salt = rng.int(1, 255);
    for (let i = 0; i < bytes.length; i += 1) {
      const mix = (key[i % key.length] + salt + (((entryIndex + 1) * 13) % 256) + ((i * 7) % 251)) & 0xff;
      out[i] = (bytes[i] + mix) & 0xff;
    }
    const tagMask = (salt + mask + ((entryIndex + 1) * 3)) % 5;
    const tagEnc = (tag + tagMask) % 5;
    return { tagEnc, salt, data: out };
  });
  const keyEncoded = key.map((value, idx) => value ^ ((mask + idx * 11) % 256));
  return {
    keyEncoded,
    maskPieces,
    entries,
    count: program.consts.length,
  };
}

function splitConstEntries(entries, rng, targetSize) {
  if (!entries || entries.length <= targetSize) {
    return [entries];
  }
  const minSize = Math.max(4, Math.floor(targetSize * 0.6));
  const maxSize = Math.max(minSize, Math.floor(targetSize * 1.4));
  const parts = [];
  let index = 0;
  while (index < entries.length) {
    const remaining = entries.length - index;
    const size = rng
      ? Math.min(remaining, rng.int(minSize, maxSize))
      : Math.min(remaining, targetSize);
    parts.push(entries.slice(index, index + size));
    index += size;
  }
  return parts;
}

function buildDecoyVmStrings(rng, count) {
  const heads = [
    "vm",
    "dispatch",
    "trace",
    "handler",
    "opcode",
    "const",
    "seed",
    "stack",
    "guard",
    "decrypt",
  ];
  const tails = [
    "probe",
    "state",
    "route",
    "graph",
    "flow",
    "node",
    "mask",
    "table",
    "core",
    "stub",
  ];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const left = rng.pick(heads);
    const right = rng.pick(tails);
    const stamp = rng.int(0x1000, 0xffff).toString(16);
    out.push(`${left}_${right}_${stamp}`);
  }
  return out;
}

function buildSymbolNoiseToken(rng) {
  const chunks = [
    "!@#$%^&*",
    "[]{}<>?/\\|",
    "+-=~`",
    ":;,.\"'",
    "__--__",
    "::==::",
    "||&&||",
  ];
  const parts = rng.int(2, 4);
  let out = "";
  for (let i = 0; i < parts; i += 1) {
    out += chunks[rng.int(0, chunks.length - 1)];
    if (rng.bool(0.6)) {
      out += String(rng.int(0, 9999));
    }
  }
  return out;
}

const VM_JUMP_OPS = new Set(["JMP", "JMP_IF_FALSE", "JMP_IF_TRUE", "NOISE_BRANCH"]);

function remapInstructionJumpTargets(instructions, indexMap) {
  for (const inst of instructions) {
    if (!inst || !VM_JUMP_OPS.has(inst[0])) {
      continue;
    }
    const target = Number(inst[1]) || 0;
    if (target > 0 && target < indexMap.length && indexMap[target]) {
      inst[1] = indexMap[target];
    }
  }
}

function applyInstructionFusion(program, rng, vmOptions = {}) {
  if (!program || !Array.isArray(program.instructions) || vmOptions.instructionFusion === false) {
    return;
  }
  const original = program.instructions;
  if (original.length < 3) {
    return;
  }
  const jumpTargets = new Set();
  for (const inst of original) {
    if (inst && VM_JUMP_OPS.has(inst[0])) {
      const target = Number(inst[1]) || 0;
      if (target > 0) {
        jumpTargets.add(target);
      }
    }
  }
  const fused = [];
  const indexMap = new Array(original.length + 1);
  let changed = false;
  for (let i = 0; i < original.length; ) {
    const instA = original[i];
    const instB = original[i + 1];
    const instC = original[i + 2];
    const idxA = i + 1;
    const idxB = i + 2;
    const idxC = i + 3;
    let fusedInst = null;
    if (
      instA &&
      instB &&
      instC &&
      !jumpTargets.has(idxB) &&
      !jumpTargets.has(idxC)
    ) {
      const opA = instA[0];
      const opB = instB[0];
      const opC = instC[0];
      if (opA === "PUSH_LOCAL" && opB === "PUSH_LOCAL" && opC === "ADD") {
        fusedInst = ["PUSH_LOCAL_ADD_LOCAL", instA[1] || 0, instB[1] || 0];
      } else if (opA === "PUSH_LOCAL" && opB === "PUSH_LOCAL" && opC === "SUB") {
        fusedInst = ["PUSH_LOCAL_SUB_LOCAL", instA[1] || 0, instB[1] || 0];
      } else if (opA === "PUSH_CONST" && opB === "PUSH_CONST" && opC === "ADD") {
        fusedInst = ["PUSH_CONST_ADD_CONST", instA[1] || 0, instB[1] || 0];
      }
    }
    if (fusedInst) {
      const mapped = fused.length + 1;
      indexMap[idxA] = mapped;
      indexMap[idxB] = mapped;
      indexMap[idxC] = mapped;
      fused.push(fusedInst);
      i += 3;
      changed = true;
      continue;
    }
    const mapped = fused.length + 1;
    indexMap[idxA] = mapped;
    fused.push(instA);
    i += 1;
  }
  if (!changed) {
    return;
  }
  remapInstructionJumpTargets(fused, indexMap);
  program.instructions = fused;
}

function injectFakeInstructions(program, rng, probability) {
  if (!probability || probability <= 0) {
    return;
  }
  const hasControlFlowSensitiveOps = Array.isArray(program.instructions) && program.instructions.some((inst) => (
    Array.isArray(inst) && (
      inst[0] === "CALL" ||
      inst[0] === "CALL_EXPAND" ||
      inst[0] === "RETURN" ||
      inst[0] === "RETURN_CALL" ||
      inst[0] === "RETURN_CALL_EXPAND" ||
      inst[0] === "APPEND_CALL" ||
      inst[0] === "APPEND_CALL_EXPAND" ||
      VM_JUMP_OPS.has(inst[0])
    )
  ));
  if (hasControlFlowSensitiveOps) {
    return;
  }
  const nilIndex = ensureConst(program, null);
  const original = program.instructions.slice();
  const next = [];
  const indexMap = new Array(original.length + 1);
  for (let i = 0; i < original.length; i += 1) {
    const inst = original[i];
    indexMap[i + 1] = next.length + 1;
    next.push(inst);
    if (rng.bool(probability)) {
      const kind = rng.pick(["nop", "push_pop"]);
      if (kind === "nop") {
        next.push(["NOISE_NOP", 0, 0]);
      } else if (kind === "push_pop") {
        next.push(["PUSH_CONST", nilIndex, 0], ["POP", 0, 0]);
      }
    }
  }
  remapInstructionJumpTargets(next, indexMap);
  program.instructions = compactInstructionList(next);
}

function hasNestedFunction(fnNode) {
  let found = false;
  walk(fnNode, (node) => {
    if (found || !node || !node.type) {
      return;
    }
    if (node === fnNode) {
      return;
    }
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
      found = true;
    }
  });
  return found;
}

function hasVararg(fnNode, style) {
  if (style === "custom") {
    return Boolean(fnNode.hasVararg);
  }
  return false;
}

function getFunctionBodyStatements(fnNode, style) {
  if (!fnNode) {
    return [];
  }
  if (style === "custom") {
    return fnNode.body && fnNode.body.body ? fnNode.body.body : [];
  }
  return Array.isArray(fnNode.body) ? fnNode.body : [];
}

function isSetMetatableCall(expr) {
  if (!expr || expr.type !== "CallExpression" || !expr.base) {
    return false;
  }
  return expr.base.type === "Identifier" && expr.base.name === "setmetatable";
}

function isMetatableConstructor(fnNode, style) {
  const name = fnNode && typeof fnNode.__obf_original_name === "string"
    ? fnNode.__obf_original_name
    : getFunctionName(fnNode);
  if (!name || !name.endsWith(".new")) {
    return false;
  }
  const body = getFunctionBodyStatements(fnNode, style);
  return body.some((stmt) => (
    stmt &&
    stmt.type === "ReturnStatement" &&
    Array.isArray(stmt.arguments) &&
    stmt.arguments.some((arg) => isSetMetatableCall(arg))
  ));
}

function shouldVirtualizeFunction(fnNode, options) {
  const include = options.vm && Array.isArray(options.vm.include) ? options.vm.include : [];
  const all = options.vm && options.vm.all;
  const style = options && options.luauParser === "luaparse" ? "luaparse" : "custom";
  if (isMetatableConstructor(fnNode, style)) {
    return false;
  }
  if (all || include.length === 0) {
    return true;
  }
  const name = fnNode && typeof fnNode.__obf_original_name === "string"
    ? fnNode.__obf_original_name
    : getFunctionName(fnNode);
  return name ? include.includes(name) : false;
}

function getFunctionName(fnNode) {
  if (!fnNode) {
    return null;
  }
  if (fnNode.name && fnNode.name.type === "FunctionName") {
    const parts = [fnNode.name.base.name, ...fnNode.name.members.map((m) => m.name)];
    if (fnNode.name.method) {
      parts.push(fnNode.name.method.name);
    }
    return parts.join(".");
  }
  if (fnNode.identifier && fnNode.identifier.type === "Identifier") {
    return fnNode.identifier.name;
  }
  return null;
}

function cloneAst(node) {
  if (node === null || node === undefined) {
    return node;
  }
  return JSON.parse(JSON.stringify(node));
}

function makeIdentifierNode(name) {
  return {
    type: "Identifier",
    name,
  };
}

function makeFunctionNameNode(name) {
  return {
    type: "FunctionName",
    base: makeIdentifierNode(name),
    members: [],
    method: null,
  };
}

function makeNilLiteralNode() {
  return {
    type: "NilLiteral",
    value: null,
    raw: "nil",
  };
}

function walkAny(node, visitor, parent = null, key = null) {
  if (node === null || node === undefined) {
    return;
  }
  visitor(node, parent, key);
  if (Array.isArray(node)) {
    node.forEach((item) => walkAny(item, visitor, parent, key));
    return;
  }
  if (typeof node !== "object") {
    return;
  }
  Object.keys(node).forEach((childKey) => {
    const child = node[childKey];
    if (Array.isArray(child)) {
      child.forEach((item) => walkAny(item, visitor, node, childKey));
      return;
    }
    walkAny(child, visitor, node, childKey);
  });
}

function isFunctionNode(node) {
  return Boolean(node && (node.type === "FunctionDeclaration" || node.type === "FunctionExpression"));
}

function getFunctionBodyStatementsByStyle(fnNode, style) {
  if (!isFunctionNode(fnNode)) {
    return [];
  }
  if (style === "custom") {
    return fnNode.body && Array.isArray(fnNode.body.body) ? fnNode.body.body : [];
  }
  return Array.isArray(fnNode.body) ? fnNode.body : [];
}

function isTaskCallbackCall(node) {
  if (!node || node.type !== "CallExpression" || !node.base) {
    return false;
  }
  const base = node.base;
  if (base.type !== "MemberExpression" || base.indexer !== ".") {
    return false;
  }
  if (!base.base || base.base.type !== "Identifier" || base.base.name !== "task") {
    return false;
  }
  const method = base.identifier && base.identifier.name;
  return method === "spawn" || method === "defer" || method === "delay";
}

function getTaskCallbackArgIndex(node) {
  if (!isTaskCallbackCall(node)) {
    return -1;
  }
  const method = node.base && node.base.identifier ? node.base.identifier.name : "";
  if (method === "delay") {
    return 1;
  }
  return 0;
}

function isReferenceIdentifier(node, parent, key) {
  if (!node || node.type !== "Identifier" || !parent) {
    return true;
  }
  if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression") && key === "parameters") {
    return false;
  }
  if (parent.type === "FunctionName") {
    return false;
  }
  if (parent.type === "LocalStatement" && key === "variables") {
    return false;
  }
  if (parent.type === "ForNumericStatement" && key === "variable") {
    return false;
  }
  if (parent.type === "ForGenericStatement" && key === "variables") {
    return false;
  }
  if (parent.type === "MemberExpression" && key === "identifier") {
    return false;
  }
  return true;
}

function collectFunctionLocalNames(fnNode) {
  const names = new Set();
  const params = Array.isArray(fnNode.parameters) ? fnNode.parameters : [];
  params.forEach((param) => {
    if (param && param.type === "Identifier" && param.name) {
      names.add(param.name);
    }
  });

  const visitOwnedNodes = (node, parent = null, key = null) => {
    if (node === null || node === undefined) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => visitOwnedNodes(item, parent, key));
      return;
    }
    if (typeof node !== "object" || !node.type) {
      return;
    }
    if (node !== fnNode && isFunctionNode(node)) {
      if (node.type === "FunctionDeclaration" && node.isLocal) {
        const fnName = getFunctionName(node);
        if (fnName && !fnName.includes(".")) {
          names.add(fnName);
        }
      }
      return;
    }
    if (node.type === "Identifier" && parent) {
      if (parent.type === "LocalStatement" && key === "variables" && node.name) {
        names.add(node.name);
        return;
      }
      if (parent.type === "ForNumericStatement" && key === "variable" && node.name) {
        names.add(node.name);
        return;
      }
      if (parent.type === "ForGenericStatement" && key === "variables" && node.name) {
        names.add(node.name);
      }
      return;
    }
    if (node.type === "FunctionDeclaration" && node.isLocal) {
      const fnName = getFunctionName(node);
      if (fnName && !fnName.includes(".")) {
        names.add(fnName);
      }
    }
    Object.keys(node).forEach((childKey) => {
      visitOwnedNodes(node[childKey], node, childKey);
    });
  };

  visitOwnedNodes(fnNode);
  return names;
}

function collectDeclaredNamesInFunction(fnNode) {
  if (!collectDeclaredNamesInFunction.cache) {
    collectDeclaredNamesInFunction.cache = new WeakMap();
  }
  const cache = collectDeclaredNamesInFunction.cache;
  if (cache.has(fnNode)) {
    return cache.get(fnNode);
  }
  const names = collectFunctionLocalNames(fnNode);
  cache.set(fnNode, names);
  return names;
}

function collectUsedIdentifierOrder(fnNode) {
  if (!collectUsedIdentifierOrder.cache) {
    collectUsedIdentifierOrder.cache = new WeakMap();
  }
  const cache = collectUsedIdentifierOrder.cache;
  if (cache.has(fnNode)) {
    return cache.get(fnNode);
  }
  const names = [];
  const seen = new Set();
  walkAny(fnNode, (node, parent, key) => {
    if (!node || node.type !== "Identifier" || !node.name) {
      return;
    }
    if (!isReferenceIdentifier(node, parent, key)) {
      return;
    }
    if (seen.has(node.name)) {
      return;
    }
    seen.add(node.name);
    names.push(node.name);
  });
  cache.set(fnNode, names);
  return names;
}

function buildLiftedLocalFunction(name, fnExpr, captureNames = []) {
  const originalParams = Array.isArray(fnExpr.parameters)
    ? fnExpr.parameters.filter((param) => param && param.type === "Identifier")
    : [];
  return {
    type: "FunctionDeclaration",
    name: makeFunctionNameNode(name),
    parameters: [
      ...cloneAst(originalParams),
      ...captureNames.map((capture) => makeIdentifierNode(capture)),
    ],
    hasVararg: false,
    varargAnnotation: null,
    returnType: null,
    typeParameters: [],
    isLocal: true,
    body: cloneAst(fnExpr.body),
  };
}

function liftNestedVmCallbacksInFunction(fnNode, style, makeHelperName) {
  const lifted = [];
  const hostLocals = collectFunctionLocalNames(fnNode);
  const body = getFunctionBodyStatementsByStyle(fnNode, style);
  if (!body.length) {
    return lifted;
  }

  const visitNode = (node, depth) => {
    if (!node || typeof node !== "object") {
      return;
    }

    const isCall = node.type === "CallExpression" || node.type === "MethodCallExpression";
    if (depth === 0 && isCall && Array.isArray(node.arguments) && isTaskCallbackCall(node)) {
      const callbackArgIndex = getTaskCallbackArgIndex(node);
      if (callbackArgIndex < 0) {
        return;
      }
      for (let argIndex = 0; argIndex < node.arguments.length; argIndex += 1) {
        const arg = node.arguments[argIndex];
        if (argIndex !== callbackArgIndex || !arg || arg.type !== "FunctionExpression") {
          continue;
        }
        if (arg.hasVararg) {
          continue;
        }
        if (!canVirtualizeFunction(arg, style)) {
          continue;
        }

        const declared = collectDeclaredNamesInFunction(arg);
        const used = collectUsedIdentifierOrder(arg);
        const captures = [];
        const captureSet = new Set();
        used.forEach((name) => {
          if (declared.has(name) || !hostLocals.has(name) || captureSet.has(name)) {
            return;
          }
          captureSet.add(name);
          captures.push(name);
        });

        const helperName = makeHelperName();
        const helperFn = buildLiftedLocalFunction(helperName, arg, captures);
        lifted.push(helperFn);

        node.arguments[argIndex] = makeIdentifierNode(helperName);
        if (captures.length > 0) {
          const declaredParamCount = Array.isArray(arg.parameters) ? arg.parameters.length : 0;
          const existingArgCount = Math.max(0, node.arguments.length - (callbackArgIndex + 1));
          const paddingCount = Math.max(0, declaredParamCount - existingArgCount);
          const padding = [];
          for (let i = 0; i < paddingCount; i += 1) {
            padding.push(makeNilLiteralNode());
          }
          node.arguments.push(
            ...padding,
            ...captures.map((capture) => makeIdentifierNode(capture))
          );
        }
      }
    }

    Object.keys(node).forEach((childKey) => {
      const child = node[childKey];
      if (Array.isArray(child)) {
        child.forEach((item) => {
          if (!item || typeof item !== "object") {
            return;
          }
          visitNode(item, depth + (isFunctionNode(item) ? 1 : 0));
        });
        return;
      }
      if (child && typeof child === "object") {
        visitNode(child, depth + (isFunctionNode(child) ? 1 : 0));
      }
    });
  };

  body.forEach((stmt) => visitNode(stmt, 0));
  return lifted;
}

function liftNestedVmCallbacks(ast, ctx, style) {
  const usedNames = new Set();
  walk(ast, (node) => {
    if (node && node.type === "Identifier" && node.name) {
      usedNames.add(node.name);
    }
  });

  const makeHelperName = () => {
    if (!ctx || !ctx.rng || typeof ctx.rng.int !== "function") {
      throw new Error("liftNestedVmCallbacks requires a deterministic rng");
    }
    let name = "";
    while (!name || usedNames.has(name)) {
      const rand = ctx.rng.int(1, 1_000_000_000);
      name = `__vm_lift_${rand}`;
    }
    usedNames.add(name);
    return name;
  };

  const inserts = [];
  walk(ast, (node, parent, key, index) => {
    if (!isFunctionNode(node)) {
      return;
    }
    if (!parent || key === null || key === undefined || index === null || index === undefined) {
      return;
    }
    const container = parent[key];
    if (!Array.isArray(container)) {
      return;
    }
    const lifted = liftNestedVmCallbacksInFunction(node, style, makeHelperName);
    if (!lifted.length) {
      return;
    }
    inserts.push({
      container,
      index,
      nodes: lifted,
    });
  });

  const groups = new Map();
  inserts.forEach((entry) => {
    const existing = groups.get(entry.container) || [];
    existing.push(entry);
    groups.set(entry.container, existing);
  });
  groups.forEach((entries, container) => {
    entries.sort((a, b) => b.index - a.index);
    entries.forEach((entry) => {
      container.splice(entry.index, 0, ...entry.nodes);
    });
  });
}

function canVirtualizeFunction(fnNode, style) {
  let unsupported = false;
  walk(fnNode, (node) => {
    if (unsupported || !node || !node.type) {
      return;
    }
    if (node === fnNode) {
      return;
    }
    switch (node.type) {
      default:
        return;
    }
  });
  return !unsupported;
}

function buildBlockIds(count, rng) {
  const ids = [];
  const used = new Set();
  const max = 0x3fffffff;
  for (let i = 0; i < count; i += 1) {
    let id = 0;
    while (!id || used.has(id)) {
      id = rng.int(1, max);
    }
    used.add(id);
    ids.push(id);
  }
  return ids;
}

function buildDispatchTree(blocks, rng, emitBlock, indent = "") {
  if (!blocks.length) {
    return [`${indent}pc = 0`];
  }
  if (blocks.length === 1) {
    const lines = emitBlock(blocks[0]);
    return lines.map((line) => `${indent}${line}`);
  }
  const mid = Math.floor(blocks.length / 2);
  const left = blocks.slice(0, mid);
  const right = blocks.slice(mid);
  const lower = left[left.length - 1].id;
  const upper = right[0].id;
  const bound = lower + 1 <= upper ? rng.int(lower + 1, upper) : upper;
  const lines = [];
  lines.push(`${indent}if pc < ${bound} then`);
  lines.push(...buildDispatchTree(left, rng, emitBlock, `${indent}  `));
  lines.push(`${indent}else`);
  lines.push(...buildDispatchTree(right, rng, emitBlock, `${indent}  `));
  lines.push(`${indent}end`);
  return lines;
}

function buildSparseDispatch(blocks, rng, emitBlock, indent = "", { fakeEdges = true } = {}) {
  if (!blocks.length) {
    return [`${indent}pc = 0`];
  }
  const blockIds = new Set(blocks.map((block) => block.id));
  const bucketCount = Math.max(3, Math.min(11, Math.floor(Math.sqrt(blocks.length)) + 1));
  const salt = rng.int(9, 251);
  const buckets = Array.from({ length: bucketCount }, () => []);
  for (const block of blocks) {
    const idx = (block.id + salt) % bucketCount;
    buckets[idx].push(block);
  }
  buckets.forEach((bucket) => rng.shuffle(bucket));

  const fakeEntries = Array.from({ length: bucketCount }, (_, idx) => {
    let fakeId = 0;
    while (!fakeId || blockIds.has(fakeId)) {
      fakeId = rng.int(1, 0x3fffffff);
    }
    const fallback = buckets[idx].length
      ? rng.pick(buckets[idx]).id
      : blocks[0].id;
    return { id: fakeId, fallback };
  });
  const noiseSeed = rng.int(100, 0x7fff);
  const makeDispatchName = () => `d${rng.int(1, 0x3fffffff).toString(36)}`;
  const saltName = makeDispatchName();
  const bucketCountName = makeDispatchName();
  const noiseName = makeDispatchName();
  const bucketName = makeDispatchName();

  const lines = [];
  lines.push(`${indent}local ${saltName} = ${salt}`);
  lines.push(`${indent}local ${bucketCountName} = ${bucketCount}`);
  lines.push(`${indent}local ${noiseName} = ${noiseSeed}`);
  lines.push(`${indent}while pc ~= 0 do`);
  lines.push(`${indent}  local ${bucketName} = ((pc + ${saltName}) % ${bucketCountName}) + 1`);
  lines.push(`${indent}  ${noiseName} = (${noiseName} + ${bucketName} + top + 1) % 2147483647`);

  for (let i = 0; i < bucketCount; i += 1) {
    const prefix = i === 0 ? "if" : "elseif";
    lines.push(`${indent}  ${prefix} ${bucketName} == ${i + 1} then`);
    if (fakeEdges) {
      lines.push(`${indent}    if ${noiseName} < 0 then`);
      lines.push(`${indent}      pc = ${fakeEntries[i].id}`);
      lines.push(`${indent}    end`);
    }
    const bucket = buckets[i];
    if (!bucket.length) {
      lines.push(`${indent}    if pc == ${fakeEntries[i].id} then`);
      lines.push(`${indent}      pc = ${fakeEntries[i].fallback}`);
      lines.push(`${indent}    else`);
      lines.push(`${indent}      pc = 0`);
      lines.push(`${indent}    end`);
      continue;
    }
    for (let j = 0; j < bucket.length; j += 1) {
      const block = bucket[j];
      const branch = j === 0 ? "if" : "elseif";
      lines.push(`${indent}    ${branch} pc == ${block.id} then`);
      const emitted = emitBlock(block);
      emitted.forEach((line) => lines.push(`${indent}      ${line}`));
    }
    lines.push(`${indent}    elseif pc == ${fakeEntries[i].id} then`);
    lines.push(`${indent}      pc = ${fakeEntries[i].fallback}`);
    lines.push(`${indent}    else`);
    lines.push(`${indent}      pc = 0`);
    lines.push(`${indent}    end`);
  }
  lines.push(`${indent}  else`);
  lines.push(`${indent}    pc = 0`);
  lines.push(`${indent}  end`);
  lines.push(`${indent}end`);
  return lines;
}

function buildVmSource(
  program,
  opcodeInfo,
  paramNames,
  seedState,
  keySchedule,
  bcInfo,
  constInfo,
  rng,
  vmOptions = {},
  reservedNames = null,
  opcodeList = OPCODES,
  isaProfile = null,
  sharedRuntime = null
) {
  // This is the main bytecode-to-Luau lowering step. It stitches together
  // const decoding, opcode decoding, helper runtimes, and the final dispatch loop.
  const constCount = constInfo ? constInfo.count : program.consts.length;
  const blockDispatch = Boolean(vmOptions.blockDispatch);
  const useBytecodeStream = !blockDispatch && vmOptions.bytecodeEncrypt !== false;
  const initValues = Array.isArray(program.localInitValues) ? program.localInitValues : paramNames;
  const setTargets = Array.isArray(program.localSetTargets) ? program.localSetTargets : initValues;
  const seedPieces = seedState ? seedState.pieces : [];
  const keyMaskPieces = keySchedule ? keySchedule.maskPieces : null;
  const keyEncoded = keySchedule ? keySchedule.encoded : null;
  const keyRounds = keySchedule ? keySchedule.rounds : 0;
  const opEncoded = opcodeInfo ? opcodeInfo.encoded : null;
  const opKeyPieces = opcodeInfo ? opcodeInfo.keyPieces : null;
  const opEncodingMode = opcodeInfo ? opcodeInfo.encodingMode : "mask";
  const nameUsed = new Set();
  if (reservedNames && typeof reservedNames.forEach === "function") {
    reservedNames.forEach((name) => {
      if (name) {
        nameUsed.add(name);
      }
    });
  }
  const makeName = makeVmNameFactory(rng, nameUsed);
  const makeVmHelperAliasName = makeName;
  const bitNames = sharedRuntime ? sharedRuntime.bitNames : {
    mod: makeName(),
    bit: makeName(),
    norm: makeName(),
    u64: makeName(),
    from: makeName(),
    lo: makeName(),
    add: makeName(),
    modn: makeName(),
    modSmall: makeName(),
    bxor64: makeName(),
    band64: makeName(),
    bor64: makeName(),
    bnot64: makeName(),
    lshift64: makeName(),
    rshift64: makeName(),
    bxor32: makeName(),
    band32: makeName(),
    bor32: makeName(),
    bnot32: makeName(),
    lshift32: makeName(),
    rshift32: makeName(),
  };
  const helperNames = {
    getConst: makeName(),
    getInst: makeName(),
    byte: makeName(),
    u32: makeName(),
    partByte: makeName(),
    constEntry: makeName(),
    keyAt: makeName(),
    expandArgs: makeName(),
    callExpanded: makeName(),
    syncLocal: makeName(),
    cell: makeName(),
    localValue: makeName(),
    localSet: makeName(),
    localDeclare: makeName(),
    closureFactory: makeName(),
    varargs: makeName(),
  };
  const renderInitValue = (entry) => {
    if (!entry) {
      return "nil";
    }
    if (typeof entry === "object" && entry.cell) {
      return String(entry.cell);
    }
    if (typeof entry === "object" && entry.expr) {
      return `${helperNames.cell}(${entry.expr})`;
    }
    return `${helperNames.cell}(${entry})`;
  };
  const localsInit = (initValues || []).map(renderInitValue);
  const localsTable = `{ ${localsInit.join(", ")} }`;
  const vmStateNames = {
    bcKeyCount: makeName(),
    stateKey: makeName(),
    statePulse: makeName(),
  };
  const vmMeta = {
    isaKeyA: makeName(),
    isaKeyB: makeName(),
  };
  const decoyNames = {
    pool: makeName(),
    key: makeName(),
    decode: makeName(),
    vm: makeName(),
    pc: makeName(),
    stack: makeName(),
    sink: makeName(),
    guard: makeName(),
    token: makeName(),
    opcode: makeName(),
    probe: makeName(),
  };
  const activeIsa = isaProfile || {
    enabled: false,
    keyA: 0,
    keyB: 0,
    stackProtocol: "direct",
    dispatchGraph: "tree",
    fakeEdges: false,
  };
  const runtimeTools = sharedRuntime ? sharedRuntime.runtimeTools : {
    bundle: makeName(),
    char: makeName(),
    byte: makeName(),
    concat: makeName(),
    pack: makeName(),
    unpack: makeName(),
    select: makeName(),
    type: makeName(),
    floor: makeName(),
    getfenv: makeName(),
  };
  const vmCoreNames = {
    seed: makeVmHelperAliasName(),
  };
  const call = (fn, args) => `${fn}(${args.join(", ")})`;
  const charExpr = (text) => makeVmCharExpr(runtimeTools.char, text);
  const u64from = (v) => call(bitNames.from, [v]);
  const u64lo = (v) => call(bitNames.lo, [v]);
  const u64add = (a, b) => call(bitNames.add, [a, b]);
  const u64mod = (a, m) => call(bitNames.modn, [a, m]);
  const u64modSmall = (a) => call(bitNames.modSmall, [a]);
  const bxor64 = (a, b) => call(bitNames.bxor64, [a, b]);
  const band64 = (a, b) => call(bitNames.band64, [a, b]);
  const bor64 = (a, b) => call(bitNames.bor64, [a, b]);
  const lshift64 = (a, b) => call(bitNames.lshift64, [a, b]);
  const rshift64 = (a, b) => call(bitNames.rshift64, [a, b]);
  const bnot64 = (a) => call(bitNames.bnot64, [a]);
  const bxor32 = (a, b) => call(bitNames.bxor32, [a, b]);
  const band32 = (a, b) => call(bitNames.band32, [a, b]);
  const bor32 = (a, b) => call(bitNames.bor32, [a, b]);
  const lshift32 = (a, b) => call(bitNames.lshift32, [a, b]);
  const rshift32 = (a, b) => call(bitNames.rshift32, [a, b]);
  const bnot32 = (a) => call(bitNames.bnot32, [a]);
  const renderLinearInstruction = (inst) => {
    const row = [inst[0] || 0];
    if (Array.isArray(inst) && inst.length > 1) {
      row.push(inst[1] || 0);
    }
    if (Array.isArray(inst) && inst.length > 2) {
      row.push(inst[2] || 0);
    }
    return `{ ${row.join(", ")} }`;
  };
  const emitSharedOpBody = (opName, config = {}) => {
    // Both the linear and block-dispatch backends lower through this shared
    // opcode emitter so instruction semantics stay in one place.
    const {
      mode = "linear",
      nextExpr = "pc + 1",
      aExpr = "a",
      bExpr = "b",
      getConstExpr = (value) => `${helperNames.getConst}(${value})`,
      pushLine = "top = top + 1",
      jumpTargetExpr = aExpr,
      noiseStateName = null,
    } = config;
    const finish = (linesOut) => {
      if (mode === "block") {
        return [...linesOut, `pc = ${nextExpr}`];
      }
      return [...linesOut, `return ${nextExpr}, false, nil`];
    };
    const finishStop = (retExpr) => {
      if (mode === "block") {
        return [retExpr];
      }
      return [`return 0, true, ${retExpr}`];
    };
    switch (opName) {
      case "NOP":
      case "NOISE_NOP":
        return finish([]);
      case "PUSH_CONST":
        return finish([pushLine, `stack[top] = ${getConstExpr(aExpr)}`]);
      case "PUSH_VARARG":
        return finish([pushLine, `stack[top] = ${helperNames.varargs}[${aExpr}]`]);
      case "PUSH_VARARGS":
        return finish([pushLine, `stack[top] = ${helperNames.varargs}`]);
      case "PUSH_LOCAL":
        return finish([pushLine, `stack[top] = ${helperNames.localValue}(${aExpr})`]);
      case "PUSH_LOCAL_ADD_LOCAL":
        return finish([pushLine, `stack[top] = ${helperNames.localValue}(${aExpr}) + ${helperNames.localValue}(${bExpr})`]);
      case "PUSH_LOCAL_SUB_LOCAL":
        return finish([pushLine, `stack[top] = ${helperNames.localValue}(${aExpr}) - ${helperNames.localValue}(${bExpr})`]);
      case "PUSH_CONST_ADD_CONST":
        return finish([pushLine, `stack[top] = ${getConstExpr(aExpr)} + ${getConstExpr(bExpr)}`]);
      case "ADD_REG_LOCAL":
        return finish([
          `${helperNames.localSet}(${aExpr}, ${helperNames.localValue}(${aExpr}) + ${helperNames.localValue}(${bExpr}))`,
        ]);
      case "ADD_REG_CONST":
        return finish([
          `${helperNames.localSet}(${aExpr}, ${helperNames.localValue}(${aExpr}) + ${getConstExpr(bExpr)})`,
        ]);
      case "SUB_REG_LOCAL":
        return finish([
          `${helperNames.localSet}(${aExpr}, ${helperNames.localValue}(${aExpr}) - ${helperNames.localValue}(${bExpr}))`,
        ]);
      case "SUB_REG_CONST":
        return finish([
          `${helperNames.localSet}(${aExpr}, ${helperNames.localValue}(${aExpr}) - ${getConstExpr(bExpr)})`,
        ]);
      case "SET_LOCAL":
        return finish([
          `${helperNames.localSet}(${aExpr}, stack[top])`,
          "stack[top] = nil",
          "top = top - 1",
        ]);
      case "DECLARE_LOCAL":
        return finish([
          `${helperNames.localDeclare}(${aExpr}, stack[top])`,
          "stack[top] = nil",
          "top = top - 1",
        ]);
      case "PUSH_CLOSURE":
        return finish([pushLine, `stack[top] = ${helperNames.closureFactory}[${aExpr}](locals)`]);
      case "PUSH_GLOBAL":
        return finish([pushLine, `stack[top] = env[${getConstExpr(aExpr)}]`]);
      case "SET_GLOBAL":
        return finish([
          `env[${getConstExpr(aExpr)}] = stack[top]`,
          "stack[top] = nil",
          "top = top - 1",
        ]);
      case "NEW_TABLE":
        return finish(["top = top + 1", "stack[top] = {}"]);
      case "DUP":
        return finish(["top = top + 1", "stack[top] = stack[top - 1]"]);
      case "SWAP":
        return finish(["stack[top], stack[top - 1] = stack[top - 1], stack[top]"]);
      case "POP":
        return finish(["stack[top] = nil", "top = top - 1"]);
      case "GET_TABLE":
        return finish([
          "local idx = stack[top]",
          "stack[top] = nil",
          "local base = stack[top - 1]",
          "stack[top - 1] = base[idx]",
          "top = top - 1",
        ]);
      case "SET_TABLE":
        return finish([
          "local val = stack[top]",
          "stack[top] = nil",
          "local key = stack[top - 1]",
          "stack[top - 1] = nil",
          "local base = stack[top - 2]",
          "base[key] = val",
          "stack[top - 2] = nil",
          "top = top - 3",
        ]);
      case "CALL":
        return finish([
          `local argc = ${aExpr}`,
          `local retc = ${bExpr}`,
          "local base = top - argc",
          "local fn = stack[base]",
          "if retc == 0 then",
          "  fn(unpack(stack, base + 1, top))",
          "  for i = top, base, -1 do",
          "    stack[i] = nil",
          "  end",
          "  top = base - 1",
          "else",
          "  local res = pack(fn(unpack(stack, base + 1, top)))",
          "  for i = top, base, -1 do",
          "    stack[i] = nil",
          "  end",
          "  top = base - 1",
          "  if retc == 1 then",
          "    top = top + 1",
          "    stack[top] = res[1]",
          "  else",
          "    for i = 1, retc do",
          "      top = top + 1",
          "      stack[top] = res[i]",
          "    end",
          "  end",
          "end",
        ]);
      case "CALL_EXPAND":
        return finish([
          `local retc = ${aExpr}`,
          "local tail = stack[top]",
          "local prefixArgs = stack[top - 1]",
          "local fn = stack[top - 2]",
          `local res = ${helperNames.callExpanded}(fn, prefixArgs, tail)`,
          "for i = top, top - 2, -1 do",
          "  stack[i] = nil",
          "end",
          "top = top - 3",
          "if retc == 0 then",
          ...(mode === "block" ? [`  pc = ${nextExpr}`] : ["  return pc + 1, false, nil"]),
          "elseif retc == 1 then",
          "  top = top + 1",
          "  stack[top] = res[1]",
          ...(mode === "block" ? [`  pc = ${nextExpr}`] : ["  return pc + 1, false, nil"]),
          "else",
          "  for i = 1, retc do",
          "    top = top + 1",
          "    stack[top] = res[i]",
          "  end",
          ...(mode === "block" ? [`  pc = ${nextExpr}`] : ["  return pc + 1, false, nil"]),
          "end",
        ].filter(Boolean));
      case "RETURN_CALL":
        if (mode === "block") {
          return [
            `local argc = ${aExpr}`,
            `local prefix = ${bExpr}`,
            "local base = top - argc",
            "local fn = stack[base]",
            "if prefix == 0 then",
            "  return fn(unpack(stack, base + 1, top))",
            "end",
            "local res = pack(fn(unpack(stack, base + 1, top)))",
            "local merged = { n = prefix + (res.n or #res) }",
            "local prefixBase = base - prefix",
            "for i = 1, prefix do",
            "  merged[i] = stack[prefixBase + i - 1]",
            "end",
            "for i = 1, res.n or #res do",
            "  merged[prefix + i] = res[i]",
            "end",
            "return unpack(merged, 1, merged.n)",
          ];
        }
        return finishStop(`(function()
  local argc = ${aExpr}
  local prefix = ${bExpr}
  local base = top - argc
  local fn = stack[base]
  if prefix == 0 then
    return pack(fn(unpack(stack, base + 1, top)))
  end
  local res = pack(fn(unpack(stack, base + 1, top)))
  local merged = { n = prefix + (res.n or #res) }
  local prefixBase = base - prefix
  for i = 1, prefix do
    merged[i] = stack[prefixBase + i - 1]
  end
  for i = 1, res.n or #res do
    merged[prefix + i] = res[i]
  end
  return merged
end)()`);
      case "RETURN_CALL_EXPAND":
        if (mode === "block") {
          return [
            `local prefix = ${aExpr}`,
            "local tail = stack[top]",
            "local prefixArgs = stack[top - 1]",
            "local fn = stack[top - 2]",
            `local res = ${helperNames.callExpanded}(fn, prefixArgs, tail)`,
            "if prefix == 0 then",
            "  return unpack(res, 1, res.n or #res)",
            "end",
            "local merged = { n = prefix + (res.n or #res) }",
            "local prefixBase = top - 2 - prefix",
            "for i = 1, prefix do",
            "  merged[i] = stack[prefixBase + i - 1]",
            "end",
            "for i = 1, res.n or #res do",
            "  merged[prefix + i] = res[i]",
            "end",
            "return unpack(merged, 1, merged.n)",
          ];
        }
        return finishStop(`(function()
  local prefix = ${aExpr}
  local tail = stack[top]
  local prefixArgs = stack[top - 1]
  local fn = stack[top - 2]
  local res = ${helperNames.callExpanded}(fn, prefixArgs, tail)
  if prefix == 0 then
    return res
  end
  local merged = { n = prefix + (res.n or #res) }
  local prefixBase = top - 2 - prefix
  for i = 1, prefix do
    merged[i] = stack[prefixBase + i - 1]
  end
  for i = 1, res.n or #res do
    merged[prefix + i] = res[i]
  end
  return merged
end)()`);
      case "APPEND_CALL":
        return finish([
          `local argc = ${aExpr}`,
          `local startIndex = ${bExpr}`,
          "local base = top - argc",
          "local fn = stack[base]",
          "local tbl = stack[base - 1]",
          "local res = pack(fn(unpack(stack, base + 1, top)))",
          "for i = top, base, -1 do",
          "  stack[i] = nil",
          "end",
          "top = base - 1",
          "for i = 1, res.n or #res do",
          "  tbl[startIndex + i - 1] = res[i]",
          "end",
          "if tbl.n ~= nil then",
          "  tbl.n = startIndex + (res.n or #res) - 1",
          "end",
        ]);
      case "APPEND_CALL_EXPAND":
        return finish([
          `local startIndex = ${aExpr}`,
          "local tail = stack[top]",
          "local prefixArgs = stack[top - 1]",
          "local fn = stack[top - 2]",
          "local tbl = stack[top - 3]",
          `local res = ${helperNames.callExpanded}(fn, prefixArgs, tail)`,
          "for i = top, top - 2, -1 do",
          "  stack[i] = nil",
          "end",
          "top = top - 3",
          "for i = 1, res.n or #res do",
          "  tbl[startIndex + i - 1] = res[i]",
          "end",
          "if tbl.n ~= nil then",
          "  tbl.n = startIndex + (res.n or #res) - 1",
          "end",
        ]);
      case "APPEND_VARARGS":
        return finish([
          `local startIndex = ${aExpr}`,
          "local tail = stack[top]",
          "local tbl = stack[top - 1]",
          "for i = 1, tail.n or #tail do",
          "  tbl[startIndex + i - 1] = tail[i]",
          "end",
          "if tbl.n ~= nil then",
          "  tbl.n = startIndex + (tail.n or #tail) - 1",
          "end",
          "stack[top] = nil",
          "top = top - 1",
        ]);
      case "RETURN":
        if (mode === "block") {
          return [
            `local count = ${aExpr}`,
            "if count == 0 then",
            "  return",
            "elseif count == 1 then",
            "  return stack[top]",
            "else",
            "  local base = top - count + 1",
            "  return unpack(stack, base, top)",
            "end",
          ];
        }
        return finishStop(`(function()
  local count = ${aExpr}
  if count == 0 then
    return pack()
  elseif count == 1 then
    return pack(stack[top])
  else
    local base = top - count + 1
    return pack(unpack(stack, base, top))
  end
end)()`);
      case "RETURN_VARARGS":
        if (mode === "block") {
          return [
            `local prefix = ${aExpr}`,
            "local tail = stack[top]",
            "if prefix == 0 then",
            "  return unpack(tail, 1, tail.n or #tail)",
            "end",
            "local merged = { n = prefix + (tail.n or #tail) }",
            "local prefixBase = top - prefix",
            "for i = 1, prefix do",
            "  merged[i] = stack[prefixBase + i - 1]",
            "end",
            "for i = 1, tail.n or #tail do",
            "  merged[prefix + i] = tail[i]",
            "end",
            "return unpack(merged, 1, merged.n)",
          ];
        }
        return finishStop(`(function()
  local prefix = ${aExpr}
  local tail = stack[top]
  if prefix == 0 then
    return tail
  end
  local merged = { n = prefix + (tail.n or #tail) }
  local prefixBase = top - prefix
  for i = 1, prefix do
    merged[i] = stack[prefixBase + i - 1]
  end
  for i = 1, tail.n or #tail do
    merged[prefix + i] = tail[i]
  end
  return merged
end)()`);
      case "JMP":
        return finish([], jumpTargetExpr);
      case "PREP_ITER":
        return finish([
          `local fnSlot = ${runtimeTools.floor}(${aExpr} / 65536)`,
          `local stateSlot = ${aExpr} % 65536`,
          `local ctrlSlot = ${bExpr}`,
          `local gen = ${helperNames.localValue}(fnSlot)`,
          `local state = ${helperNames.localValue}(stateSlot)`,
          `local ctrl = ${helperNames.localValue}(ctrlSlot)`,
          `local kind = ${runtimeTools.type}(gen)`,
          `if kind == "table" or kind == "userdata" then`,
          `  local mtfn = env["getmetatable"] or getmetatable`,
          "  local mt = mtfn and mtfn(gen)",
          `  local mtKind = ${runtimeTools.type}(mt)`,
          "  local iter = mtKind == \"table\" and mt.__iter or nil",
          "  local callMeta = mtKind == \"table\" and mt.__call or nil",
          `  if ${runtimeTools.type}(iter) == "function" then`,
          "    gen, state, ctrl = iter(gen)",
          "  elseif kind == \"table\" and callMeta == nil then",
          "    state = gen",
          "    gen = env[\"next\"] or next",
          "    ctrl = nil",
          "  end",
          "end",
          `${helperNames.localSet}(fnSlot, gen)`,
          `${helperNames.localSet}(stateSlot, state)`,
          `${helperNames.localSet}(ctrlSlot, ctrl)`,
        ]);
      case "JMP_IF_LOCAL_LT":
        return [
          `local left = ${runtimeTools.floor}(${aExpr} / 65536)`,
          `local right = ${aExpr} % 65536`,
          `if ${helperNames.localValue}(left) < ${helperNames.localValue}(right) then`,
          mode === "block" ? `  pc = ${bExpr}` : `  return ${bExpr}, false, nil`,
          "end",
          mode === "block" ? `pc = ${nextExpr}` : `return ${nextExpr}, false, nil`,
        ];
      case "JMP_IF_LOCAL_GT":
        return [
          `local left = ${runtimeTools.floor}(${aExpr} / 65536)`,
          `local right = ${aExpr} % 65536`,
          `if ${helperNames.localValue}(left) > ${helperNames.localValue}(right) then`,
          mode === "block" ? `  pc = ${bExpr}` : `  return ${bExpr}, false, nil`,
          "end",
          mode === "block" ? `pc = ${nextExpr}` : `return ${nextExpr}, false, nil`,
        ];
      case "JMP_IF_LOCAL_LE":
        return [
          `local left = ${runtimeTools.floor}(${aExpr} / 65536)`,
          `local right = ${aExpr} % 65536`,
          `if ${helperNames.localValue}(left) <= ${helperNames.localValue}(right) then`,
          mode === "block" ? `  pc = ${bExpr}` : `  return ${bExpr}, false, nil`,
          "end",
          mode === "block" ? `pc = ${nextExpr}` : `return ${nextExpr}, false, nil`,
        ];
      case "JMP_IF_LOCAL_GE":
        return [
          `local left = ${runtimeTools.floor}(${aExpr} / 65536)`,
          `local right = ${aExpr} % 65536`,
          `if ${helperNames.localValue}(left) >= ${helperNames.localValue}(right) then`,
          mode === "block" ? `  pc = ${bExpr}` : `  return ${bExpr}, false, nil`,
          "end",
          mode === "block" ? `pc = ${nextExpr}` : `return ${nextExpr}, false, nil`,
        ];
      case "JMP_IF_FALSE":
        if (mode === "block") {
          return [
            "if not stack[top] then",
            `  pc = ${jumpTargetExpr}`,
            "else",
            `  pc = ${nextExpr}`,
            "end",
          ];
        }
        return [
          "if not stack[top] then",
          `  return ${jumpTargetExpr}, false, nil`,
          "end",
          "return pc + 1, false, nil",
        ];
      case "JMP_IF_TRUE":
        if (mode === "block") {
          return [
            "if stack[top] then",
            `  pc = ${jumpTargetExpr}`,
            "else",
            `  pc = ${nextExpr}`,
            "end",
          ];
        }
        return [
          "if stack[top] then",
          `  return ${jumpTargetExpr}, false, nil`,
          "end",
          "return pc + 1, false, nil",
        ];
      case "ADD":
      case "SUB":
      case "MUL":
      case "DIV":
      case "MOD":
      case "POW":
      case "CONCAT":
      case "EQ":
      case "NE":
      case "LT":
      case "LE":
      case "GT":
      case "GE": {
        const opMap = {
          ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "%", POW: "^", CONCAT: "..",
          EQ: "==", NE: "~=", LT: "<", LE: "<=", GT: ">", GE: ">=",
        };
        return finish([`stack[top - 1] = stack[top - 1] ${opMap[opName]} stack[top]`, "top = top - 1"]);
      }
      case "IDIV":
        return finish([`stack[top - 1] = ${runtimeTools.floor}(stack[top - 1] / stack[top])`, "top = top - 1"]);
      case "BAND":
      case "BOR":
      case "BXOR":
      case "SHL":
      case "SHR": {
        const opMap = {
          BAND: band32("stack[top - 1]", "stack[top]"),
          BOR: bor32("stack[top - 1]", "stack[top]"),
          BXOR: bxor32("stack[top - 1]", "stack[top]"),
          SHL: lshift32("stack[top - 1]", "stack[top]"),
          SHR: rshift32("stack[top - 1]", "stack[top]"),
        };
        return finish([`stack[top - 1] = ${opMap[opName]}`, "top = top - 1"]);
      }
      case "UNM":
        return finish(["stack[top] = -stack[top]"]);
      case "NOT":
        return finish(["stack[top] = not stack[top]"]);
      case "LEN":
        return finish(["stack[top] = #stack[top]"]);
      case "BNOT":
        return finish([`stack[top] = ${bnot32("stack[top]")}`]);
      case "NOISE_READ":
        return finish([
          `local slot = ((a + pc + ${vmCoreNames.seed}) % 11) + 1`,
          `local ghost = ${noiseStateName}[slot]`,
          "if ghost == nil then",
          "  ghost = stack[top]",
          "end",
          `${noiseStateName}[slot] = ghost`,
        ]);
      case "NOISE_WRITE":
        return finish([
          `local slot = ((a + b + pc + ${vmCoreNames.seed}) % 11) + 1`,
          `local ghost = ${noiseStateName}[slot] or 0`,
          `${noiseStateName}[slot] = ${bxor32("ghost", "(a + b + pc) % " + bitNames.mod)}`,
        ]);
      case "NOISE_BRANCH":
        return mode === "block"
          ? [
              `if ((${aExpr} + pc + ${vmCoreNames.seed}) % 97) == 211 then`,
              `  pc = ${jumpTargetExpr}`,
              "else",
              `  pc = ${nextExpr}`,
              "end",
            ]
          : [
              `if ((a + pc + ${vmCoreNames.seed}) % 97) == 211 then`,
              `  return ${jumpTargetExpr}, false, nil`,
              "end",
              "return pc + 1, false, nil",
            ];
      default:
        return null;
    }
  };

  const lines = [
    `do`,
  ];
  if (!sharedRuntime) {
    lines.push(
      `local ${runtimeTools.bundle} = { string.char, string.byte, table.concat, table.pack, table.unpack, select, type, math.floor, getfenv }`,
      `local ${runtimeTools.char}, ${runtimeTools.byte}, ${runtimeTools.concat}, ${runtimeTools.pack}, ${runtimeTools.unpack}, ${runtimeTools.select}, ${runtimeTools.type}, ${runtimeTools.floor}, ${runtimeTools.getfenv} = ${runtimeTools.bundle}[1], ${runtimeTools.bundle}[2], ${runtimeTools.bundle}[3], ${runtimeTools.bundle}[4], ${runtimeTools.bundle}[5], ${runtimeTools.bundle}[6], ${runtimeTools.bundle}[7], ${runtimeTools.bundle}[8], ${runtimeTools.bundle}[9]`,
    );
  }
  const upperPoolLines = [];
  const lowerPoolLines = [];
  let upperPoolInsertIndex = lines.length;
  const poolPlacementMode = normalizeVmMode(
    vmOptions.poolPlacement,
    new Set(["auto", "top", "bottom", "spread"]),
    "spread"
  );
  const resolvePoolPlacement = () => {
    if (poolPlacementMode === "top" || poolPlacementMode === "bottom") {
      return poolPlacementMode;
    }
    return rng.bool(0.5) ? "top" : "bottom";
  };
  const appendPoolLines = (_kind, poolLines) => {
    if (!poolLines || !poolLines.length) return;
    if (resolvePoolPlacement() === "top") {
      upperPoolLines.push(...poolLines);
    } else {
      lowerPoolLines.push(...poolLines);
    }
  };
  const appendPoolAssignments = (kind, target, values) => {
    for (let i = 0; i < values.length; i += 1) {
      appendPoolLines(`${kind}_${i + 1}`, [`${target}[${i + 1}] = ${values[i]}`]);
    }
  };
  lines.push(
    `local bc_parts, bc_order, bc_part_lengths = {}, {}, {}`,
    `local const_parts, const_order, const_part_sizes, consts_data = {}, {}, {}, {}`
  );
  upperPoolInsertIndex = lines.length;

  if (!sharedRuntime) {
    const bitNameBytes = [98, 105, 116, 51, 50];
    const bitKey = rng.int(11, 200);
    const bitEncoded = bitNameBytes.map((value) => (value - bitKey + 256) % 256);
    const bitKeyName = makeVmHelperAliasName();
    const bitDataName = makeVmHelperAliasName();
    const bitOutName = makeVmHelperAliasName();
    const bitEnvName = makeVmHelperAliasName();
    const bitGetfName = makeVmHelperAliasName();
    lines.push(`local ${bitNames.mod} = 4294967296`);
    lines.push(`local ${bitNames.bit}`);
    lines.push(`do`);
    lines.push(`  local ${bitKeyName} = ${bitKey}`);
    lines.push(`  local ${bitDataName} = { ${bitEncoded.join(", ")} }`);
    lines.push(`  local ${bitOutName} = {}`);
    lines.push(`  for i = 1, #${bitDataName} do`);
    lines.push(`    ${bitOutName}[i] = ${runtimeTools.char}((${bitDataName}[i] + ${bitKeyName}) % 256)`);
    lines.push(`  end`);
    lines.push(`  local ${bitEnvName}`);
    lines.push(`  local ${bitGetfName} = ${runtimeTools.getfenv}`);
    lines.push(`  if ${runtimeTools.type}(${bitGetfName}) == "function" then ${bitEnvName} = ${bitGetfName}(1) end`);
    lines.push(`  if ${runtimeTools.type}(${bitEnvName}) ~= "table" then ${bitEnvName} = _G end`);
    lines.push(`  ${bitNames.bit} = ${bitEnvName}[${runtimeTools.concat}(${bitOutName})]`);
    lines.push(`end`);
    lines.push(`local ${bitNames.band32}, ${bitNames.bor32}, ${bitNames.bxor32}, ${bitNames.bnot32}, ${bitNames.lshift32}, ${bitNames.rshift32}`);
    lines.push(`if ${bitNames.bit} == nil then`);
    lines.push(`  local function ${bitNames.norm}(x)`);
    lines.push(`    x = x % ${bitNames.mod}`);
    lines.push(`    if x < 0 then x = x + ${bitNames.mod} end`);
    lines.push(`    return x`);
    lines.push(`  end`);
    lines.push(`  ${bitNames.band32} = function(a, b)`);
    lines.push(`    a = ${bitNames.norm}(a)`);
    lines.push(`    b = ${bitNames.norm}(b)`);
    lines.push(`    local res = 0`);
    lines.push(`    local bit = 1`);
    lines.push(`    for i = 0, 31 do`);
    lines.push(`      local abit = a % 2`);
    lines.push(`      local bbit = b % 2`);
    lines.push(`      if abit == 1 and bbit == 1 then res = res + bit end`);
    lines.push(`      a = (a - abit) / 2`);
    lines.push(`      b = (b - bbit) / 2`);
    lines.push(`      bit = bit * 2`);
    lines.push(`    end`);
    lines.push(`    return res`);
    lines.push(`  end`);
    lines.push(`  ${bitNames.bor32} = function(a, b)`);
    lines.push(`    a = ${bitNames.norm}(a)`);
    lines.push(`    b = ${bitNames.norm}(b)`);
    lines.push(`    local res = 0`);
    lines.push(`    local bit = 1`);
    lines.push(`    for i = 0, 31 do`);
    lines.push(`      local abit = a % 2`);
    lines.push(`      local bbit = b % 2`);
    lines.push(`      if abit == 1 or bbit == 1 then res = res + bit end`);
    lines.push(`      a = (a - abit) / 2`);
    lines.push(`      b = (b - bbit) / 2`);
    lines.push(`      bit = bit * 2`);
    lines.push(`    end`);
    lines.push(`    return res`);
    lines.push(`  end`);
    lines.push(`  ${bitNames.bxor32} = function(a, b)`);
    lines.push(`    a = ${bitNames.norm}(a)`);
    lines.push(`    b = ${bitNames.norm}(b)`);
    lines.push(`    local res = 0`);
    lines.push(`    local bit = 1`);
    lines.push(`    for i = 0, 31 do`);
    lines.push(`      local abit = a % 2`);
    lines.push(`      local bbit = b % 2`);
    lines.push(`      if abit + bbit == 1 then res = res + bit end`);
    lines.push(`      a = (a - abit) / 2`);
    lines.push(`      b = (b - bbit) / 2`);
    lines.push(`      bit = bit * 2`);
    lines.push(`    end`);
    lines.push(`    return res`);
    lines.push(`  end`);
    lines.push(`  ${bitNames.bnot32} = function(a)`);
    lines.push(`    return ${bitNames.mod} - 1 - ${bitNames.norm}(a)`);
    lines.push(`  end`);
    lines.push(`  ${bitNames.lshift32} = function(a, b)`);
    lines.push(`    b = b % 32`);
    lines.push(`    return (${bitNames.norm}(a) * (2 ^ b)) % ${bitNames.mod}`);
    lines.push(`  end`);
    lines.push(`  ${bitNames.rshift32} = function(a, b)`);
    lines.push(`    b = b % 32`);
    lines.push(`    return ${runtimeTools.floor}(${bitNames.norm}(a) / (2 ^ b))`);
    lines.push(`  end`);
    lines.push(`else`);
    lines.push(`  local ${bitNames.bit}_source = ${bitNames.bit}`);
    lines.push(`  ${bitNames.band32}, ${bitNames.bor32}, ${bitNames.bxor32}, ${bitNames.bnot32}, ${bitNames.lshift32}, ${bitNames.rshift32} = ${bitNames.bit}_source[${charExpr("band")}], ${bitNames.bit}_source[${charExpr("bor")}], ${bitNames.bit}_source[${charExpr("bxor")}], ${bitNames.bit}_source[${charExpr("bnot")}], ${bitNames.bit}_source[${charExpr("lshift")}], ${bitNames.bit}_source[${charExpr("rshift")}]`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.u64}(hi, lo)`);
    lines.push(`  return { hi, lo }`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.from}(v)`);
    lines.push(`  return { 0, v % ${bitNames.mod} }`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.lo}(v)`);
    lines.push(`  return v[2]`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.add}(a, b)`);
    lines.push(`  local lo = a[2] + b[2]`);
    lines.push(`  local carry = 0`);
    lines.push(`  if lo >= ${bitNames.mod} then`);
    lines.push(`    lo = lo - ${bitNames.mod}`);
    lines.push(`    carry = 1`);
    lines.push(`  end`);
    lines.push(`  local hi = (a[1] + b[1] + carry) % ${bitNames.mod}`);
    lines.push(`  return { hi, lo }`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.modn}(a, m)`);
    lines.push(`  local v = (a[1] % m) * (${bitNames.mod} % m) + (a[2] % m)`);
    lines.push(`  return v % m`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.modSmall}(a)`);
    lines.push(`  local v = (a[1] % 256) + (a[2] % 256)`);
    lines.push(`  return v % 256`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.bxor64}(a, b)`);
    lines.push(`  return { ${bitNames.bxor32}(a[1], b[1]), ${bitNames.bxor32}(a[2], b[2]) }`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.band64}(a, b)`);
    lines.push(`  return { ${bitNames.band32}(a[1], b[1]), ${bitNames.band32}(a[2], b[2]) }`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.bor64}(a, b)`);
    lines.push(`  return { ${bitNames.bor32}(a[1], b[1]), ${bitNames.bor32}(a[2], b[2]) }`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.bnot64}(a)`);
    lines.push(`  return { ${bitNames.bnot32}(a[1]), ${bitNames.bnot32}(a[2]) }`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.lshift64}(a, b)`);
    lines.push(`  b = b % 64`);
    lines.push(`  if b == 0 then`);
    lines.push(`    return { a[1], a[2] }`);
    lines.push(`  end`);
    lines.push(`  if b >= 32 then`);
    lines.push(`    local hi = ${bitNames.lshift32}(a[2], b - 32)`);
    lines.push(`    return { hi, 0 }`);
    lines.push(`  end`);
    lines.push(`  local hi = ${bitNames.bor32}(${bitNames.lshift32}(a[1], b), ${bitNames.rshift32}(a[2], 32 - b))`);
    lines.push(`  local lo = ${bitNames.lshift32}(a[2], b)`);
    lines.push(`  return { hi, lo }`);
    lines.push(`end`);
    lines.push(`local function ${bitNames.rshift64}(a, b)`);
    lines.push(`  b = b % 64`);
    lines.push(`  if b == 0 then`);
    lines.push(`    return { a[1], a[2] }`);
    lines.push(`  end`);
    lines.push(`  if b >= 32 then`);
    lines.push(`    local lo = ${bitNames.rshift32}(a[1], b - 32)`);
    lines.push(`    return { 0, lo }`);
    lines.push(`  end`);
    lines.push(`  local hi = ${bitNames.rshift32}(a[1], b)`);
    lines.push(`  local lo = ${bitNames.bor32}(${bitNames.rshift32}(a[2], b), ${bitNames.lshift32}(a[1], 32 - b))`);
    lines.push(`  return { hi, lo }`);
    lines.push(`end`);
  }

  if (!blockDispatch && !useBytecodeStream) {
    if (bcInfo && bcInfo.parts && bcInfo.parts.length > 1) {
      const partStrings = bcInfo.parts.map((part) => {
        const items = part
          .map((inst) => renderLinearInstruction(inst))
          .join(", ");
        return `{ ${items} }`;
      });
      lines.push(`local bc_parts = { ${partStrings.join(", ")} }`);
      lines.push(`local bc_offsets = { ${bcInfo.offsets.join(", ")} }`);
      lines.push(`local bc_order = { ${bcInfo.order.join(", ")} }`);
      lines.push(`local bc = {}`);
      lines.push(`for i = 1, #bc_order do`);
      lines.push(`  local idx = bc_order[i]`);
      lines.push(`  local part = bc_parts[idx]`);
      lines.push(`  local offset = bc_offsets[idx]`);
      lines.push(`  for j = 1, #part do`);
      lines.push(`    bc[offset + j - 1] = part[j]`);
      lines.push(`  end`);
      lines.push(`end`);
    } else {
      const bc = program.instructions
        .map((inst) => renderLinearInstruction(inst))
        .join(", ");
      lines.push(`local bc = { ${bc} }`);
    }
  }

  if (seedPieces.length) {
    const bcLenExpr = !blockDispatch && !useBytecodeStream
      ? "#bc"
      : String(program.instructions.length);
    lines.push(`local seed_pieces = { ${seedPieces.join(", ")} }`);
    lines.push(`local ${vmCoreNames.seed} = ${u64from("0")}`);
    lines.push(`for i = 1, #seed_pieces do`);
    lines.push(`  local v = seed_pieces[i]`);
    lines.push(`  local v64 = ${u64from("v")}`);
    lines.push(`  ${vmCoreNames.seed} = ${bxor64(u64add(vmCoreNames.seed, "v64"), band64(lshift64("v64", "(i - 1) % 3"), u64from("0xff")))}`);
    lines.push(`  ${vmCoreNames.seed} = ${band64(vmCoreNames.seed, u64from("0xff"))}`);
    lines.push(`end`);
    lines.push(`${vmCoreNames.seed} = ${u64modSmall(u64add(vmCoreNames.seed, u64from(`${bcLenExpr} + ${constCount}`)))}`);
  } else {
    lines.push(`local ${vmCoreNames.seed} = 0`);
  }
  lines.push(`local ${vmMeta.isaKeyA} = ${activeIsa.keyA || 0}`);
  lines.push(`local ${vmMeta.isaKeyB} = ${activeIsa.keyB || 0}`);

  if (!blockDispatch && opEncoded && opKeyPieces) {
    lines.push(`local op_key = ${opKeyPieces[0]} + ${opKeyPieces[1]} + ${vmCoreNames.seed}`);
    lines.push(`op_key = (op_key % 255) + 1`);
    lines.push(`local op_map = {}`);
    if (opEncodingMode === "pairs") {
      lines.push(`local op_pairs = ${luaString(opEncoded.join("\\95"))}`);
      lines.push(`local op_pair_cursor = 1`);
      lines.push(`local op_pair_buffer = {}`);
      lines.push(`for op_pair_chunk in string.gmatch(op_pairs, "[^\\\\]+") do`);
      lines.push(`  op_pair_buffer[#op_pair_buffer + 1] = tonumber(op_pair_chunk) or 0`);
      lines.push(`end`);
      lines.push(`for i = 1, #op_pair_buffer, 2 do`);
      lines.push(`  local pair_index = ${runtimeTools.floor}((i + 1) / 2)`);
      lines.push(`  local left = op_pair_buffer[i] or 0`);
      lines.push(`  local right = op_pair_buffer[i + 1] or 0`);
      lines.push(`  local mix = pair_index - 1`);
      lines.push(`  mix = mix * 11`);
      lines.push(`  mix = mix + op_key`);
      lines.push(`  mix = mix % 255`);
      lines.push(`  op_map[pair_index] = ${bxor32(bxor32("left", "right"), "mix")}`);
      lines.push(`end`);
    } else {
      lines.push(`local op_data = { ${opEncoded.join(", ")} }`);
      lines.push(`for i = 1, #op_data do`);
      lines.push(`  local mix = i - 1`);
      lines.push(`  mix = mix * 7`);
      lines.push(`  mix = mix + op_key`);
      lines.push(`  mix = mix % 255`);
      lines.push(`  op_map[i] = ${bxor32("op_data[i]", "mix")}`);
      lines.push(`end`);
    }
  } else if (!blockDispatch) {
    const identityOps = opcodeList.map((_, idx) => idx + 1);
    lines.push(`local op_map = { ${identityOps.join(", ")} }`);
  }

  if (!blockDispatch && keyEncoded && keyMaskPieces) {
    // Derive a per-program key schedule that can reconstruct per-instruction
    // masks without storing the expanded key stream in plaintext.
    const keyOutName = makeVmHelperAliasName();
    lines.push(`local bc_key_data = { ${keyEncoded.join(", ")} }`);
    lines.push(`local bc_key_state = {}`);
    lines.push(`local bc_key_mask = ${bxor32(String(keyMaskPieces[0]), String(keyMaskPieces[1]))} + ${vmCoreNames.seed}`);
    lines.push(`bc_key_mask = (bc_key_mask + 40503) % ${bitNames.mod}`);
    lines.push(`for i = 1, #bc_key_data do`);
    lines.push(`  local mix = i - 1`);
    lines.push(`  mix = mix * 40503`);
    lines.push(`  mix = mix + bc_key_mask`);
    lines.push(`  mix = mix % ${bitNames.mod}`);
    lines.push(`  bc_key_state[i] = ${bxor32("bc_key_data[i]", "mix")}`);
    lines.push(`end`);
    lines.push(`local ${vmStateNames.bcKeyCount} = #bc_key_state`);
    lines.push(`local bc_key_rounds = ${Math.max(1, keyRounds || 1)}`);
    lines.push(`local function ${helperNames.keyAt}(pcv)`);
    lines.push(`  if ${vmStateNames.bcKeyCount} < 4 then`);
    lines.push(`    return 0`);
    lines.push(`  end`);
    lines.push(`  local v0 = (pcv + ${vmCoreNames.seed} + bc_key_state[1]) % ${bitNames.mod}`);
    lines.push(`  v0 = ${bxor32("v0", "bc_key_state[2]")}`);
    lines.push(`  local v1 = (${vmCoreNames.seed} + bc_key_state[3]) % ${bitNames.mod}`);
    lines.push(`  v1 = ${bxor32("v1", "(pcv + bc_key_state[4]) % " + bitNames.mod)}`);
    lines.push(`  local sum = (bc_key_state[1] + bc_key_state[4] + pcv) % ${bitNames.mod}`);
    lines.push(`  for _ = 1, bc_key_rounds do`);
    lines.push(`    sum = (sum + 40503) % ${bitNames.mod}`);
    lines.push(`    local m1 = ${bxor32(lshift32("v1", "4"), rshift32("v1", "5"))}`);
    lines.push(`    m1 = ${bxor32("m1", "(v1 + sum) % " + bitNames.mod)}`);
    lines.push(`    local k1 = bc_key_state[(sum % 4) + 1]`);
    lines.push(`    v0 = (v0 + ${bxor32("m1", "k1")}) % ${bitNames.mod}`);
    lines.push(`    local m2 = ${bxor32(lshift32("v0", "4"), rshift32("v0", "5"))}`);
    lines.push(`    m2 = ${bxor32("m2", "(v0 + sum) % " + bitNames.mod)}`);
    lines.push(`    local k2 = bc_key_state[(${rshift32("sum", "11")} % 4) + 1]`);
    lines.push(`    v1 = (v1 + ${bxor32("m2", "k2")}) % ${bitNames.mod}`);
    lines.push(`  end`);
    lines.push(`  local ${keyOutName} = ${bxor32("v0", "v1")}`);
    lines.push(`  ${keyOutName} = ${bxor32(keyOutName, "(pcv + sum) % " + bitNames.mod)}`);
    lines.push(`  return ${keyOutName}`);
    lines.push(`end`);
  } else {
    lines.push(`local ${vmStateNames.bcKeyCount} = 0`);
    lines.push(`local function ${helperNames.keyAt}(_)`);
    lines.push(`  return 0`);
    lines.push(`end`);
  }

  const decoyProbability = typeof vmOptions.decoyProbability === "number"
    ? vmOptions.decoyProbability
    : 0.85;
  const enableDecoyVm = vmOptions.decoyRuntime !== false
    && rng.bool(Math.max(0, Math.min(1, decoyProbability)));
  if (enableDecoyVm) {
    // Decoy VMs consume plausible-looking byte strings so static analysis has
    // extra interpreter-shaped code paths to wade through.
    const decoyOutName = makeVmHelperAliasName();
    const decoyCountRaw = Number(vmOptions.decoyStrings);
    const decoyCount = Number.isFinite(decoyCountRaw)
      ? Math.max(4, Math.min(96, Math.floor(decoyCountRaw)))
      : 12;
    const decoyShift = rng.int(5, 37);
    const decoyStrings = buildDecoyVmStrings(rng, decoyCount);
    const decoyEncoded = decoyStrings.map((text) => {
      const bytes = [];
      for (let i = 0; i < text.length; i += 1) {
        bytes.push((text.charCodeAt(i) + decoyShift) & 0xff);
      }
      return luaByteString(bytes);
    });
    const decoyOrder = Array.from({ length: decoyEncoded.length }, (_, idx) => idx + 1);
    rng.shuffle(decoyOrder);
    lines.push(`local ${decoyNames.pool} = {}`);
    for (const idx of decoyOrder) {
      lines.push(`${decoyNames.pool}[${idx}] = ${decoyEncoded[idx - 1]}`);
    }
    lines.push(`local ${decoyNames.key} = (${decoyShift} + (${vmCoreNames.seed} - ${vmCoreNames.seed})) % 256`);
    lines.push(`local function ${decoyNames.decode}(i)`);
    lines.push(`  local raw = ${decoyNames.pool}[i]`);
    lines.push(`  if not raw then return nil end`);
    lines.push(`  local ${decoyOutName} = {}`);
    lines.push(`  for j = 1, #raw do`);
    lines.push(`    local v = ${runtimeTools.byte}(raw, j) - ${decoyNames.key}`);
    lines.push(`    if v < 0 then v = v + 256 end`);
    lines.push(`    ${decoyOutName}[j] = ${runtimeTools.char}(v)`);
    lines.push(`  end`);
    lines.push(`  return ${runtimeTools.concat}(${decoyOutName})`);
    lines.push(`end`);
    lines.push(`local function ${decoyNames.vm}(${decoyNames.pc}, ${decoyNames.stack})`);
    lines.push(`  local ${decoyNames.sink} = 0`);
    lines.push(`  local ${decoyNames.guard} = 0`);
    lines.push(`  while ${decoyNames.pc} > 0 do`);
    lines.push(`    ${decoyNames.guard} = ${decoyNames.guard} + 1`);
    lines.push(`    if ${decoyNames.guard} > #${decoyNames.pool} then break end`);
    lines.push(`    local ${decoyNames.token} = ${decoyNames.decode}(${decoyNames.pc})`);
    lines.push(`    local ${decoyNames.opcode} = ${decoyNames.token} and (${runtimeTools.byte}(${decoyNames.token}, 1) % 6) or 0`);
    lines.push(`    if ${decoyNames.opcode} == 0 then`);
    lines.push(`      ${decoyNames.sink} = ${decoyNames.sink} + ${decoyNames.pc}`);
    lines.push(`      ${decoyNames.pc} = ${decoyNames.pc} + 1`);
    lines.push(`    elseif ${decoyNames.opcode} == 1 then`);
    lines.push(`      ${decoyNames.sink} = ${bxor32(decoyNames.sink, decoyNames.guard)}`);
    lines.push(`      ${decoyNames.pc} = ${decoyNames.pc} + 1`);
    lines.push(`    elseif ${decoyNames.opcode} == 2 then`);
    lines.push(`      ${decoyNames.sink} = ${decoyNames.sink} + (${decoyNames.token} and #${decoyNames.token} or 0)`);
    lines.push(`      ${decoyNames.pc} = ${decoyNames.pc} + 2`);
    lines.push(`    elseif ${decoyNames.opcode} == 3 then`);
    lines.push(`      ${decoyNames.pc} = 0`);
    lines.push(`    else`);
    lines.push(`      ${decoyNames.pc} = ${decoyNames.pc} + 1`);
    lines.push(`    end`);
    lines.push(`  end`);
    lines.push(`  return ${decoyNames.sink}, ${decoyNames.stack}`);
    lines.push(`end`);
    const decoyGateA = rng.int(3, 17);
    const decoyGateB = rng.int(0, 18);
    lines.push(`local ${decoyNames.probe} = (${vmCoreNames.seed} + ${vmStateNames.bcKeyCount} + #${decoyNames.pool}) % 19`);
    lines.push(`if ((${decoyNames.probe} * ${decoyGateA}) + ${vmCoreNames.seed}) % 19 == ${decoyGateB} then`);
    lines.push(`  ${decoyNames.vm}((${decoyNames.probe} % #${decoyNames.pool}) + 1, {})`);
    lines.push(`end`);
  }

  if (constInfo) {
    const constEncoding = vmOptions.constsEncoding === "table" ? "table" : "string";
    const renderConstEntry = (entry) => {
      if (constEncoding === "string") {
        return `{ ${entry.tagEnc}, ${entry.salt}, ${luaByteString(entry.data)} }`;
      }
      const data = entry.data.join(", ");
      return `{ ${entry.tagEnc}, ${entry.salt}, { ${data} } }`;
    };
    if (vmOptions.constsSplit && constInfo.entries.length > (vmOptions.constsSplitSize || 0)) {
      const parts = splitConstEntries(constInfo.entries, rng, vmOptions.constsSplitSize || 24);
      const storageOrder = parts.map((_, idx) => idx + 1);
      rng.shuffle(storageOrder);
      const storedParts = storageOrder.map((idx) => parts[idx - 1]);
      const logicalOrder = new Array(parts.length);
      storageOrder.forEach((partIndex, storageIndex) => {
        logicalOrder[partIndex - 1] = storageIndex + 1;
      });
      const partStrings = storedParts.map((part) => `{ ${part.map(renderConstEntry).join(", ")} }`);
      const logicalSizes = parts.map((part) => part.length);
      appendPoolAssignments("const_parts", "const_parts", partStrings);
      appendPoolAssignments("const_order", "const_order", logicalOrder.map(String));
      appendPoolAssignments("const_part_sizes", "const_part_sizes", logicalSizes.map(String));
      lines.push(`local function ${helperNames.constEntry}(i)`);
      lines.push(`  local offset = 0`);
      lines.push(`  for p = 1, #const_part_sizes do`);
      lines.push(`    local size = const_part_sizes[p]`);
      lines.push(`    local limit = offset + size`);
      lines.push(`    if i <= limit then`);
      lines.push(`      local part = const_parts[const_order[p]]`);
      lines.push(`      return part[i - offset]`);
      lines.push(`    end`);
      lines.push(`    offset = limit`);
      lines.push(`  end`);
      lines.push(`  return nil`);
      lines.push(`end`);
    } else {
      const constEntries = constInfo.entries.map(renderConstEntry);
      appendPoolAssignments("consts_data", "consts_data", constEntries);
      lines.push(`local function ${helperNames.constEntry}(i)`);
      lines.push(`  return consts_data[i]`);
      lines.push(`end`);
    }
    lines.push(`local consts_key_enc = { ${constInfo.keyEncoded.join(", ")} }`);
    lines.push(`local consts_key = {}`);
    lines.push(`local consts_cache = {}`);
    lines.push(`local consts_ready = {}`);
    lines.push(`local const_key_mask = ${bxor32(String(constInfo.maskPieces[0]), String(constInfo.maskPieces[1]))} + ${vmCoreNames.seed}`);
    lines.push(`const_key_mask = const_key_mask % 256`);
    lines.push(`for i = 1, #consts_key_enc do`);
    lines.push(`  local mix = i - 1`);
    lines.push(`  mix = mix * 11`);
    lines.push(`  mix = mix + const_key_mask`);
    lines.push(`  mix = mix % 256`);
    lines.push(`  consts_key[i] = ${bxor32("consts_key_enc[i]", "mix")}`);
    lines.push(`end`);
    const constKeyLenName = makeVmHelperAliasName();
    const constEntryName = makeVmHelperAliasName();
    const constDataName = makeVmHelperAliasName();
    const constOutName = makeVmHelperAliasName();
    const constIndexName = makeVmHelperAliasName();
    const constMixName = makeVmHelperAliasName();
    const constValueName = makeVmHelperAliasName();
    const constStringName = makeVmHelperAliasName();
    lines.push(`local ${constKeyLenName} = #consts_key`);
    if (constEncoding === "string") {
      lines.push(`local const_byte = ${runtimeTools.byte}`);
    }
    lines.push(`local function ${helperNames.getConst}(i)`);
    lines.push(`  if consts_ready[i] then`);
    lines.push(`    return consts_cache[i]`);
    lines.push(`  end`);
    lines.push(`  consts_ready[i] = true`);
    lines.push(`  local ${constEntryName} = ${helperNames.constEntry}(i)`);
    lines.push(`  if not ${constEntryName} then`);
    lines.push(`    return nil`);
    lines.push(`  end`);
    lines.push(`  local tagEnc = ${constEntryName}[1]`);
    lines.push(`  local salt = ${constEntryName}[2] or 0`);
    lines.push(`  local ${constDataName} = ${constEntryName}[3]`);
    lines.push(`  local ${constOutName} = {}`);
    lines.push(`  for j = 1, #${constDataName} do`);
    lines.push(`    local ${constIndexName} = (j - 1) % ${constKeyLenName} + 1`);
    lines.push(`    local ${constMixName} = consts_key[${constIndexName}] + salt + ((i * 13) % 256) + (((j - 1) * 7) % 251)`);
    lines.push(`    ${constMixName} = ${constMixName} % 256`);
    if (constEncoding === "string") {
      lines.push(`    local ${constValueName} = const_byte(${constDataName}, j) - ${constMixName}`);
    } else {
      lines.push(`    local ${constValueName} = ${constDataName}[j] - ${constMixName}`);
    }
    lines.push(`    if ${constValueName} < 0 then ${constValueName} = ${constValueName} + 256 end`);
    lines.push(`    ${constOutName}[j] = ${runtimeTools.char}(${constValueName})`);
    lines.push(`  end`);
    lines.push(`  local ${constStringName} = ${runtimeTools.concat}(${constOutName})`);
    lines.push(`  local value`);
    lines.push(`  local tag = (tagEnc - ((salt + const_key_mask + (i * 3)) % 5)) % 5`);
    lines.push(`  if tag == 0 then`);
    lines.push(`    value = nil`);
    lines.push(`  elseif tag == 1 then`);
    lines.push(`    value = false`);
    lines.push(`  elseif tag == 2 then`);
    lines.push(`    value = true`);
    lines.push(`  elseif tag == 3 then`);
    lines.push(`    value = tonumber(${constStringName})`);
    lines.push(`  else`);
    lines.push(`    value = ${constStringName}`);
    lines.push(`  end`);
    lines.push(`  consts_cache[i] = value`);
    lines.push(`  return value`);
    lines.push(`end`);
  } else {
    const consts = program.consts.map((value) => {
      if (value === null || value === undefined) {
        return "nil";
      }
      if (typeof value === "string") {
        return luaString(value);
      }
      if (typeof value === "boolean") {
        return value ? "true" : "false";
      }
      return String(value);
    });
    const constTable = `{ ${consts.join(", ")} }`;
    lines.push(`local consts = ${constTable}`);
    lines.push(`local function ${helperNames.getConst}(i)`);
    lines.push(`  return consts[i]`);
    lines.push(`end`);
  }

  lines.push(
    `local function ${helperNames.cell}(value) return { value } end`,
    `local locals = ${localsTable}`,
    `local stack = {}`,
    `local top = 0`,
    `local env`,
    `local getf = ${runtimeTools.getfenv}`,
    `if ${runtimeTools.type}(getf) == "function" then env = getf(1) end`,
    `if ${runtimeTools.type}(env) ~= "table" then env = _G end`,
    `local pack = ${runtimeTools.pack}`,
    `if pack == nil then`,
    `  pack = function(...) return { n = ${runtimeTools.select}("#", ...), ... } end`,
    `end`,
    `local unpack = ${runtimeTools.unpack}`,
    `if unpack == nil then`,
    `  local function unpack_fn(t, i, j)`,
    `    i = i or 1`,
    `    j = j or (t.n or #t)`,
    `    if i > j then return end`,
    `    return t[i], unpack_fn(t, i + 1, j)`,
    `  end`,
    `  unpack = unpack_fn`,
    `end`,
  );
  if (vmOptions.sandbox !== false) {
    lines.push(
      `do`,
      `  local raw_env = env`,
      `  local safe_env = {}`,
      `  local blocked = { debug = true, getfenv = true, setfenv = true, load = true, loadstring = true, dofile = true, loadfile = true, package = true, io = true }`,
      `  local env_meta = {}`,
      `  env_meta.__index = function(_, key)`,
      `    if blocked[key] == true then return nil end`,
      `    return raw_env[key]`,
      `  end`,
      `  env_meta.__newindex = function(_, key, value)`,
      `    if blocked[key] == true then error("operation unavailable", 0) end`,
      `    rawset(safe_env, key, value)`,
      `  end`,
      `  env_meta.__metatable = "locked"`,
      `  safe_env._G = safe_env`,
      `  safe_env._ENV = safe_env`,
      `  setmetatable(safe_env, env_meta)`,
      `  env = safe_env`,
      `end`,
    );
  }
  if (program && program.hasVararg) {
    lines.push(`local ${helperNames.varargs} = pack(...)`);
  } else {
    lines.push(`local ${helperNames.varargs} = { n = 0 }`);
  }
  lines.push(`local function ${helperNames.expandArgs}(prefix, tail)`);
  lines.push(`  local args = {}`);
  lines.push(`  local count = 0`);
  lines.push(`  local prefixCount = prefix and (prefix.n or #prefix) or 0`);
  lines.push(`  if prefixCount > 0 then`);
  lines.push(`    table.move(prefix, 1, prefixCount, 1, args)`);
  lines.push(`    count = prefixCount`);
  lines.push(`  end`);
  lines.push(`  local tailCount = tail and (tail.n or #tail) or 0`);
  lines.push(`  if tailCount > 0 then`);
  lines.push(`    table.move(tail, 1, tailCount, count + 1, args)`);
  lines.push(`    count = count + tailCount`);
  lines.push(`  end`);
  lines.push(`  args.n = count`);
  lines.push(`  return args`);
  lines.push(`end`);
  lines.push(`local function ${helperNames.callExpanded}(fn, prefix, tail)`);
  lines.push(`  local args = ${helperNames.expandArgs}(prefix, tail)`);
  lines.push(`  return pack(fn(unpack(args, 1, args.n or #args)))`);
  lines.push(`end`);
  const syncSetterTable = makeName();
  lines.push(`local ${syncSetterTable} = {}`);
  if (setTargets && setTargets.length) {
    setTargets.forEach((target, index) => {
      if (!target || typeof target === "object") {
        return;
      }
      const setterName = makeVmHelperAliasName();
      lines.push(`local function ${setterName}(nextValue)`);
      lines.push(`  ${target} = nextValue`);
      lines.push(`end`);
      lines.push(`${syncSetterTable}[${index + 1}] = ${setterName}`);
    });
  }
  lines.push(`local function ${helperNames.syncLocal}(idx, value)`);
  lines.push(`  local setter = ${syncSetterTable}[idx]`);
  lines.push(`  if setter then`);
  lines.push(`    setter(value)`);
  lines.push(`  end`);
  lines.push(`  return`);
  lines.push(`end`);
  lines.push(`local function ${helperNames.localValue}(idx)`);
  lines.push(`  local slot = locals[idx]`);
  lines.push(`  if slot == nil then return nil end`);
  lines.push(`  return slot[1]`);
  lines.push(`end`);
  lines.push(`local function ${helperNames.localSet}(idx, value)`);
  lines.push(`  local slot = locals[idx]`);
  lines.push(`  if slot == nil then`);
  lines.push(`    slot = ${helperNames.cell}(nil)`);
  lines.push(`    locals[idx] = slot`);
  lines.push(`  end`);
  lines.push(`  slot[1] = value`);
  lines.push(`  ${helperNames.syncLocal}(idx, value)`);
  lines.push(`end`);
  lines.push(`local function ${helperNames.localDeclare}(idx, value)`);
  lines.push(`  locals[idx] = ${helperNames.cell}(value)`);
  lines.push(`  ${helperNames.syncLocal}(idx, value)`);
  lines.push(`end`);
  lines.push(`local ${helperNames.closureFactory} = {}`);
  if (program && Array.isArray(program.closures) && program.closures.length) {
    program.closures.forEach((closure, index) => {
      const nestedProgram = closure && closure.program ? closure.program : null;
      if (!nestedProgram) {
        return;
      }
      const nestedOpcodeList = Array.from(new Set([
        ...OPCODES,
        ...NOISE_OPCODES,
        ...(nestedProgram.instructions || [])
          .map((inst) => inst && inst[0])
          .filter((name) => typeof name === "string"),
      ]));
      const nestedOpcodeMap = buildOpcodeMap(null, false, nestedOpcodeList);
      nestedProgram.instructions = compactInstructionList(nestedProgram.instructions || []).map((inst) => {
        if (!inst || typeof inst[0] !== "string") {
          return inst;
        }
        const opName = inst[0];
        const width = getOpcodeArity(opName);
        const out = [nestedOpcodeMap[opName]];
        if (width >= 1) {
          out.push(inst[1] || 0);
        }
        if (width >= 2) {
          out.push(inst[2] || 0);
        }
        return out;
      });
      const nestedOptions = {
        ...vmOptions,
        blockDispatch: false,
        bytecodeEncrypt: false,
        constsEncrypt: false,
        constsSplit: false,
        runtimeKey: false,
        runtimeSplit: false,
        decoyRuntime: false,
        symbolNoise: false,
        dynamicCoupling: false,
      };
      const nestedBuilt = buildVmSource(
        nestedProgram,
        null,
        nestedProgram.paramNames || [],
        null,
        null,
        null,
        null,
        rng,
        nestedOptions,
        reservedNames,
        nestedOpcodeList,
        null,
        sharedRuntime
      );
      const nestedSource = typeof nestedBuilt === "string" ? nestedBuilt : nestedBuilt.source;
      const params = (nestedProgram.paramNames || [])
        .map((name, paramIndex) => (name && typeof name === "string" ? name : `_${paramIndex + 1}`));
      if (nestedProgram.hasVararg) {
        params.push("...");
      }
      lines.push(`${helperNames.closureFactory}[${index + 1}] = function(__vm_parent_locals)`);
      const captureCells = Array.isArray(closure.captures) && closure.captures.length
        ? closure.captures.map((capture) => `__vm_parent_locals[${capture.index}]`).join(", ")
        : "";
      lines.push(`  local __vm_captures = { ${captureCells} }`);
      lines.push(`  return function(${params.join(", ")})`);
      nestedSource.split("\n").forEach((line) => {
        lines.push(`    ${line}`);
      });
      lines.push(`  end`);
      lines.push(`end`);
    });
  }
  const dynamicCoupling = vmOptions.dynamicCoupling !== false;
  const couplingMul = rng.int(3, 31);
  const couplingAdd = rng.int(7, 127);
  lines.push(`local ${vmStateNames.stateKey} = (${vmCoreNames.seed} + ${vmStateNames.bcKeyCount} + ${couplingAdd}) % ${bitNames.mod}`);
  if (vmOptions.symbolNoise !== false) {
    const noisePool = makeName();
    const noiseSum = makeName();
    const noiseMap = makeName();
    const noiseCount = rng.int(3, 6);
    const noiseValues = Array.from({ length: noiseCount }, () => luaString(buildSymbolNoiseToken(rng)));
    lines.push(`local ${noisePool} = { ${noiseValues.join(", ")} }`);
    lines.push(`local ${noiseSum} = 0`);
    lines.push(`for i = 1, #${noisePool} do`);
    lines.push(`  ${noiseSum} = ${noiseSum} + #${noisePool}[i]`);
    lines.push(`end`);
    lines.push(`local ${noiseMap} = { ["!@#"] = ${noiseSum}, ["[]{}"] = #${noisePool} }`);
    lines.push(`if (${noiseMap}["!@#"] % 8191) == 8192 then`);
    lines.push(`  ${noisePool}[1] = ${noisePool}[1] .. ${luaString("!?!")}`);
    lines.push(`end`);
  }

  if (useBytecodeStream) {
    const stream = encodeBytecodeStream(program.instructions, rng, seedState, bcInfo);
    const partStrings = stream.parts.map((part) => bytesToLuaString(part));
    const logicalPartLengths = stream.order.map((storageIndex) => stream.parts[storageIndex - 1].length);
    appendPoolAssignments("bc_parts", "bc_parts", partStrings);
    appendPoolAssignments("bc_order", "bc_order", stream.order.map(String));
    appendPoolAssignments("bc_part_lengths", "bc_part_lengths", logicalPartLengths.map(String));
    lines.push(`local bc_key = ${stream.keyPieces[0]} + ${stream.keyPieces[1]} + ${vmCoreNames.seed}`);
    lines.push(`bc_key = bc_key % 256`);
    lines.push(`local bc_mul = ${stream.multiplier}`);
    lines.push(`local bc_span = ${stream.blockSpan}`);
    lines.push(`local bc_twist = ${stream.twist}`);
    lines.push(`local bc_byte = ${runtimeTools.byte}`);
    lines.push(`local bc_inst_count = ${program.instructions.length}`);
    const streamIndexName = makeName();
    const streamIndexReadyName = makeName();
    const streamEnsureIndexName = makeName();
    lines.push(`local ${streamIndexName} = {}`);
    lines.push(`local ${streamIndexReadyName} = false`);
    lines.push(`local function ${helperNames.partByte}(pos)`);
    lines.push(`  local offset = 0`);
    lines.push(`  for p = 1, #bc_order do`);
    lines.push(`    local len = bc_part_lengths[p]`);
    lines.push(`    local limit = offset + len`);
    lines.push(`    if pos <= limit then`);
    lines.push(`      local part = bc_parts[bc_order[p]]`);
    lines.push(`      return bc_byte(part, pos - offset)`);
    lines.push(`    end`);
    lines.push(`    offset = limit`);
    lines.push(`  end`);
    lines.push(`  return nil`);
    lines.push(`end`);
    lines.push(`local function ${helperNames.byte}(i)`);
    lines.push(`  local b = ${helperNames.partByte}(i)`);
    lines.push(`  if b == nil then`);
    lines.push(`    return 0`);
    lines.push(`  end`);
    lines.push(`  local mix = (i * bc_mul) % 256`);
    lines.push(`  local block = (${runtimeTools.floor}((i - 1) / bc_span) + 1) * bc_twist`);
    lines.push(`  mix = mix + block + bc_key`);
    lines.push(`  mix = mix % 256`);
    lines.push(`  return ${bxor32("b", "mix")}`);
    lines.push(`end`);
    lines.push(`local function ${helperNames.u32}(pos)`);
    lines.push(`  local b1 = ${helperNames.byte}(pos)`);
    lines.push(`  local b2 = ${helperNames.byte}(pos + 1)`);
    lines.push(`  local b3 = ${helperNames.byte}(pos + 2)`);
    lines.push(`  local b4 = ${helperNames.byte}(pos + 3)`);
    lines.push(`  return b1 + b2 * 256 + b3 * 65536 + b4 * 16777216`);
    lines.push(`end`);
    lines.push(`local function ${streamEnsureIndexName}()`);
    lines.push(`  if ${streamIndexReadyName} then`);
    lines.push(`    return`);
    lines.push(`  end`);
    lines.push(`  local cursor = 1`);
    lines.push(`  for i = 1, bc_inst_count do`);
    lines.push(`    ${streamIndexName}[i] = cursor`);
    lines.push(`    local width = ${helperNames.byte}(cursor)`);
    lines.push(`    if width == nil or width < 1 then`);
    lines.push(`      width = 1`);
    lines.push(`    end`);
    lines.push(`    cursor = cursor + 1 + width * 4`);
    lines.push(`  end`);
    lines.push(`  ${streamIndexReadyName} = true`);
    lines.push(`end`);
    lines.push(`local function ${helperNames.getInst}(pc)`);
    lines.push(`  ${streamEnsureIndexName}()`);
    lines.push(`  local base = ${streamIndexName}[pc]`);
    lines.push(`  if base == nil then`);
    lines.push(`    return 0, 0, 0`);
    lines.push(`  end`);
    lines.push(`  local width = ${helperNames.byte}(base)`);
    lines.push(`  if width == nil or width < 1 then`);
    lines.push(`    return 0, 0, 0`);
    lines.push(`  end`);
    lines.push(`  local op = ${helperNames.u32}(base + 1)`);
    lines.push(`  local a = 0`);
    lines.push(`  local b = 0`);
    lines.push(`  if width > 1 then`);
    lines.push(`    a = ${helperNames.u32}(base + 5)`);
    lines.push(`  end`);
    lines.push(`  if width > 2 then`);
    lines.push(`    b = ${helperNames.u32}(base + 9)`);
    lines.push(`  end`);
    lines.push(`  return op, a, b`);
    lines.push(`end`);
  }

  if (lowerPoolLines.length) {
    lines.push(...lowerPoolLines);
    lowerPoolLines.length = 0;
  }

  if (blockDispatch) {
    const ids = buildBlockIds(program.instructions.length, rng);
    const idByIndex = new Map();
    const blocks = program.instructions.map((inst, idx) => {
      const entry = {
        id: ids[idx],
        index: idx + 1,
        op: inst[0],
        a: inst[1] || 0,
        b: inst[2] || 0,
      };
      idByIndex.set(entry.index, entry.id);
      return entry;
    });
    const entryId = ids[0] || 0;
    const sorted = blocks.slice().sort((a, b) => a.id - b.id);
    const emitBlock = (block) => {
      const opName = typeof block.op === "string" ? block.op : (opcodeList[block.op - 1] || "NOP");
      const a = block.a || 0;
      const b = block.b || 0;
      const isX = typeof opName === "string" && opName.endsWith("_X");
      const aExpr = isX ? bxor32(String(a), vmMeta.isaKeyA) : String(a);
      const bExpr = opName === "CALL_X" ? bxor32(String(b), vmMeta.isaKeyB) : String(b);
      const aValue = isX ? (a ^ (activeIsa.keyA || 0)) : a;
      const nextId = idByIndex.get(block.index + 1) || 0;
      const targetId = idByIndex.get(aValue) || 0;
      const leftLocal = Math.floor(a / 65536);
      const rightLocal = a % 65536;
      const targetIdB = idByIndex.get(b) || 0;
      const baseOpName = typeof opName === "string" && opName.endsWith("_X")
        ? opName.slice(0, -2)
        : opName;
      const emitSharedBlockBody = () => emitSharedOpBody(baseOpName, {
        mode: "block",
        nextExpr: String(nextId),
        aExpr,
        bExpr,
        jumpTargetExpr: String(targetId),
      });
      switch (opName) {
        case "CALL_EXPAND":
          return [
            `local retc = ${aExpr}`,
            "local tail = stack[top]",
            "local prefixArgs = stack[top - 1]",
            "local fn = stack[top - 2]",
            `local res = ${helperNames.callExpanded}(fn, prefixArgs, tail)`,
            "for i = top, top - 2, -1 do",
            "  stack[i] = nil",
            "end",
            "top = top - 3",
            "if retc == 0 then",
            `  pc = ${nextId}`,
            "elseif retc == 1 then",
            "  top = top + 1",
            "  stack[top] = res[1]",
            `  pc = ${nextId}`,
            "else",
            "  for i = 1, retc do",
            "    top = top + 1",
            "    stack[top] = res[i]",
            "  end",
            `  pc = ${nextId}`,
            "end",
          ];
        case "RETURN_CALL":
          return [
            `local argc = ${aExpr}`,
            `local prefix = ${bExpr}`,
            "local base = top - argc",
            "local fn = stack[base]",
            "if prefix == 0 then",
            "  return fn(unpack(stack, base + 1, top))",
            "end",
            "local res = pack(fn(unpack(stack, base + 1, top)))",
            "local merged = { n = prefix + (res.n or #res) }",
            "local prefixBase = base - prefix",
            "for i = 1, prefix do",
            "  merged[i] = stack[prefixBase + i - 1]",
            "end",
            "for i = 1, res.n or #res do",
            "  merged[prefix + i] = res[i]",
            "end",
            "return unpack(merged, 1, merged.n)",
          ];
        case "RETURN_CALL_EXPAND":
          return [
            `local prefix = ${aExpr}`,
            "local tail = stack[top]",
            "local prefixArgs = stack[top - 1]",
            "local fn = stack[top - 2]",
            `local res = ${helperNames.callExpanded}(fn, prefixArgs, tail)`,
            "if prefix == 0 then",
            "  return unpack(res, 1, res.n or #res)",
            "end",
            "local merged = { n = prefix + (res.n or #res) }",
            "local prefixBase = top - 2 - prefix",
            "for i = 1, prefix do",
            "  merged[i] = stack[prefixBase + i - 1]",
            "end",
            "for i = 1, res.n or #res do",
            "  merged[prefix + i] = res[i]",
            "end",
            "return unpack(merged, 1, merged.n)",
          ];
        case "APPEND_CALL":
          return [
            `local argc = ${aExpr}`,
            `local startIndex = ${bExpr}`,
            "local base = top - argc",
            "local fn = stack[base]",
            "local tbl = stack[base - 1]",
            "local res = pack(fn(unpack(stack, base + 1, top)))",
            "for i = top, base, -1 do",
            "  stack[i] = nil",
            "end",
            "top = base - 1",
            "for i = 1, res.n or #res do",
            "  tbl[startIndex + i - 1] = res[i]",
            "end",
            "if tbl.n ~= nil then",
            "  tbl.n = startIndex + (res.n or #res) - 1",
            "end",
            `pc = ${nextId}`,
          ];
        case "APPEND_CALL_EXPAND":
          return [
            `local startIndex = ${aExpr}`,
            "local tail = stack[top]",
            "local prefixArgs = stack[top - 1]",
            "local fn = stack[top - 2]",
            "local tbl = stack[top - 3]",
            `local res = ${helperNames.callExpanded}(fn, prefixArgs, tail)`,
            "for i = top, top - 2, -1 do",
            "  stack[i] = nil",
            "end",
            "top = top - 3",
            "for i = 1, res.n or #res do",
            "  tbl[startIndex + i - 1] = res[i]",
            "end",
            "if tbl.n ~= nil then",
            "  tbl.n = startIndex + (res.n or #res) - 1",
            "end",
            `pc = ${nextId}`,
          ];
        case "RETURN":
          return [
            `local count = ${a}`,
            "if count == 0 then",
            "  return",
            "elseif count == 1 then",
            "  return stack[top]",
            "else",
            "  local base = top - count + 1",
            "  return unpack(stack, base, top)",
            "end",
          ];
        case "JMP":
        case "JMP_X":
          return [`pc = ${targetId}`];
        case "JMP_IF_LOCAL_LT":
          return [
            `if ${helperNames.localValue}(${leftLocal}) < ${helperNames.localValue}(${rightLocal}) then`,
            `  pc = ${targetIdB}`,
            "else",
            `  pc = ${nextId}`,
            "end",
          ];
        case "JMP_IF_LOCAL_GT":
          return [
            `if ${helperNames.localValue}(${leftLocal}) > ${helperNames.localValue}(${rightLocal}) then`,
            `  pc = ${targetIdB}`,
            "else",
            `  pc = ${nextId}`,
            "end",
          ];
        case "JMP_IF_LOCAL_LE":
          return [
            `if ${helperNames.localValue}(${leftLocal}) <= ${helperNames.localValue}(${rightLocal}) then`,
            `  pc = ${targetIdB}`,
            "else",
            `  pc = ${nextId}`,
            "end",
          ];
        case "JMP_IF_LOCAL_GE":
          return [
            `if ${helperNames.localValue}(${leftLocal}) >= ${helperNames.localValue}(${rightLocal}) then`,
            `  pc = ${targetIdB}`,
            "else",
            `  pc = ${nextId}`,
            "end",
          ];
        case "JMP_IF_FALSE":
        case "JMP_IF_FALSE_X":
          return [
            "if not stack[top] then",
            `  pc = ${targetId}`,
            "else",
            `  pc = ${nextId}`,
            "end",
          ];
        case "JMP_IF_TRUE":
        case "JMP_IF_TRUE_X":
          return [
            "if stack[top] then",
            `  pc = ${targetId}`,
            "else",
            `  pc = ${nextId}`,
            "end",
          ];
        case "ADD":
          return [
            "stack[top - 1] = stack[top - 1] + stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "ADD_REG_LOCAL":
          return [
            `${helperNames.localSet}(${a}, ${helperNames.localValue}(${a}) + ${helperNames.localValue}(${b}))`,
            `pc = ${nextId}`,
          ];
        case "ADD_REG_CONST":
          return [
            `${helperNames.localSet}(${a}, ${helperNames.localValue}(${a}) + ${helperNames.getConst}(${b}))`,
            `pc = ${nextId}`,
          ];
        case "SUB_REG_LOCAL":
          return [
            `${helperNames.localSet}(${a}, ${helperNames.localValue}(${a}) - ${helperNames.localValue}(${b}))`,
            `pc = ${nextId}`,
          ];
        case "SUB_REG_CONST":
          return [
            `${helperNames.localSet}(${a}, ${helperNames.localValue}(${a}) - ${helperNames.getConst}(${b}))`,
            `pc = ${nextId}`,
          ];
        case "SUB":
          return [
            "stack[top - 1] = stack[top - 1] - stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "MUL":
          return [
            "stack[top - 1] = stack[top - 1] * stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "DIV":
          return [
            "stack[top - 1] = stack[top - 1] / stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "IDIV":
          return [
            `stack[top - 1] = ${runtimeTools.floor}(stack[top - 1] / stack[top])`,
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "MOD":
          return [
            "stack[top - 1] = stack[top - 1] % stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "POW":
          return [
            "stack[top - 1] = stack[top - 1] ^ stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "CONCAT":
          return [
            "stack[top - 1] = stack[top - 1] .. stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "EQ":
          return [
            "stack[top - 1] = stack[top - 1] == stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "NE":
          return [
            "stack[top - 1] = stack[top - 1] ~= stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "LT":
          return [
            "stack[top - 1] = stack[top - 1] < stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "LE":
          return [
            "stack[top - 1] = stack[top - 1] <= stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "GT":
          return [
            "stack[top - 1] = stack[top - 1] > stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "GE":
          return [
            "stack[top - 1] = stack[top - 1] >= stack[top]",
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "BAND":
          return [
            `stack[top - 1] = ${band32("stack[top - 1]", "stack[top]")}`,
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "BOR":
          return [
            `stack[top - 1] = ${bor32("stack[top - 1]", "stack[top]")}`,
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "BXOR":
          return [
            `stack[top - 1] = ${bxor32("stack[top - 1]", "stack[top]")}`,
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "SHL":
          return [
            `stack[top - 1] = ${lshift32("stack[top - 1]", "stack[top]")}`,
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "SHR":
          return [
            `stack[top - 1] = ${rshift32("stack[top - 1]", "stack[top]")}`,
            "top = top - 1",
            `pc = ${nextId}`,
          ];
        case "UNM":
          return [
            "stack[top] = -stack[top]",
            `pc = ${nextId}`,
          ];
        case "NOT":
          return [
            "stack[top] = not stack[top]",
            `pc = ${nextId}`,
          ];
        case "LEN":
          return [
            "stack[top] = #stack[top]",
            `pc = ${nextId}`,
          ];
        case "BNOT":
          return [
            `stack[top] = ${bnot32("stack[top]")}`,
            `pc = ${nextId}`,
          ];
        case "NOISE_NOP":
          return [`pc = ${nextId}`];
        case "NOISE_READ":
          return [
            "local probe = stack[top]",
            `if probe == nil then probe = ${helperNames.localValue}(1) end`,
            `pc = ${nextId}`,
          ];
        case "NOISE_WRITE":
          return [
            `local ghost = ${bxor32(String(a), String(b))}`,
            "if ghost < 0 then ghost = -ghost end",
            `pc = ${nextId}`,
          ];
        case "NOISE_BRANCH":
          return [
            `if ((${a} + top + 1) % 97) == 211 then`,
            `  pc = ${targetId}`,
            "else",
            `  pc = ${nextId}`,
            "end",
          ];
        default:
          return emitSharedBlockBody() || [`pc = ${nextId}`];
      }
    };

    if (activeIsa.stackProtocol === "api") {
      lines.push(`local function push(arr, t, v)`);
      lines.push(`  t = t + 1`);
      lines.push(`  arr[t] = v`);
      lines.push(`  return t`);
      lines.push(`end`);
    }
    const dispatchMode = activeIsa.dispatchGraph === "auto"
      ? (() => {
          if (sorted.length <= 6) {
            return rng.bool(0.7) ? "tree" : "sparse";
          }
          return rng.bool(0.5) ? "tree" : "sparse";
        })()
      : activeIsa.dispatchGraph;
    lines.push(`local pc = ${entryId}`);
    if (dispatchMode === "sparse") {
      lines.push(...buildSparseDispatch(sorted, rng, emitBlock, "", { fakeEdges: activeIsa.fakeEdges }));
    } else {
      lines.push(`while pc ~= 0 do`);
      lines.push(...buildDispatchTree(sorted, rng, emitBlock, "  "));
      lines.push("end");
    }
    lines.push("end");
  } else {
    const noiseStateName = makeName();
    const emitLinearHandlerBody = (rawOpName) => {
      const opName = typeof rawOpName === "string" && rawOpName.endsWith("_X")
        ? rawOpName.slice(0, -2)
        : rawOpName;
      const sharedBody = emitSharedOpBody(opName, {
        mode: "linear",
        nextExpr: "pc + 1",
        aExpr: "a",
        bExpr: "b",
        noiseStateName,
      });
      switch (opName) {
        case "CALL_EXPAND":
          return [
            "local retc = a",
            "local tail = stack[top]",
            "local prefixArgs = stack[top - 1]",
            "local fn = stack[top - 2]",
            `local res = ${helperNames.callExpanded}(fn, prefixArgs, tail)`,
            "for i = top, top - 2, -1 do",
            "  stack[i] = nil",
            "end",
            "top = top - 3",
            "if retc == 0 then",
            "  return pc + 1, false, nil",
            "elseif retc == 1 then",
            "  top = top + 1",
            "  stack[top] = res[1]",
            "else",
            "  for i = 1, retc do",
            "    top = top + 1",
            "    stack[top] = res[i]",
            "  end",
            "end",
            "return pc + 1, false, nil",
          ];
        case "RETURN_CALL":
          return [
            "local argc = a",
            "local prefix = b",
            "local base = top - argc",
            "local fn = stack[base]",
            "if prefix == 0 then",
            "  return 0, true, pack(fn(unpack(stack, base + 1, top)))",
            "end",
            "local res = pack(fn(unpack(stack, base + 1, top)))",
            "local merged = { n = prefix + (res.n or #res) }",
            "local prefixBase = base - prefix",
            "for i = 1, prefix do",
            "  merged[i] = stack[prefixBase + i - 1]",
            "end",
            "for i = 1, res.n or #res do",
            "  merged[prefix + i] = res[i]",
            "end",
            "return 0, true, merged",
          ];
        case "RETURN_CALL_EXPAND":
          return [
            "local prefix = a",
            "local tail = stack[top]",
            "local prefixArgs = stack[top - 1]",
            "local fn = stack[top - 2]",
            `local res = ${helperNames.callExpanded}(fn, prefixArgs, tail)`,
            "if prefix == 0 then",
            "  return 0, true, res",
            "end",
            "local merged = { n = prefix + (res.n or #res) }",
            "local prefixBase = top - 2 - prefix",
            "for i = 1, prefix do",
            "  merged[i] = stack[prefixBase + i - 1]",
            "end",
            "for i = 1, res.n or #res do",
            "  merged[prefix + i] = res[i]",
            "end",
            "return 0, true, merged",
          ];
        case "APPEND_CALL":
          return [
            "local argc = a",
            "local startIndex = b",
            "local base = top - argc",
            "local fn = stack[base]",
            "local tbl = stack[base - 1]",
            "local res = pack(fn(unpack(stack, base + 1, top)))",
            "for i = top, base, -1 do",
            "  stack[i] = nil",
            "end",
            "top = base - 1",
            "for i = 1, res.n or #res do",
            "  tbl[startIndex + i - 1] = res[i]",
            "end",
            "if tbl.n ~= nil then",
            "  tbl.n = startIndex + (res.n or #res) - 1",
            "end",
            "return pc + 1, false, nil",
          ];
        case "APPEND_CALL_EXPAND":
          return [
            "local startIndex = a",
            "local tail = stack[top]",
            "local prefixArgs = stack[top - 1]",
            "local fn = stack[top - 2]",
            "local tbl = stack[top - 3]",
            `local res = ${helperNames.callExpanded}(fn, prefixArgs, tail)`,
            "for i = top, top - 2, -1 do",
            "  stack[i] = nil",
            "end",
            "top = top - 3",
            "for i = 1, res.n or #res do",
            "  tbl[startIndex + i - 1] = res[i]",
            "end",
            "if tbl.n ~= nil then",
            "  tbl.n = startIndex + (res.n or #res) - 1",
            "end",
            "return pc + 1, false, nil",
          ];
        case "RETURN":
          return [
            "local count = a",
            "if count == 0 then",
            "  return 0, true, pack()",
            "elseif count == 1 then",
            "  return 0, true, pack(stack[top])",
            "else",
            "  local base = top - count + 1",
            "  return 0, true, pack(unpack(stack, base, top))",
            "end",
          ];
        case "JMP":
          return ["return a, false, nil"];
        case "JMP_IF_FALSE":
          return [
            "if not stack[top] then",
            "  return a, false, nil",
            "end",
            "return pc + 1, false, nil",
          ];
        case "JMP_IF_TRUE":
          return [
            "if stack[top] then",
            "  return a, false, nil",
            "end",
            "return pc + 1, false, nil",
          ];
        case "ADD":
          return [
            "stack[top - 1] = stack[top - 1] + stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "SUB":
          return [
            "stack[top - 1] = stack[top - 1] - stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "MUL":
          return [
            "stack[top - 1] = stack[top - 1] * stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "DIV":
          return [
            "stack[top - 1] = stack[top - 1] / stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "IDIV":
          return [
            `stack[top - 1] = ${runtimeTools.floor}(stack[top - 1] / stack[top])`,
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "MOD":
          return [
            "stack[top - 1] = stack[top - 1] % stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "POW":
          return [
            "stack[top - 1] = stack[top - 1] ^ stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "CONCAT":
          return [
            "stack[top - 1] = stack[top - 1] .. stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "EQ":
          return [
            "stack[top - 1] = stack[top - 1] == stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "NE":
          return [
            "stack[top - 1] = stack[top - 1] ~= stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "LT":
          return [
            "stack[top - 1] = stack[top - 1] < stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "LE":
          return [
            "stack[top - 1] = stack[top - 1] <= stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "GT":
          return [
            "stack[top - 1] = stack[top - 1] > stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "GE":
          return [
            "stack[top - 1] = stack[top - 1] >= stack[top]",
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "BAND":
          return [
            `stack[top - 1] = ${band32("stack[top - 1]", "stack[top]")}`,
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "BOR":
          return [
            `stack[top - 1] = ${bor32("stack[top - 1]", "stack[top]")}`,
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "BXOR":
          return [
            `stack[top - 1] = ${bxor32("stack[top - 1]", "stack[top]")}`,
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "SHL":
          return [
            `stack[top - 1] = ${lshift32("stack[top - 1]", "stack[top]")}`,
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "SHR":
          return [
            `stack[top - 1] = ${rshift32("stack[top - 1]", "stack[top]")}`,
            "top = top - 1",
            "return pc + 1, false, nil",
          ];
        case "UNM":
          return [
            "stack[top] = -stack[top]",
            "return pc + 1, false, nil",
          ];
        case "NOT":
          return [
            "stack[top] = not stack[top]",
            "return pc + 1, false, nil",
          ];
        case "LEN":
          return [
            "stack[top] = #stack[top]",
            "return pc + 1, false, nil",
          ];
        case "BNOT":
          return [
            `stack[top] = ${bnot32("stack[top]")}`,
            "return pc + 1, false, nil",
          ];
        case "NOISE_READ":
          return [
            `local slot = ((a + pc + ${vmCoreNames.seed}) % 11) + 1`,
            `local ghost = ${noiseStateName}[slot]`,
            "if ghost == nil then",
            "  local probe = stack[top]",
            `  if ${runtimeTools.type}(probe) == "number" then`,
            "    ghost = probe",
            "  else",
            "    ghost = 0",
            "  end",
            "end",
            `${noiseStateName}[slot] = ghost`,
            "return pc + 1, false, nil",
          ];
        case "NOISE_WRITE":
          return [
            `local slot = ((a + b + pc + ${vmCoreNames.seed}) % 11) + 1`,
            `local ghost = ${noiseStateName}[slot]`,
            `if ${runtimeTools.type}(ghost) ~= "number" then`,
            "  ghost = 0",
            "end",
            `${noiseStateName}[slot] = ${bxor32("ghost", "(a + b + pc) % " + bitNames.mod)}`,
            "return pc + 1, false, nil",
          ];
        case "NOISE_BRANCH":
          return [
            `if ((a + pc + ${vmCoreNames.seed}) % 97) == 211 then`,
            "  return a, false, nil",
            "end",
            "return pc + 1, false, nil",
          ];
        default:
          return sharedBody || ["return pc + 1, false, nil"];
      }
    };

    const opcodeIndexByName = new Map(opcodeList.map((name, idx) => [name, idx + 1]));
    const dispatchOps = opcodeList.filter((name) => typeof name === "string" && opcodeIndexByName.has(name));
    const shuffledDispatchOps = dispatchOps.length ? dispatchOps.slice() : ["NOP"];
    rng.shuffle(shuffledDispatchOps);
    const maxGroups = Math.max(1, Math.min(6, shuffledDispatchOps.length));
    const minGroups = Math.min(2, maxGroups);
    const groupCount = maxGroups === minGroups ? maxGroups : rng.int(minGroups, maxGroups);
    const dispatchBuckets = Array.from({ length: groupCount }, () => []);
    shuffledDispatchOps.forEach((opName, idx) => {
      dispatchBuckets[idx % groupCount].push(opName);
    });

    const dispatchNames = {
      groupMap: makeName(),
      tokenMap: makeName(),
      dispatchers: makeName(),
      group: makeName(),
      token: makeName(),
      runner: makeName(),
      nextPc: makeName(),
      stop: makeName(),
      ret: makeName(),
    };

    const groupPlans = dispatchBuckets.map((ops, idx) => {
      const decodeName = makeName();
      const handlersName = makeName();
      const dispatchName = makeName();
      const groupMask = rng.int(0x101, 0x7fffffff) >>> 0;
      const usedHandlerIds = new Set();
      const usedTokens = new Set();
      const entries = ops.map((opName) => {
        let handlerId = 0;
        while (!handlerId || usedHandlerIds.has(handlerId)) {
          handlerId = rng.int(1, 0x3fff);
        }
        usedHandlerIds.add(handlerId);
        let token = 0;
        while (!token || usedTokens.has(token)) {
          token = rng.int(0x1000, 0x7fffffff) >>> 0;
        }
        usedTokens.add(token);
        const opcodeIndex = opcodeIndexByName.get(opName) || 1;
        const opExpr = `op_map[${buildIndexExpression(opcodeIndex, rng)}]`;
        return {
          opName,
          handlerId,
          token,
          maskedToken: (token ^ groupMask) >>> 0,
          opExpr,
        };
      });
      return {
        groupId: idx + 1,
        decodeName,
        handlersName,
        dispatchName,
        groupMask,
        entries,
      };
    });

    lines.push(`local ${noiseStateName} = {}`);
    lines.push(`local ${dispatchNames.groupMap} = {}`);
    lines.push(`local ${dispatchNames.tokenMap} = {}`);
    for (const group of groupPlans) {
      for (const entry of group.entries) {
        lines.push(`${dispatchNames.groupMap}[${entry.opExpr}] = ${group.groupId}`);
        lines.push(`${dispatchNames.tokenMap}[${entry.opExpr}] = ${entry.maskedToken}`);
      }
    }

    for (const group of groupPlans) {
      lines.push(`local ${group.decodeName} = {}`);
      for (const entry of group.entries) {
        lines.push(`${group.decodeName}[${entry.token}] = ${entry.handlerId}`);
      }
      lines.push(`local ${group.handlersName} = {}`);
      for (const entry of group.entries) {
        lines.push(`${group.handlersName}[${entry.handlerId}] = function(a, b, pc)`);
        const body = emitLinearHandlerBody(entry.opName);
        body.forEach((line) => lines.push(`  ${line}`));
        lines.push(`end`);
      }
      lines.push(`local function ${group.dispatchName}(token, a, b, pc, pulse)`);
      if (dynamicCoupling) {
        lines.push(`  local raw = ${bxor32("token", "pulse")}`);
      } else {
        lines.push(`  local raw = token`);
      }
      lines.push(`  local key = ${bxor32("raw", String(group.groupMask))}`);
      lines.push(`  local hid = ${group.decodeName}[key]`);
      lines.push(`  if hid == nil then return 0, true, nil end`);
      lines.push(`  local fn = ${group.handlersName}[hid]`);
      lines.push(`  if fn == nil then return 0, true, nil end`);
      lines.push(`  return fn(a, b, pc)`);
      lines.push(`end`);
    }

    lines.push(`local ${dispatchNames.dispatchers} = {}`);
    for (const group of groupPlans) {
      lines.push(`${dispatchNames.dispatchers}[${group.groupId}] = ${group.dispatchName}`);
    }

    const loopLines = [
      `local pc = 1`,
      `while true do`,
    ];
    if (useBytecodeStream) {
      loopLines.push(`  local op, a, b = ${helperNames.getInst}(pc)`);
    } else {
      loopLines.push(`  local inst = bc[pc]`);
      loopLines.push(`  if inst == nil then return end`);
      loopLines.push(`  local op = inst[1] or 0`);
      loopLines.push(`  local a = inst[2] or 0`);
      loopLines.push(`  local b = inst[3] or 0`);
    }
    loopLines.push(
      `  local key = 0`,
      `  if ${vmStateNames.bcKeyCount} > 0 then`,
      `    key = ${helperNames.keyAt}(pc)`,
      `    local a_mask = ${bxor32("key", lshift32("key", "5"))}`,
      `    local b_mask = ${bxor32(bxor32("key", rshift32("key", "3")), "2779096485")}`,
      `    op = ${bxor32("op", "key")}`,
      `    a = ${bxor32("a", "a_mask")}`,
      `    b = ${bxor32("b", "b_mask")}`,
      `  end`,
      `  ${vmStateNames.stateKey} = (${vmStateNames.stateKey} * ${couplingMul} + ${couplingAdd} + pc + ${vmCoreNames.seed}) % ${bitNames.mod}`,
      `  local ${vmStateNames.statePulse} = ${dynamicCoupling
        ? bxor32(vmStateNames.stateKey, rshift32(vmStateNames.stateKey, "7"))
        : "0"}`,
      `  local ${dispatchNames.group} = ${dispatchNames.groupMap}[op]`,
      `  if ${dispatchNames.group} == nil then`,
      `    return`,
      `  end`,
      `  local ${dispatchNames.token} = ${dispatchNames.tokenMap}[op]`,
      `  if ${dispatchNames.token} == nil then`,
      `    return`,
      `  end`,
      ...(dynamicCoupling
        ? [`  ${dispatchNames.token} = ${bxor32(dispatchNames.token, vmStateNames.statePulse)}`]
        : []),
      `  local ${dispatchNames.runner} = ${dispatchNames.dispatchers}[${dispatchNames.group}]`,
      `  if ${dispatchNames.runner} == nil then`,
      `    return`,
      `  end`,
      `  local ${dispatchNames.nextPc}, ${dispatchNames.stop}, ${dispatchNames.ret} = ${dispatchNames.runner}(${dispatchNames.token}, a, b, pc, ${vmStateNames.statePulse})`,
      `  if ${dispatchNames.stop} then`,
      `    if ${dispatchNames.ret} == nil then`,
      `      return`,
      `    end`,
      `    return unpack(${dispatchNames.ret}, 1, ${dispatchNames.ret}.n or #${dispatchNames.ret})`,
      `  end`,
      `  pc = ${dispatchNames.nextPc}`,
      `end`,
      `end`,
    );
    lines.push(...loopLines);
  }

  if (upperPoolLines.length) {
    lines.splice(upperPoolInsertIndex, 0, ...upperPoolLines);
  }
  const vmSource = lines.join("\n");
  const coreAliases = {
    bc: makeVmHelperAliasName(),
    bc_keys: makeVmHelperAliasName(),
    consts: makeVmHelperAliasName(),
    locals: makeVmHelperAliasName(),
    stack: makeVmHelperAliasName(),
    top: makeVmHelperAliasName(),
    pc: makeVmHelperAliasName(),
    env: makeVmHelperAliasName(),
  };
  return { source: vmSource, coreAliases };
}

function replaceFunctionBody(fnNode, vmAst, style) {
  const body = vmAst.body || [];
  if (style === "custom") {
    fnNode.body = { type: "Block", body };
    return;
  }
  fnNode.body = body;
}

function replaceChunkBody(ast, vmAst, prefix = null) {
  if (!ast || !Array.isArray(ast.body)) {
    return;
  }
  const prefixBody = Array.isArray(prefix) ? prefix : [];
  const vmBody = vmAst && Array.isArray(vmAst.body) ? vmAst.body : [];
  ast.body = [...prefixBody, ...vmBody];
}

function markVmNodes(vmAst) {
  if (!vmAst || typeof vmAst !== "object") {
    return;
  }
  vmAst.__obf_vm = true;
  walk(vmAst, (node) => {
    node.__obf_vm = true;
  });
}

function shouldVirtualizeTopLevelChunk(ast, options) {
  if (!ast || ast.type !== "Chunk") {
    return false;
  }
  if (ast.__obf_vm_chunk) {
    return false;
  }
  if (!options || !options.vm || options.vm.topLevel !== true) {
    return false;
  }
  return true;
}

function pushTopLevelLocalName(names, seen, name) {
  if (!name || typeof name !== "string" || name.includes(".")) {
    return;
  }
  if (seen.has(name)) {
    const index = names.indexOf(name);
    if (index !== -1) {
      names.splice(index, 1);
    }
  }
  seen.add(name);
  names.push(name);
}

function collectTopLevelPreboundLocals(statements) {
  const names = [];
  const seen = new Set();
  if (!Array.isArray(statements)) {
    return names;
  }
  statements.forEach((stmt) => {
    if (!stmt || !stmt.type) {
      return;
    }
    if (stmt.type === "LocalStatement") {
      const vars = Array.isArray(stmt.variables) ? stmt.variables : [];
      vars.forEach((variable) => {
        if (variable && variable.type === "Identifier") {
          pushTopLevelLocalName(names, seen, variable.name);
        }
      });
      return;
    }
    if (stmt.type === "FunctionDeclaration" && stmt.isLocal) {
      pushTopLevelLocalName(names, seen, getFunctionName(stmt));
    }
  });
  return names;
}

function findEnclosingStatementList(root, target) {
  const contexts = findFunctionContext(root, target);
  return contexts ? contexts.statementList : null;
}

function isStatementNode(node) {
  return Boolean(
    node &&
    typeof node === "object" &&
    typeof node.type === "string" &&
    (node.type.endsWith("Statement") || node.type === "FunctionDeclaration")
  );
}

function isStatementList(value) {
  return Array.isArray(value) && value.some((item) => isStatementNode(item));
}

function getFunctionCaptureParams(fnNode) {
  const names = [];
  const seen = new Set();
  if (!fnNode || !Array.isArray(fnNode.parameters)) {
    return names;
  }
  if (
    fnNode.type === "FunctionDeclaration" &&
    fnNode.name &&
    fnNode.name.type === "FunctionName" &&
    fnNode.name.method
  ) {
    seen.add("self");
    names.push("self");
  }
  fnNode.parameters.forEach((param) => {
    if (!param || param.type !== "Identifier" || !param.name || seen.has(param.name)) {
      return;
    }
    seen.add(param.name);
    names.push(param.name);
  });
  return names;
}

function findFunctionContext(root, target, state = null) {
  if (state === null) {
    if (!findFunctionContext.cache) {
      findFunctionContext.cache = new WeakMap();
    }
    let rootCache = findFunctionContext.cache.get(root);
    if (!rootCache) {
      rootCache = new WeakMap();
      findFunctionContext.cache.set(root, rootCache);
    }
    if (rootCache.has(target)) {
      return rootCache.get(target);
    }
    const found = findFunctionContext(root, target, {});
    rootCache.set(target, found);
    return found;
  }
  if (root === target) {
    return state;
  }
  if (!root || typeof root !== "object") {
    return null;
  }
  if (Array.isArray(root)) {
    const nextStatementList = isStatementList(root) ? root : state.statementList || null;
    for (const item of root) {
      const nextState = isStatementNode(item)
        ? {
            ...state,
            statementList: nextStatementList,
            statement: item,
            frames: [...(state.frames || []), { statementList: nextStatementList, statement: item }],
          }
        : { ...state, statementList: nextStatementList };
      const found = findFunctionContext(item, target, nextState);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const nextFunction = isFunctionNode(root) ? root : state.enclosingFunction || null;
  for (const key of Object.keys(root)) {
    const found = findFunctionContext(root[key], target, {
      ...state,
      enclosingFunction: nextFunction,
    });
    if (found) {
      return found;
    }
  }
  return null;
}

function collectStatementPrefixLocals(statementList, stopStatement, names, seen) {
  if (!Array.isArray(statementList)) {
    return;
  }
  for (const stmt of statementList) {
    if (stmt === stopStatement) {
      break;
    }
    if (!stmt || !stmt.type) {
      continue;
    }
    if (stmt.type === "LocalStatement") {
      const vars = Array.isArray(stmt.variables) ? stmt.variables : [];
      vars.forEach((variable) => {
        if (variable && variable.type === "Identifier") {
          pushTopLevelLocalName(names, seen, variable.name);
        }
      });
      continue;
    }
    if (stmt.type === "FunctionDeclaration" && stmt.isLocal) {
      pushTopLevelLocalName(names, seen, getFunctionName(stmt));
    }
  }
}

function collectStatementScopedBindings(stmt, names, seen) {
  if (!stmt || !stmt.type) {
    return;
  }
  if (stmt.type === "ForNumericStatement" && stmt.variable && stmt.variable.type === "Identifier") {
    pushTopLevelLocalName(names, seen, stmt.variable.name);
    return;
  }
  if (stmt.type === "ForGenericStatement" && Array.isArray(stmt.variables)) {
    stmt.variables.forEach((variable) => {
      if (variable && variable.type === "Identifier") {
        pushTopLevelLocalName(names, seen, variable.name);
      }
    });
  }
}

function collectVisibleOuterBindingsForFunction(ast, fnNode) {
  const names = [];
  const seen = new Set();
  const context = findFunctionContext(ast, fnNode) || {};
  const frames = Array.isArray(context.frames) && context.frames.length
    ? context.frames
    : [{ statementList: context.statementList || (ast && Array.isArray(ast.body) ? ast.body : []), statement: context.statement || fnNode }];

  frames.forEach((frame) => {
    collectStatementPrefixLocals(frame.statementList, frame.statement, names, seen);
    collectStatementScopedBindings(frame.statement, names, seen);
  });

  getFunctionCaptureParams(context.enclosingFunction).forEach((name) => {
    pushTopLevelLocalName(names, seen, name);
  });
  if (context.enclosingFunction && context.enclosingFunction.type === "FunctionDeclaration" && context.enclosingFunction.isLocal) {
    pushTopLevelLocalName(names, seen, getFunctionName(context.enclosingFunction));
  }
  return names;
}

function collectPreboundLocalsForFunction(ast, fnNode) {
  if (!collectPreboundLocalsForFunction.cache) {
    collectPreboundLocalsForFunction.cache = new WeakMap();
  }
  const cacheKey = ast || fnNode;
  let astCache = collectPreboundLocalsForFunction.cache.get(cacheKey);
  if (!astCache) {
    astCache = new WeakMap();
    collectPreboundLocalsForFunction.cache.set(cacheKey, astCache);
  }
  if (astCache.has(fnNode)) {
    return astCache.get(fnNode);
  }
  const visibleBindings = new Set(collectVisibleOuterBindingsForFunction(ast, fnNode));
  if (!visibleBindings.size) {
    astCache.set(fnNode, []);
    return [];
  }

  const declared = collectDeclaredNamesInFunction(fnNode);
  const prebound = collectUsedIdentifierOrder(fnNode).filter((name) => (
    !declared.has(name) && visibleBindings.has(name)
  ));
  astCache.set(fnNode, prebound);
  return prebound;
}

function buildTopLevelChunkPlan(ast) {
  const body = ast && Array.isArray(ast.body) ? ast.body : [];
  // Preserve already-inserted VM prelude statements and top-level function
  // declarations ahead of chunk virtualization so shared helpers stay in scope.
  let splitIndex = 0;
  while (splitIndex < body.length && body[splitIndex] && body[splitIndex].__obf_vm) {
    splitIndex += 1;
  }
  for (let i = 0; i < body.length; i += 1) {
    const stmt = body[i];
    if (stmt && stmt.type === "FunctionDeclaration") {
      splitIndex = i + 1;
    }
  }
  const prefix = body.slice(0, splitIndex);
  const statements = body.slice(splitIndex).filter((stmt) => !(stmt && stmt.__obf_vm));
  const preboundLocals = collectTopLevelPreboundLocals(prefix);
  return {
    prefix,
    statements,
    preboundLocals,
  };
}

function collectVmCandidateFunctions(ast, style) {
  const candidates = [];
  walk(ast, (node) => {
    if (!node || node.__obf_vm || node.__obf_skip_vm) {
      return;
    }
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression") {
      return;
    }
    const fnName = getFunctionName(node);
    if (!fnName || fnName.startsWith("__obf_")) {
      return;
    }
    if (!canVirtualizeFunction(node, style)) {
      return;
    }
    candidates.push(node);
  });
  return candidates;
}

function scoreVmCandidateFunction(node, style) {
  const body = style === "custom"
    ? (node.body && node.body.body ? node.body.body : [])
    : Array.isArray(node.body) ? node.body : [];
  const fnName = getFunctionName(node);
  let score = Array.isArray(body) ? body.length : 0;
  walk(node, (child) => {
    if (!child || child === node) {
      return;
    }
    switch (child.type) {
      case "ForNumericStatement":
      case "ForGenericStatement":
      case "WhileStatement":
      case "RepeatStatement":
        score += 6;
        break;
      case "IfStatement":
        score += 4;
        break;
      case "CallExpression":
      case "MethodCallExpression":
        score += 2;
        if (fnName && child.base && child.base.type === "Identifier" && child.base.name === fnName) {
          score += 10;
        }
        break;
      case "BinaryExpression":
      case "LogicalExpression":
        score += 1;
        break;
      default:
        break;
    }
  });
  return score;
}

function buildAutoVmIncludeSet(ast, style, options) {
  const countRaw = Number(options?.vm?.autoSelectCount);
  const count = Number.isFinite(countRaw) ? Math.max(1, Math.floor(countRaw)) : 3;
  const minScoreRaw = Number(options?.vm?.autoSelectMinScore);
  const minScore = Number.isFinite(minScoreRaw) ? minScoreRaw : 6;
  const rankedAll = collectVmCandidateFunctions(ast, style)
    .map((node) => ({ node, score: scoreVmCandidateFunction(node, style) }))
    .sort((a, b) => b.score - a.score);
  const ranked = rankedAll.filter((entry) => entry.score >= minScore);
  const selected = ranked.length ? ranked : rankedAll.slice(0, 1);
  return new Set(selected.slice(0, count).map((entry) => entry.node));
}

function virtualizeLuau(ast, ctx) {
  const style = ctx.options && ctx.options.luauParser === "luaparse" ? "luaparse" : "custom";
  liftNestedVmCallbacks(ast, ctx, style);
  const layers = Math.max(1, ctx.options.vm?.layers || 1);
  let sharedRuntime = null;
  let sharedRuntimeReservedNames = null;
  let sharedPreludeBody = null;
  let sharedPreludeApplied = false;
  const ensureSharedRuntime = () => {
    // Shared helper names must avoid colliding with both user identifiers and
    // per-function VM helper locals, otherwise upvalue lookups can be shadowed.
    if (sharedRuntime) {
      return sharedRuntime;
    }
    const usedNames = addIdentifierNames(ast, new Set());
    sharedRuntime = createSharedVmRuntime(ctx.rng, usedNames);
    sharedRuntimeReservedNames = new Set(usedNames);
    Object.values(sharedRuntime.runtimeTools).forEach((name) => sharedRuntimeReservedNames.add(name));
    Object.values(sharedRuntime.bitNames).forEach((name) => sharedRuntimeReservedNames.add(name));
    return sharedRuntime;
  };
  const buildReservedVmNames = (root) => {
    const reserved = new Set(sharedRuntimeReservedNames || []);
    addIdentifierNames(root, reserved);
    return reserved;
  };
  const ensureSharedPreludeBody = () => {
    if (sharedPreludeBody) {
      return sharedPreludeBody;
    }
    const runtime = ensureSharedRuntime();
    const source = buildSharedVmRuntimePreludeSource(runtime, ctx.rng);
    const preludeAst = style === "custom"
      ? ctx.parseCustom(source)
      : ctx.parseLuaparse(source);
    markVmNodes(preludeAst);
    sharedPreludeBody = Array.isArray(preludeAst.body) ? preludeAst.body : [];
    return sharedPreludeBody;
  };
  for (let layer = 0; layer < layers; layer += 1) {
    const minStatements = ctx.options.vm?.minStatements ?? DEFAULT_MIN_STATEMENTS;
    let layerNeedsSharedPrelude = false;
    const includeList = Array.isArray(ctx.options.vm?.include) ? ctx.options.vm.include : [];
    const broadVirtualization = Boolean(ctx.options.vm?.all) || includeList.length === 0;
    const autoSelectEnabled = broadVirtualization && ctx.options.vm?.autoSelect !== false;
    const autoIncludeSet = autoSelectEnabled
      ? buildAutoVmIncludeSet(ast, style, ctx.options)
      : null;

    walk(ast, (node) => {
      if (node && node.__obf_vm) {
        return;
      }
      if (node && node.__obf_skip_vm) {
        return;
      }
      if (!node || (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression")) {
        return;
      }
      const fnName = getFunctionName(node);
      if (fnName && fnName.startsWith("__obf_")) {
        return;
      }
      if (!shouldVirtualizeFunction(node, ctx.options)) {
        return;
      }
      if (!canVirtualizeFunction(node, style)) {
        return;
      }
      const body = style === "custom"
        ? (node.body && node.body.body ? node.body.body : [])
        : Array.isArray(node.body) ? node.body : [];
      if (!body || body.length < minStatements) {
        tracePass(ctx, {
          kind: "skip-virtualize-function",
          reason: "below-min-statements",
          functionName: fnName || "<anonymous>",
          statements: Array.isArray(body) ? body.length : 0,
        });
        return;
      }

      const compiler = new VmCompiler({ style, options: ctx.options });
      const preboundLocals = collectPreboundLocalsForFunction(ast, node);
      const selfBoundLocals = new Set(compiler.getFunctionPreboundLocals(node));
      const externalPreboundLocals = preboundLocals.filter((name) => !selfBoundLocals.has(name));
      if (node.type === "FunctionExpression" && broadVirtualization) {
        tracePass(ctx, {
          kind: "skip-virtualize-function",
          reason: "anonymous-broad",
          functionName: fnName || "<anonymous>",
        });
        return;
      }
      if (autoIncludeSet && !autoIncludeSet.has(node)) {
        tracePass(ctx, {
          kind: "skip-virtualize-function",
          reason: "auto-select",
          functionName: fnName || "<anonymous>",
        });
        return;
      }
      if (externalPreboundLocals.length > 0 && broadVirtualization) {
        tracePass(ctx, {
          kind: "skip-virtualize-function",
          reason: "captured-outer-locals",
          functionName: fnName || "<anonymous>",
          locals: externalPreboundLocals,
        });
        return;
      }
      let program;
      try {
        program = compiler.compileFunction(node, preboundLocals);
      } catch (err) {
        const debug = Boolean(ctx.options.vm?.debug) || process.env.JS_OBF_VM_DEBUG === "1";
        if (debug) {
          const name = getFunctionName(node) || "<anonymous>";
          const message = err && err.message ? err.message : String(err);
          console.warn(`[js-obf] luau-vm skipped ${name}: ${message}`);
        }
        tracePass(ctx, {
          kind: "skip-virtualize-function",
          reason: "compile-failed",
          functionName: getFunctionName(node) || "<anonymous>",
        });
        return;
      }

      applyInstructionFusion(program, ctx.rng, ctx.options.vm || {});
      injectFakeInstructions(program, ctx.rng, ctx.options.vm?.fakeOpcodes ?? 0);
      program.instructions = compactInstructionList(program.instructions);
      // Virtualization always compiles to a plain instruction list first, then
      // applies encoding/splitting so the VM backend works from one IR shape.

      const blockDispatch = Boolean(ctx.options.vm?.blockDispatch);
      const isaProfile = blockDispatch
        ? applyPolymorphicBlockISA(program, ctx.rng, ctx.options.vm || {})
        : {
            enabled: false,
            keyA: 0,
            keyB: 0,
            stackProtocol: "direct",
            dispatchGraph: "tree",
            fakeEdges: false,
          };
      const opcodeList = Array.from(new Set([
        ...OPCODES,
        ...NOISE_OPCODES,
        ...program.instructions
          .map((inst) => inst && inst[0])
          .filter((name) => typeof name === "string"),
      ]));
      const seedState = buildSeedState(ctx.rng, program.instructions.length, program.consts.length);
      let opcodeInfo = null;
      let keySchedule = null;
      let bcInfo = null;

      if (!blockDispatch) {
        const opcodeMap = buildOpcodeMap(ctx.rng, ctx.options.vm?.opcodeShuffle !== false, opcodeList);
        opcodeInfo = ctx.options.vm?.opcodeEncoding === "pairs"
          ? buildOpcodePairsEncoding(opcodeMap, ctx.rng, seedState, opcodeList)
          : buildOpcodeEncoding(opcodeMap, ctx.rng, seedState, opcodeList);

        program.instructions = program.instructions.map((inst) => {
          const opName = inst[0];
          const width = getOpcodeArity(opName);
          const out = [opcodeMap[opName]];
          if (width >= 1) {
            out.push(inst[1] || 0);
          }
          if (width >= 2) {
            out.push(inst[2] || 0);
          }
          return out;
        });

        keySchedule = ctx.options.vm?.runtimeKey === false
          ? null
          : buildKeySchedule(ctx.rng, seedState);
        if (keySchedule) {
          program.instructions = program.instructions.map((inst, idx) => {
            const key = computeInstructionKey(
              idx + 1,
              seedState.seed,
              keySchedule.words,
              keySchedule.rounds
            );
            const { aMask, bMask } = deriveInstructionMasks(key);
            if (!key) {
              return inst;
            }
            const out = [((inst[0] || 0) ^ key) >>> 0];
            if (inst.length > 1) {
              out.push(((inst[1] || 0) ^ aMask) >>> 0);
            }
            if (inst.length > 2) {
              out.push(((inst[2] || 0) ^ bMask) >>> 0);
            }
            return out;
          });
        }

        bcInfo = ctx.options.vm?.runtimeSplit === false
          ? null
          : splitInstructions(program.instructions, ctx.rng);
      }

      const constInfo = ctx.options.vm?.constsEncrypt === false
        ? null
        : encodeConstPool(program, ctx.rng, seedState);
      const runtime = ensureSharedRuntime();
      layerNeedsSharedPrelude = true;
      const reservedNames = buildReservedVmNames(node);
      const vmBuild = buildVmSource(
        program,
        opcodeInfo,
        program.paramNames,
        seedState,
        keySchedule,
        bcInfo,
        constInfo,
        ctx.rng,
        ctx.options.vm,
        reservedNames,
        opcodeList,
        isaProfile,
        runtime
      );
      const vmSource = typeof vmBuild === "string" ? vmBuild : vmBuild.source;
      const vmAst = style === "custom"
        ? ctx.parseCustom(vmSource)
        : ctx.parseLuaparse(vmSource);
      renameGeneratedVmAst(vmAst, ctx.rng, reservedNames, ctx.options.renameOptions);
      markVmNodes(vmAst);
      replaceFunctionBody(node, vmAst, style);
      tracePass(ctx, {
        kind: "virtualize-function",
        functionName: fnName || "<anonymous>",
        layer: layer + 1,
        instructions: program.instructions.length,
        consts: program.consts.length,
      });
    });

    if (!shouldVirtualizeTopLevelChunk(ast, ctx.options)) {
      if (layerNeedsSharedPrelude && !sharedPreludeApplied) {
        const preludeBody = ensureSharedPreludeBody();
        ast.body = [...preludeBody, ...(Array.isArray(ast.body) ? ast.body : [])];
        sharedPreludeApplied = true;
      }
      continue;
    }
    const chunkPlan = buildTopLevelChunkPlan(ast);
    if (!Array.isArray(chunkPlan.statements) || chunkPlan.statements.length < minStatements) {
      if (layerNeedsSharedPrelude && !sharedPreludeApplied) {
        const preludeBody = ensureSharedPreludeBody();
        ast.body = [...preludeBody, ...(Array.isArray(ast.body) ? ast.body : [])];
        sharedPreludeApplied = true;
      }
      tracePass(ctx, {
        kind: "skip-virtualize-chunk",
        reason: "below-min-statements",
        statements: Array.isArray(chunkPlan.statements) ? chunkPlan.statements.length : 0,
      });
      continue;
    }

    const compiler = new VmCompiler({ style, options: ctx.options });
    let program;
    try {
      program = compiler.compileChunk(ast, {
        statements: chunkPlan.statements,
        preboundLocals: chunkPlan.preboundLocals,
      });
    } catch (err) {
      if (layerNeedsSharedPrelude && !sharedPreludeApplied) {
        const preludeBody = ensureSharedPreludeBody();
        ast.body = [...preludeBody, ...(Array.isArray(ast.body) ? ast.body : [])];
        sharedPreludeApplied = true;
      }
      const debug = Boolean(ctx.options.vm?.debug) || process.env.JS_OBF_VM_DEBUG === "1";
      if (debug) {
        const message = err && err.message ? err.message : String(err);
        console.warn(`[js-obf] luau-vm skipped <chunk>: ${message}`);
      }
      tracePass(ctx, {
        kind: "skip-virtualize-chunk",
        reason: "compile-failed",
      });
      continue;
    }

    applyInstructionFusion(program, ctx.rng, ctx.options.vm || {});
    injectFakeInstructions(program, ctx.rng, ctx.options.vm?.fakeOpcodes ?? 0);
    program.instructions = compactInstructionList(program.instructions);

    const blockDispatch = Boolean(ctx.options.vm?.blockDispatch);
    const isaProfile = blockDispatch
      ? applyPolymorphicBlockISA(program, ctx.rng, ctx.options.vm || {})
      : {
          enabled: false,
          keyA: 0,
          keyB: 0,
          stackProtocol: "direct",
          dispatchGraph: "tree",
          fakeEdges: false,
        };
    const opcodeList = Array.from(new Set([
      ...OPCODES,
      ...NOISE_OPCODES,
      ...program.instructions
        .map((inst) => inst && inst[0])
        .filter((name) => typeof name === "string"),
    ]));
    const seedState = buildSeedState(ctx.rng, program.instructions.length, program.consts.length);
    let opcodeInfo = null;
    let keySchedule = null;
    let bcInfo = null;

    if (!blockDispatch) {
      const opcodeMap = buildOpcodeMap(ctx.rng, ctx.options.vm?.opcodeShuffle !== false, opcodeList);
      opcodeInfo = ctx.options.vm?.opcodeEncoding === "pairs"
        ? buildOpcodePairsEncoding(opcodeMap, ctx.rng, seedState, opcodeList)
        : buildOpcodeEncoding(opcodeMap, ctx.rng, seedState, opcodeList);

      program.instructions = program.instructions.map((inst) => {
        const opName = inst[0];
        const width = getOpcodeArity(opName);
        const out = [opcodeMap[opName]];
        if (width >= 1) {
          out.push(inst[1] || 0);
        }
        if (width >= 2) {
          out.push(inst[2] || 0);
        }
        return out;
      });

      keySchedule = ctx.options.vm?.runtimeKey === false
        ? null
        : buildKeySchedule(ctx.rng, seedState);
      if (keySchedule) {
        program.instructions = program.instructions.map((inst, idx) => {
          const key = computeInstructionKey(
            idx + 1,
            seedState.seed,
            keySchedule.words,
            keySchedule.rounds
          );
          const { aMask, bMask } = deriveInstructionMasks(key);
          if (!key) {
            return inst;
          }
          const out = [((inst[0] || 0) ^ key) >>> 0];
          if (inst.length > 1) {
            out.push(((inst[1] || 0) ^ aMask) >>> 0);
          }
          if (inst.length > 2) {
            out.push(((inst[2] || 0) ^ bMask) >>> 0);
          }
          return out;
        });
      }

      bcInfo = ctx.options.vm?.runtimeSplit === false
        ? null
        : splitInstructions(program.instructions, ctx.rng);
    }

    const constInfo = ctx.options.vm?.constsEncrypt === false
      ? null
      : encodeConstPool(program, ctx.rng, seedState);
    const runtime = ensureSharedRuntime();
    layerNeedsSharedPrelude = true;
    const reservedNames = buildReservedVmNames(chunkPlan.statements);
    const vmBuild = buildVmSource(
      program,
      opcodeInfo,
      program.paramNames,
      seedState,
      keySchedule,
      bcInfo,
      constInfo,
      ctx.rng,
      ctx.options.vm,
      reservedNames,
      opcodeList,
      isaProfile,
      runtime
    );
    const vmSource = typeof vmBuild === "string" ? vmBuild : vmBuild.source;
    const vmAst = style === "custom"
      ? ctx.parseCustom(vmSource)
      : ctx.parseLuaparse(vmSource);
    renameGeneratedVmAst(vmAst, ctx.rng, reservedNames, ctx.options.renameOptions);
    markVmNodes(vmAst);
    const chunkPrefix = sharedPreludeApplied
      ? chunkPlan.prefix
      : [...ensureSharedPreludeBody(), ...chunkPlan.prefix];
    replaceChunkBody(ast, vmAst, chunkPrefix);
    sharedPreludeApplied = true;
    ast.__obf_vm_chunk = true;
    tracePass(ctx, {
      kind: "virtualize-chunk",
      layer: layer + 1,
      instructions: program.instructions.length,
      consts: program.consts.length,
    });
  }
}

module.exports = {
  virtualizeLuau,
  __test: {
    computeSeedFromPieces,
    VmCompiler,
    collectPreboundLocalsForFunction,
  },
};
