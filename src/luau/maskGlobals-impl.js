const { insertAtTop, walk } = require("./ast");
const { makeShortNameFactory } = require("./names");
const { getCachedSSAUsedNamesFromRoot } = require("./ssa-utils");

const BASE_RESERVED = new Set(["_ENV", "_G"]);
const NAME_RESERVED = new Set(["_ENV", "_G", "type", "getfenv"]);
const COMMON_MASKED_MEMBER_NAMES = new Set([
  "print",
  "warn",
  "char",
  "byte",
  "concat",
  "pack",
  "unpack",
  "floor",
  "abs",
  "min",
  "max",
  "insert",
  "remove",
  "move",
  "find",
  "sub",
  "gsub",
  "rep",
  "format",
  "match",
  "gmatch",
  "clock",
  "random",
  "randomseed",
]);

function tracePass(ctx, event) {
  if (ctx && typeof ctx.debugTrace === "function") {
    ctx.debugTrace(event);
  }
}

function createScope(parent = null) {
  return { parent, bindings: new Set() };
}

function defineName(scope, name) {
  scope.bindings.add(name);
}

function isDefined(scope, name) {
  let current = scope;
  while (current) {
    if (current.bindings.has(name)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function stringLiteral(value, ctx) {
  const raw = JSON.stringify(value);
  if (ctx && ctx.factory && typeof ctx.factory.makeStringLiteral === "function") {
    return ctx.factory.makeStringLiteral(raw, value);
  }
  return { type: "StringLiteral", value, raw };
}

function escapedByteStringLiteral(value, ctx) {
  const bytes = Array.from(Buffer.from(String(value), "utf8"));
  const raw = `"${bytes.map((byte) => `\\${String(byte).padStart(3, "0")}`).join("")}"`;
  if (ctx && ctx.factory && typeof ctx.factory.makeStringLiteral === "function") {
    return ctx.factory.makeStringLiteral(raw, value);
  }
  return { type: "StringLiteral", value, raw };
}

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
  walk(ast, (node) => {
    if (node && node.type === "Identifier" && typeof node.name === "string") {
      used.add(node.name);
    }
  });
  return used;
}

function envIndex(name, envAlias, ctx) {
  return {
    type: "IndexExpression",
    base: { type: "Identifier", name: envAlias },
    index: escapedByteStringLiteral(name, ctx),
  };
}

function isMaskedGlobalChain(expr, envAlias) {
  if (!expr || typeof expr !== "object") {
    return false;
  }
  if (expr.type === "IndexExpression") {
    if (expr.base && expr.base.type === "Identifier" && expr.base.name === envAlias) {
      return true;
    }
    return isMaskedGlobalChain(expr.base, envAlias);
  }
  if (expr.type === "MemberExpression") {
    return isMaskedGlobalChain(expr.base, envAlias);
  }
  return false;
}

function markSkip(node) {
  if (node && typeof node === "object") {
    node.__obf_skip_mask = true;
  }
}

function buildEnvAliasNodes(style, envAlias, getfAlias, ctx) {
  const envIdentifier = { type: "Identifier", name: envAlias };
  const getfIdentifier = { type: "Identifier", name: getfAlias };
  const localEnv = {
    type: "LocalStatement",
    variables: [envIdentifier],
    init: [{ type: "NilLiteral", value: null, raw: "nil" }],
  };
  const localGetf = {
    type: "LocalStatement",
    variables: [getfIdentifier],
    init: [{ type: "Identifier", name: "getfenv" }],
  };
  const getfCondition = {
    type: "BinaryExpression",
    operator: "==",
    left: {
      type: "CallExpression",
      base: { type: "Identifier", name: "type" },
      arguments: [getfIdentifier],
    },
    right: stringLiteral("function", ctx),
  };
  const getfAssign = {
    type: "AssignmentStatement",
    variables: [envIdentifier],
    init: [
      {
        type: "CallExpression",
        base: getfIdentifier,
        arguments: [{ type: "NumericLiteral", value: 1, raw: "1" }],
      },
    ],
  };
  const getfBody = style === "custom"
    ? { type: "Block", body: [getfAssign] }
    : [getfAssign];
  const getfClause = style === "custom"
    ? { condition: getfCondition, body: getfBody }
    : { type: "IfClause", condition: getfCondition, body: getfBody };
  const getfIf = {
    type: "IfStatement",
    clauses: [getfClause],
    elseBody: null,
  };

  const condition = {
    type: "BinaryExpression",
    operator: "~=",
    left: {
      type: "CallExpression",
      base: { type: "Identifier", name: "type" },
      arguments: [envIdentifier],
    },
    right: stringLiteral("table", ctx),
  };
  const assignEnv = {
    type: "AssignmentStatement",
    variables: [envIdentifier],
    init: [{ type: "Identifier", name: "_G" }],
  };
  const clauseBody = style === "custom"
    ? { type: "Block", body: [assignEnv] }
    : [assignEnv];
  const ifClause = style === "custom"
    ? { condition, body: clauseBody }
    : { type: "IfClause", condition, body: clauseBody };
  const ifStmt = {
    type: "IfStatement",
    clauses: [ifClause],
    elseBody: null,
  };
  markSkip(localEnv);
  markSkip(localGetf);
  markSkip(getfIf);
  markSkip(ifStmt);
  return [localEnv, localGetf, getfIf, ifStmt];
}

function shouldMask(name, scope, reserved) {
  if (!name || reserved.has(name)) {
    return false;
  }
  return !isDefined(scope, name);
}

function maskExpression(expr, scope, envAlias, reserved, ctx) {
  if (!expr || typeof expr !== "object") {
    return expr;
  }
  switch (expr.type) {
    case "Identifier":
      if (shouldMask(expr.name, scope, reserved)) {
        tracePass(ctx, {
          kind: "mask-global",
          name: expr.name,
        });
        return envIndex(expr.name, envAlias, ctx);
      }
      return expr;
    case "BinaryExpression":
    case "LogicalExpression":
      expr.left = maskExpression(expr.left, scope, envAlias, reserved, ctx);
      expr.right = maskExpression(expr.right, scope, envAlias, reserved, ctx);
      return expr;
    case "UnaryExpression":
      expr.argument = maskExpression(expr.argument, scope, envAlias, reserved, ctx);
      return expr;
    case "GroupExpression":
      expr.expression = maskExpression(expr.expression, scope, envAlias, reserved, ctx);
      return expr;
    case "IndexExpression":
      expr.base = maskExpression(expr.base, scope, envAlias, reserved, ctx);
      expr.index = maskExpression(expr.index, scope, envAlias, reserved, ctx);
      return expr;
    case "MemberExpression":
      expr.base = maskExpression(expr.base, scope, envAlias, reserved, ctx);
      if (
        expr.identifier &&
        typeof expr.identifier.name === "string" &&
        COMMON_MASKED_MEMBER_NAMES.has(expr.identifier.name) &&
        isMaskedGlobalChain(expr.base, envAlias)
      ) {
        return {
          type: "IndexExpression",
          base: expr.base,
          index: escapedByteStringLiteral(expr.identifier.name, ctx),
        };
      }
      return expr;
    case "CallExpression":
      expr.base = maskExpression(expr.base, scope, envAlias, reserved, ctx);
      expr.arguments = (expr.arguments || []).map((arg) => maskExpression(arg, scope, envAlias, reserved, ctx));
      return expr;
    case "MethodCallExpression":
      expr.base = maskExpression(expr.base, scope, envAlias, reserved, ctx);
      expr.arguments = (expr.arguments || []).map((arg) => maskExpression(arg, scope, envAlias, reserved, ctx));
      return expr;
    case "TableCallExpression":
      expr.base = maskExpression(expr.base, scope, envAlias, reserved, ctx);
      expr.arguments = maskExpression(expr.arguments, scope, envAlias, reserved, ctx);
      return expr;
    case "StringCallExpression":
      expr.base = maskExpression(expr.base, scope, envAlias, reserved, ctx);
      expr.argument = maskExpression(expr.argument, scope, envAlias, reserved, ctx);
      return expr;
    case "TableConstructorExpression":
      expr.fields.forEach((field) => maskTableField(field, scope, envAlias, reserved, ctx));
      return expr;
    case "IfExpression":
      expr.clauses.forEach((clause) => {
        clause.condition = maskExpression(clause.condition, scope, envAlias, reserved, ctx);
        clause.value = maskExpression(clause.value, scope, envAlias, reserved, ctx);
      });
      expr.elseValue = maskExpression(expr.elseValue, scope, envAlias, reserved, ctx);
      return expr;
    case "TypeAssertion":
      expr.expression = maskExpression(expr.expression, scope, envAlias, reserved, ctx);
      return expr;
    case "InterpolatedString":
      if (expr.parts && Array.isArray(expr.parts)) {
        expr.parts = expr.parts.map((part) => {
          if (part && part.type === "InterpolatedStringText") {
            return part;
          }
          return maskExpression(part, scope, envAlias, reserved, ctx);
        });
      }
      return expr;
    case "FunctionDeclaration":
    case "FunctionExpression":
      maskFunctionExpression(expr, scope, envAlias, reserved, ctx);
      return expr;
    default:
      return expr;
  }
}

function maskTableField(field, scope, envAlias, reserved, ctx) {
  if (!field || typeof field !== "object") {
    return;
  }
  if (field.type === "TableKey") {
    field.key = maskExpression(field.key, scope, envAlias, reserved, ctx);
    field.value = maskExpression(field.value, scope, envAlias, reserved, ctx);
    return;
  }
  if (field.type === "TableKeyString") {
    field.value = maskExpression(field.value, scope, envAlias, reserved, ctx);
    return;
  }
  if (field.type === "TableValue") {
    field.value = maskExpression(field.value, scope, envAlias, reserved, ctx);
    return;
  }
  if (field.kind === "index") {
    field.key = maskExpression(field.key, scope, envAlias, reserved, ctx);
    field.value = maskExpression(field.value, scope, envAlias, reserved, ctx);
  } else if (field.kind === "name") {
    field.value = maskExpression(field.value, scope, envAlias, reserved, ctx);
  } else if (field.kind === "list") {
    field.value = maskExpression(field.value, scope, envAlias, reserved, ctx);
  }
}

function maskAssignmentTarget(target, scope, envAlias, reserved, ctx) {
  if (!target || typeof target !== "object") {
    return target;
  }
  if (target.type === "Identifier" && shouldMask(target.name, scope, reserved)) {
    tracePass(ctx, {
      kind: "mask-global",
      name: target.name,
    });
    return envIndex(target.name, envAlias, ctx);
  }
  if (target.type === "MemberExpression") {
    target.base = maskExpression(target.base, scope, envAlias, reserved, ctx);
    return target;
  }
  if (target.type === "IndexExpression") {
    target.base = maskExpression(target.base, scope, envAlias, reserved, ctx);
    target.index = maskExpression(target.index, scope, envAlias, reserved, ctx);
    return target;
  }
  return target;
}

function maskStatementList(body, scope, envAlias, reserved, ctx) {
  for (const stmt of body) {
    maskStatement(stmt, scope, envAlias, reserved, ctx);
  }
}

function maskStatement(stmt, scope, envAlias, reserved, ctx) {
  if (!stmt || typeof stmt !== "object") {
    return;
  }
  if (stmt.__obf_skip_mask) {
    return;
  }
  switch (stmt.type) {
    case "LocalStatement":
      if (stmt.init && stmt.init.length) {
        stmt.init = stmt.init.map((expr) => maskExpression(expr, scope, envAlias, reserved, ctx));
      }
      stmt.variables.forEach((variable) => {
        if (variable && variable.type === "Identifier") {
          defineName(scope, variable.name);
        }
      });
      return;
    case "AssignmentStatement":
      stmt.init = stmt.init.map((expr) => maskExpression(expr, scope, envAlias, reserved, ctx));
      stmt.variables = stmt.variables.map((variable) => maskAssignmentTarget(variable, scope, envAlias, reserved, ctx));
      return;
    case "CompoundAssignmentStatement":
      stmt.value = maskExpression(stmt.value, scope, envAlias, reserved, ctx);
      stmt.variable = maskAssignmentTarget(stmt.variable, scope, envAlias, reserved, ctx);
      return;
    case "CallStatement":
      stmt.expression = maskExpression(stmt.expression, scope, envAlias, reserved, ctx);
      return;
    case "ReturnStatement":
      stmt.arguments = stmt.arguments.map((expr) => maskExpression(expr, scope, envAlias, reserved, ctx));
      return;
    case "IfStatement":
      maskIfStatement(stmt, scope, envAlias, reserved, ctx);
      return;
    case "WhileStatement":
      stmt.condition = maskExpression(stmt.condition, scope, envAlias, reserved, ctx);
      maskScopedBody(stmt.body, scope, envAlias, reserved, ctx);
      return;
    case "RepeatStatement": {
      const repeatScope = createScope(scope);
      if (Array.isArray(stmt.body)) {
        maskStatementList(stmt.body, repeatScope, envAlias, reserved, ctx);
      } else if (stmt.body && Array.isArray(stmt.body.body)) {
        maskStatementList(stmt.body.body, repeatScope, envAlias, reserved, ctx);
      }
      stmt.condition = maskExpression(stmt.condition, repeatScope, envAlias, reserved, ctx);
      return;
    }
    case "ForNumericStatement": {
      stmt.start = maskExpression(stmt.start, scope, envAlias, reserved, ctx);
      stmt.end = maskExpression(stmt.end, scope, envAlias, reserved, ctx);
      if (stmt.step) {
        stmt.step = maskExpression(stmt.step, scope, envAlias, reserved, ctx);
      }
      const loopScope = createScope(scope);
      if (stmt.variable && stmt.variable.type === "Identifier") {
        defineName(loopScope, stmt.variable.name);
      }
      maskScopedBody(stmt.body, loopScope, envAlias, reserved, ctx);
      return;
    }
    case "ForGenericStatement": {
      stmt.iterators = stmt.iterators.map((expr) => maskExpression(expr, scope, envAlias, reserved, ctx));
      const loopScope = createScope(scope);
      stmt.variables.forEach((variable) => {
        if (variable && variable.type === "Identifier") {
          defineName(loopScope, variable.name);
        }
      });
      maskScopedBody(stmt.body, loopScope, envAlias, reserved, ctx);
      return;
    }
    case "DoStatement":
      maskScopedBody(stmt.body, scope, envAlias, reserved, ctx);
      return;
    case "FunctionDeclaration":
      maskFunctionDeclaration(stmt, scope, envAlias, reserved, ctx);
      return;
    case "BreakStatement":
    case "ContinueStatement":
    case "LabelStatement":
    case "GotoStatement":
    case "TypeAliasStatement":
    case "ExportTypeStatement":
    case "TypeFunctionStatement":
    case "ExportTypeFunctionStatement":
      return;
    default:
      return;
  }
}

function maskFunctionDeclaration(stmt, scope, envAlias, reserved, ctx) {
  const fnScope = createScope(scope);

  let isLocal = Boolean(stmt.isLocal);
  let fnId = null;
  if (stmt.name && stmt.name.type === "FunctionName") {
    if (stmt.isLocal && stmt.name.base && stmt.name.base.type === "Identifier") {
      fnId = stmt.name.base;
    } else {
      isLocal = false;
    }
  } else if (stmt.identifier && stmt.identifier.type === "Identifier") {
    fnId = stmt.identifier;
  }

  if (isLocal && fnId) {
    defineName(scope, fnId.name);
    defineName(fnScope, fnId.name);
  }

  if (stmt.name && stmt.name.type === "FunctionName" && stmt.name.method) {
    defineName(fnScope, "self");
  }

  if (stmt.parameters && stmt.parameters.length) {
    stmt.parameters.forEach((param) => {
      if (param && param.type === "Identifier") {
        defineName(fnScope, param.name);
      }
    });
  }

  if (stmt.body) {
    if (Array.isArray(stmt.body)) {
      maskStatementList(stmt.body, fnScope, envAlias, reserved, ctx);
    } else if (stmt.body.body && Array.isArray(stmt.body.body)) {
      maskStatementList(stmt.body.body, fnScope, envAlias, reserved, ctx);
    }
  }
}

function maskFunctionExpression(expr, scope, envAlias, reserved, ctx) {
  const fnScope = createScope(scope);

  if (expr.identifier && expr.identifier.type === "Identifier") {
    defineName(fnScope, expr.identifier.name);
  }

  if (expr.parameters && expr.parameters.length) {
    expr.parameters.forEach((param) => {
      if (param && param.type === "Identifier") {
        defineName(fnScope, param.name);
      }
    });
  }

  if (expr.body) {
    if (Array.isArray(expr.body)) {
      maskStatementList(expr.body, fnScope, envAlias, reserved, ctx);
    } else if (expr.body.body && Array.isArray(expr.body.body)) {
      maskStatementList(expr.body.body, fnScope, envAlias, reserved, ctx);
    }
  }
}

function maskIfStatement(stmt, scope, envAlias, reserved, ctx) {
  if (!stmt.clauses || !stmt.clauses.length) {
    return;
  }
  const firstClause = stmt.clauses[0];
  if (firstClause && typeof firstClause.type === "string") {
    stmt.clauses.forEach((clause) => {
      if (clause.type !== "ElseClause") {
        clause.condition = maskExpression(clause.condition, scope, envAlias, reserved, ctx);
      }
      const clauseScope = createScope(scope);
      maskStatementList(clause.body, clauseScope, envAlias, reserved, ctx);
    });
    return;
  }
  stmt.clauses.forEach((clause) => {
    clause.condition = maskExpression(clause.condition, scope, envAlias, reserved, ctx);
    const clauseScope = createScope(scope);
    if (clause.body && clause.body.body) {
      maskStatementList(clause.body.body, clauseScope, envAlias, reserved, ctx);
    }
  });
  if (stmt.elseBody) {
    const elseScope = createScope(scope);
    if (stmt.elseBody.body) {
      maskStatementList(stmt.elseBody.body, elseScope, envAlias, reserved, ctx);
    }
  }
}

function maskScopedBody(body, parentScope, envAlias, reserved, ctx) {
  const scope = createScope(parentScope);
  if (Array.isArray(body)) {
    maskStatementList(body, scope, envAlias, reserved, ctx);
    return;
  }
  if (body && Array.isArray(body.body)) {
    maskStatementList(body.body, scope, envAlias, reserved, ctx);
  }
}

function maskGlobalsLuau(ast, ctx) {
  if (!ctx.options.renameOptions || ctx.options.renameOptions.maskGlobals === false) {
    return;
  }
  if (!ast.__obf_env_alias) {
    const used = collectIdentifierNames(ast, ctx);
    if (ctx && typeof ctx.getSSA === "function") {
      getCachedSSAUsedNamesFromRoot(ctx.getSSA()).forEach((name) => used.add(name));
    }
    const reserved = new Set(NAME_RESERVED);
    const nameFor = makeShortNameFactory(ctx.rng, used, reserved, { minLength: 1, maxLength: 3 });
    const envAlias = nameFor("mask_env");
    reserved.add(envAlias);
    const getfAlias = nameFor("mask_getfenv");
    reserved.add(getfAlias);
    ast.__obf_env_alias_name = envAlias;
    ast.__obf_getf_alias_name = getfAlias;
    const style = !ctx.options || ctx.options.luauParser !== "luaparse" ? "custom" : "luaparse";
    insertAtTop(ast, buildEnvAliasNodes(style, envAlias, getfAlias, ctx));
    ast.__obf_env_alias = true;
  }
  const rootScope = createScope(null);
  const envAlias = ast.__obf_env_alias_name;
  const getfAlias = ast.__obf_getf_alias_name;
  const reserved = new Set(BASE_RESERVED);
  if (envAlias) {
    reserved.add(envAlias);
  }
  if (getfAlias) {
    reserved.add(getfAlias);
  }
  if (Array.isArray(ast.body)) {
    maskStatementList(ast.body, rootScope, envAlias, reserved, ctx);
  }
}

module.exports = {
  maskGlobalsLuau,
};
