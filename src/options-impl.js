const { DEFAULT_RESERVED } = require("./utils/reserved");

const DEFAULT_ECMA = 2020;

function normalizeEcma(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_ECMA;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (!text) {
    return DEFAULT_ECMA;
  }
  const normalized = text.startsWith("es") ? text.slice(2) : text;
  const parsed = Number(normalized);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return DEFAULT_ECMA;
}

function normalizeProbability(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, numeric));
}

function normalizeCount(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const clamped = Math.max(min, Math.min(max, Math.floor(numeric)));
  return clamped;
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

const PRESETS = {
  high: {
    rename: true,
    strings: true,
    cff: true,
    dead: true,
    vm: false,
  },
  balanced: {
    rename: true,
    strings: true,
    cff: true,
    dead: false,
    vm: false,
  },
  low: {
    rename: true,
    strings: false,
    cff: false,
    dead: false,
    vm: false,
  },
};

const JS_SCHEMES = {
  classic: {
    stringMinLength: 3,
    stringSampleRate: 1,
    stringSegmentSize: null,
    deadProbability: 0.15,
    vm: null,
  },
  stealth: {
    stringMinLength: 2,
    stringSampleRate: 0.92,
    stringSegmentSize: 96,
    deadProbability: 0.1,
    vm: null,
  },
  runtime: {
    stringMinLength: 2,
    stringSampleRate: 0.95,
    stringSegmentSize: 80,
    deadProbability: 0.12,
    vm: {
      enabled: true,
      downlevel: true,
      fakeOpcodes: 0.2,
      bytecodeEncrypt: true,
      constsEncrypt: true,
    },
  },
};

function normalizeJsScheme(value) {
  if (value === undefined || value === null || value === "") {
    return "classic";
  }
  const text = String(value).trim().toLowerCase();
  return JS_SCHEMES[text] ? text : "classic";
}

function normalizeOptions(userOptions = {}) {
  const requestedPreset = String(userOptions.preset ?? "high").toLowerCase();
  const presetName = PRESETS[requestedPreset] ? requestedPreset : "high";
  const preset = PRESETS[presetName] || PRESETS.high;
  const stringsUserOptions = userOptions.stringsOptions || {};
  const cffUserOptions = userOptions.cffOptions || {};
  const renameUserOptions = userOptions.renameOptions || {};
  const wrapUserOptions = userOptions.wrapOptions || {};
  const numbersUserOptions = userOptions.numbersOptions || {};
  const constArrayUserOptions = userOptions.constArrayOptions || {};
  const padFooterUserOptions = userOptions.padFooterOptions || {};
  const debugUserOptions = userOptions.debugLuauTransforms || {};
  const cffModeRaw = typeof cffUserOptions.mode === "string"
    ? cffUserOptions.mode.toLowerCase()
    : null;
  const antiHookUserOptions = userOptions.antiHook;
  const ecma = normalizeEcma(userOptions.ecma);
  const lang = String(userOptions.lang ?? "js").toLowerCase();
  const schemeName = lang === "luau"
    ? "classic"
    : normalizeJsScheme(userOptions.scheme ?? userOptions.jsScheme);
  const scheme = JS_SCHEMES[schemeName] || JS_SCHEMES.classic;
  const defaultCffMode = lang === "luau" ? "classic" : null;
  const cffMode = cffModeRaw === "vm" || cffModeRaw === "classic" || cffModeRaw === "woven"
    ? cffModeRaw
    : null;
  const effectiveCffMode = cffMode || defaultCffMode;
  const luauStyle = "default";
  const luauParser = "custom";
  const maxCount = normalizeCount(stringsUserOptions.maxCount, 5000, { min: 0 });
  const jsSegmentDefault = scheme.stringSegmentSize
    ? Math.min(maxCount, scheme.stringSegmentSize)
    : maxCount;
  const segmentDefault = lang === "luau" ? Math.min(maxCount, 120) : jsSegmentDefault;
  const segmentSize = normalizeCount(
    stringsUserOptions.segmentSize,
    segmentDefault,
    { min: 1, max: Math.max(1, maxCount) }
  );
  const stringsPoolEncoding = "table";
  const splitMin = normalizeCount(stringsUserOptions.splitMin, 12, { min: 2 });
  const splitMaxParts = normalizeCount(stringsUserOptions.splitMaxParts, 3, { min: 2, max: 6 });
  const wrapIterations = normalizeCount(
    wrapUserOptions.iterations ?? userOptions.wrapIterations,
    1,
    { min: 1, max: 6 }
  );
  const numbersMaxDepth = normalizeCount(numbersUserOptions.maxDepth, 6, { min: 1, max: 12 });
  const numbersRange = normalizeCount(numbersUserOptions.range, 2 ** 20, { min: 1, max: 2 ** 26 });
  const constArrayMinLength = normalizeCount(constArrayUserOptions.minLength, 1, { min: 1, max: 1024 });
  const constArrayShards = normalizeCount(constArrayUserOptions.shards, 3, { min: 1, max: 16 });
  const constArrayShardMin = normalizeCount(constArrayUserOptions.shardMinLength, 6, { min: 2, max: 2048 });
  const constArrayOpaque = constArrayUserOptions.opaque !== false;
  const constArrayEncoding = typeof constArrayUserOptions.encoding === "string"
    ? constArrayUserOptions.encoding.toLowerCase()
    : "base64";
  const padFooterBlocks = normalizeCount(
    padFooterUserOptions.blocks ?? userOptions.padFooterBlocks,
    2,
    { min: 1, max: 8 }
  );
  const userVmEnabled = typeof userOptions.vm === "boolean"
    ? userOptions.vm
    : Boolean(userOptions.vm && userOptions.vm.enabled);
  const cffEnabledByDefault = userOptions.cff ?? preset.cff;
  const vmLikeFlow = lang === "luau" && (userVmEnabled || (cffEnabledByDefault && effectiveCffMode === "vm"));
  const constArrayPerScopeDefault = !vmLikeFlow;

  const isLuauHighPreset = lang === "luau" && presetName === "high";
  const compactDefault = lang === "luau"
    ? (userOptions.compact ?? true)
    : Boolean(userOptions.compact);
  const defaultStringMinLength = lang === "luau" ? 1 : scheme.stringMinLength;
  const schemeVmDefaults = lang === "js" && scheme.vm ? scheme.vm : null;
  const hasUserVm = hasOwn(userOptions, "vm") && userOptions.vm !== undefined;
  let vmInput = hasUserVm
    ? userOptions.vm
    : (schemeVmDefaults || { enabled: preset.vm });
  if (
    schemeVmDefaults &&
    vmInput &&
    typeof vmInput === "object" &&
    !Array.isArray(vmInput)
  ) {
    vmInput = { ...schemeVmDefaults, ...vmInput };
  }
  const options = {
    preset: presetName,
    scheme: schemeName,
    lang: lang === "luau" ? "luau" : "js",
    luauParser: "custom",
    rename: userOptions.rename ?? preset.rename,
    strings: userOptions.strings ?? preset.strings,
    cff: userOptions.cff ?? preset.cff,
    dead: userOptions.dead ?? preset.dead,
    vm: vmInput,
    wrap: userOptions.wrap ?? wrapUserOptions.enabled ?? false,
    wrapOptions: {
      iterations: wrapIterations,
    },
    proxifyLocals: userOptions.proxifyLocals ?? false,
    numbers: userOptions.numbers ?? isLuauHighPreset,
    numbersOptions: {
      probability: normalizeProbability(numbersUserOptions.probability, 1),
      innerProbability: normalizeProbability(numbersUserOptions.innerProbability, 0.2),
      maxDepth: numbersMaxDepth,
      range: numbersRange,
    },
    constArray: userOptions.constArray ?? false,
    constArrayOptions: {
      probability: normalizeProbability(constArrayUserOptions.probability, 1),
      stringsOnly: constArrayUserOptions.stringsOnly ?? false,
      shuffle: constArrayUserOptions.shuffle !== false,
      rotate: constArrayUserOptions.rotate !== false,
      minLength: constArrayMinLength,
      encoding: constArrayEncoding === "base64" ? "base64" : "none",
      wrapper: constArrayUserOptions.wrapper !== false,
      shards: constArrayShards,
      shardMinLength: constArrayShardMin,
      perScope: constArrayUserOptions.perScope ?? constArrayPerScopeDefault,
      wipe: constArrayUserOptions.wipe !== false,
      opaque: constArrayOpaque,
    },
    padFooter: userOptions.padFooter ?? false,
    padFooterOptions: {
      blocks: padFooterBlocks,
    },
    seed: userOptions.seed,
    filename: userOptions.filename ?? "input.js",
    sourceMap: Boolean(userOptions.sourceMap),
    compact: compactDefault,
    minify: userOptions.minify !== false,
    beautify: Boolean(userOptions.beautify),
    timing: userOptions.timing === true,
    ecma,
    luauStyle,
    stringsOptions: {
      minLength: stringsUserOptions.minLength ?? defaultStringMinLength,
      maxCount,
      segmentSize,
      sampleRate: normalizeProbability(stringsUserOptions.sampleRate, scheme.stringSampleRate),
      split: Boolean(stringsUserOptions.split),
      splitMin,
      splitMaxParts,
      encodeValueFallback: stringsUserOptions.encodeValueFallback !== false,
      poolEncoding: stringsPoolEncoding,
      encodeConsole: stringsUserOptions.encodeConsole !== false,
      encodeObjectKeys: stringsUserOptions.encodeObjectKeys !== false,
      encodeJSXAttributes: stringsUserOptions.encodeJSXAttributes !== false,
      encodeTemplateChunks: stringsUserOptions.encodeTemplateChunks !== false,
    },
    renameOptions: {
      reserved: userOptions.reserved ?? DEFAULT_RESERVED,
      renameGlobals: renameUserOptions.renameGlobals ?? userOptions.renameGlobals ?? false,
      renameMembers: renameUserOptions.renameMembers ?? userOptions.renameMembers ?? false,
      homoglyphs: renameUserOptions.homoglyphs ?? userOptions.homoglyphs ?? false,
      maskGlobals: renameUserOptions.maskGlobals ?? userOptions.maskGlobals ?? (lang === "luau"),
      preserveTopReturnNames: renameUserOptions.preserveTopReturnNames ?? userOptions.preserveTopReturnNames ?? true,
    },
    deadCodeOptions: {
      probability: normalizeProbability(
        userOptions.deadCodeOptions && userOptions.deadCodeOptions.probability,
        scheme.deadProbability
      ),
    },
    cffOptions: {
      minStatements: 3,
      downlevel: cffUserOptions.downlevel ?? Boolean(userOptions.cffDownlevel),
      mode: effectiveCffMode,
      opaque: cffUserOptions.opaque !== false,
      hideTopReturnExpr: Boolean(cffUserOptions.hideTopReturnExpr ?? userOptions.cffHideTopReturnExpr),
    },
    antiHook: {
      enabled: false,
      lock: false,
    },
    debugLuauTransforms: {
      enabled: Boolean(debugUserOptions.enabled),
      passes: Array.isArray(debugUserOptions.passes) ? debugUserOptions.passes.slice() : [],
      outputDir: typeof debugUserOptions.outputDir === "string"
        ? debugUserOptions.outputDir
        : "dist/.luau-debug",
      includeAst: debugUserOptions.includeAst !== false,
      includeChanges: debugUserOptions.includeChanges !== false,
      includeTrace: debugUserOptions.includeTrace !== false,
    },
  };

  if (typeof antiHookUserOptions === "boolean") {
    options.antiHook.enabled = antiHookUserOptions;
  } else if (antiHookUserOptions && typeof antiHookUserOptions === "object") {
    options.antiHook.enabled = antiHookUserOptions.enabled !== false;
    options.antiHook.lock = Boolean(antiHookUserOptions.lock);
  }

  if (typeof options.vm === "boolean") {
    options.vm = { enabled: options.vm };
  }
  const vmOptions = options.vm || {};
  const cffEnabled = options.cff !== false;
  const vmCffEnabled = lang === "luau" && cffEnabled && options.cffOptions.mode === "vm";
  const luauVmFeatureDefaults = lang === "luau" && (Boolean(vmOptions.enabled) || vmCffEnabled);
  const vmLayers = normalizeCount(vmOptions.layers, 1, { min: 1, max: 3 });
  const vmRuntimeKey = vmOptions.runtimeKey !== false;
  const vmRuntimeSplit = vmOptions.runtimeSplit !== false;
  const vmMode = typeof vmOptions.mode === "string"
    ? vmOptions.mode.toLowerCase()
    : null;
  const normalizedVmMode = vmMode === "compact" || vmMode === "balanced" || vmMode === "max"
    ? vmMode
    : (lang === "luau" && (Boolean(vmOptions.enabled) || vmCffEnabled) ? "compact" : "max");
  const vmOpcodeEncoding = typeof vmOptions.opcodeEncoding === "string"
    ? vmOptions.opcodeEncoding.toLowerCase()
    : "mask";
  const vmConstsEncoding = typeof vmOptions.constsEncoding === "string"
    ? vmOptions.constsEncoding.toLowerCase()
    : "table";
  const vmCompactDefaults = {
    fakeOpcodes: 0,
    constsSplit: false,
    decoyRuntime: false,
    symbolNoise: false,
    instructionFusion: false,
    semanticMisdirection: false,
    dynamicCoupling: false,
    blockDispatch: false,
  };
  const vmBalancedDefaults = {
    fakeOpcodes: 0,
    constsSplit: false,
    decoyRuntime: false,
    symbolNoise: false,
    instructionFusion: true,
    semanticMisdirection: false,
    dynamicCoupling: false,
    blockDispatch: true,
  };
  const vmMaxDefaults = {
    fakeOpcodes: 0.15,
    constsSplit: true,
    decoyRuntime: true,
    symbolNoise: true,
    instructionFusion: true,
    semanticMisdirection: true,
    dynamicCoupling: true,
    blockDispatch: true,
  };
  const vmModeDefaults = normalizedVmMode === "compact"
    ? vmCompactDefaults
    : normalizedVmMode === "balanced"
      ? vmBalancedDefaults
      : vmMaxDefaults;
  const vmConstsSplit = hasOwn(vmOptions, "constsSplit")
    ? vmOptions.constsSplit !== false
    : vmModeDefaults.constsSplit;
  const vmConstsSplitSize = normalizeCount(vmOptions.constsSplitSize, 24, { min: 4, max: 200 });
  const vmBlockDispatch = hasOwn(vmOptions, "blockDispatch")
    ? vmOptions.blockDispatch
    : vmModeDefaults.blockDispatch;
  const vmDispatchGraph = typeof vmOptions.dispatchGraph === "string"
    ? vmOptions.dispatchGraph.toLowerCase()
    : null;
  const vmStackProtocol = typeof vmOptions.stackProtocol === "string"
    ? vmOptions.stackProtocol.toLowerCase()
    : null;
  const vmIsaPolymorph = vmOptions.isaPolymorph;
  const vmFakeEdges = vmOptions.fakeEdges;
  const vmNumericStyle = typeof vmOptions.numericStyle === "string"
    ? vmOptions.numericStyle.toLowerCase()
    : null;
  const vmDecoyRuntime = vmOptions.decoyRuntime;
  const vmDecoyProbability = normalizeProbability(vmOptions.decoyProbability, 0.85);
  const vmDecoyStrings = normalizeCount(vmOptions.decoyStrings, 12, { min: 4, max: 96 });
  const vmSymbolNoise = vmOptions.symbolNoise;
  const vmInstructionFusion = vmOptions.instructionFusion;
  const vmSemanticMisdirection = vmOptions.semanticMisdirection;
  const vmDynamicCoupling = vmOptions.dynamicCoupling;
  const vmShellStyle = typeof vmOptions.shellStyle === "string"
    ? vmOptions.shellStyle.toLowerCase()
    : null;
  const vmExplicitScope = {
    include: Array.isArray(vmOptions.include),
    all: vmOptions.all !== undefined,
    topLevel: vmOptions.topLevel !== undefined,
  };
  let fakeOpcodes = vmOptions.fakeOpcodes;
  if (fakeOpcodes === undefined || fakeOpcodes === true) {
    fakeOpcodes = vmModeDefaults.fakeOpcodes;
  } else if (fakeOpcodes === false) {
    fakeOpcodes = 0;
  } else {
    fakeOpcodes = Number(fakeOpcodes);
    if (Number.isNaN(fakeOpcodes)) {
      fakeOpcodes = vmModeDefaults.fakeOpcodes;
    }
  }
  fakeOpcodes = Math.max(0, Math.min(1, fakeOpcodes));
  let vmAll = vmOptions.all === undefined
    ? (lang === "js" && Boolean(vmOptions.enabled) && (!Array.isArray(vmOptions.include) || vmOptions.include.length === 0))
    : Boolean(vmOptions.all);
  let vmTopLevel = Boolean(vmOptions.topLevel);

  if (
    lang === "luau" &&
    Boolean(vmOptions.enabled) &&
    vmShellStyle === "packed" &&
    !vmExplicitScope.include &&
    !vmExplicitScope.all &&
    !vmExplicitScope.topLevel
  ) {
    vmAll = true;
    vmTopLevel = true;
  }

  options.vm = {
    enabled: Boolean(vmOptions.enabled),
    include: vmOptions.include || [],
    all: vmAll,
    layers: vmLayers,
    topLevel: vmTopLevel,
    shellStyle: vmShellStyle,
    explicitScope: vmExplicitScope,
    mode: normalizedVmMode,
    opcodeEncoding: vmOpcodeEncoding === "pairs" ? "pairs" : "mask",
    opcodeShuffle: vmOptions.opcodeShuffle !== false,
    runtimeKey: vmRuntimeKey,
    runtimeSplit: vmRuntimeSplit,
    fakeOpcodes,
    bytecodeEncrypt: vmOptions.bytecodeEncrypt !== false,
    constsEncrypt: vmOptions.constsEncrypt !== false,
    constsEncoding: vmConstsEncoding === "table" ? "table" : "string",
    constsSplit: Boolean(vmConstsSplit),
    constsSplitSize: vmConstsSplitSize,
    blockDispatch: Boolean(vmBlockDispatch),
    dispatchGraph: vmDispatchGraph || "tree",
    stackProtocol: vmStackProtocol || "auto",
    isaPolymorph: vmIsaPolymorph === undefined ? false : vmIsaPolymorph,
    fakeEdges: vmFakeEdges === undefined ? false : Boolean(vmFakeEdges),
    numericStyle: vmNumericStyle || (lang === "luau" && Boolean(vmOptions.enabled) ? "mixed" : "plain"),
    decoyRuntime: vmDecoyRuntime === undefined ? vmModeDefaults.decoyRuntime : Boolean(vmDecoyRuntime),
    decoyProbability: vmDecoyProbability,
    decoyStrings: vmDecoyStrings,
    symbolNoise: vmSymbolNoise === undefined ? vmModeDefaults.symbolNoise : Boolean(vmSymbolNoise),
    instructionFusion: vmInstructionFusion === undefined
      ? vmModeDefaults.instructionFusion
      : Boolean(vmInstructionFusion),
    semanticMisdirection: vmSemanticMisdirection === undefined
      ? vmModeDefaults.semanticMisdirection
      : Boolean(vmSemanticMisdirection),
    dynamicCoupling: vmDynamicCoupling === undefined
      ? vmModeDefaults.dynamicCoupling
      : Boolean(vmDynamicCoupling),
    downlevel: Boolean(vmOptions.downlevel),
    sandbox: vmOptions.sandbox !== false,
    debug: Boolean(vmOptions.debug),
  };

  return options;
}

module.exports = {
  normalizeOptions,
  PRESETS,
};
