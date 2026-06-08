const { walk, buildScope } = require("./ast");

const LUA_KEYWORDS = new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
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

const DEFAULT_RESERVED = new Set([
  "_ENV",
  "_G",
  "table",
  "string",
  "math",
  "bit32",
  "utf8",
  "debug",
  "coroutine",
  "type",
  "getfenv",
  "setfenv",
  "pcall",
  "xpcall",
  "pairs",
  "ipairs",
  "next",
  "print",
  "require",
  "select",
  "tonumber",
  "tostring",
  "rawget",
  "rawset",
  "setmetatable",
  "getmetatable",
]);

const FIRST_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_";
const REST_ALPHABET = `${FIRST_ALPHABET}0123456789`;

function collectScopeNames(scope, out) {
  if (!scope) {
    return;
  }
  for (const name of scope.bindings.keys()) {
    out.add(name);
  }
  for (const name of scope.typeBindings.keys()) {
    out.add(name);
  }
  scope.references.forEach((ref) => {
    if (ref && ref.name) {
      out.add(ref.name);
    }
  });
  scope.typeReferences.forEach((ref) => {
    if (ref && ref.name) {
      out.add(ref.name);
    }
  });
  scope.children.forEach((child) => collectScopeNames(child, out));
}

function collectIdentifierNames(ast, ctx = null) {
  const used = new Set();
  const scope =
    ctx && typeof ctx.getScope === "function"
      ? ctx.getScope()
      : ctx && typeof ctx.buildScope === "function"
        ? ctx.buildScope(ast, { includeTypes: true })
        : null;
  if (scope) {
    collectScopeNames(scope, used);
    return used;
  }
  if (typeof buildScope === "function" && ctx && ctx.useScope) {
    collectScopeNames(buildScope(ast, { includeTypes: true }), used);
    return used;
  }
  walk(ast, (node) => {
    if (node && node.type === "Identifier" && typeof node.name === "string") {
      used.add(node.name);
    }
  });
  return used;
}

function makeNameFactory(rng, used = new Set(), extraReserved = null, options = {}) {
  const reserved = new Set([...LUA_KEYWORDS, ...DEFAULT_RESERVED]);
  if (extraReserved) {
    for (const name of extraReserved) {
      reserved.add(name);
    }
  }
  const minLength = options.minLength ?? 3;
  const maxLength = options.maxLength ?? 8;
  return (_prefix) => {
    let name = "";
    while (!name || reserved.has(name) || used.has(name) || name.toLowerCase().includes("obf")) {
      const length = rng.int(minLength, maxLength);
      let out = FIRST_ALPHABET[rng.int(0, FIRST_ALPHABET.length - 1)];
      for (let i = 1; i < length; i += 1) {
        out += REST_ALPHABET[rng.int(0, REST_ALPHABET.length - 1)];
      }
      name = out;
    }
    used.add(name);
    return name;
  };
}

function countNamesOfLength(length) {
  if (length <= 1) {
    return FIRST_ALPHABET.length;
  }
  return FIRST_ALPHABET.length * (REST_ALPHABET.length ** (length - 1));
}

function nameAtLengthIndex(length, index) {
  if (length <= 1) {
    return FIRST_ALPHABET[index % FIRST_ALPHABET.length];
  }
  let restIndex = index % (REST_ALPHABET.length ** (length - 1));
  const firstIndex = Math.floor(index / (REST_ALPHABET.length ** (length - 1))) % FIRST_ALPHABET.length;
  let name = FIRST_ALPHABET[firstIndex];
  const chars = new Array(length - 1);
  for (let pos = chars.length - 1; pos >= 0; pos -= 1) {
    chars[pos] = REST_ALPHABET[restIndex % REST_ALPHABET.length];
    restIndex = Math.floor(restIndex / REST_ALPHABET.length);
  }
  return name + chars.join("");
}

function makeShortNameFactory(_rng, used = new Set(), extraReserved = null, options = {}) {
  const reserved = new Set([...LUA_KEYWORDS, ...DEFAULT_RESERVED]);
  if (extraReserved) {
    for (const name of extraReserved) {
      reserved.add(name);
    }
  }
  const minLength = options.minLength ?? 1;
  const preferredMaxLength = options.maxLength ?? 3;
  let length = minLength;
  let index = 0;

  return (_prefix) => {
    while (true) {
      const count = countNamesOfLength(length);
      if (index >= count) {
        length += 1;
        index = 0;
        continue;
      }
      const name = nameAtLengthIndex(length, index);
      index += 1;
      if (!reserved.has(name) && !used.has(name) && !name.toLowerCase().includes("obf")) {
        used.add(name);
        return name;
      }
      if (length >= preferredMaxLength && index >= count) {
        length += 1;
        index = 0;
      }
    }
  };
}

module.exports = {
  collectIdentifierNames,
  makeNameFactory,
  makeShortNameFactory,
};
