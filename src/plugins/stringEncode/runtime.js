const parser = require("@babel/parser");
const { buildCharCodeExpr } = require("../../utils/runtime");

function buildRuntime({
  poolNames,
  poolMeta,
  orderName,
  groupName,
  indexName,
  keyName,
  cacheName,
  decodeName,
  getEncodedName,
  shiftName,
  rotKeyName,
  alphabetName,
  b64LabelName,
  errName,
  rotOffset,
  b64Name,
  chachaName,
  u8ToStrName,
  unshiftName,
  poolSelectName,
  order,
  groupMap,
  indexMap,
  key,
  shift,
  rotKey,
  valueName,
  bytesName,
  errMessage,
}) {
  const poolDecls = poolNames
    .map((name, idx) => {
      const meta = poolMeta[idx];
      const shardDecls = meta.shards
        .map((shard, shardIdx) => `  const d${shardIdx} = ${JSON.stringify(shard)};`)
        .join("\n");
      const shardRefs = meta.shards.map((_, shardIdx) => `d${shardIdx}`).join(", ");
      const idxDecl = `  const i = ${JSON.stringify(meta.indexPairs)};`;
      const lensDecl = `  const l = ${JSON.stringify(meta.shardLens)};`;
      const maskDecl = `  const m = ${meta.mask};`;
      const indexMaskDecl = `  const im = ${meta.indexMask};`;
      return `const ${name} = (() => {\n${shardDecls}\n${idxDecl}\n${lensDecl}\n${maskDecl}\n${indexMaskDecl}\n  return [[${shardRefs}], l, i, m, im];\n})();`;
    })
    .join("\n");
  const poolSelectCases = poolNames
    .map((name, idx) => `    case ${idx}: return ${name};`)
    .join("\n");
  const errExpr = buildCharCodeExpr(errMessage || "decode unavailable");
  // ChaCha20 runtime implementation
  const code = `
${poolDecls}
const ${orderName} = ${JSON.stringify(order)};
const ${groupName} = ${JSON.stringify(groupMap)};
const ${indexName} = ${JSON.stringify(indexMap)};
const ${keyName} = ${JSON.stringify(key)};
const ${shiftName} = ${shift};
const ${cacheName} = [];
const ${rotKeyName} = ${JSON.stringify(rotKey)};
const ${alphabetName} = (() => {
  const out = [];
  for (let i = 65; i <= 90; i += 1) out.push(String.fromCharCode(i));
  for (let i = 97; i <= 122; i += 1) out.push(String.fromCharCode(i));
  for (let i = 48; i <= 57; i += 1) out.push(String.fromCharCode(i));
  out.push(String.fromCharCode(43), String.fromCharCode(47), String.fromCharCode(61));
  return out.join("");
})();
const ${b64LabelName} = String.fromCharCode(98, 97, 115, 101, 54, 52);
const ${errName} = ${errExpr};
const ${poolSelectName} = (group) => {
  switch (group) {
${poolSelectCases}
    default:
      return ${poolNames[0]};
  }
};
const ${getEncodedName} = (pool, pos) => {
  const data = pool[0];
  const lens = pool[1];
  const idx = pool[2];
  const mask = pool[3];
  const idxMask = pool[4];
  let offset = idx[pos * 2] ^ idxMask;
  let length = idx[pos * 2 + 1] ^ idxMask;
  let shard = 0;
  let shardOffset = offset;
  while (shard < lens.length && shardOffset >= lens[shard]) {
    shardOffset -= lens[shard];
    shard += 1;
  }
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const piece = data[shard];
    const code = piece[shardOffset] ^ mask;
    out += String.fromCharCode(code);
    shardOffset += 1;
    if (shardOffset >= lens[shard]) {
      shard += 1;
      shardOffset = 0;
    }
  }
  return out;
};
const ${unshiftName} = (input) => {
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const idx = ${alphabetName}.indexOf(ch);
    if (idx < 0) {
      out += ch;
      continue;
    }
    const shift = ${rotKeyName}[(i + ${rotOffset}) % ${rotKeyName}.length];
    const next = (idx - shift + ${alphabetName}.length) % ${alphabetName}.length;
    out += ${alphabetName}[next];
  }
  return out;
};
const ${b64Name} = (s) => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(s, ${b64LabelName});
  }
  if (typeof atob !== "undefined") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }
  throw new Error(${errName});
};
const ${chachaName} = (keyBytes) => {
  const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
  const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
  const qr = (s, a, b, c, d) => {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
  };
  const key = new Uint8Array(32);
  const kb = Uint8Array.from(keyBytes);
  if (kb.length >= 32) {
    key.set(kb.slice(0, 32));
  } else {
    key.set(kb);
    let h = 0x811c9dc5;
    for (let i = 0; i < kb.length; i++) { h ^= kb[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    for (let i = kb.length; i < 32; i++) { h ^= i; h = Math.imul(h, 0x01000193) >>> 0; key[i] = h & 0xff; }
  }
  const nonce = new Uint8Array(12);
  let nh = 0x6a09e667;
  for (let i = 0; i < kb.length; i++) { nh ^= kb[i]; nh = Math.imul(nh, 0x85ebca6b) >>> 0; nh = rotl(nh, 13); }
  for (let i = 0; i < 12; i++) { nh ^= i * 0x9e3779b9; nh = Math.imul(nh, 0xcc9e2d51) >>> 0; nonce[i] = nh & 0xff; nh = rotl(nh, 15); }
  const state = new Uint32Array(16);
  state[0] = SIGMA[0]; state[1] = SIGMA[1]; state[2] = SIGMA[2]; state[3] = SIGMA[3];
  for (let i = 0; i < 8; i++) {
    state[4 + i] = (key[i*4] | (key[i*4+1] << 8) | (key[i*4+2] << 16) | (key[i*4+3] << 24)) >>> 0;
  }
  state[12] = 0;
  for (let i = 0; i < 3; i++) {
    state[13 + i] = (nonce[i*4] | (nonce[i*4+1] << 8) | (nonce[i*4+2] << 16) | (nonce[i*4+3] << 24)) >>> 0;
  }
  let block = null;
  let blockIdx = 64;
  let counter = 0;
  return (byte) => {
    if (blockIdx >= 64) {
      state[12] = counter >>> 0;
      const w = new Uint32Array(state);
      for (let r = 0; r < 10; r++) {
        qr(w, 0, 4, 8, 12); qr(w, 1, 5, 9, 13); qr(w, 2, 6, 10, 14); qr(w, 3, 7, 11, 15);
        qr(w, 0, 5, 10, 15); qr(w, 1, 6, 11, 12); qr(w, 2, 7, 8, 13); qr(w, 3, 4, 9, 14);
      }
      block = new Uint8Array(64);
      for (let i = 0; i < 16; i++) {
        const word = (w[i] + state[i]) >>> 0;
        block[i*4] = word & 0xff;
        block[i*4+1] = (word >>> 8) & 0xff;
        block[i*4+2] = (word >>> 16) & 0xff;
        block[i*4+3] = (word >>> 24) & 0xff;
      }
      blockIdx = 0;
      counter++;
    }
    return byte ^ block[blockIdx++];
  };
};
const ${u8ToStrName} = (u8) => {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder().decode(u8);
  }
  let s = "";
  for (let i = 0; i < u8.length; i += 1) {
    s += String.fromCharCode(u8[i]);
  }
  try {
    return decodeURIComponent(escape(s));
  } catch {
    return s;
  }
};
function ${decodeName}(i) {
  let state = 0;
  let mapped;
  let group;
  let pos;
  let pool;
  let ${valueName};
  let ${bytesName};
  while (true) {
    switch (state) {
      case 0:
        i = i - ${shiftName};
        ${valueName} = ${cacheName}[i];
        state = ${valueName} !== undefined ? 5 : 1;
        break;
      case 1:
        mapped = ${orderName}[i];
        group = ${groupName}[mapped];
        pos = ${indexName}[mapped];
        state = 2;
        break;
      case 2:
        pool = ${poolSelectName}(group);
        ${bytesName} = ${b64Name}(${unshiftName}(${getEncodedName}(pool, pos)));
        state = 3;
        break;
      case 3: {
        const next = ${chachaName}(${keyName});
        for (let n = 0; n < ${bytesName}.length; n += 1) {
          ${bytesName}[n] = next(${bytesName}[n]);
        }
        ${valueName} = ${u8ToStrName}(${bytesName});
        ${cacheName}[i] = ${valueName};
        state = 5;
        break;
      }
      case 5:
        return ${valueName};
      default:
        return ${valueName};
    }
  }
}
`;
  return parser.parse(code, { sourceType: "script" }).program.body;
}

module.exports = {
  buildRuntime,
};
