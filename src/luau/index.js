const { normalizeOptions } = require("../options");
const { RNG } = require("../utils/rng");
const {
  extractDirectives,
  walk: walkLuauAst,
  parseLuau: parseLuauAst,
  generateLuau: generateLuauAst,
} = require("./ast");
const {
  validate: validateLuau,
  buildCFG: buildLuauCFG,
  buildSSA: buildLuauSSA,
  buildIR: buildLuauIR,
  buildIRSSA: buildLuauIRSSA,
  traverse: traverseLuau,
  buildScope: buildLuauScope,
  factory: luauFactory,
  diagnostics: luauDiagnostics,
} = require("./custom");
const { stringEncode: stringEncodeCustom } = require("./custom/strings");
const { stringEncode } = require("./strings");
const { splitStringsLuau } = require("./splitStrings");
const { controlFlowFlatten } = require("./cff");
const { numbersToExpressions } = require("./numbersToExpressions");
const { constantArrayLuau } = require("./constArray");
const {
  collectConstructorMemberHints,
  collectDynamicIndexBaseNames,
  collectDynamicIndexMemberNames,
  collectSafeFunctionParameterHints,
  renameLuau,
} = require("./rename");
const { maskGlobalsLuau } = require("./maskGlobals");
const { virtualizeLuau } = require("./vm");
const { antiHookLuau } = require("./antiHook");
const { encodeMembers } = require("./encodeMembers");
const { injectDeadCode } = require("./dead");
const { entryLuau } = require("./entry");
const { wrapInFunction } = require("./wrap");
const { proxifyLocals } = require("./proxifyLocals");
const { padFooterLuau } = require("./padFooter");
const { stylizeNumericLiteralsLuau } = require("./literalStyle");
const { buildSourceMap, shiftMappings } = require("./sourceMap");
const { createLuauDebugRecorder } = require("./debug");
const { makeShortNameFactory } = require("./names");
const MAX_LUAU_OUTPUT_BYTES = 5 * 1024 * 1024;
const PACKED_PAYLOAD_RADIX = 85;
const PACKED_PAYLOAD_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

