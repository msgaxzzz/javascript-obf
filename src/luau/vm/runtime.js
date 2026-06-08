const { walk } = require("../ast");
const { makeShortNameFactory } = require("../names");

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

const VM_NAME_KEYWORDS = new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
]);

const VM_NAME_RESERVED = new Set([
  "bc",
  "seed",
  "locals",
  "stack",
  "top",
  "pc",
  "env",
  "pack",
  "unpack",
  "math",
  "string",
  "table",
  "_G",
  "_ENV",
  "bit32",
  "debug",
  "utf8",
]);

const VM_TEMPLATE_RESERVED = new Set([
  "_",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "abit",
  "argc",
  "args",
  "arr",
  "base",
  "bit",
  "bits",
  "bitv",
  "block",
  "carry",
  "count",
  "cursor",
  "data",
  "fn",
  "getf",
  "ghost",
  "hi",
  "hid",
  "idx",
  "inst",
  "key",
  "left",
  "len",
  "limit",
  "lo",
  "merged",
  "mix",
  "nextValue",
  "offset",
  "op",
  "part",
  "pcv",
  "pos",
  "prefix",
  "prefixArgs",
  "prefixBase",
  "prefixCount",
  "probe",
  "pulse",
  "raw",
  "res",
  "retc",
  "right",
  "salt",
  "setter",
  "size",
  "slot",
  "startIndex",
  "sum",
  "tag",
  "tagEnc",
  "tail",
  "tailCount",
  "tbl",
  "token",
  "value",
  "width",
]);

function addVmReservedNames(usedNames) {
  VM_TEMPLATE_RESERVED.forEach((name) => usedNames.add(name));
  return usedNames;
}

function makeVmNameFactory(rng, usedNames) {
  addVmReservedNames(usedNames);
  return makeShortNameFactory(rng, usedNames, VM_NAME_RESERVED);
}

function makeVmHelperName(rng, usedNames) {
  return makeVmNameFactory(rng, usedNames)();
}

function makeVmCharExpr(charName, text) {
  const bytes = Array.from(Buffer.from(String(text), "utf8"));
  if (!bytes.length) {
    return '""';
  }
  return `${charName}(${bytes.join(", ")})`;
}

function createSharedVmRuntime(rng, reservedNames = null) {
  const usedNames = new Set();
  if (reservedNames && typeof reservedNames.forEach === "function") {
    reservedNames.forEach((name) => {
      if (name) {
        usedNames.add(name);
      }
    });
  }
  const makeName = makeVmNameFactory(rng, usedNames);
  return {
    runtimeTools: {
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
    },
    bitNames: {
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
    },
  };
}

