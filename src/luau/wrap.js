const { collectIdentifierNames, makeShortNameFactory } = require("./names");

function identifier(name) {
  return { type: "Identifier", name };
}

function functionName(name) {
  return {
    type: "FunctionName",
    base: identifier(name),
    members: [],
    method: null,
  };
}

function buildFunctionDeclaration(name, body, isCustom) {
  if (isCustom) {
    const node = {
      type: "FunctionDeclaration",
      name: functionName(name),
      parameters: [],
      hasVararg: false,
      varargAnnotation: null,
      returnType: null,
      typeParameters: [],
      isLocal: true,
      body: { type: "Block", body },
    };
    node.__obf_skip_vm = true;
    return node;
  }
  const node = {
    type: "FunctionDeclaration",
    identifier: identifier(name),
    parameters: [],
    isLocal: true,
    body,
  };
  node.__obf_skip_vm = true;
  return node;
}

function buildReturnCall(name) {
  return {
    type: "ReturnStatement",
    arguments: [
      {
        type: "CallExpression",
        base: identifier(name),
        arguments: [],
      },
    ],
  };
}

function wrapOnce(ast, nameGen, isCustom) {
  if (!ast || !Array.isArray(ast.body)) {
    return;
  }
  const name = nameGen();
  const originalBody = ast.body;
  const fn = buildFunctionDeclaration(name, originalBody, isCustom);
  const returnCall = buildReturnCall(name);
  ast.body = [fn, returnCall];
}

function wrapInFunction(ast, ctx) {
  if (!ctx.options.wrap) {
    return;
  }
  const iterations = ctx.options.wrapOptions?.iterations ?? 1;
  if (!Number.isFinite(iterations) || iterations < 1) {
    return;
  }
  const used = collectIdentifierNames(ast, ctx);
  const nameGen = makeShortNameFactory(ctx.rng, used);
  const isCustom = !ctx.options || ctx.options.luauParser !== "luaparse";
  for (let i = 0; i < iterations; i += 1) {
    wrapOnce(ast, nameGen, isCustom);
  }
}

module.exports = {
  wrapInFunction,
};