function isWordChar(ch) {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

function concealResidualLuauMembers(code) {
  if (!code || typeof code !== "string") {
    return code;
  }
  return code.replace(/\.mode\b/g, '["\\109\\111\\100\\101"]');
}

function mergeOptionGroup(defaults, provided) {
  if (!provided || typeof provided !== "object" || Array.isArray(provided)) {
    return { ...defaults };
  }
  return { ...defaults, ...provided };
}

function normalizeLuauOptions(options) {
  const rawOptions = options && typeof options === "object" ? { ...options } : {};
  const defaultOptions = normalizeOptions({
    ...rawOptions,
    lang: "luau",
    luauParser: "custom",
  });
  const normalizedOptions = {
    ...defaultOptions,
    ...rawOptions,
    lang: "luau",
    luauParser: "custom",
  };
  const rawVm = typeof rawOptions.vm === "boolean"
    ? { enabled: rawOptions.vm }
    : rawOptions.vm;

  normalizedOptions.vm = mergeOptionGroup(defaultOptions.vm, rawVm);
  normalizedOptions.wrapOptions = mergeOptionGroup(defaultOptions.wrapOptions, rawOptions.wrapOptions);
  normalizedOptions.numbersOptions = mergeOptionGroup(defaultOptions.numbersOptions, rawOptions.numbersOptions);
  normalizedOptions.constArrayOptions = mergeOptionGroup(defaultOptions.constArrayOptions, rawOptions.constArrayOptions);
  normalizedOptions.padFooterOptions = mergeOptionGroup(defaultOptions.padFooterOptions, rawOptions.padFooterOptions);
  normalizedOptions.stringsOptions = mergeOptionGroup(defaultOptions.stringsOptions, rawOptions.stringsOptions);
  normalizedOptions.renameOptions = mergeOptionGroup(defaultOptions.renameOptions, rawOptions.renameOptions);
  normalizedOptions.deadCodeOptions = mergeOptionGroup(defaultOptions.deadCodeOptions, rawOptions.deadCodeOptions);
  normalizedOptions.cffOptions = mergeOptionGroup(defaultOptions.cffOptions, rawOptions.cffOptions);
  if (typeof rawOptions.antiHook === "boolean") {
    normalizedOptions.antiHook = {
      ...defaultOptions.antiHook,
      enabled: rawOptions.antiHook,
    };
  } else {
    normalizedOptions.antiHook = mergeOptionGroup(defaultOptions.antiHook, rawOptions.antiHook);
  }

  return normalizedOptions;
}

function getLuauFunctionName(node) {
  if (!node) {
    return null;
  }
  if (node.name && node.name.type === "FunctionName") {
    const parts = [node.name.base.name, ...(node.name.members || []).map((member) => member.name)];
    if (node.name.method) {
      parts.push(node.name.method.name);
    }
    return parts.join(".");
  }
  if (node.identifier && node.identifier.type === "Identifier") {
    return node.identifier.name;
  }
  return null;
}

function annotateOriginalFunctionNames(ast) {
  walkLuauAst(ast, (node) => {
    if (!node || node.type !== "FunctionDeclaration") {
      return;
    }
    const name = getLuauFunctionName(node);
    if (name) {
      node.__obf_original_name = name;
    }
  });
}

function readLongBracketOpen(source, index) {
  if (source[index] !== "[") {
    return null;
  }
  let cursor = index + 1;
  while (source[cursor] === "=") {
    cursor += 1;
  }
  if (source[cursor] !== "[") {
    return null;
  }
  return {
    openLength: cursor - index + 1,
    close: `]${"=".repeat(cursor - index - 1)}]`,
  };
}

function readQuotedStringEnd(source, index) {
  const quote = source[index];
  if (quote !== "'" && quote !== "\"" && quote !== "`") {
    return null;
  }
  let cursor = index + 1;
  while (cursor < source.length) {
    const current = source[cursor];
    if (current === "\\") {
      cursor = Math.min(source.length, cursor + 2);
      continue;
    }
    cursor += 1;
    if (current === quote) {
      break;
    }
  }
  return cursor;
}

function isWhitespaceChar(ch) {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\v";
}

function shouldKeepSpace(prevChar, nextChar, lastTwo) {
  if (!prevChar || !nextChar) {
    return false;
  }
  if (isWordChar(prevChar) && isWordChar(nextChar)) {
    return true;
  }
  if (prevChar === "-" && nextChar === "-") {
    return true;
  }
  if (/\d/.test(prevChar) && nextChar === ".") {
    return true;
  }
  if (prevChar === "." && /\d/.test(nextChar)) {
    return true;
  }
  if (lastTwo === ".." && nextChar === ".") {
    return true;
  }
  return false;
}

function compactLuauWhitespace(source) {
  const chunks = [];
  let lastChar = "";
  let lastTwo = "";
  const pushChunk = (text) => {
    if (!text) {
      return;
    }
    chunks.push(text);
    if (text.length === 1) {
      lastTwo = `${lastTwo}${text}`.slice(-2);
    } else {
      lastTwo = text.slice(-2);
    }
    lastChar = text[text.length - 1];
  };
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];

    const quotedEnd = readQuotedStringEnd(source, index);
    if (quotedEnd !== null) {
      pushChunk(source.slice(index, quotedEnd));
      index = quotedEnd;
      continue;
    }

    if (ch === "[") {
      const open = readLongBracketOpen(source, index);
      if (open) {
        pushChunk(source.slice(index, index + open.openLength));
        index += open.openLength;
        const closeIdx = source.indexOf(open.close, index);
        if (closeIdx === -1) {
          pushChunk(source.slice(index));
          break;
        }
        pushChunk(source.slice(index, closeIdx + open.close.length));
        index = closeIdx + open.close.length;
        continue;
      }
    }

    if (ch === "-" && next === "-") {
      pushChunk("--");
      index += 2;
      const longOpen = readLongBracketOpen(source, index);
      if (longOpen) {
        pushChunk(source.slice(index, index + longOpen.openLength));
        index += longOpen.openLength;
        const closeIdx = source.indexOf(longOpen.close, index);
        if (closeIdx === -1) {
          pushChunk(source.slice(index));
          break;
        }
        pushChunk(source.slice(index, closeIdx + longOpen.close.length));
        index = closeIdx + longOpen.close.length;
      } else {
        while (index < source.length && source[index] !== "\n") {
          pushChunk(source[index]);
          index += 1;
        }
        if (index < source.length && source[index] === "\n") {
          pushChunk("\n");
          index += 1;
        }
      }
      continue;
    }

    if (isWhitespaceChar(ch)) {
      let cursor = index + 1;
      while (cursor < source.length && isWhitespaceChar(source[cursor])) {
        cursor += 1;
      }
      const nextChar = source[cursor];
      if (shouldKeepSpace(lastChar, nextChar, lastTwo)) {
        pushChunk(" ");
      }
      index = cursor;
      continue;
    }

    pushChunk(ch);
    index += 1;
  }
  return chunks.join("");
}

