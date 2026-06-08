const { OPCODES } = require("./constants");
const { buildOpcodeMapping } = require("./mapping");
const {
  encodeBytecode,
  encodeConstPool,
  encodeOpcodeTable,
} = require("./encoding");
const parser = require("@babel/parser");
const { buildVmRuntimeSource } = require("./runtime");
const { VmCompiler } = require("./compiler");
const { makeLiteral } = require("./ast-utils");
const {
  canVirtualize,
  collectLocals,
  normalizeFunction,
  rewriteClosureRefs,
} = require("./normalize");
const { compileStatement } = require("./emit");

function createMiniVmInfo(rng) {
  const pool = Array.from({ length: 256 }, (_, i) => i);
  rng.shuffle(pool);
  const mask = rng.int(1, 255);
  const ops = pool.slice(0, 4).map((value) => value ^ mask);
  return { mask, ops };
}

function buildMiniVmProgram(ops, blocks) {
  const [opPush, opRebuild, opToStr, opStore] = ops;
  const program = [];
  for (const block of blocks) {
    for (const idx of block.pool) {
      program.push(opPush, idx);
    }
    program.push(opRebuild);
    if (block.toString === true) {
      program.push(opToStr);
    }
    program.push(opStore, block.store);
  }
  return program;
}

function splitBytes(bytes, rng, count) {
  const total = bytes.length;
  if (total === 0) {
    return [{ chunk: [], offset: 0 }];
  }
  const chunks = [];
  let offset = 0;
  const chunkCount = Math.max(1, Math.min(count, total));
  for (let i = 0; i < chunkCount; i += 1) {
    const remaining = total - offset;
    const remainingChunks = chunkCount - i;
    const minSize = Math.max(1, remaining - (remainingChunks - 1));
    const size = i === chunkCount - 1 ? remaining : rng.int(1, minSize);
    chunks.push({ chunk: bytes.slice(offset, offset + size), offset });
    offset += size;
  }
  return chunks;
}

function encodeRuntimeSource(source, rng) {
  const bytes = Buffer.from(source, "utf8");
  const keyLen = rng.int(6, 14);
  const key = Array.from({ length: keyLen }, () => rng.int(1, 255));
  const chunkCount = Math.min(Math.max(2, rng.int(2, 6)), Math.max(2, bytes.length));
  const splits = splitBytes(bytes, rng, chunkCount);
  const parts = [];
  const offsets = [];
  for (const entry of splits) {
    const out = new Array(entry.chunk.length);
    for (let i = 0; i < entry.chunk.length; i += 1) {
      const idx = entry.offset + i;
      out[i] = entry.chunk[i] ^ key[idx % key.length];
    }
    parts.push(out);
    offsets.push(entry.offset);
  }
  const order = Array.from({ length: parts.length }, (_, i) => i);
  rng.shuffle(order);
  return {
    parts,
    offsets,
    order,
    key,
    total: bytes.length,
  };
}

function shouldVirtualize(fnPath, options) {
  if (options.all) {
    return true;
  }
  const name = fnPath.node.id ? fnPath.node.id.name : null;
  if (name && options.include && options.include.includes(name)) {
    return true;
  }
  const comments = fnPath.node.leadingComments || [];
  return comments.some((c) => c.value.includes("@vm"));
}

function getSuperInfo(fnPath) {
  if (fnPath.isClassMethod && fnPath.isClassMethod()) {
    return {
      mode: fnPath.node.static ? "static" : "instance",
      kind: fnPath.node.kind || "method",
    };
  }
  if (fnPath.isClassPrivateMethod && fnPath.isClassPrivateMethod()) {
    return {
      mode: fnPath.node.static ? "static" : "instance",
      kind: fnPath.node.kind || "method",
    };
  }
  if (fnPath.isObjectMethod && fnPath.isObjectMethod()) {
    return {
      mode: "object",
      kind: "method",
    };
  }
  return null;
}

