function buildCliArgs(options = {}) {
  const args = [];

  if (options.preset) {
    args.push("--preset", String(options.preset));
  }
  if (options.scheme || options.jsScheme) {
    args.push("--scheme", String(options.scheme || options.jsScheme));
  }
  if (options.lang) {
    args.push("--lang", String(options.lang));
  }
  if (options.luauStyle) {
    args.push("--luau-style", String(options.luauStyle));
  }
  if (options.rename === false) {
    args.push("--no-rename");
  }
  if (options.renameOptions) {
    if (options.renameOptions.renameGlobals === true) {
      args.push("--rename-globals");
    } else if (options.renameOptions.renameGlobals === false) {
      args.push("--no-rename-globals");
    }
    if (options.renameOptions.renameMembers === true) {
      args.push("--rename-members");
    } else if (options.renameOptions.renameMembers === false) {
      args.push("--no-rename-members");
    }
    if (options.renameOptions.homoglyphs === true) {
      args.push("--rename-homoglyphs");
    } else if (options.renameOptions.homoglyphs === false) {
      args.push("--no-rename-homoglyphs");
    }
    if (options.renameOptions.maskGlobals === true) {
      args.push("--mask-globals");
    } else if (options.renameOptions.maskGlobals === false) {
      args.push("--no-mask-globals");
    }
  }
  if (options.strings === false) {
    args.push("--no-strings");
  }

  const stringsOptions = options.stringsOptions || {};
  if (stringsOptions.split === true) {
    args.push("--strings-split");
  } else if (stringsOptions.split === false) {
    args.push("--no-strings-split");
  }
  if (stringsOptions.splitMin !== undefined && stringsOptions.splitMin !== null) {
    args.push("--strings-split-min", String(stringsOptions.splitMin));
  }
  if (stringsOptions.splitMaxParts !== undefined && stringsOptions.splitMaxParts !== null) {
    args.push("--strings-split-max-parts", String(stringsOptions.splitMaxParts));
  }
  if (stringsOptions.segmentSize !== undefined && stringsOptions.segmentSize !== null) {
    args.push("--strings-segment-size", String(stringsOptions.segmentSize));
  }
  if (stringsOptions.encodeValueFallback === false) {
    args.push("--no-strings-value-fallback");
  } else if (stringsOptions.encodeValueFallback === true) {
    args.push("--strings-value-fallback");
  }
  if (stringsOptions.encodeObjectKeys === false) {
    args.push("--no-strings-object-keys");
  } else if (stringsOptions.encodeObjectKeys === true) {
    args.push("--strings-object-keys");
  }
  if (stringsOptions.encodeJSXAttributes === false) {
    args.push("--no-strings-jsx-attrs");
  } else if (stringsOptions.encodeJSXAttributes === true) {
    args.push("--strings-jsx-attrs");
  }
  if (stringsOptions.encodeTemplateChunks === false) {
    args.push("--no-strings-template-chunks");
  } else if (stringsOptions.encodeTemplateChunks === true) {
    args.push("--strings-template-chunks");
  }
  if (options.wrap) {
    args.push("--wrap");
  }
  if (options.wrapOptions && options.wrapOptions.iterations) {
    args.push("--wrap-iterations", String(options.wrapOptions.iterations));
  }
  if (options.proxifyLocals) {
    args.push("--proxify-locals");
  } else if (options.proxifyLocals === false) {
    args.push("--no-proxify-locals");
  }
  if (options.numbers === true) {
    args.push("--numbers-expr");
  } else if (options.numbers === false) {
    args.push("--no-numbers-expr");
  }
  if (options.numbersOptions) {
    if (options.numbersOptions.probability !== undefined && options.numbersOptions.probability !== null) {
      args.push("--numbers-expr-threshold", String(options.numbersOptions.probability));
    }
    if (options.numbersOptions.innerProbability !== undefined && options.numbersOptions.innerProbability !== null) {
      args.push("--numbers-expr-inner", String(options.numbersOptions.innerProbability));
    }
    if (options.numbersOptions.maxDepth !== undefined && options.numbersOptions.maxDepth !== null) {
      args.push("--numbers-expr-max-depth", String(options.numbersOptions.maxDepth));
    }
  }
  if (options.constArray === true) {
    args.push("--const-array");
  } else if (options.constArray === false) {
    args.push("--no-const-array");
  }
  if (options.constArrayOptions) {
    if (options.constArrayOptions.probability !== undefined && options.constArrayOptions.probability !== null) {
      args.push("--const-array-threshold", String(options.constArrayOptions.probability));
    }
    if (options.constArrayOptions.stringsOnly === true) {
      args.push("--const-array-strings-only");
    } else if (options.constArrayOptions.stringsOnly === false) {
      args.push("--no-const-array-strings-only");
    }
    if (options.constArrayOptions.shuffle === true) {
      args.push("--const-array-shuffle");
    } else if (options.constArrayOptions.shuffle === false) {
      args.push("--no-const-array-shuffle");
    }
    if (options.constArrayOptions.rotate === true) {
      args.push("--const-array-rotate");
    } else if (options.constArrayOptions.rotate === false) {
      args.push("--no-const-array-rotate");
    }
    if (options.constArrayOptions.encoding) {
      args.push("--const-array-encoding", String(options.constArrayOptions.encoding));
    }
    if (options.constArrayOptions.wrapper === true) {
      args.push("--const-array-wrapper");
    } else if (options.constArrayOptions.wrapper === false) {
      args.push("--no-const-array-wrapper");
    }
  }
  if (options.padFooter === true) {
    args.push("--pad-footer");
  } else if (options.padFooter === false) {
    args.push("--no-pad-footer");
  }
  if (options.padFooterOptions && options.padFooterOptions.blocks !== undefined && options.padFooterOptions.blocks !== null) {
    args.push("--pad-footer-blocks", String(options.padFooterOptions.blocks));
  }

  if (options.cff === false) {
    args.push("--no-cff");
  }
  const cffOptions = options.cffOptions || {};
  if (cffOptions.downlevel) {
    args.push("--cff-downlevel");
  }
  if (cffOptions.mode) {
    args.push("--cff-mode", String(cffOptions.mode));
  }
  if (cffOptions.opaque === true) {
    args.push("--cff-opaque");
  } else if (cffOptions.opaque === false) {
    args.push("--no-cff-opaque");
  }
  if (cffOptions.hideTopReturnExpr === true) {
    args.push("--cff-hide-top-return-expr");
  }
  if (options.dead === false) {
    args.push("--no-dead");
  }

  const vm = options.vm || {};
  if (vm.enabled) {
    args.push("--vm");
  }
  if (vm.mode) {
    args.push("--vm-mode", String(vm.mode));
  }
  if (vm.opcodeEncoding) {
    args.push("--vm-opcode-encoding", String(vm.opcodeEncoding));
  }
  if (vm.layers !== undefined && vm.layers !== null) {
    args.push("--vm-layers", String(vm.layers));
  }
  if (vm.topLevel === true) {
    args.push("--vm-top-level");
  } else if (vm.topLevel === false) {
    args.push("--no-vm-top-level");
  }
  if (vm.shellStyle) {
    args.push("--vm-shell-style", String(vm.shellStyle));
  }
  if (Array.isArray(vm.include) && vm.include.length > 0) {
    args.push("--vm-include", vm.include.join(","));
  }
  if (vm.opcodeShuffle === false) {
    args.push("--no-vm-opcode-shuffle");
  } else if (vm.opcodeShuffle === true) {
    args.push("--vm-opcode-shuffle");
  }
  if (vm.fakeOpcodes !== undefined && vm.fakeOpcodes !== null && vm.fakeOpcodes !== "") {
    args.push("--vm-fake-opcodes", String(vm.fakeOpcodes));
  }
  if (vm.bytecodeEncrypt === false) {
    args.push("--no-vm-bytecode");
  } else if (vm.bytecodeEncrypt === true) {
    args.push("--vm-bytecode");
  }
  if (vm.constsEncrypt === false) {
    args.push("--no-vm-consts");
  } else if (vm.constsEncrypt === true) {
    args.push("--vm-consts");
  }
  if (vm.constsSplit === false) {
    args.push("--no-vm-consts-split");
  } else if (vm.constsSplit === true) {
    args.push("--vm-consts-split");
  }
  if (vm.constsSplitSize !== undefined && vm.constsSplitSize !== null && vm.constsSplitSize !== "") {
    args.push("--vm-consts-split-size", String(vm.constsSplitSize));
  }
  if (vm.constsEncoding) {
    args.push("--vm-consts-encoding", String(vm.constsEncoding));
  }
  if (vm.runtimeKey === false) {
    args.push("--no-vm-runtime-key");
  } else if (vm.runtimeKey === true) {
    args.push("--vm-runtime-key");
  }
  if (vm.runtimeSplit === false) {
    args.push("--no-vm-runtime-split");
  } else if (vm.runtimeSplit === true) {
    args.push("--vm-runtime-split");
  }
  if (vm.decoyRuntime === false) {
    args.push("--no-vm-decoy-runtime");
  } else if (vm.decoyRuntime === true) {
    args.push("--vm-decoy-runtime");
  }
  if (vm.decoyProbability !== undefined && vm.decoyProbability !== null && vm.decoyProbability !== "") {
    args.push("--vm-decoy-probability", String(vm.decoyProbability));
  }
  if (vm.decoyStrings !== undefined && vm.decoyStrings !== null && vm.decoyStrings !== "") {
    args.push("--vm-decoy-strings", String(vm.decoyStrings));
  }
  if (vm.symbolNoise === false) {
    args.push("--no-vm-symbol-noise");
  } else if (vm.symbolNoise === true) {
    args.push("--vm-symbol-noise");
  }
  if (vm.instructionFusion === false) {
    args.push("--no-vm-instruction-fusion");
  } else if (vm.instructionFusion === true) {
    args.push("--vm-instruction-fusion");
  }
  if (vm.semanticMisdirection === false) {
    args.push("--no-vm-semantic-misdirection");
  } else if (vm.semanticMisdirection === true) {
    args.push("--vm-semantic-misdirection");
  }
  if (vm.dynamicCoupling === false) {
    args.push("--no-vm-dynamic-coupling");
  } else if (vm.dynamicCoupling === true) {
    args.push("--vm-dynamic-coupling");
  }
  if (vm.dispatchGraph) {
    args.push("--vm-dispatch-graph", String(vm.dispatchGraph));
  }
  if (vm.stackProtocol) {
    args.push("--vm-stack-protocol", String(vm.stackProtocol));
  }
  if (vm.isaPolymorph === true) {
    args.push("--vm-isa-polymorph");
  } else if (vm.isaPolymorph === false) {
    args.push("--no-vm-isa-polymorph");
  }
  if (vm.fakeEdges === true) {
    args.push("--vm-fake-edges");
  } else if (vm.fakeEdges === false) {
    args.push("--no-vm-fake-edges");
  }
  if (vm.blockDispatch === true) {
    args.push("--vm-block-dispatch");
  } else if (vm.blockDispatch === false) {
    args.push("--no-vm-block-dispatch");
  }
  if (vm.numericStyle) {
    args.push("--vm-numeric-style", String(vm.numericStyle));
  }
  if (vm.downlevel) {
    args.push("--vm-downlevel");
  }
  if (vm.debug) {
    args.push("--vm-debug");
  }

  if (options.antiHook && options.antiHook.lock) {
    args.push("--anti-hook-lock");
  } else if (options.antiHook && options.antiHook.enabled) {
    args.push("--anti-hook");
  }

  if (options.seed) {
    args.push("--seed", String(options.seed));
  }
  if (options.ecma !== undefined && options.ecma !== null && options.ecma !== "") {
    args.push("--ecma", String(options.ecma));
  }
  if (options.sourceMap) {
    args.push("--sourcemap");
  }
  if (options.minify === false) {
    args.push("--no-minify");
  }
  if (options.beautify && options.minify !== false) {
    args.push("--beautify");
  }
  if (options.compact) {
    args.push("--compact");
  }
  if (options.timing === true) {
    args.push("--timing");
  } else if (options.timing === false) {
    args.push("--no-timing");
  }

  return args;
}

module.exports = {
  buildCliArgs,
};