function neutralizeDoubleDashInCode(source) {
  const chunks = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];

    const quotedEnd = readQuotedStringEnd(source, index);
    if (quotedEnd !== null) {
      chunks.push(source.slice(index, quotedEnd));
      index = quotedEnd;
      continue;
    }

    if (ch === "[") {
      const open = readLongBracketOpen(source, index);
      if (open) {
        chunks.push(source.slice(index, index + open.openLength));
        index += open.openLength;
        const closeIdx = source.indexOf(open.close, index);
        if (closeIdx === -1) {
          chunks.push(source.slice(index));
          break;
        }
        chunks.push(source.slice(index, closeIdx + open.close.length));
        index = closeIdx + open.close.length;
        continue;
      }
    }

    if (ch === "-" && next === "-") {
      chunks.push("- -");
      index += 2;
      continue;
    }

    chunks.push(ch);
    index += 1;
  }
  return chunks.join("");
}

function makeLongBracketLiteral(source) {
  const value = String(source);
  let equalsCount = 1;
  while (
    value.includes(`]${"=".repeat(equalsCount)}]`)
    || value.endsWith(`]${"=".repeat(equalsCount)}`)
  ) {
    equalsCount += 1;
  }
  const equals = "=".repeat(equalsCount);
  return `[${equals}[${value}]${equals}]`;
}

function makeByteEscapeLiteral(source) {
  const bytes = Buffer.from(String(source), "utf8");
  if (!bytes.length) {
    return "\"\"";
  }
  return `"${Array.from(bytes, (value) => `\\${String(value).padStart(3, "0")}`).join("")}"`;
}

function buildPackedPayloadEncoding(source) {
  const bytes = Buffer.from(String(source), "utf8");
  let payload = "";
  for (let index = 0; index < bytes.length; index += 4) {
    const a = bytes[index] || 0;
    const b = bytes[index + 1] || 0;
    const c = bytes[index + 2] || 0;
    const d = bytes[index + 3] || 0;
    let value = (((a * 256) + b) * 256 + c) * 256 + d;
    const block = new Array(5);
    for (let cursor = 4; cursor >= 0; cursor -= 1) {
      block[cursor] = PACKED_PAYLOAD_ALPHABET.charAt(value % PACKED_PAYLOAD_RADIX);
      value = Math.floor(value / PACKED_PAYLOAD_RADIX);
    }
    payload += block.join("");
  }

  return {
    payload,
    size: bytes.length,
  };
}

function buildPackedPayloadFragments(payload, rng) {
  const value = String(payload);
  const blockCount = Math.max(1, Math.floor(value.length / 5));
  let fragmentCount = blockCount >= 120 ? 7 : blockCount >= 72 ? 6 : blockCount >= 36 ? 5 : 4;
  if (rng && typeof rng.int === "function") {
    fragmentCount += rng.int(0, 2);
  }
  fragmentCount = Math.min(fragmentCount, blockCount);

  const fragments = [];
  let blockOffset = 0;
  for (let index = 0; index < fragmentCount; index += 1) {
    const remainingBlocks = blockCount - blockOffset;
    const remainingFragments = fragmentCount - index;
    const minBlocks = Math.max(1, Math.floor(remainingBlocks / (remainingFragments + 1)));
    const maxBlocks = Math.max(minBlocks, remainingBlocks - (remainingFragments - 1));
    const blockSize = index === fragmentCount - 1
      ? remainingBlocks
      : (rng && typeof rng.int === "function"
        ? rng.int(minBlocks, maxBlocks)
        : Math.floor(remainingBlocks / remainingFragments));
    fragments.push(value.slice(blockOffset * 5, (blockOffset + blockSize) * 5));
    blockOffset += blockSize;
  }

  return fragments.filter(Boolean);
}

function buildPackedDecodeLoopLines(templateId, names) {
  const {
    packedVar,
    outVar,
    decodeVar,
    indexVar,
    stateVar,
    limitVar,
    cursorVar,
    blockVar,
  } = names;
  if (templateId === 1) {
    return [
      `local ${cursorVar}=1;`,
      `repeat `,
      `local ${blockVar}=${packedVar}:sub(${cursorVar},${cursorVar}+4);`,
      `if #${blockVar}<5 then break end;`,
      `${outVar}[#${outVar}+1]=${decodeVar}(${blockVar});`,
      `${cursorVar}=${cursorVar}+5;`,
      `until ${cursorVar}>#${packedVar};`,
    ];
  }
  if (templateId === 2) {
    return [
      `local ${limitVar}=#${packedVar};`,
      `for ${cursorVar}=1,${limitVar},5 do `,
      `local ${blockVar}=${packedVar}:sub(${cursorVar},${cursorVar}+4);`,
      `if #${blockVar}==5 then ${outVar}[#${outVar}+1]=${decodeVar}(${blockVar});end;`,
      `end;`,
    ];
  }
  return [
    `local ${indexVar}=1;`,
    `local ${stateVar}=1;`,
    "while true do ",
    `if ${stateVar}==1 then `,
    `if ${indexVar}>#${packedVar} then ${stateVar}=3 else ${stateVar}=2 end;`,
    `elseif ${stateVar}==2 then `,
    `${outVar}[#${outVar}+1]=${decodeVar}(${packedVar}:sub(${indexVar},${indexVar}+4));`,
    `${indexVar}=${indexVar}+5;`,
    `${stateVar}=1;`,
    "else break end;",
    "end;",
  ];
}