function createRuntimeBundle(ctx) {
  if (ctx.state.vmRuntimeBundle) {
    return ctx.state.vmRuntimeBundle;
  }
  const execName = ctx.nameGen.next();
  const execAsyncName = ctx.nameGen.next();
  const opsName = ctx.nameGen.next();
  const opsLookupName = ctx.nameGen.next();
  const globalsName = ctx.nameGen.next();
  const makeFuncName = ctx.nameGen.next();
  const maskName = ctx.nameGen.next();
  const opcodeB64Name = ctx.nameGen.next();
  const opcodeStreamName = ctx.nameGen.next();
  const miniVmName = ctx.nameGen.next();
  const bytecodeEnabled = ctx.options.vm.bytecodeEncrypt !== false;
  const bytecodeDecodeName = bytecodeEnabled ? ctx.nameGen.next() : null;
  const bytecodeCacheName = bytecodeEnabled ? ctx.nameGen.next() : null;
  const bytecodeB64Name = bytecodeEnabled ? ctx.nameGen.next() : null;
  const bytecodeRc4Name = bytecodeEnabled ? ctx.nameGen.next() : null;
  const constsEnabled = ctx.options.vm.constsEncrypt !== false;
  const constDecodeName = constsEnabled ? ctx.nameGen.next() : null;
  const constCacheName = constsEnabled ? ctx.nameGen.next() : null;
  const constB64Name = constsEnabled ? ctx.nameGen.next() : null;
  const constRc4Name = constsEnabled ? ctx.nameGen.next() : null;
  const constUtf8Name = constsEnabled ? ctx.nameGen.next() : null;

  const opcodeMapping = buildOpcodeMapping(ctx);
  const opcodeInfo = encodeOpcodeTable(opcodeMapping.decode, ctx.rng);
  const miniVmInfo = createMiniVmInfo(ctx.rng);
  const miniVmPrograms = {
    opcode: buildMiniVmProgram(miniVmInfo.ops, [
      { pool: [0, 1, 2, 3], toString: true, store: 0 },
      { pool: [4, 5, 6, 7], store: 1 },
      { pool: [8, 9, 10, 11], store: 2 },
      { pool: [12, 13, 14, 15], store: 3 },
      { pool: [16, 17, 18, 19], store: 4 },
    ]),
    bytecode: buildMiniVmProgram(miniVmInfo.ops, [
      { pool: [0, 1, 2, 3], toString: true, store: 0 },
      { pool: [4, 5, 6, 7], store: 1 },
      { pool: [8, 9, 10, 11], store: 2 },
    ]),
    consts: buildMiniVmProgram(miniVmInfo.ops, [
      { pool: [0, 1, 2, 3], toString: true, store: 0 },
      { pool: [4, 5, 6, 7], store: 1 },
      { pool: [8, 9, 10, 11], store: 2 },
      { pool: [12, 13, 14, 15], store: 3 },
    ]),
  };

  const runtimeSource = buildVmRuntimeSource(
    {
      execName,
      execAsyncName,
      opsName,
      opsLookupName,
      globalsName,
      makeFuncName,
      maskName,
      opcodeB64Name,
      opcodeStreamName,
      miniVmName,
      bytecodeDecodeName,
      bytecodeCacheName,
      bytecodeB64Name,
      bytecodeRc4Name,
      constDecodeName,
      constCacheName,
      constB64Name,
      constRc4Name,
      constUtf8Name,
    },
    opcodeInfo,
    opcodeMapping.mask,
    miniVmInfo,
    miniVmPrograms
  );

  const exportProps = {
    exec: ctx.nameGen.next(),
    execAsync: ctx.nameGen.next(),
  };
  if (bytecodeEnabled) {
    exportProps.bytecodeDecode = ctx.nameGen.next();
  }
  if (constsEnabled) {
    exportProps.constDecode = ctx.nameGen.next();
  }

  const exports = [
    `"${exportProps.exec}": ${execName}`,
    `"${exportProps.execAsync}": ${execAsyncName}`,
  ];
  if (bytecodeEnabled) {
    exports.push(`"${exportProps.bytecodeDecode}": ${bytecodeDecodeName}`);
  }
  if (constsEnabled) {
    exports.push(`"${exportProps.constDecode}": ${constDecodeName}`);
  }

  const wrappedSource = `${runtimeSource}\nreturn { ${exports.join(", ")} };`;
  const cacheKey = ctx.nameGen.next();
  const bundle = {
    runtimeSource: wrappedSource,
    cacheKey,
    props: exportProps,
  };
  ctx.state.vmRuntimeBundle = bundle;
  return bundle;
}