function buildSharedVmRuntimePreludeSource(sharedRuntime, rng) {
  const { runtimeTools, bitNames } = sharedRuntime;
  const charExpr = (text) => makeVmCharExpr(runtimeTools.char, text);
  const usedNames = new Set([
    ...Object.values(runtimeTools),
    ...Object.values(bitNames),
  ]);
  const localName = makeVmNameFactory(rng, usedNames);
  const bitKeyName = localName();
  const bitDataName = localName();
  const bitOutName = localName();
  const bitEnvName = localName();
  const bitGetfName = localName();
  const lines = [];
  lines.push(
    `local ${runtimeTools.bundle} = { string.char, string.byte, table.concat, table.pack, table.unpack, select, type, math.floor, getfenv }`,
    `local ${runtimeTools.char}, ${runtimeTools.byte}, ${runtimeTools.concat}, ${runtimeTools.pack}, ${runtimeTools.unpack}, ${runtimeTools.select}, ${runtimeTools.type}, ${runtimeTools.floor}, ${runtimeTools.getfenv} = ${runtimeTools.bundle}[1], ${runtimeTools.bundle}[2], ${runtimeTools.bundle}[3], ${runtimeTools.bundle}[4], ${runtimeTools.bundle}[5], ${runtimeTools.bundle}[6], ${runtimeTools.bundle}[7], ${runtimeTools.bundle}[8], ${runtimeTools.bundle}[9]`,
    `local ${bitNames.mod} = 4294967296`,
    `local ${bitNames.bit}`,
    `do`,
  );
  const bitNameBytes = [98, 105, 116, 51, 50];
  const bitKey = rng.int(11, 200);
  const bitEncoded = bitNameBytes.map((value) => (value - bitKey + 256) % 256);
  lines.push(
    `  local ${bitKeyName} = ${bitKey}`,
    `  local ${bitDataName} = { ${bitEncoded.join(", ")} }`,
    `  local ${bitOutName} = {}`,
    `  for i = 1, #${bitDataName} do`,
    `    ${bitOutName}[i] = ${runtimeTools.char}((${bitDataName}[i] + ${bitKeyName}) % 256)`,
    `  end`,
    `  local ${bitEnvName}`,
    `  local ${bitGetfName} = ${runtimeTools.getfenv}`,
    `  if ${runtimeTools.type}(${bitGetfName}) == "function" then ${bitEnvName} = ${bitGetfName}(1) end`,
    `  if ${runtimeTools.type}(${bitEnvName}) ~= "table" then ${bitEnvName} = _G end`,
    `  ${bitNames.bit} = ${bitEnvName}[${runtimeTools.concat}(${bitOutName})]`,
    `end`,
    `local ${bitNames.norm}`,
    `local ${bitNames.band32}, ${bitNames.bor32}, ${bitNames.bxor32}, ${bitNames.bnot32}, ${bitNames.lshift32}, ${bitNames.rshift32}`,
    `if ${bitNames.bit} == nil then`,
    `  ${bitNames.norm} = function(x)`,
    `    x = x % ${bitNames.mod}`,
    `    if x < 0 then x = x + ${bitNames.mod} end`,
    `    return x`,
    `  end`,
    `  ${bitNames.band32} = function(a, b)`,
    `    a = ${bitNames.norm}(a)`,
    `    b = ${bitNames.norm}(b)`,
    `    local res, bitv = 0, 1`,
    `    while a > 0 or b > 0 do`,
    `      if (a % 2 == 1) and (b % 2 == 1) then res = res + bitv end`,
    `      a = ${runtimeTools.floor}(a / 2)`,
    `      b = ${runtimeTools.floor}(b / 2)`,
    `      bitv = bitv * 2`,
    `    end`,
    `    return ${bitNames.norm}(res)`,
    `  end`,
    `  ${bitNames.bor32} = function(a, b)`,
    `    a = ${bitNames.norm}(a)`,
    `    b = ${bitNames.norm}(b)`,
    `    local res, bitv = 0, 1`,
    `    while a > 0 or b > 0 do`,
    `      if (a % 2 == 1) or (b % 2 == 1) then res = res + bitv end`,
    `      a = ${runtimeTools.floor}(a / 2)`,
    `      b = ${runtimeTools.floor}(b / 2)`,
    `      bitv = bitv * 2`,
    `    end`,
    `    return ${bitNames.norm}(res)`,
    `  end`,
    `  ${bitNames.bxor32} = function(a, b)`,
    `    a = ${bitNames.norm}(a)`,
    `    b = ${bitNames.norm}(b)`,
    `    local res, bitv = 0, 1`,
    `    while a > 0 or b > 0 do`,
    `      if (a % 2) ~= (b % 2) then res = res + bitv end`,
    `      a = ${runtimeTools.floor}(a / 2)`,
    `      b = ${runtimeTools.floor}(b / 2)`,
    `      bitv = bitv * 2`,
    `    end`,
    `    return ${bitNames.norm}(res)`,
    `  end`,
    `  ${bitNames.bnot32} = function(a)`,
    `    return ${bitNames.norm}((${bitNames.mod} - 1) - ${bitNames.norm}(a))`,
    `  end`,
    `  ${bitNames.lshift32} = function(a, b)`,
    `    return ${bitNames.norm}(${bitNames.norm}(a) * (2 ^ (b % 32)))`,
    `  end`,
    `  ${bitNames.rshift32} = function(a, b)`,
    `    return ${runtimeTools.floor}(${bitNames.norm}(a) / (2 ^ (b % 32)))`,
    `  end`,
    `else`,
    `  ${bitNames.band32} = ${bitNames.bit}[${charExpr("band")}]`,
    `  ${bitNames.bor32} = ${bitNames.bit}[${charExpr("bor")}]`,
    `  ${bitNames.bxor32} = ${bitNames.bit}[${charExpr("bxor")}]`,
    `  ${bitNames.bnot32} = ${bitNames.bit}[${charExpr("bnot")}]`,
    `  ${bitNames.lshift32} = ${bitNames.bit}[${charExpr("lshift")}]`,
    `  ${bitNames.rshift32} = ${bitNames.bit}[${charExpr("rshift")}]`,
    `end`,
    `local function ${bitNames.u64}(hi, lo)`,
    `  return { hi, lo }`,
    `end`,
    `local function ${bitNames.from}(v)`,
    `  return { 0, v % ${bitNames.mod} }`,
    `end`,
    `local function ${bitNames.lo}(v)`,
    `  return v[2]`,
    `end`,
    `local function ${bitNames.add}(a, b)`,
    `  local lo = a[2] + b[2]`,
    `  local carry = 0`,
    `  if lo >= ${bitNames.mod} then`,
    `    lo = lo - ${bitNames.mod}`,
    `    carry = 1`,
    `  end`,
    `  local hi = (a[1] + b[1] + carry) % ${bitNames.mod}`,
    `  return { hi, lo }`,
    `end`,
    `local function ${bitNames.modn}(a, m)`,
    `  local v = (a[1] % m) * (${bitNames.mod} % m) + (a[2] % m)`,
    `  return v % m`,
    `end`,
    `local function ${bitNames.modSmall}(a)`,
    `  local v = (a[1] % 256) + (a[2] % 256)`,
    `  return v % 256`,
    `end`,
    `local ${bitNames.bxor64} = function(a, b) return { ${bitNames.bxor32}(a[1], b[1]), ${bitNames.bxor32}(a[2], b[2]) } end`,
    `local ${bitNames.band64} = function(a, b) return { ${bitNames.band32}(a[1], b[1]), ${bitNames.band32}(a[2], b[2]) } end`,
    `local ${bitNames.bor64} = function(a, b) return { ${bitNames.bor32}(a[1], b[1]), ${bitNames.bor32}(a[2], b[2]) } end`,
    `local ${bitNames.bnot64} = function(a) return { ${bitNames.bnot32}(a[1]), ${bitNames.bnot32}(a[2]) } end`,
    `local ${bitNames.lshift64} = function(a, b)`,
    `  b = b % 64`,
    `  if b == 0 then`,
    `    return { a[1], a[2] }`,
    `  end`,
    `  if b >= 32 then`,
    `    local hi = ${bitNames.lshift32}(a[2], b - 32)`,
    `    return { hi, 0 }`,
    `  end`,
    `  local hi = ${bitNames.bor32}(${bitNames.lshift32}(a[1], b), ${bitNames.rshift32}(a[2], 32 - b))`,
    `  local lo = ${bitNames.lshift32}(a[2], b)`,
    `  return { hi, lo }`,
    `end`,
    `local ${bitNames.rshift64} = function(a, b)`,
    `  b = b % 64`,
    `  if b == 0 then`,
    `    return { a[1], a[2] }`,
    `  end`,
    `  if b >= 32 then`,
    `    local lo = ${bitNames.rshift32}(a[1], b - 32)`,
    `    return { 0, lo }`,
    `  end`,
    `  local hi = ${bitNames.rshift32}(a[1], b)`,
    `  local lo = ${bitNames.bor32}(${bitNames.rshift32}(a[2], b), ${bitNames.lshift32}(a[1], 32 - b))`,
    `  return { hi, lo }`,
    `end`
  );
  return lines.join("\n");
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

module.exports = {
  luaString,
  luaByteString,
  VM_NAME_KEYWORDS,
  VM_NAME_RESERVED,
  makeVmNameFactory,
  makeVmHelperName,
  makeVmCharExpr,
  createSharedVmRuntime,
  buildSharedVmRuntimePreludeSource,
  addIdentifierNames,
};