function buildPackedLuauShell(code, rng) {
  const encoding = buildPackedPayloadEncoding(code);
  const fragments = buildPackedPayloadFragments(encoding.payload, rng);
  const alphabetSplitA = rng && typeof rng.int === "function"
    ? rng.int(18, 30)
    : 24;
  const alphabetSplitB = rng && typeof rng.int === "function"
    ? rng.int(alphabetSplitA + 12, 58)
    : 52;
  const alphabetParts = [
    PACKED_PAYLOAD_ALPHABET.slice(0, alphabetSplitA),
    PACKED_PAYLOAD_ALPHABET.slice(alphabetSplitA, alphabetSplitB),
    PACKED_PAYLOAD_ALPHABET.slice(alphabetSplitB),
  ].filter(Boolean);
  const nameFor = makeShortNameFactory(rng, new Set(["_"]));
  const partsVar = nameFor();
  const loaderVar = nameFor();
  const indexVar = nameFor();
  const blockVar = nameFor();
  const valueVar = nameFor();
  const decodedVar = nameFor();
  const packedVar = nameFor();
  const sizeVar = nameFor();
  const decodeVar = nameFor();
  const envVar = nameFor();
  const stateVar = nameFor();
  const joinVar = nameFor();
  const concatKeyVar = nameFor();
  const alphabetVar = nameFor();
  const loadAKeyVar = nameFor();
  const loadBKeyVar = nameFor();
  const loadAHeadVar = nameFor();
  const loadATailVar = nameFor();
  const loadBHeadVar = nameFor();
  const loadBTailVar = nameFor();
  const execVar = nameFor();
  const dispatchVar = nameFor();
  const payloadArgVar = nameFor();
  const sizeArgVar = nameFor();
  const outVar = nameFor();
  const rootVar = nameFor();
  const limitVar = nameFor();
  const cursorVar = nameFor();
  const fragmentIndexVar = nameFor();
  const fragmentEntryVar = nameFor();
  const decodeTemplate = rng && typeof rng.int === "function" ? rng.int(0, 2) : 0;
  const shardTemplate = rng && typeof rng.int === "function" ? rng.int(0, 2) : 0;
  const shuffled = fragments.map((value, idx) => ({ value, idx: idx + 1 }));
  if (rng && typeof rng.shuffle === "function") {
    rng.shuffle(shuffled);
  }
  const shardVars = Array.from({ length: rng && typeof rng.int === "function" ? rng.int(2, 4) : 2 }, () => nameFor());
  const stageVar = nameFor();
  const assembleVar = nameFor();
  const rehydrateVar = nameFor();
  const alphabetPartVars = alphabetParts.map(() => nameFor());

  const lines = [
    "return(function(...)",
  ];
  const scaffoldLines = [
    `local ${partsVar}={};`,
    `local ${concatKeyVar}=${makeByteEscapeLiteral("concat")};`,
    `local ${joinVar}=table[${concatKeyVar}];`,
  ];
  alphabetParts.forEach((part, index) => {
    scaffoldLines.push(`local ${alphabetPartVars[index]}=${makeByteEscapeLiteral(part)};`);
  });
  scaffoldLines.push(`local ${alphabetVar}=${alphabetPartVars.join("..")};`);
  let shardDeclCursor = 0;
  scaffoldLines.forEach((line, index) => {
    lines.push(line);
    while (
      shardDeclCursor < shardVars.length
      && ((index + 1) * shardVars.length >= (shardDeclCursor + 1) * scaffoldLines.length)
    ) {
      lines.push(`local ${shardVars[shardDeclCursor]}={};`);
      shardDeclCursor += 1;
    }
  });
  while (shardDeclCursor < shardVars.length) {
    lines.push(`local ${shardVars[shardDeclCursor]}={};`);
    shardDeclCursor += 1;
  }

  const shardInsertLines = [];
  shuffled.forEach((entry, index) => {
    const shardVar = shardVars[index % shardVars.length];
    if (shardTemplate === 0) {
      shardInsertLines.push(`${shardVar}[#${shardVar}+1]={${entry.idx},${makeLongBracketLiteral(entry.value)}};`);
    } else if (shardTemplate === 1) {
      shardInsertLines.push(`${shardVar}[#${shardVar}+1]={[1]=${makeLongBracketLiteral(entry.value)},[2]=${entry.idx}};`);
    } else {
      shardInsertLines.push(`${shardVar}[#${shardVar}+1]={{${entry.idx}},${makeLongBracketLiteral(entry.value)}};`);
    }
  });
  const shardRebuildLines = [];
  shardVars.forEach((shardVar) => {
    shardRebuildLines.push(`for ${fragmentIndexVar}=1,#${shardVar} do `);
    shardRebuildLines.push(`local ${fragmentEntryVar}=${shardVar}[${fragmentIndexVar}];`);
    if (shardTemplate === 0) {
      shardRebuildLines.push(`if ${fragmentEntryVar} then ${partsVar}[${fragmentEntryVar}[1]]=${fragmentEntryVar}[2];end;`);
    } else if (shardTemplate === 1) {
      shardRebuildLines.push(`if ${fragmentEntryVar} then ${partsVar}[${fragmentEntryVar}[2]]=${fragmentEntryVar}[1];end;`);
    } else {
      shardRebuildLines.push(`if ${fragmentEntryVar} then ${partsVar}[${fragmentEntryVar}[1][1]]=${fragmentEntryVar}[2];end;`);
    }
    shardRebuildLines.push(`end;`);
  });
  const shardBreakA = Math.max(1, Math.floor(shardInsertLines.length / 3));
  const shardBreakB = Math.max(shardBreakA + 1, Math.floor((shardInsertLines.length * 2) / 3));
  lines.push(...shardInsertLines.slice(0, shardBreakA));
  lines.push(`local function ${decodeVar}(${blockVar})`);
  lines.push(`local ${valueVar}=0;`);
  lines.push(`for ${indexVar}=1,5 do ${valueVar}=${valueVar}*${PACKED_PAYLOAD_RADIX}+(string.find(${alphabetVar},${blockVar}:sub(${indexVar},${indexVar}),1,true)-1);end;`);
  lines.push(`return string.char(math.floor(${valueVar}/16777216)%256,math.floor(${valueVar}/65536)%256,math.floor(${valueVar}/256)%256,${valueVar}%256);`);
  lines.push("end;");
  lines.push(...shardInsertLines.slice(shardBreakA, shardBreakB));
  lines.push(`local ${sizeVar}=${encoding.size};`);

  lines.push(`local function ${dispatchVar}(${decodedVar},...)`);
  lines.push(`local ${loadAHeadVar}=${makeByteEscapeLiteral("loa")};`);
  lines.push(`local ${loadATailVar}=${makeByteEscapeLiteral("dstr")}..${makeByteEscapeLiteral("ing")};`);
  lines.push(`local ${loadBHeadVar}=${makeByteEscapeLiteral("lo")};`);
  lines.push(`local ${loadBTailVar}=${makeByteEscapeLiteral("ad")};`);
  lines.push(`local ${loadAKeyVar}=${loadAHeadVar}..${loadATailVar};`);
  lines.push(`local ${loadBKeyVar}=${loadBHeadVar}..${loadBTailVar};`);
  lines.push(`local ${rootVar}=(function()return _G end)();`);
  lines.push(`local ${envVar}=type(${rootVar})=="table" and ${rootVar} or nil;`);
  lines.push(`local ${loaderVar}=${envVar} and (${envVar}[${loadAKeyVar}] or ${envVar}[${loadBKeyVar}]);`);
  lines.push(`return ${loaderVar}(${decodedVar})(...);`);
  lines.push("end;");
  lines.push(...shardInsertLines.slice(shardBreakB));
  lines.push(...shardRebuildLines);

  lines.push(`local function ${assembleVar}(${packedVar})`);
  lines.push(`local ${outVar}={};`);
  lines.push(...buildPackedDecodeLoopLines(decodeTemplate, {
    packedVar,
    outVar,
    decodeVar,
    indexVar,
    stateVar,
    limitVar,
    cursorVar,
    blockVar,
  }));
  lines.push(`return ${outVar};`);
  lines.push("end;");
  lines.push(`local function ${rehydrateVar}(${stageVar},${sizeArgVar})`);
  lines.push(`local ${decodedVar}=${joinVar}(${stageVar});`);
  lines.push(`return ${decodedVar}:sub(1,${sizeArgVar});`);
  lines.push("end;");
  lines.push(`local function ${execVar}(${payloadArgVar},${sizeArgVar},...)`);
  lines.push(`local ${packedVar}={};`);
  lines.push(`for ${fragmentIndexVar}=1,#${payloadArgVar} do `);
  lines.push(`local ${fragmentEntryVar}=${payloadArgVar}[${fragmentIndexVar}];`);
  lines.push(`if ${fragmentEntryVar} then ${packedVar}[#${packedVar}+1]=${fragmentEntryVar};end;`);
  lines.push(`end;`);
  lines.push(`${packedVar}=table[${concatKeyVar}](${packedVar});`);
  lines.push(`local ${stageVar}=${assembleVar}(${packedVar});`);
  lines.push(`local ${decodedVar}=${rehydrateVar}(${stageVar},${sizeArgVar});`);
  lines.push(`return ${dispatchVar}(${decodedVar},...);`);
  lines.push("end;");
  lines.push(`return ${execVar}(${partsVar},${sizeVar},...);`);
  lines.push("end)(...)");

  return lines.join("");
}