function buildInlineRuntime(ctx, runtimeSource, cacheKey) {
  const runtimeId = ctx.nameGen.next();
  const partsId = ctx.nameGen.next();
  const orderId = ctx.nameGen.next();
  const offsetsId = ctx.nameGen.next();
  const keyId = ctx.nameGen.next();
  const totalId = ctx.nameGen.next();
  const bytesId = ctx.nameGen.next();
  const iId = ctx.nameGen.next();
  const jId = ctx.nameGen.next();
  const idxId = ctx.nameGen.next();
  const chunkId = ctx.nameGen.next();
  const offsetId = ctx.nameGen.next();
  const srcId = ctx.nameGen.next();
  const tmpId = ctx.nameGen.next();
  const kId = ctx.nameGen.next();
  const factoryId = ctx.nameGen.next();
  const globalId = ctx.nameGen.next();
  const cachedId = ctx.nameGen.next();
  const cacheKeyId = ctx.nameGen.next();
  const objId = ctx.nameGen.next();

  const encoded = encodeRuntimeSource(runtimeSource, ctx.rng);
  const code = `
const ${runtimeId} = (() => {
  const ${globalId} = typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : typeof global !== "undefined"
        ? global
        : this;
  const ${cacheKeyId} = ${JSON.stringify(cacheKey)};
  const ${cachedId} = ${globalId}[${cacheKeyId}];
  if (${cachedId}) {
    return ${cachedId};
  }
  const ${partsId} = ${JSON.stringify(encoded.parts)};
  const ${orderId} = ${JSON.stringify(encoded.order)};
  const ${offsetsId} = ${JSON.stringify(encoded.offsets)};
  const ${keyId} = ${JSON.stringify(encoded.key)};
  const ${totalId} = ${encoded.total};
  const ${bytesId} = new Uint8Array(${totalId});
  for (let ${iId} = 0; ${iId} < ${orderId}.length; ${iId}++) {
    const ${idxId} = ${orderId}[${iId}];
    const ${chunkId} = ${partsId}[${idxId}];
    const ${offsetId} = ${offsetsId}[${idxId}];
    for (let ${jId} = 0; ${jId} < ${chunkId}.length; ${jId}++) {
      ${bytesId}[${offsetId} + ${jId}] =
        ${chunkId}[${jId}] ^ ${keyId}[(${offsetId} + ${jId}) % ${keyId}.length];
    }
  }
  let ${srcId} = "";
  if (typeof TextDecoder !== "undefined") {
    ${srcId} = new TextDecoder().decode(${bytesId});
  } else if (typeof Buffer !== "undefined") {
    ${srcId} = Buffer.from(${bytesId}).toString("utf8");
  } else {
    let ${tmpId} = "";
    for (let ${kId} = 0; ${kId} < ${bytesId}.length; ${kId}++) {
      ${tmpId} += String.fromCharCode(${bytesId}[${kId}]);
    }
    try {
      ${srcId} = decodeURIComponent(escape(${tmpId}));
    } catch (err) {
      ${srcId} = ${tmpId};
    }
  }
  const ${factoryId} = Function(${srcId});
  const ${objId} = ${factoryId}();
  try {
    Object.defineProperty(${globalId}, ${cacheKeyId}, {
      value: ${objId},
      configurable: true,
    });
  } catch (err) {
    ${globalId}[${cacheKeyId}] = ${objId};
  }
  return ${objId};
})();
`;
  const nodes = parser.parse(code, { sourceType: "script" }).program.body;
  return {
    runtimeId: ctx.t.identifier(runtimeId),
    prelude: nodes,
  };
}

function applyVmToFunction(fnPath, ctx) {
  if (!canVirtualize(fnPath, ctx)) {
    return false;
  }
  if (!normalizeFunction(fnPath, ctx)) {
    return false;
  }

  const envId = ctx.t.identifier(ctx.nameGen.next());
  const envThisKey = ctx.nameGen.next();
  const envArgsKey = ctx.nameGen.next();
  const envNewTargetKey = ctx.nameGen.next();

  rewriteClosureRefs(fnPath, ctx, envId, envThisKey, envArgsKey);

  const locals = collectLocals(fnPath);
  const opcodeMapping = buildOpcodeMapping(ctx);
  const compiler = new VmCompiler(ctx, locals, opcodeMapping);
  const state = {
    ctx,
    locals,
    breakLabel: null,
    continueLabel: null,
    isAsync: fnPath.node.async,
    newTargetKey: envNewTargetKey,
    withStack: [],
    superInfo: getSuperInfo(fnPath),
  };

  for (const stmt of fnPath.node.body.body) {
    if (!compileStatement(stmt, compiler, state)) {
      return false;
    }
  }

  compiler.emit(OPCODES.PUSH_CONST, compiler.addConst(undefined));
  compiler.emit(OPCODES.RETURN);

  const codeId = ctx.t.identifier(ctx.nameGen.next());
  const constId = ctx.t.identifier(ctx.nameGen.next());
  const useBytecodeEncrypt = ctx.options.vm.bytecodeEncrypt !== false;
  const useConstEncrypt = ctx.options.vm.constsEncrypt !== false;
  const makeNumArray = (values) =>
    ctx.t.arrayExpression(values.map((value) => ctx.t.numericLiteral(value)));
  const makeStrArray = (values) =>
    ctx.t.arrayExpression(values.map((value) => ctx.t.stringLiteral(value)));
  const makePool = (values) =>
    ctx.t.arrayExpression(
      values.map((value) =>
        Array.isArray(value)
          ? makeNumArray(value)
          : ctx.t.numericLiteral(value)
      )
    );
  const bundle = createRuntimeBundle(ctx);
  const runtime = buildInlineRuntime(ctx, bundle.runtimeSource, bundle.cacheKey);
  const execCallee = fnPath.node.async
    ? ctx.t.memberExpression(
        runtime.runtimeId,
        ctx.t.stringLiteral(bundle.props.execAsync),
        true
      )
    : ctx.t.memberExpression(
        runtime.runtimeId,
        ctx.t.stringLiteral(bundle.props.exec),
        true
      );
  const bytecodeDecode = bundle.props.bytecodeDecode
    ? ctx.t.memberExpression(
        runtime.runtimeId,
        ctx.t.stringLiteral(bundle.props.bytecodeDecode),
        true
      )
    : null;
  const constDecode = bundle.props.constDecode
    ? ctx.t.memberExpression(
        runtime.runtimeId,
        ctx.t.stringLiteral(bundle.props.constDecode),
        true
      )
    : null;
  let codeInit = ctx.t.arrayExpression(
    compiler.code.map((n) => ctx.t.numericLiteral(n))
  );
  if (useBytecodeEncrypt && bytecodeDecode) {
    const meta = encodeBytecode(compiler.code, ctx.rng);
    const partsExpr = makeStrArray(meta.parts);
    const orderExpr = makeNumArray(meta.order);
    const poolExpr = makePool([
      meta.alphabetMasked,
      meta.alphabetMask,
      meta.alphabetOrder,
      meta.alphabetOrderMask,
      meta.paramMasked,
      meta.paramMask,
      meta.paramOrder,
      meta.paramOrderMask,
      meta.keyMasked,
      meta.keyMask,
      meta.keyOrder,
      meta.keyOrderMask,
    ]);
    codeInit = ctx.t.callExpression(bytecodeDecode, [partsExpr, orderExpr, poolExpr]);
  }
  let constInit = ctx.t.arrayExpression(
    compiler.consts.map((value) => makeLiteral(ctx.t, value))
  );
  if (useConstEncrypt && constDecode) {
    const meta = encodeConstPool(compiler.consts, ctx.rng);
    const payloadExpr = makeStrArray(meta.parts);
    const orderExpr = makeNumArray(meta.order);
    const poolExpr = makePool([
      meta.alphabetMasked,
      meta.alphabetMask,
      meta.alphabetOrder,
      meta.alphabetOrderMask,
      meta.paramMasked,
      meta.paramMask,
      meta.paramOrder,
      meta.paramOrderMask,
      meta.keyMasked,
      meta.keyMask,
      meta.keyOrder,
      meta.keyOrderMask,
      meta.maskMasked,
      meta.maskMask,
      meta.maskOrder,
      meta.maskOrderMask,
    ]);
    constInit = ctx.t.callExpression(constDecode, [payloadExpr, orderExpr, poolExpr]);
  }

  const envProperties = [];
  for (const name of locals) {
    const key = ctx.t.isValidIdentifier(name)
      ? ctx.t.identifier(name)
      : ctx.t.stringLiteral(name);
    const value = fnPath.node.params.some(
      (p) => p.type === "Identifier" && p.name === name
    )
      ? ctx.t.identifier(name)
      : ctx.t.identifier("undefined");
    envProperties.push(ctx.t.objectProperty(key, value));
  }
  envProperties.push(
    ctx.t.objectProperty(
      ctx.t.stringLiteral(envThisKey),
      ctx.t.thisExpression()
    )
  );
  envProperties.push(
    ctx.t.objectProperty(
      ctx.t.stringLiteral(envArgsKey),
      ctx.t.identifier("arguments")
    )
  );
  envProperties.push(
    ctx.t.objectProperty(
      ctx.t.stringLiteral(envNewTargetKey),
      ctx.t.metaProperty(ctx.t.identifier("new"), ctx.t.identifier("target"))
    )
  );

  const newBody = ctx.t.blockStatement([
    ctx.t.variableDeclaration("const", [
      ctx.t.variableDeclarator(codeId, codeInit),
    ]),
    ctx.t.variableDeclaration("const", [
      ctx.t.variableDeclarator(constId, constInit),
    ]),
    ctx.t.variableDeclaration("const", [
      ctx.t.variableDeclarator(envId, ctx.t.objectExpression(envProperties)),
    ]),
    ctx.t.returnStatement(
      ctx.t.callExpression(execCallee, [
        codeId,
        constId,
        envId,
        ctx.t.thisExpression(),
      ])
    ),
  ]);

  fnPath.get("body").replaceWith(
    ctx.t.blockStatement([...runtime.prelude, ...newBody.body])
  );
  return true;
}

function vmPlugin(ast, ctx) {
  const { traverse, options } = ctx;
  traverse(ast, {
    Program(path) {
      path.traverse({
        Function(fnPath) {
          if (!shouldVirtualize(fnPath, options.vm)) {
            return;
          }
          if (applyVmToFunction(fnPath, ctx)) {
            fnPath.skip();
          }
        },
      });
    },
  });
}

module.exports = vmPlugin;