async function obfuscateLuau(source, options) {
  options = normalizeLuauOptions(options);
  const debugRecorder = createLuauDebugRecorder({
    ...(options.debugLuauTransforms || {}),
    filename: options.filename,
    seed: options.seed,
  });
  const rng = new RNG(options.seed);
  const directives = extractDirectives(source);
  const useCustom = true;
  const vmEnabled = options.vm === true || (options.vm && options.vm.enabled);
  const cffMode = options.cffOptions && options.cffOptions.mode
    ? options.cffOptions.mode
    : "classic";
  const useVmCff = Boolean(options.cff && cffMode === "vm");
  const ast = parseLuauAst(source);
  annotateOriginalFunctionNames(ast);
  const constructorMemberHints = collectConstructorMemberHints(ast);
  const dynamicIndexBaseNames = collectDynamicIndexBaseNames(ast);
  const dynamicIndexMemberNames = collectDynamicIndexMemberNames(ast);
  const safeFunctionParameterHints = collectSafeFunctionParameterHints(ast);
  const validateAst = options.validateAst === true;
  if (validateAst) {
    validateLuau(ast, { throw: true });
  }

  const analysis = {
    scope: null,
    cfg: null,
    ssa: null,
    ir: null,
    irSSA: null,
  };
  const getScope = () => {
    if (!analysis.scope) {
      analysis.scope = buildLuauScope(ast, { includeTypes: true });
    }
    return analysis.scope;
  };
  const getCFG = () => {
    if (!analysis.cfg) {
      analysis.cfg = buildLuauCFG(ast);
    }
    return analysis.cfg;
  };
  const getSSA = () => {
    if (!analysis.ssa) {
      analysis.ssa = buildLuauSSA(getCFG());
    }
    return analysis.ssa;
  };
  const getIR = () => {
    if (!analysis.ir) {
      analysis.ir = buildLuauIR(ast);
    }
    return analysis.ir;
  };
  const getIRSSA = () => {
    if (!analysis.irSSA) {
      analysis.irSSA = buildLuauIRSSA(getIR());
    }
    return analysis.irSSA;
  };
  const invalidateAnalysis = () => {
    analysis.scope = null;
    analysis.cfg = null;
    analysis.ssa = null;
    analysis.ir = null;
    analysis.irSSA = null;
  };

  const ctx = {
    options,
    rng,
    parseCustom: parseLuauAst,
    parseLuaparse: parseLuauAst,
    traverse: traverseLuau,
    buildScope: buildLuauScope,
    buildCFG: buildLuauCFG,
    buildSSA: buildLuauSSA,
    buildIR: buildLuauIR,
    buildIRSSA: buildLuauIRSSA,
    factory: luauFactory,
    diagnostics: luauDiagnostics,
    constructorMemberHints,
    dynamicIndexBaseNames,
    dynamicIndexMemberNames,
    safeFunctionParameterHints,
    validate: validateLuau,
    getScope,
    getCFG,
    getSSA,
    getIR,
    getIRSSA,
    invalidateAnalysis,
    raise: (message, node, expected) =>
      luauDiagnostics.makeDiagnosticErrorFromNode
        ? luauDiagnostics.makeDiagnosticErrorFromNode(message, node, expected)
        : luauDiagnostics.makeDiagnosticError(message, node, expected),
  };

  const timingEnabled = options.timing === true;
  const logTiming = timingEnabled
    ? (name, durationMs) => {
        const seconds = (durationMs / 1000).toFixed(3);
        process.stderr.write(`[js-obf] ${name} ${seconds}s\n`);
      }
    : null;
  let passIndex = 0;

  const safeDebugCall = (callback, label) => {
    if (typeof callback !== "function") {
      return null;
    }

    try {
      return callback();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      process.stderr.write(`[js-obf] ${label} failed: ${message}\n`);
      return null;
    }
  };

  const runLuauPlugin = (name, fn) => {
    const start = timingEnabled ? process.hrtime.bigint() : null;
    passIndex += 1;
    const debugPass = safeDebugCall(
      () => (debugRecorder ? debugRecorder.beginPass(name, passIndex, ast) : null),
      `debug recorder beginPass for ${name}`
    );
    try {
      const result = fn(debugPass);
      if (validateAst) {
        validateLuau(ast, { throw: true });
      }
      invalidateAnalysis();
      safeDebugCall(
        () => (debugPass ? debugPass.complete(ast) : null),
        `debug recorder complete for ${name}`
      );
      return result;
    } catch (err) {
      safeDebugCall(
        () => (debugPass ? debugPass.fail(ast, err) : null),
        `debug recorder fail for ${name}`
      );
      const message = err && err.message ? err.message : String(err);
      const wrapped = new Error(`[js-obf] plugin ${name} failed: ${message}`);
      if (err && err.stack) {
        wrapped.stack = `${wrapped.message}\nCaused by: ${err.stack}`;
      }
      wrapped.cause = err;
      if (err && err.diagnostic) {
        wrapped.diagnostic = err.diagnostic;
      }
      throw wrapped;
    } finally {
      if (timingEnabled) {
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1e6;
        logTiming(`plugin ${name}`, durationMs);
      }
    }
  };

  const queuedLuauPasses = [];
  const enqueueLuauPass = (name, fn) => {
    queuedLuauPasses.push({ name, fn });
  };
  const vmEnabledSafe = Boolean(vmEnabled && !useVmCff);
  const skipClassicConstArrayForVm = Boolean(vmEnabledSafe && options.constArray);
  const skipClassicCffForVm = Boolean(vmEnabled && options.cff && !useVmCff);

  const makePassPluginCtx = (name, passHandle) => {
    const traceablePasses = new Set([
      "luau-rename",
      "luau-maskGlobals",
      "luau-strings",
      "luau-vm",
      "luau-vm-cff",
    ]);

    if (!traceablePasses.has(name) || !passHandle || typeof passHandle.recordTrace !== "function") {
      return ctx;
    }

    return {
      ...ctx,
      debugTrace: passHandle.recordTrace,
    };
  };

  enqueueLuauPass("luau-entry", () => entryLuau(ast, ctx));

  if (options.wrap) {
    enqueueLuauPass("luau-wrap", () => wrapInFunction(ast, ctx));
  }

  if (options.constArray && !skipClassicConstArrayForVm) {
    enqueueLuauPass("luau-const-array", () => constantArrayLuau(ast, ctx));
  }

  if (options.stringsOptions && options.stringsOptions.split && !options.strings) {
    enqueueLuauPass("luau-split-strings", () => splitStringsLuau(ast, ctx));
  }

  if (options.numbers) {
    enqueueLuauPass("luau-numbers", () => numbersToExpressions(ast, ctx));
  }

  const runClassicCffBeforeVm = Boolean(options.cff && !useVmCff && vmEnabled && !skipClassicCffForVm);
  if (runClassicCffBeforeVm) {
    enqueueLuauPass("luau-cff", () => controlFlowFlatten(ast, ctx));
  }

  const renameBeforeVm = Boolean(options.rename && vmEnabled && !useVmCff);
  if (renameBeforeVm) {
    enqueueLuauPass("luau-rename", (passHandle) => renameLuau(ast, {
      ...makePassPluginCtx("luau-rename", passHandle),
      options,
    }));
  }

  if (vmEnabled && !useVmCff) {
    enqueueLuauPass("luau-vm", (passHandle) => virtualizeLuau(ast, makePassPluginCtx("luau-vm", passHandle)));
  }

  if (options.cff) {
    if (useVmCff) {
      const vmOptions = { ...options.vm, enabled: true };
      if (!vmOptions.layers) {
        vmOptions.layers = 1;
      }
      enqueueLuauPass("luau-vm-cff", (passHandle) => virtualizeLuau(ast, {
        ...makePassPluginCtx("luau-vm-cff", passHandle),
        options: { ...options, vm: vmOptions },
      }));
    } else if (!runClassicCffBeforeVm && !skipClassicCffForVm) {
      enqueueLuauPass("luau-cff", () => controlFlowFlatten(ast, ctx));
    }
  }

  if (options.rename && !renameBeforeVm) {
    enqueueLuauPass("luau-rename", (passHandle) => renameLuau(ast, {
      ...makePassPluginCtx("luau-rename", passHandle),
      options,
    }));
  }

  if (options.strings) {
    enqueueLuauPass("luau-encodeMembers", () => encodeMembers(ast, ctx));
  }

  if (options.proxifyLocals) {
    enqueueLuauPass("luau-proxifyLocals", () => proxifyLocals(ast, ctx));
  }

  if (options.strings) {
    enqueueLuauPass("luau-strings", (passHandle) => {
      if (useCustom) {
        stringEncodeCustom(ast, options, rng, makePassPluginCtx("luau-strings", passHandle));
      } else {
        stringEncode(ast, makePassPluginCtx("luau-strings", passHandle));
      }
    });
  }

  if (options.dead) {
    enqueueLuauPass("luau-dead", () => injectDeadCode(ast, ctx));
  }

  if (options.antiHook && options.antiHook.enabled) {
    enqueueLuauPass("luau-antiHook", () => antiHookLuau(ast, ctx));
  }

  enqueueLuauPass("luau-maskGlobals", (passHandle) => maskGlobalsLuau(ast, makePassPluginCtx("luau-maskGlobals", passHandle)));

  if (options.padFooter) {
    enqueueLuauPass("luau-pad-footer", () => padFooterLuau(ast, ctx));
  }

  enqueueLuauPass("luau-literal-style", () => stylizeNumericLiteralsLuau(ast, ctx));

  for (let queueIndex = 0; queueIndex < queuedLuauPasses.length; queueIndex += 1) {
    const queued = queuedLuauPasses[queueIndex];
    try {
      runLuauPlugin(queued.name, queued.fn);
    } catch (err) {
      if (debugRecorder && typeof debugRecorder.markPassSkipped === "function") {
        for (let skipIndex = queueIndex + 1; skipIndex < queuedLuauPasses.length; skipIndex += 1) {
          const skipped = queuedLuauPasses[skipIndex];
          safeDebugCall(
            () => debugRecorder.markPassSkipped(skipped.name, skipIndex + 1),
            `debug recorder markPassSkipped for ${skipped.name}`
          );
        }
      }
      throw err;
    }
  }

  let cfg = null;
  if (options.cfg === true) {
    cfg = getCFG();
  }
  let ssa = null;
  if (options.ssa === true) {
    ssa = getSSA();
  }
  let ir = null;
  if (options.ir === true) {
    ir = getIR();
  }
  let irSSA = null;
  if (options.irSSA === true) {
    irSSA = getIRSSA();
  }
  const usePackedShell = options.lang === "luau" && vmEnabled && options.vm && options.vm.shellStyle === "packed";
  const shouldGenerateSourceMap = Boolean(options.sourceMap && !usePackedShell);
  const generated = generateLuauAst(ast, {
    compact: shouldGenerateSourceMap ? false : options.compact,
    sourceMap: shouldGenerateSourceMap,
  });
  const baseCode = shouldGenerateSourceMap ? generated.code : generated;
  let code = baseCode;
  let map = null;
  if (!shouldGenerateSourceMap) {
    if (options.compact) {
      code = compactLuauWhitespace(code);
    }
    code = neutralizeDoubleDashInCode(code);
    code = concealResidualLuauMembers(code);
  }
  if (directives) {
    code = `${directives}\n${code}`;
  }
  if (usePackedShell) {
    code = buildPackedLuauShell(code, rng);
  }
  if (shouldGenerateSourceMap) {
    const prefixLines = directives ? directives.split("\n").length : 0;
    map = buildSourceMap(
      shiftMappings(generated.mappings || [], prefixLines),
      {
        file: options.filename || "output.lua",
        source: options.filename || "input.lua",
        sourceContent: source,
      }
    );
  }

  const outputSize = Buffer.byteLength(code, "utf8");
  if (outputSize > MAX_LUAU_OUTPUT_BYTES) {
    if (usePackedShell) {
      throw new Error(
        `Luau packed output too large: ${outputSize} bytes (max ${MAX_LUAU_OUTPUT_BYTES}).`
      );
    }
    let fallbackCode = compactLuauWhitespace(baseCode);
    if (directives) {
      fallbackCode = `${directives}\n${fallbackCode}`;
    }
    const fallbackSize = Buffer.byteLength(fallbackCode, "utf8");
    if (fallbackSize <= MAX_LUAU_OUTPUT_BYTES) {
      code = fallbackCode;
    } else {
      throw new Error(
        `Luau output too large: ${fallbackSize} bytes (max ${MAX_LUAU_OUTPUT_BYTES}).`
      );
    }
  }

  return {
    code,
    map,
    cfg,
    ssa,
    ir,
    irSSA,
  };
}

module.exports = {
  obfuscateLuau,
  MAX_LUAU_OUTPUT_BYTES,
};
