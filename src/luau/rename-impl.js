const { walk } = require("./ast");
const { getCachedSSAReadNamesFromRoot } = require("./ssa-utils");

const LUA_KEYWORDS = new Set([
  "and",
  "break",
  "continue",
  "do",
  "else",
  "elseif",
  "end",
  "export",
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
  "type",
  "typeof",
  "until",
  "while",
  "self",
]);
const LUA_RESERVED_GLOBALS = new Set(["_ENV", "_G"]);
const LUA_METAMETHOD_PREFIX = "__";
const SAFE_FUNCTION_EXPR_PARAM_NAME = /^(deps|state|node|runtime|self|engine|ctx|context)$/i;
const EXTERNAL_SCHEMA_PARAM_NAME = /^(payload|input|params|options|config)$/i;
const EXTERNAL_SCHEMA_LOCAL_NAME = /^(payload|input|summary|report)$/i;
const BUILTIN_LIBS = new Set([
  "bit32",
  "coroutine",
  "debug",
  "io",
  "math",
  "os",
  "package",
  "string",
  "table",
  "utf8",
]);

const FIRST_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_";
const REST_CHARS = `${FIRST_CHARS}0123456789`;

function countNamesOfLength(length, firstAlphabet, restAlphabet) {
  if (length <= 1) {
    return firstAlphabet.length;
  }
  return firstAlphabet.length * (restAlphabet.length ** (length - 1));
}

function nameAtLengthIndex(length, index, firstAlphabet, restAlphabet) {
  if (length <= 1) {
    return firstAlphabet[index % firstAlphabet.length];
  }
  let restIndex = index % (restAlphabet.length ** (length - 1));
  const firstIndex = Math.floor(index / (restAlphabet.length ** (length - 1))) % firstAlphabet.length;
  let name = firstAlphabet[firstIndex];
  const chars = new Array(length - 1);
  for (let pos = chars.length - 1; pos >= 0; pos -= 1) {
    chars[pos] = restAlphabet[restIndex % restAlphabet.length];
    restIndex = Math.floor(restIndex / restAlphabet.length);
  }
  return name + chars.join("");
}

class LuaNameGenerator {
  constructor({ reserved = [], alphabets = null } = {}) {
    this.reserved = new Set(reserved);
    this.used = new Set();
    this.index = 0;
    this.length = 1;
    if (alphabets && alphabets.first && alphabets.rest) {
      this.firstAlphabet = alphabets.first;
      this.restAlphabet = alphabets.rest;
    } else {
      this.firstAlphabet = FIRST_CHARS;
      this.restAlphabet = REST_CHARS;
    }
  }

  next() {
    while (true) {
      const count = countNamesOfLength(this.length, this.firstAlphabet, this.restAlphabet);
      if (this.index >= count) {
        this.length += 1;
        this.index = 0;
        continue;
      }
      const name = nameAtLengthIndex(this.length, this.index, this.firstAlphabet, this.restAlphabet);
      this.index += 1;
      if (!this.reserved.has(name) && !this.used.has(name)) {
        this.used.add(name);
        return name;
      }
    }
  }

  reserve(name) {
    this.reserved.add(name);
  }
}

function collectIdentifiers(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (node && node.type === "Identifier" && typeof node.name === "string") {
      names.add(node.name);
    }
  });
  return names;
}

function collectGlobalBindings(ast) {
  const globals = new Set();
  if (!ast || !Array.isArray(ast.body)) {
    return globals;
  }
  for (const stmt of ast.body) {
    if (!stmt || typeof stmt !== "object") {
      continue;
    }
    if (stmt.type === "AssignmentStatement") {
      const variables = stmt.variables || [];
      variables.forEach((variable) => {
        if (variable && variable.type === "Identifier" && typeof variable.name === "string") {
          globals.add(variable.name);
        }
      });
      continue;
    }
    if (stmt.type === "FunctionDeclaration") {
      if (stmt.isLocal) {
        continue;
      }
      if (stmt.name && stmt.name.type === "FunctionName") {
        if (!stmt.name.members.length && !stmt.name.method && stmt.name.base) {
          globals.add(stmt.name.base.name);
        }
        continue;
      }
      if (stmt.identifier && stmt.identifier.type === "Identifier") {
        globals.add(stmt.identifier.name);
      }
    }
  }
  return globals;
}

function createScope(parent = null) {
  return { parent, bindings: new Map(), memberSafe: new Map() };
}

function resolveName(scope, name) {
  let current = scope;
  while (current) {
    if (current.bindings.has(name)) {
      return current.bindings.get(name);
    }
    current = current.parent;
  }
  return null;
}

function resolveBindingScope(scope, name) {
  let current = scope;
  while (current) {
    if (current.bindings.has(name)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function resolveMemberSafety(scope, name) {
  let current = scope;
  while (current) {
    if (current.memberSafe.has(name)) {
      return current.memberSafe.get(name);
    }
    current = current.parent;
  }
  return false;
}

function isEnvAliasIdentifier(node, scope, ctx) {
  if (!node || node.type !== "Identifier") {
    return false;
  }
  if (ctx && ctx.envAliasName && node.name === ctx.envAliasName) {
    return true;
  }
  if (node.name === "_ENV" || node.name === "_G") {
    return !resolveName(scope, node.name);
  }
  return false;
}

function isEnvAliasLookup(expr, scope, ctx) {
  if (!expr || typeof expr !== "object") {
    return false;
  }
  if (expr.type === "IndexExpression") {
    if (isEnvAliasIdentifier(expr.base, scope, ctx)) {
      return true;
    }
    return isEnvAliasLookup(expr.base, scope, ctx);
  }
  if (expr.type === "MemberExpression") {
    return isEnvAliasLookup(expr.base, scope, ctx);
  }
  return false;
}

function isBuiltinLibBase(expr, scope, ctx) {
  if (!expr || typeof expr !== "object") {
    return false;
  }
  if (expr.type === "Identifier") {
    return BUILTIN_LIBS.has(expr.name) && !resolveName(scope, expr.name);
  }
  if (isEnvAliasLookup(expr, scope, ctx)) {
    return true;
  }
  return false;
}

function isDynamicKeyMapAccess(expr, scope, ctx) {
  if (!expr || typeof expr !== "object") {
    return false;
  }
  if (expr.type === "Identifier" && resolveDynamicMapRecordAlias(scope, expr.name)) {
    return true;
  }
  const exprPath = getMemberPath(expr);
  if (exprPath && ctx.dynamicIndexBaseNames && ctx.dynamicIndexBaseNames.has(exprPath)) {
    return true;
  }
  if (expr.type === "IndexExpression") {
    if (
      expr.index &&
      expr.index.type !== "StringLiteral" &&
      expr.index.type !== "NumericLiteral" &&
      expr.index.type !== "BooleanLiteral"
    ) {
      return isDefinitelyLocalTable(expr.base, scope, ctx);
    }
    return isDynamicKeyMapAccess(expr.base, scope, ctx);
  }
  if (expr.type === "MemberExpression") {
    if (
      expr.identifier &&
      expr.identifier.type === "Identifier" &&
      ctx.dynamicIndexMemberNames &&
      ctx.dynamicIndexMemberNames.has(expr.identifier.name) &&
      isDefinitelyLocalTable(expr.base, scope, ctx)
    ) {
      return true;
    }
    if (
      expr.identifier &&
      expr.identifier.type === "Identifier" &&
      ctx.dynamicIndexRecordBaseMemberNames &&
      ctx.dynamicIndexRecordBaseMemberNames.has(expr.identifier.name) &&
      isDefinitelyLocalTable(expr.base, scope, ctx)
    ) {
      return true;
    }
    return isDynamicKeyMapAccess(expr.base, scope, ctx);
  }
  return false;
}

function defineName(scope, name, ctx) {
  if (
    ctx.reserved.has(name) ||
    (scope && scope.isRoot && ctx.topReturnExportNames && ctx.topReturnExportNames.has(name))
  ) {
    scope.bindings.set(name, name);
    return name;
  }
  let next = ctx.generator.next();
  while (ctx.used.has(next) || ctx.reserved.has(next)) {
    next = ctx.generator.next();
  }
  ctx.used.add(next);
  scope.bindings.set(name, next);
  return next;
}

function defineGlobal(name, ctx) {
  if (ctx.reserved.has(name) || (ctx.topReturnExportNames && ctx.topReturnExportNames.has(name))) {
    ctx.globals.set(name, name);
    return name;
  }
  let next = ctx.generator.next();
  while (ctx.used.has(next) || ctx.reserved.has(next)) {
    next = ctx.generator.next();
  }
  ctx.used.add(next);
  ctx.globals.set(name, next);
  return next;
}

function traceRename(ctx, event) {
  if (ctx && typeof ctx.debugTrace === "function") {
    ctx.debugTrace(event);
  }
}

function defineMember(name, ctx) {
  if (ctx.reserved.has(name)) {
    ctx.memberMap.set(name, name);
    return name;
  }
  let next = ctx.generator.next();
  while (ctx.used.has(next) || ctx.reserved.has(next)) {
    next = ctx.generator.next();
  }
  ctx.used.add(next);
  ctx.memberMap.set(name, next);
  return next;
}

function getIdentifierName(node) {
  return node && node.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function getDirectReturnExportName(expr) {
  let current = expr;
  while (current && current.type === "GroupExpression") {
    current = current.expression;
  }
  if (!current || typeof current !== "object") {
    return null;
  }
  if (current.type === "Identifier") {
    return getIdentifierName(current);
  }
  if (current.type === "CallExpression") {
    let base = current.base;
    while (base && base.type === "GroupExpression") {
      base = base.expression;
    }
    return base && base.type === "Identifier" ? getIdentifierName(base) : null;
  }
  return null;
}

function collectTopReturnExportNames(ast) {
  const names = new Set();
  const marked = ast && ast.__obf_top_return_export_names;
  if (marked && typeof marked.forEach === "function") {
    marked.forEach((name) => {
      if (typeof name === "string" && name) {
        names.add(name);
      }
    });
  }
  if (!ast || !Array.isArray(ast.body)) {
    return names;
  }
  ast.body.forEach((stmt) => {
    if (!stmt || stmt.type !== "ReturnStatement" || !Array.isArray(stmt.arguments)) {
      return;
    }
    stmt.arguments.forEach((expr) => {
      const name = getDirectReturnExportName(expr);
      if (name) {
        names.add(name);
      }
    });
  });
  return names;
}

function getMemberPath(expr) {
  if (!expr || typeof expr !== "object") {
    return null;
  }
  if (expr.type === "Identifier") {
    return expr.name;
  }
  if (expr.type === "MemberExpression" && expr.identifier && expr.identifier.type === "Identifier") {
    const base = getMemberPath(expr.base);
    if (!base) {
      return null;
    }
    return `${base}.${expr.identifier.name}`;
  }
  return null;
}

function markExternalShapePath(scope, expr) {
  if (!scope || !expr) {
    return;
  }
  const path = getMemberPath(expr);
  if (!path) {
    return;
  }
  if (!scope.externalShapePaths) {
    scope.externalShapePaths = new Set();
  }
  const parts = path.split(".");
  for (let i = 1; i <= parts.length; i += 1) {
    scope.externalShapePaths.add(parts.slice(0, i).join("."));
  }
}

function markExternalShapeBinding(scope, originalName, mappedName) {
  const names = [originalName, mappedName];
  const seen = new Set();
  names.forEach((name) => {
    if (typeof name !== "string" || !name || seen.has(name)) {
      return;
    }
    seen.add(name);
    markExternalShapePath(scope, { type: "Identifier", name });
  });
}

function markExternalShapeMemberBinding(scope, originalName, mappedName, memberName) {
  const names = [originalName, mappedName];
  const seen = new Set();
  names.forEach((name) => {
    if (typeof name !== "string" || !name || seen.has(name)) {
      return;
    }
    seen.add(name);
    markExternalShapePath(scope, {
      type: "MemberExpression",
      base: { type: "Identifier", name },
      identifier: { type: "Identifier", name: memberName },
    });
  });
}

function markDynamicMapRecordAlias(scope, originalName, mappedName, ctx = null) {
  if (!scope) {
    return;
  }
  if (!scope.dynamicMapRecordAliases) {
    scope.dynamicMapRecordAliases = new Set();
  }
  [originalName, mappedName].forEach((name) => {
    if (typeof name === "string" && name) {
      scope.dynamicMapRecordAliases.add(name);
    }
  });
  traceRename(ctx, {
    kind: "mark-dynamic-map-record-alias",
    originalName,
    mappedName,
  });
}

function resolveDynamicMapRecordAlias(scope, name) {
  let current = scope;
  while (current) {
    if (current.dynamicMapRecordAliases && current.dynamicMapRecordAliases.has(name)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function resolveExternalShapePath(scope, expr) {
  const path = getMemberPath(expr);
  if (!path) {
    return false;
  }
  let current = scope;
  while (current) {
    if (current.externalShapePaths && current.externalShapePaths.has(path)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function shouldPropagateExternalShapeFromValue(value, scope) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (resolveExternalShapePath(scope, value)) {
    return true;
  }
  if (value.type === "GroupExpression") {
    return shouldPropagateExternalShapeFromValue(value.expression, scope);
  }
  if (
    (value.type === "CallExpression" || value.type === "MethodCallExpression") &&
    Array.isArray(value.arguments) &&
    value.arguments.length > 0
  ) {
    return resolveExternalShapePath(scope, value.arguments[0]);
  }
  return false;
}

function isExternalShapeValueSource(value, scope) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (resolveExternalShapePath(scope, value)) {
    return true;
  }
  if (value.type === "GroupExpression") {
    return isExternalShapeValueSource(value.expression, scope);
  }
  if (value.type === "MemberExpression" || value.type === "IndexExpression") {
    return Boolean(value.base && resolveExternalShapePath(scope, value.base));
  }
  return false;
}

function isDynamicMapFunctionCall(expr, ctx) {
  if (!expr || typeof expr !== "object" || !ctx || !ctx.dynamicMapFunctionNames) {
    return false;
  }
  if (expr.type === "CallExpression") {
    if (expr.base && expr.base.type === "MemberExpression" && expr.base.identifier && expr.base.identifier.type === "Identifier") {
      return ctx.dynamicMapFunctionNames.has(expr.base.identifier.name);
    }
    if (expr.base && expr.base.type === "Identifier") {
      return ctx.dynamicMapFunctionNames.has(expr.base.name);
    }
    return false;
  }
  if (expr.type === "MethodCallExpression") {
    return Boolean(expr.method && expr.method.type === "Identifier" && ctx.dynamicMapFunctionNames.has(expr.method.name));
  }
  return false;
}

function registerConstructorMember(ctx, ownerNames, memberNames) {
  if (!ctx || !ctx.constructorMembers) {
    return;
  }
  ownerNames.forEach((ownerName) => {
    if (typeof ownerName !== "string" || !ownerName) {
      return;
    }
    let members = ctx.constructorMembers.get(ownerName);
    if (!members) {
      members = new Set();
      ctx.constructorMembers.set(ownerName, members);
    }
    memberNames.forEach((memberName) => {
      if (typeof memberName === "string" && memberName) {
        members.add(memberName);
      }
    });
  });
}

function isKnownConstructorMember(ownerName, memberName, ctx) {
  if (!ctx || !ctx.constructorMembers || typeof ownerName !== "string" || typeof memberName !== "string") {
    return false;
  }
  const members = ctx.constructorMembers.get(ownerName);
  return Boolean(members && members.has(memberName));
}

function isLocalTableLikeExpression(expr, localTableVars, ownerName) {
  if (!expr || typeof expr !== "object") {
    return false;
  }
  switch (expr.type) {
    case "TableConstructorExpression":
      return true;
    case "GroupExpression":
      return isLocalTableLikeExpression(expr.expression, localTableVars, ownerName);
    case "Identifier":
      return localTableVars.has(expr.name);
    case "IfExpression":
      if (!Array.isArray(expr.clauses) || !expr.clauses.length) {
        return false;
      }
      if (!isLocalTableLikeExpression(expr.elseValue, localTableVars, ownerName)) {
        return false;
      }
      return expr.clauses.every((clause) => isLocalTableLikeExpression(clause.value, localTableVars, ownerName));
    case "CallExpression": {
      const calleeName = getIdentifierName(expr.base);
      if (calleeName !== "setmetatable") {
        return false;
      }
      const args = Array.isArray(expr.arguments) ? expr.arguments : [];
      if (args.length < 2) {
        return false;
      }
      return isLocalTableLikeExpression(args[0], localTableVars, ownerName) && getIdentifierName(args[1]) === ownerName;
    }
    default:
      return false;
  }
}

function functionReturnsLocalTableLike(stmt, ownerName) {
  if (!stmt || !stmt.body) {
    return false;
  }
  const body = Array.isArray(stmt.body) ? stmt.body : stmt.body.body;
  if (!Array.isArray(body)) {
    return false;
  }

  const localTableVars = new Set();
  for (const entry of body) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (entry.type === "LocalStatement") {
      const variables = Array.isArray(entry.variables) ? entry.variables : [];
      const init = Array.isArray(entry.init) ? entry.init : [];
      variables.forEach((variable, index) => {
        const varName = getIdentifierName(variable);
        if (!varName) {
          return;
        }
        if (isLocalTableLikeExpression(init[index], localTableVars, ownerName)) {
          localTableVars.add(varName);
        }
      });
      continue;
    }
    if (entry.type === "ReturnStatement") {
      const values = Array.isArray(entry.arguments) ? entry.arguments : [];
      return values.some((value) => isLocalTableLikeExpression(value, localTableVars, ownerName));
    }
  }
  return false;
}

function collectConstructorMemberHints(ast) {
  const constructorMembers = new Map();
  const body = ast && Array.isArray(ast.body) ? ast.body : [];
  for (const stmt of body) {
    if (!stmt || stmt.type !== "FunctionDeclaration" || !stmt.name || stmt.name.type !== "FunctionName") {
      continue;
    }
    const ownerName = getIdentifierName(stmt.name.base);
    const memberNode = stmt.name.method || (Array.isArray(stmt.name.members) ? stmt.name.members[stmt.name.members.length - 1] : null);
    const memberName = getIdentifierName(memberNode);
    if (!ownerName || !memberName) {
      continue;
    }
    if (!functionReturnsLocalTableLike(stmt, ownerName)) {
      continue;
    }
    let members = constructorMembers.get(ownerName);
    if (!members) {
      members = new Set();
      constructorMembers.set(ownerName, members);
    }
    members.add(memberName);
  }
  return constructorMembers;
}

function collectDynamicIndexBaseNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (!node || node.type !== "IndexExpression" || !node.base || !node.index) {
      return;
    }
    if (
      node.index.type === "StringLiteral" ||
      node.index.type === "NumericLiteral" ||
      node.index.type === "BooleanLiteral"
    ) {
      return;
    }
    const basePath = getMemberPath(node.base);
    if (basePath) {
      names.add(basePath);
    }
  });
  return names;
}

function collectDynamicIndexRecordBaseNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (!node || node.type !== "AssignmentStatement") {
      return;
    }
    const variables = Array.isArray(node.variables) ? node.variables : [];
    const init = Array.isArray(node.init) ? node.init : [];
    variables.forEach((variable, index) => {
      if (!variable || variable.type !== "IndexExpression" || !variable.base || !variable.index) {
        return;
      }
      if (
        variable.index.type === "StringLiteral" ||
        variable.index.type === "NumericLiteral" ||
        variable.index.type === "BooleanLiteral"
      ) {
        return;
      }
      const basePath = getMemberPath(variable.base);
      const value = init[index];
      if (basePath && value && value.type === "TableConstructorExpression") {
        names.add(basePath);
      }
    });
  });
  return names;
}

function collectDynamicIndexRecordBaseMemberNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (!node || node.type !== "AssignmentStatement") {
      return;
    }
    const variables = Array.isArray(node.variables) ? node.variables : [];
    const init = Array.isArray(node.init) ? node.init : [];
    variables.forEach((variable, index) => {
      const value = init[index];
      if (
        !variable ||
        variable.type !== "IndexExpression" ||
        !variable.base ||
        variable.base.type !== "MemberExpression" ||
        !variable.base.identifier ||
        !variable.index
      ) {
        return;
      }
      if (
        variable.index.type === "StringLiteral" ||
        variable.index.type === "NumericLiteral" ||
        variable.index.type === "BooleanLiteral"
      ) {
        return;
      }
      if (value && value.type === "TableConstructorExpression") {
        const memberName = getIdentifierName(variable.base.identifier);
        if (memberName) {
          names.add(memberName);
        }
      }
    });
  });
  return names;
}

function collectDynamicIndexRecordMemberNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (!node || node.type !== "AssignmentStatement") {
      return;
    }
    const variables = Array.isArray(node.variables) ? node.variables : [];
    const init = Array.isArray(node.init) ? node.init : [];
    variables.forEach((variable, index) => {
      const value = init[index];
      if (
        !variable ||
        variable.type !== "IndexExpression" ||
        !variable.base ||
        !variable.index
      ) {
        return;
      }
      if (
        variable.index &&
        (
          variable.index.type === "StringLiteral" ||
          variable.index.type === "NumericLiteral" ||
          variable.index.type === "BooleanLiteral"
        )
      ) {
        return;
      }
      if (value && value.type === "TableConstructorExpression") {
        value.fields.forEach((field) => {
          if (!field || typeof field !== "object") {
            return;
          }
          if (field.kind === "name" && field.name && field.name.type === "Identifier") {
            names.add(field.name.name);
            return;
          }
          if (field.type === "TableKeyString" && field.key && field.key.type === "Identifier") {
            names.add(field.key.name);
          }
        });
      }
    });
  });
  return names;
}

function collectDynamicIndexMemberNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (!node || node.type !== "IndexExpression" || !node.base || !node.index) {
      return;
    }
    if (
      node.index.type === "StringLiteral" ||
      node.index.type === "NumericLiteral" ||
      node.index.type === "BooleanLiteral"
    ) {
      return;
    }
    if (node.base && node.base.type === "MemberExpression" && node.base.identifier) {
      const memberName = getIdentifierName(node.base.identifier);
      if (memberName) {
        names.add(memberName);
      }
    }
  });
  return names;
}

function functionReturnsDynamicKeyMap(stmt, inheritedLocalMapVars = null) {
  if (!stmt || !stmt.body) {
    return false;
  }
  const body = Array.isArray(stmt.body) ? stmt.body : stmt.body.body;
  if (!Array.isArray(body)) {
    return false;
  }

  const localMapVars = inheritedLocalMapVars ? new Set(inheritedLocalMapVars) : new Set();
  for (const entry of body) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (entry.type === "LocalStatement") {
      const variables = Array.isArray(entry.variables) ? entry.variables : [];
      const init = Array.isArray(entry.init) ? entry.init : [];
      variables.forEach((variable, index) => {
        const varName = getIdentifierName(variable);
        const initExpr = init[index];
        if (varName && initExpr && initExpr.type === "TableConstructorExpression") {
          localMapVars.add(varName);
        }
      });
      continue;
    }
    if (entry.type === "AssignmentStatement") {
      const variables = Array.isArray(entry.variables) ? entry.variables : [];
      if (variables.some((variable) => (
        variable &&
        variable.type === "IndexExpression" &&
        variable.base &&
        variable.base.type === "Identifier" &&
        localMapVars.has(variable.base.name) &&
        variable.index &&
        variable.index.type !== "StringLiteral" &&
        variable.index.type !== "NumericLiteral" &&
        variable.index.type !== "BooleanLiteral"
      ))) {
        return true;
      }
      continue;
    }
    if (entry.type === "IfStatement") {
      const clauses = Array.isArray(entry.clauses) ? entry.clauses : [];
      for (const clause of clauses) {
        const nestedBody = clause && clause.body && clause.body.body ? clause.body.body : clause && clause.body;
        if (functionReturnsDynamicKeyMap({ body: nestedBody }, localMapVars)) {
          return true;
        }
      }
      const elseBody = entry.elseBody && entry.elseBody.body ? entry.elseBody.body : entry.elseBody;
      if (functionReturnsDynamicKeyMap({ body: elseBody }, localMapVars)) {
        return true;
      }
      continue;
    }
    if (entry.type === "ForGenericStatement" || entry.type === "ForNumericStatement" || entry.type === "WhileStatement" || entry.type === "RepeatStatement" || entry.type === "DoStatement") {
      const nestedBody = entry.body && entry.body.body ? entry.body.body : entry.body;
      if (functionReturnsDynamicKeyMap({ body: nestedBody }, localMapVars)) {
        return true;
      }
    }
  }
  return false;
}

function collectExternalSchemaLocalNames(ast) {
  const names = new Set();
  const localTableVars = new Set();
  const functionParams = new Map();

  function visitDeep(value, visitor) {
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => visitDeep(entry, visitor));
      return;
    }
    visitor(value);
    Object.keys(value).forEach((key) => {
      visitDeep(value[key], visitor);
    });
  }

  function getFunctionMeta(stmt) {
    if (!stmt || stmt.type !== "FunctionDeclaration") {
      return null;
    }
    if (stmt.name && stmt.name.type === "FunctionName") {
      const memberNode =
        stmt.name.method || (Array.isArray(stmt.name.members) ? stmt.name.members[stmt.name.members.length - 1] : null);
      return {
        fnName: getIdentifierName(memberNode) || getIdentifierName(stmt.name.base),
      };
    }
    if (stmt.isLocal) {
      return {
        fnName: getIdentifierName(stmt.name && stmt.name.base),
      };
    }
    return {
      fnName: getIdentifierName(stmt.identifier),
    };
  }

  visitDeep(ast, (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (node.type === "FunctionDeclaration") {
      const meta = getFunctionMeta(node);
      const fnName = meta && meta.fnName;
      if (!fnName) {
        return;
      }
      const params = (Array.isArray(node.parameters) ? node.parameters : [])
        .map((param) => getIdentifierName(param))
        .filter(Boolean);
      functionParams.set(fnName, params);
      return;
    }
    if (node.type !== "LocalStatement") {
      return;
    }
    const variables = Array.isArray(node.variables) ? node.variables : [];
    const init = Array.isArray(node.init) ? node.init : [];
    variables.forEach((variable, index) => {
      const varName = getIdentifierName(variable);
      const initExpr = init[index];
      if (varName && initExpr && initExpr.type === "TableConstructorExpression") {
        localTableVars.add(varName);
        if (EXTERNAL_SCHEMA_LOCAL_NAME.test(varName)) {
          names.add(varName);
        }
      }
    });
  });

  visitDeep(ast, (node) => {
    if (!node || !Array.isArray(node.arguments)) {
      return;
    }
    let fnName = null;
    if (node.type === "CallExpression" && node.base && node.base.type === "Identifier") {
      fnName = node.base.name;
    } else if (node.type === "MethodCallExpression" && node.method && node.method.type === "Identifier") {
      fnName = node.method.name;
    } else {
      return;
    }
    const params = functionParams.get(fnName);
    if (!params || !params.length) {
      return;
    }
    node.arguments.forEach((arg, index) => {
      if (
        index >= params.length ||
        !arg ||
        arg.type !== "Identifier" ||
        !localTableVars.has(arg.name) ||
        !EXTERNAL_SCHEMA_PARAM_NAME.test(params[index] || "")
      ) {
        return;
      }
      names.add(arg.name);
    });
  });

  return names;
}

function collectSafeFunctionParameterHints(ast) {
  const hints = new Map();
  const localTableVars = new Set();
  const functionParams = new Map();
  const constructorMembers = collectConstructorMemberHints(ast);
  const dynamicIndexBaseNames = collectDynamicIndexBaseNames(ast);
  const dynamicIndexRecordBaseNames = collectDynamicIndexRecordBaseNames(ast);
  const dynamicIndexRecordBaseMemberNames = collectDynamicIndexRecordBaseMemberNames(ast);
  const dynamicIndexRecordMemberNames = collectDynamicIndexRecordMemberNames(ast);
  const dynamicIndexMemberNames = collectDynamicIndexMemberNames(ast);
  const SAFE_CALLBACK_PARAM_NAME = /^(handler|callback|cb|fn|thunk|resolver)$/i;
  function visitDeep(value, visitor) {
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => visitDeep(entry, visitor));
      return;
    }
    visitor(value);
    Object.keys(value).forEach((key) => {
      visitDeep(value[key], visitor);
    });
  }

  function isConstructorCallExpr(expr) {
    if (!expr || typeof expr !== "object") {
      return false;
    }
    if (expr.type === "CallExpression") {
      return Boolean(
        expr.base &&
          expr.base.type === "MemberExpression" &&
          expr.base.base &&
          expr.base.base.type === "Identifier" &&
          expr.base.identifier &&
          expr.base.identifier.type === "Identifier" &&
          isKnownConstructorMember(expr.base.base.name, expr.base.identifier.name, { constructorMembers })
      );
    }
    if (expr.type === "MethodCallExpression") {
      return Boolean(
        expr.base &&
          expr.base.type === "Identifier" &&
          expr.method &&
          expr.method.type === "Identifier" &&
          isKnownConstructorMember(expr.base.name, expr.method.name, { constructorMembers })
      );
    }
    return false;
  }

  function isDynamicKeyMapAccessStatic(expr, safeVars = localTableVars) {
    if (!expr || typeof expr !== "object") {
      return false;
    }
    const exprPath = getMemberPath(expr);
    if (exprPath && dynamicIndexBaseNames.has(exprPath)) {
      return true;
    }
    if (expr.type === "IndexExpression") {
      if (
        expr.index &&
        expr.index.type !== "StringLiteral" &&
        expr.index.type !== "NumericLiteral" &&
        expr.index.type !== "BooleanLiteral"
      ) {
        return isSafeLocalTableExpr(expr.base, safeVars);
      }
      return isDynamicKeyMapAccessStatic(expr.base, safeVars);
    }
    if (expr.type === "MemberExpression") {
      if (
        expr.identifier &&
        expr.identifier.type === "Identifier" &&
        dynamicIndexMemberNames.has(expr.identifier.name) &&
        isSafeLocalTableExpr(expr.base, safeVars)
      ) {
        return true;
      }
      if (
        expr.identifier &&
        expr.identifier.type === "Identifier" &&
        dynamicIndexRecordBaseMemberNames.has(expr.identifier.name) &&
        isSafeLocalTableExpr(expr.base, safeVars)
      ) {
        return true;
      }
      return isDynamicKeyMapAccessStatic(expr.base, safeVars);
    }
    return false;
  }

  function isDynamicMapRecordAccessStatic(expr) {
    if (!expr || typeof expr !== "object") {
      return false;
    }
    if (
      expr.type === "MemberExpression" &&
      expr.identifier &&
      expr.identifier.type === "Identifier" &&
      dynamicIndexRecordMemberNames.has(expr.identifier.name) &&
      isSafeLocalTableExpr(expr.base)
    ) {
      return true;
    }
    if (expr.type === "MemberExpression" && isDynamicKeyMapAccessStatic(expr.base)) {
      const basePath = getMemberPath(expr.base);
      if (basePath && dynamicIndexRecordBaseNames.has(basePath)) {
        return true;
      }
      if (
        expr.base &&
        expr.base.type === "MemberExpression" &&
        expr.base.identifier &&
        expr.base.identifier.type === "Identifier" &&
        dynamicIndexRecordBaseMemberNames.has(expr.base.identifier.name) &&
        isSafeLocalTableExpr(expr.base.base)
      ) {
        return true;
      }
    }
    if (expr.type === "IndexExpression") {
      if (isDynamicMapRecordAccessStatic(expr.base)) {
        return true;
      }
      if (
        expr.base &&
        expr.base.type === "MemberExpression" &&
        expr.base.identifier &&
        expr.base.identifier.type === "Identifier" &&
        dynamicIndexRecordBaseMemberNames.has(expr.base.identifier.name) &&
        isSafeLocalTableExpr(expr.base.base)
      ) {
        return true;
      }
      const staticBasePath = getMemberPath(expr.base);
      if (staticBasePath && dynamicIndexRecordBaseNames.has(staticBasePath)) {
        return true;
      }
      if (
        expr.index &&
        expr.index.type !== "StringLiteral" &&
        expr.index.type !== "NumericLiteral" &&
        expr.index.type !== "BooleanLiteral"
      ) {
        const basePath = getMemberPath(expr.base);
        return Boolean(basePath && dynamicIndexRecordBaseNames.has(basePath));
      }
      return false;
    }
    if (expr.type === "MemberExpression") {
      return isDynamicMapRecordAccessStatic(expr.base);
    }
    return false;
  }

  function isSafeLocalTableExpr(expr, safeVars = localTableVars) {
    if (!expr || typeof expr !== "object") {
      return false;
    }
    if ((expr.type === "IndexExpression" || expr.type === "MemberExpression") && isDynamicMapRecordAccessStatic(expr)) {
      return true;
    }
    if (isDynamicKeyMapAccessStatic(expr, safeVars) && !isDynamicMapRecordAccessStatic(expr)) {
      return false;
    }
    switch (expr.type) {
      case "TableConstructorExpression":
        return true;
      case "Identifier":
        return safeVars.has(expr.name);
      case "MemberExpression":
      case "IndexExpression":
        return isSafeLocalTableExpr(expr.base, safeVars);
      case "CallExpression":
      case "MethodCallExpression":
        return isConstructorCallExpr(expr);
      case "GroupExpression":
        return isSafeLocalTableExpr(expr.expression, safeVars);
      default:
        return false;
    }
  }

  function isSafeArgumentExpr(expr, safeVars = localTableVars) {
    if (!expr || typeof expr !== "object") {
      return false;
    }
    if (isDynamicKeyMapAccessStatic(expr, safeVars) && !isDynamicMapRecordAccessStatic(expr)) {
      return false;
    }
    switch (expr.type) {
      case "Identifier":
        return safeVars.has(expr.name);
      case "MemberExpression":
      case "IndexExpression":
        return isSafeArgumentExpr(expr.base, safeVars) || isSafeLocalTableExpr(expr.base, safeVars);
      case "GroupExpression":
        return isSafeArgumentExpr(expr.expression, safeVars);
      default:
        return false;
    }
  }

  function getFunctionMeta(stmt) {
    if (!stmt || stmt.type !== "FunctionDeclaration") {
      return null;
    }
    if (stmt.name && stmt.name.type === "FunctionName") {
      const memberNode =
        stmt.name.method || (Array.isArray(stmt.name.members) ? stmt.name.members[stmt.name.members.length - 1] : null);
      return {
        fnName: getIdentifierName(memberNode) || getIdentifierName(stmt.name.base),
        ownerName: getIdentifierName(stmt.name.base),
        isMethod: Boolean(stmt.name.method || memberNode),
      };
    }
    if (stmt.isLocal) {
      return {
        fnName: getIdentifierName(stmt.name && stmt.name.base),
        ownerName: null,
        isMethod: false,
      };
    }
    return {
      fnName: getIdentifierName(stmt.identifier),
      ownerName: null,
      isMethod: false,
    };
  }

  visitDeep(ast, (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (node.type === "FunctionDeclaration") {
      const meta = getFunctionMeta(node);
      const fnName = meta && meta.fnName;
      if (!fnName) {
        return;
      }
      const params = (Array.isArray(node.parameters) ? node.parameters : [])
        .map((param) => getIdentifierName(param))
        .filter(Boolean);
      functionParams.set(fnName, params);
      return;
    }
    if (node.type !== "LocalStatement") {
      return;
    }
    const variables = Array.isArray(node.variables) ? node.variables : [];
    const init = Array.isArray(node.init) ? node.init : [];
    variables.forEach((variable, index) => {
      const varName = getIdentifierName(variable);
      if (
        varName &&
        isSafeLocalTableExpr(init[index]) &&
        (!isDynamicKeyMapAccessStatic(init[index]) || isDynamicMapRecordAccessStatic(init[index]))
      ) {
        localTableVars.add(varName);
      }
    });
  });

  visitDeep(ast, (node) => {
      if (!node || !Array.isArray(node.arguments)) {
        return;
      }
      let fnName = null;
      if (node.type === "CallExpression" && node.base && node.base.type === "Identifier") {
        fnName = node.base.name;
      } else if (
        node.type === "CallExpression" &&
        node.base &&
        node.base.type === "MemberExpression" &&
        node.base.identifier &&
        node.base.identifier.type === "Identifier"
      ) {
        fnName = node.base.identifier.name;
      } else if (node.type === "MethodCallExpression" && node.method && node.method.type === "Identifier") {
        fnName = node.method.name;
      } else {
        return;
      }
      const params = functionParams.get(fnName) || [];
      const args = node.arguments;
      args.forEach((arg, index) => {
        const safeArg = isSafeArgumentExpr(arg);
        const paramName = index < params.length ? params[index] : null;
        const isLocalSortComparator = Boolean(
          arg &&
          (arg.type === "FunctionExpression" || arg.type === "FunctionDeclaration") &&
          node &&
          node.type === "CallExpression" &&
          node.base &&
          node.base.type === "MemberExpression" &&
          node.base.base &&
          node.base.base.type === "Identifier" &&
          node.base.base.name === "table" &&
          node.base.identifier &&
          node.base.identifier.type === "Identifier" &&
          node.base.identifier.name === "sort" &&
          Array.isArray(node.arguments) &&
          node.arguments[1] === arg &&
          node.arguments.length >= 2 &&
          (isSafeArgumentExpr(node.arguments[0]) || isSafeLocalTableExpr(node.arguments[0]))
        );
        if (safeArg && index < params.length) {
          let safeIndexes = hints.get(fnName);
          if (!safeIndexes) {
            safeIndexes = new Set();
            hints.set(fnName, safeIndexes);
          }
          safeIndexes.add(index);
        }
        if (
          arg &&
          (arg.type === "FunctionExpression" || arg.type === "FunctionDeclaration") &&
          typeof arg === "object" &&
          (
            safeArg ||
            isLocalSortComparator ||
            (typeof paramName === "string" && SAFE_CALLBACK_PARAM_NAME.test(paramName)) ||
            (
              node.type === "MethodCallExpression" &&
              node.method &&
              node.method.type === "Identifier" &&
              node.method.name === "register"
            ) ||
            (
              node.type === "CallExpression" &&
              node.base &&
              node.base.type === "MemberExpression" &&
              node.base.identifier &&
              node.base.identifier.type === "Identifier" &&
              node.base.identifier.name === "register"
            )
          )
        ) {
          const callbackSafeIndexes = getSafeCallbackParamIndexesForArgument(node, arg, safeArg, {
            isLocalSortComparator,
          });
          if (callbackSafeIndexes && callbackSafeIndexes.size) {
            if (!arg.__obf_safe_param_indexes) {
              arg.__obf_safe_param_indexes = new Set();
            }
            callbackSafeIndexes.forEach((safeIndex) => {
              arg.__obf_safe_param_indexes.add(safeIndex);
            });
          }
          if (
            (
              node.type === "MethodCallExpression" &&
              node.method &&
              node.method.type === "Identifier" &&
              node.method.name === "register"
            ) ||
            (
              node.type === "CallExpression" &&
              node.base &&
              node.base.type === "MemberExpression" &&
              node.base.identifier &&
              node.base.identifier.type === "Identifier" &&
              node.base.identifier.name === "register"
            )
          ) {
            arg.__obf_rename_return_table_fields = true;
          }
        }
      });
    });

  const topLevelBody = ast && Array.isArray(ast.body) ? ast.body : [];
  for (const stmt of topLevelBody) {
    const meta = getFunctionMeta(stmt);
    if (!meta || !meta.fnName || !meta.isMethod || !meta.ownerName || !constructorMembers.has(meta.ownerName)) {
      continue;
    }
    const safeVars = new Set(localTableVars);
    safeVars.add("self");
    visitDeep(stmt, (node) => {
      if (!node || typeof node !== "object") {
        return;
      }
      if (node === stmt) {
        return;
      }
      if (node.type === "LocalStatement") {
        const variables = Array.isArray(node.variables) ? node.variables : [];
        const init = Array.isArray(node.init) ? node.init : [];
        variables.forEach((variable, index) => {
          const varName = getIdentifierName(variable);
          if (
            varName &&
            isSafeLocalTableExpr(init[index], safeVars) &&
            (!isDynamicKeyMapAccessStatic(init[index], safeVars) || isDynamicMapRecordAccessStatic(init[index]))
          ) {
            safeVars.add(varName);
          }
        });
        return;
      }
      if (!Array.isArray(node.arguments)) {
        return;
      }
      let fnName = null;
      if (node.type === "CallExpression" && node.base && node.base.type === "Identifier") {
        fnName = node.base.name;
      } else if (node.type === "MethodCallExpression" && node.method && node.method.type === "Identifier") {
        fnName = node.method.name;
      } else {
        return;
      }
      const params = functionParams.get(fnName);
      if (!params || !params.length) {
        return;
      }
      node.arguments.forEach((arg, index) => {
        if (index >= params.length || !isSafeArgumentExpr(arg, safeVars)) {
          return;
        }
        let safeIndexes = hints.get(fnName);
        if (!safeIndexes) {
          safeIndexes = new Set();
          hints.set(fnName, safeIndexes);
        }
        safeIndexes.add(index);
      });
    });
  }

  return hints;
}

function hasConstructorMemberHint(ownerName, memberName, ctx) {
  if (!ctx || !ctx.constructorMemberHints || typeof ownerName !== "string" || typeof memberName !== "string") {
    return false;
  }
  const members = ctx.constructorMemberHints.get(ownerName);
  return Boolean(members && members.has(memberName));
}

function renameIdentifier(node, scope, ctx) {
  if (!node || node.type !== "Identifier") {
    return;
  }
  const mapped = resolveName(scope, node.name);
  if (mapped) {
    node.name = mapped;
    return;
  }
  if (ctx.renameGlobals && ctx.globals && ctx.globalDeclared && ctx.globalDeclared.has(node.name)) {
    node.name = defineGlobal(node.name, ctx);
  }
}

function renameMemberName(node, ctx) {
  if (!ctx.renameMembers || !node) {
    return;
  }
  const name = node.name;
  if (typeof name !== "string") {
    return;
  }
  if (name.startsWith(LUA_METAMETHOD_PREFIX)) {
    return;
  }
  let mapped = ctx.memberMap.get(name);
  if (!mapped) {
    mapped = defineMember(name, ctx);
  }
  if (ctx.dynamicIndexMemberNames && ctx.dynamicIndexMemberNames.has(name)) {
    ctx.dynamicIndexMemberNames.add(mapped);
  }
  if (ctx.dynamicIndexRecordMemberNames && ctx.dynamicIndexRecordMemberNames.has(name)) {
    ctx.dynamicIndexRecordMemberNames.add(mapped);
  }
  if (ctx.dynamicIndexRecordBaseMemberNames && ctx.dynamicIndexRecordBaseMemberNames.has(name)) {
    ctx.dynamicIndexRecordBaseMemberNames.add(mapped);
  }
  if (ctx.dynamicMapFunctionNames && ctx.dynamicMapFunctionNames.has(name)) {
    ctx.dynamicMapFunctionNames.add(mapped);
  }
  node.name = mapped;
}

function isDefinitelyLocalTable(expr, scope, ctx) {
  if (!expr || typeof expr !== "object") {
    return false;
  }
  if ((expr.type === "IndexExpression" || expr.type === "MemberExpression") && isDynamicMapRecordAccess(expr, scope, ctx)) {
    return true;
  }
  switch (expr.type) {
    case "TableConstructorExpression":
      return true;
    case "GroupExpression":
      return isDefinitelyLocalTable(expr.expression, scope, ctx);
    case "Identifier":
      if (resolveDynamicMapRecordAlias(scope, expr.name)) {
        return true;
      }
      return resolveMemberSafety(scope, expr.name);
    case "CallExpression":
      if (
        expr.base &&
        expr.base.type === "MemberExpression" &&
        expr.base.base &&
        expr.base.base.type === "Identifier" &&
        expr.base.identifier &&
        expr.base.identifier.type === "Identifier"
      ) {
        const memberName = expr.base.identifier.name;
        if (ctx.dynamicMapFunctionNames && ctx.dynamicMapFunctionNames.has(memberName)) {
          return false;
        }
        return isKnownConstructorMember(expr.base.base.name, expr.base.identifier.name, ctx);
      }
      return false;
    case "MemberExpression":
      return isDefinitelyLocalTable(expr.base, scope, ctx);
    case "IndexExpression":
      return isDefinitelyLocalTable(expr.base, scope, ctx);
    case "IfExpression":
      if (!Array.isArray(expr.clauses) || !expr.clauses.length) {
        return false;
      }
      if (!isDefinitelyLocalTable(expr.elseValue, scope, ctx)) {
        return false;
      }
      return expr.clauses.every((clause) => isDefinitelyLocalTable(clause.value, scope, ctx));
    default:
      return false;
  }
}

function isDynamicMapRecordAccess(expr, scope, ctx) {
  if (!expr || typeof expr !== "object" || !ctx || !ctx.dynamicIndexRecordBaseNames) {
    return false;
  }
  if (
    expr.type === "MemberExpression" &&
    expr.base &&
    expr.base.type === "Identifier" &&
    resolveDynamicMapRecordAlias(scope, expr.base.name)
  ) {
    return true;
  }
  if (
    expr.type === "MemberExpression" &&
    expr.identifier &&
    expr.identifier.type === "Identifier" &&
    ctx.dynamicIndexRecordMemberNames &&
    ctx.dynamicIndexRecordMemberNames.has(expr.identifier.name) &&
    isDefinitelyLocalTable(expr.base, scope, ctx)
  ) {
    return true;
  }
  if (expr.type === "MemberExpression" && isDynamicKeyMapAccess(expr.base, scope, ctx)) {
    const basePath = getMemberPath(expr.base);
    if (basePath && ctx.dynamicIndexRecordBaseNames.has(basePath)) {
      return true;
    }
    if (
      expr.base &&
      expr.base.type === "MemberExpression" &&
      expr.base.identifier &&
      expr.base.identifier.type === "Identifier" &&
      ctx.dynamicIndexRecordBaseMemberNames &&
      ctx.dynamicIndexRecordBaseMemberNames.has(expr.base.identifier.name) &&
      isDefinitelyLocalTable(expr.base.base, scope, ctx)
    ) {
      return true;
    }
  }
  if (expr.type === "IndexExpression") {
    if (isDynamicMapRecordAccess(expr.base, scope, ctx)) {
      return true;
    }
    if (
      expr.base &&
      expr.base.type === "MemberExpression" &&
      expr.base.identifier &&
      expr.base.identifier.type === "Identifier" &&
      ctx.dynamicIndexRecordBaseMemberNames &&
      ctx.dynamicIndexRecordBaseMemberNames.has(expr.base.identifier.name) &&
      isDefinitelyLocalTable(expr.base.base, scope, ctx)
    ) {
      return true;
    }
    const basePath = getMemberPath(expr.base);
    if (basePath && ctx.dynamicIndexRecordBaseNames.has(basePath)) {
      return true;
    }
    if (
      expr.index &&
      expr.index.type !== "StringLiteral" &&
      expr.index.type !== "NumericLiteral" &&
      expr.index.type !== "BooleanLiteral"
    ) {
      return Boolean(basePath && ctx.dynamicIndexRecordBaseNames.has(basePath));
    }
    return false;
  }
  if (expr.type === "MemberExpression") {
    return isDynamicMapRecordAccess(expr.base, scope, ctx);
  }
  return false;
}

function markLocalMemberSafety(scope, originalName, mappedName, safe) {
  if (!scope || !originalName) {
    return;
  }
  scope.memberSafe.set(originalName, Boolean(safe));
  if (mappedName) {
    scope.memberSafe.set(mappedName, Boolean(safe));
  }
}

function updateMemberSafetyFromAssignment(variable, value, scope, ctx) {
  if (!variable || variable.type !== "Identifier") {
    return;
  }
  const bindingScope = resolveBindingScope(scope, variable.name);
  if (!bindingScope) {
    return;
  }
  const mappedName = bindingScope.bindings.get(variable.name) || variable.name;
  const safe = isDefinitelyLocalTable(value, scope, ctx);
  markLocalMemberSafety(bindingScope, variable.name, mappedName, safe);
}

function shouldSkipMemberRename(base, scope, ctx) {
  if (resolveExternalShapePath(scope, base)) {
    traceRename(ctx, {
      kind: "skip-member-rename",
      reason: "external-shape-path",
      baseType: base && base.type ? base.type : null,
      basePath: getMemberPath(base),
    });
    return true;
  }
  if (isBuiltinLibBase(base, scope, ctx)) {
    traceRename(ctx, {
      kind: "skip-member-rename",
      reason: "builtin-lib-base",
      baseType: base && base.type ? base.type : null,
      basePath: getMemberPath(base),
    });
    return true;
  }
  if (isDynamicKeyMapAccess(base, scope, ctx) && !isDynamicMapRecordAccess(base, scope, ctx)) {
    const basePath = getMemberPath(base);
    if (
      base &&
      base.type === "MemberExpression" &&
      basePath &&
      base.base &&
      base.base.type === "Identifier" &&
      resolveDynamicMapRecordAlias(scope, base.base.name)
    ) {
      return false;
    }
    traceRename(ctx, {
      kind: "skip-member-rename",
      reason: "dynamic-key-map-access",
      baseType: base && base.type ? base.type : null,
      basePath,
    });
    return true;
  }
  if (!isDefinitelyLocalTable(base, scope, ctx)) {
    traceRename(ctx, {
      kind: "skip-member-rename",
      reason: "non-local-table-base",
      baseType: base && base.type ? base.type : null,
      basePath: getMemberPath(base),
    });
    return true;
  }
  return false;
}

function renameExpression(expr, scope, ctx, allowTableFieldRename = false) {
  if (!expr || typeof expr !== "object") {
    return;
  }
  switch (expr.type) {
    case "Identifier":
      renameIdentifier(expr, scope, ctx);
      return;
    case "BinaryExpression":
    case "LogicalExpression":
      renameExpression(expr.left, scope, ctx);
      renameExpression(expr.right, scope, ctx);
      return;
    case "UnaryExpression":
      renameExpression(expr.argument, scope, ctx);
      return;
    case "GroupExpression":
      renameExpression(expr.expression, scope, ctx);
      return;
    case "IndexExpression":
      renameExpression(expr.base, scope, ctx);
      renameExpression(expr.index, scope, ctx);
      return;
    case "MemberExpression":
      const skipMemberRename = shouldSkipMemberRename(expr.base, scope, ctx) || resolveExternalShapePath(scope, expr);
      renameExpression(expr.base, scope, ctx);
      if (!skipMemberRename) {
        renameMemberName(expr.identifier, ctx);
      }
      return;
    case "CallExpression":
      renameExpression(expr.base, scope, ctx);
      expr.arguments.forEach((arg) => {
        const allowTableFieldRename = shouldRenameCallArgumentFields(expr, arg, scope, ctx);
        renameExpression(arg, scope, ctx, allowTableFieldRename);
      });
      return;
    case "MethodCallExpression":
      const skipMethodRename = shouldSkipMemberRename(expr.base, scope, ctx);
      renameExpression(expr.base, scope, ctx);
      if (!skipMethodRename) {
        renameMemberName(expr.method, ctx);
      }
      expr.arguments.forEach((arg) => {
        const allowTableFieldRename = shouldRenameCallArgumentFields(expr, arg, scope, ctx);
        renameExpression(arg, scope, ctx, allowTableFieldRename);
      });
      return;
    case "TableCallExpression":
      renameExpression(expr.base, scope, ctx);
      renameExpression(expr.arguments, scope, ctx);
      return;
    case "StringCallExpression":
      renameExpression(expr.base, scope, ctx);
      renameExpression(expr.argument, scope, ctx);
      return;
    case "FunctionDeclaration":
      renameFunctionExpression(expr, scope, ctx);
      return;
    case "FunctionExpression":
      renameFunctionExpression(expr, scope, ctx);
      return;
    case "TableConstructorExpression":
      expr.fields.forEach((field) => renameTableField(field, scope, ctx, allowTableFieldRename));
      return;
    case "IfExpression":
      expr.clauses.forEach((clause) => {
        renameExpression(clause.condition, scope, ctx);
        renameExpression(clause.value, scope, ctx, allowTableFieldRename);
      });
      renameExpression(expr.elseValue, scope, ctx, allowTableFieldRename);
      return;
    case "TypeAssertion":
      renameExpression(expr.expression, scope, ctx, allowTableFieldRename);
      return;
    case "InterpolatedString":
      if (expr.parts && Array.isArray(expr.parts)) {
        expr.parts.forEach((part) => {
          if (part && part.type === "InterpolatedStringText") {
            return;
          }
          renameExpression(part, scope, ctx, allowTableFieldRename);
        });
      }
      return;
    case "TableKey":
      renameExpression(expr.key, scope, ctx);
      renameExpression(expr.value, scope, ctx, allowTableFieldRename);
      return;
    case "TableValue":
      renameExpression(expr.value, scope, ctx, allowTableFieldRename);
      return;
    case "TableKeyString":
      if (allowTableFieldRename && expr.key && expr.key.type === "Identifier") {
        renameMemberName(expr.key, ctx);
      }
      renameExpression(expr.value, scope, ctx, allowTableFieldRename);
      return;
    default:
      return;
  }
}

function renameTableField(field, scope, ctx, allowTableFieldRename = false) {
  if (!field || typeof field !== "object") {
    return;
  }
  if (field.type === "TableKey" || field.type === "TableKeyString" || field.type === "TableValue") {
    renameExpression(field, scope, ctx, allowTableFieldRename);
    return;
  }
  if (field.kind === "index") {
    renameExpression(field.key, scope, ctx);
    renameExpression(field.value, scope, ctx, allowTableFieldRename);
    return;
  }
  if (field.kind === "name") {
    if (allowTableFieldRename && field.name && field.name.type === "Identifier") {
      renameMemberName(field.name, ctx);
    }
    renameExpression(field.value, scope, ctx, allowTableFieldRename);
    return;
  }
  if (field.kind === "list") {
    renameExpression(field.value, scope, ctx, allowTableFieldRename);
  }
}

function shouldRenameTableFieldsForTarget(target, scope, ctx) {
  if (!target || typeof target !== "object") {
    return false;
  }
  if (isDynamicKeyMapAccess(target, scope, ctx)) {
    return false;
  }
  if (target.type === "Identifier") {
    if (ctx.dynamicIndexBaseNames && ctx.dynamicIndexBaseNames.has(target.name)) {
      return false;
    }
    if (ctx.externalSchemaLocalNames && ctx.externalSchemaLocalNames.has(target.name)) {
      return false;
    }
    return Boolean(resolveBindingScope(scope, target.name));
  }
  if (target.type === "MemberExpression" || target.type === "IndexExpression") {
    return isDefinitelyLocalTable(target.base, scope, ctx);
  }
  return false;
}

function shouldRenameLocalTableInitializer(variable, expr, scope, ctx) {
  if (!variable || variable.type !== "Identifier") {
    return false;
  }
  if (ctx.externalSchemaLocalNames && ctx.externalSchemaLocalNames.has(variable.name)) {
    return false;
  }
  if (ctx.dynamicIndexBaseNames && ctx.dynamicIndexBaseNames.has(variable.name)) {
    return false;
  }
  return isDefinitelyLocalTable(expr, scope, ctx);
}

function shouldRenameAssignedValueFieldsForTarget(target, value, scope, ctx) {
  if (shouldRenameTableFieldsForTarget(target, scope, ctx)) {
    return true;
  }
  if (isDynamicKeyMapAccess(target, scope, ctx) && isDefinitelyLocalTable(value, scope, ctx)) {
    return true;
  }
  return false;
}

function shouldRenameReturnedTableFields(scope) {
  let current = scope;
  while (current) {
    if (current.shouldRenameReturnTableFields) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function shouldRenameCallArgumentFields(callExpr, arg, scope, ctx) {
  if (!callExpr || !arg || arg.type !== "TableConstructorExpression") {
    return false;
  }
  if (callExpr.type === "CallExpression") {
    const base = callExpr.base;
    const args = Array.isArray(callExpr.arguments) ? callExpr.arguments : [];
    return Boolean(
      base &&
      base.type === "MemberExpression" &&
      base.base &&
      base.base.type === "Identifier" &&
      base.base.name === "table" &&
      base.identifier &&
      base.identifier.type === "Identifier" &&
      base.identifier.name === "insert" &&
      args.length >= 2 &&
      arg === args[1] &&
      isDefinitelyLocalTable(args[0], scope, ctx)
    );
  }
  if (callExpr.type === "MethodCallExpression") {
    const args = Array.isArray(callExpr.arguments) ? callExpr.arguments : [];
    return Boolean(
      callExpr.method &&
      callExpr.method.type === "Identifier" &&
      callExpr.method.name === "insert" &&
      args.length >= 1 &&
      arg === args[0] &&
      isDefinitelyLocalTable(callExpr.base, scope, ctx)
    );
  }
  return false;
}

function getSafeCallbackParamIndexesForArgument(callExpr, arg, safeArg, options = {}) {
  if (!arg || (arg.type !== "FunctionExpression" && arg.type !== "FunctionDeclaration")) {
    return null;
  }
  if (safeArg && Array.isArray(arg.parameters)) {
    const safeIndexes = new Set();
    for (let paramIndex = 0; paramIndex < arg.parameters.length; paramIndex += 1) {
      safeIndexes.add(paramIndex);
    }
    return safeIndexes;
  }

  const safeIndexes = new Set();
  if (Array.isArray(arg.parameters)) {
    arg.parameters.forEach((param, paramIndex) => {
      const nestedName = getIdentifierName(param);
      if (nestedName && SAFE_FUNCTION_EXPR_PARAM_NAME.test(nestedName)) {
        safeIndexes.add(paramIndex);
      }
    });
  }

  const isRegisterMethodCallback = Boolean(
    callExpr &&
    callExpr.type === "MethodCallExpression" &&
    callExpr.method &&
    callExpr.method.type === "Identifier" &&
    callExpr.method.name === "register" &&
    Array.isArray(callExpr.arguments) &&
    callExpr.arguments[1] === arg
  );
  const isRegisterCallCallback = Boolean(
    callExpr &&
    callExpr.type === "CallExpression" &&
    callExpr.base &&
    callExpr.base.type === "MemberExpression" &&
    callExpr.base.identifier &&
    callExpr.base.identifier.type === "Identifier" &&
    callExpr.base.identifier.name === "register" &&
    Array.isArray(callExpr.arguments) &&
    callExpr.arguments[2] === arg
  );
  if (isRegisterMethodCallback || isRegisterCallCallback) {
    [0, 2, 3].forEach((index) => {
      if (Array.isArray(arg.parameters) && index < arg.parameters.length) {
        safeIndexes.add(index);
      }
    });
    safeIndexes.delete(1);
  }

  if (options.isLocalSortComparator && Array.isArray(arg.parameters)) {
    for (let paramIndex = 0; paramIndex < arg.parameters.length; paramIndex += 1) {
      safeIndexes.add(paramIndex);
    }
  }

  return safeIndexes.size ? safeIndexes : null;
}

function getSafeForGenericValueIndexes(stmt, scope, ctx) {
  const safeIndexes = new Set();
  const iterators = Array.isArray(stmt && stmt.iterators) ? stmt.iterators : [];
  if (iterators.length !== 1) {
    return safeIndexes;
  }
  const iterator = iterators[0];
  if (!iterator || iterator.type !== "CallExpression" || !iterator.base || !Array.isArray(iterator.arguments)) {
    return safeIndexes;
  }
  if (iterator.base.type !== "Identifier" || (iterator.base.name !== "ipairs" && iterator.base.name !== "pairs")) {
    return safeIndexes;
  }
  if (iterator.arguments.length < 1 || !isDefinitelyLocalTable(iterator.arguments[0], scope, ctx)) {
    return safeIndexes;
  }
  const variables = Array.isArray(stmt && stmt.variables) ? stmt.variables : [];
  if (variables.length >= 2) {
    safeIndexes.add(1);
  }
  return safeIndexes;
}

function getExternalShapeForGenericValueIndexes(stmt, scope) {
  const safeIndexes = new Set();
  const iterators = Array.isArray(stmt && stmt.iterators) ? stmt.iterators : [];
  if (iterators.length !== 1) {
    return safeIndexes;
  }
  const iterator = iterators[0];
  if (!iterator || iterator.type !== "CallExpression" || !iterator.base || !Array.isArray(iterator.arguments)) {
    return safeIndexes;
  }
  if (iterator.base.type !== "Identifier" || (iterator.base.name !== "ipairs" && iterator.base.name !== "pairs")) {
    return safeIndexes;
  }
  if (iterator.arguments.length < 1 || !isExternalShapeValueSource(iterator.arguments[0], scope)) {
    return safeIndexes;
  }
  const variables = Array.isArray(stmt && stmt.variables) ? stmt.variables : [];
  if (variables.length >= 2) {
    safeIndexes.add(1);
  }
  return safeIndexes;
}

function isDynamicMapAliasInitializer(expr, scope, ctx) {
  return isDynamicKeyMapAccess(expr, scope, ctx) && !isDynamicMapRecordAccess(expr, scope, ctx);
}

function renameStatementList(body, scope, ctx) {
  for (const stmt of body) {
    renameStatement(stmt, scope, ctx);
  }
}

function renameStatement(stmt, scope, ctx) {
  if (!stmt || typeof stmt !== "object") {
    return;
  }
  switch (stmt.type) {
    case "LocalStatement": {
      if (stmt.init && stmt.init.length) {
        stmt.init.forEach((expr, index) => {
          const variable = Array.isArray(stmt.variables) ? stmt.variables[index] : null;
          const allowTableFieldRename =
            (expr && expr.type === "TableConstructorExpression" && shouldRenameReturnedTableFields(scope)) ||
            shouldRenameLocalTableInitializer(variable, expr, scope, ctx) ||
            shouldRenameTableFieldsForTarget(variable, scope, ctx);
          renameExpression(expr, scope, ctx, allowTableFieldRename);
        });
      }
      stmt.variables.forEach((variable, index) => {
        if (!variable || variable.type !== "Identifier") {
          return;
        }
        const originalName = variable.name;
        const initExpr = Array.isArray(stmt.init) ? stmt.init[index] : null;
        const safe = !(ctx.externalSchemaLocalNames && ctx.externalSchemaLocalNames.has(originalName))
          && !isDynamicMapAliasInitializer(initExpr, scope, ctx)
          && isDefinitelyLocalTable(initExpr, scope, ctx);
        const newName = defineName(scope, originalName, ctx);
        markLocalMemberSafety(scope, originalName, newName, safe);
        variable.name = newName;
        if (isDynamicMapFunctionCall(initExpr, ctx)) {
          markDynamicMapRecordAlias(scope, originalName, newName, ctx);
        }
        if (shouldPropagateExternalShapeFromValue(initExpr, scope)) {
          markExternalShapeBinding(scope, originalName, newName);
        }
      });
      return;
    }
    case "AssignmentStatement":
      stmt.variables.forEach((variable, index) => {
        const value = Array.isArray(stmt.init) ? stmt.init[index] : null;
        updateMemberSafetyFromAssignment(variable, value, scope, ctx);
        if (shouldPropagateExternalShapeFromValue(value, scope)) {
          markExternalShapePath(scope, variable);
        }
      });
      stmt.variables.forEach((variable) => renameExpression(variable, scope, ctx));
      stmt.init.forEach((expr, index) => {
        const variable = Array.isArray(stmt.variables) ? stmt.variables[index] : null;
        const allowTableFieldRename = shouldRenameAssignedValueFieldsForTarget(variable, expr, scope, ctx);
        renameExpression(expr, scope, ctx, allowTableFieldRename);
      });
      return;
    case "CompoundAssignmentStatement":
      renameExpression(stmt.variable, scope, ctx);
      renameExpression(stmt.value, scope, ctx);
      return;
    case "CallStatement":
      renameExpression(stmt.expression, scope, ctx);
      return;
    case "ReturnStatement":
      stmt.arguments.forEach((expr) => {
        const allowTableFieldRename =
          expr && expr.type === "TableConstructorExpression" && shouldRenameReturnedTableFields(scope);
        renameExpression(expr, scope, ctx, allowTableFieldRename);
      });
      return;
    case "FunctionDeclaration":
      renameFunctionDeclaration(stmt, scope, ctx);
      return;
    case "BreakStatement":
    case "ContinueStatement":
      return;
    case "WhileStatement":
      renameExpression(stmt.condition, scope, ctx);
      renameScopedBody(stmt.body, scope, ctx);
      return;
    case "RepeatStatement": {
      const repeatScope = createScope(scope);
      const body = stmt.body || [];
      if (Array.isArray(body)) {
        renameStatementList(body, repeatScope, ctx);
      } else if (body && body.body) {
        renameStatementList(body.body, repeatScope, ctx);
      }
      renameExpression(stmt.condition, repeatScope, ctx);
      return;
    }
    case "ForNumericStatement": {
      renameExpression(stmt.start, scope, ctx);
      renameExpression(stmt.end, scope, ctx);
      if (stmt.step) {
        renameExpression(stmt.step, scope, ctx);
      }
      const loopScope = createScope(scope);
      if (stmt.variable && stmt.variable.type === "Identifier") {
        const originalName = stmt.variable.name;
        const newName = defineName(loopScope, originalName, ctx);
        markLocalMemberSafety(loopScope, originalName, newName, false);
        stmt.variable.name = newName;
      }
      renameScopedBody(stmt.body, loopScope, ctx);
      return;
    }
    case "ForGenericStatement": {
      stmt.iterators.forEach((expr) => renameExpression(expr, scope, ctx));
      const loopScope = createScope(scope);
      const safeIndexes = getSafeForGenericValueIndexes(stmt, scope, ctx);
      const externalShapeIndexes = getExternalShapeForGenericValueIndexes(stmt, scope);
      stmt.variables.forEach((variable, index) => {
        if (!variable || variable.type !== "Identifier") {
          return;
        }
        const originalName = variable.name;
        const newName = defineName(loopScope, originalName, ctx);
        markLocalMemberSafety(loopScope, originalName, newName, safeIndexes.has(index));
        variable.name = newName;
        if (externalShapeIndexes.has(index)) {
          markExternalShapeBinding(loopScope, originalName, newName);
        }
      });
      renameScopedBody(stmt.body, loopScope, ctx);
      return;
    }
    case "DoStatement":
      renameScopedBody(stmt.body, scope, ctx);
      return;
    case "IfStatement":
      renameIfStatement(stmt, scope, ctx);
      return;
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

function renameScopedBody(body, parentScope, ctx) {
  const scope = createScope(parentScope);
  if (Array.isArray(body)) {
    renameStatementList(body, scope, ctx);
    return;
  }
  if (body && Array.isArray(body.body)) {
    renameStatementList(body.body, scope, ctx);
  }
}

function renameFunctionDeclaration(stmt, scope, ctx) {
  let isLocal = Boolean(stmt.isLocal);
  let fnId = null;
  let fnMember = null;
  let fnOriginalName = null;

  if (stmt.name && stmt.name.type === "FunctionName") {
    if (stmt.isLocal && stmt.name.base && stmt.name.base.type === "Identifier") {
      fnId = stmt.name.base;
    } else {
      isLocal = false;
      fnMember = stmt.name;
    }
  } else if (stmt.identifier && stmt.identifier.type === "Identifier") {
    fnId = stmt.identifier;
  } else if (stmt.identifier && stmt.identifier.type === "MemberExpression") {
    isLocal = false;
    fnMember = stmt.identifier;
  }

  if (isLocal && fnId) {
    const originalName = fnId.name;
    fnOriginalName = originalName;
    const newName = defineName(scope, originalName, ctx);
    markLocalMemberSafety(scope, originalName, newName, false);
    fnId.name = newName;
  } else if (!isLocal && fnId && ctx.renameGlobals && ctx.globalDeclared.has(fnId.name)) {
    fnId.name = defineGlobal(fnId.name, ctx);
  } else if (!isLocal && fnId) {
    fnOriginalName = fnId.name;
  }

  if (fnMember) {
    if (fnMember.type === "FunctionName") {
      const ownerOriginalName = getIdentifierName(fnMember.base);
      const constructorMemberNode = fnMember.method || (Array.isArray(fnMember.members) ? fnMember.members[fnMember.members.length - 1] : null);
      const constructorMemberOriginalName = getIdentifierName(constructorMemberNode);
      fnOriginalName = constructorMemberOriginalName;
      const returnsLocalTableLike = ownerOriginalName
        ? hasConstructorMemberHint(ownerOriginalName, constructorMemberOriginalName, ctx) || functionReturnsLocalTableLike(stmt, ownerOriginalName)
        : false;
      const skipMemberRename = shouldSkipMemberRename(fnMember.base, scope, ctx);
      renameIdentifier(fnMember.base, scope, ctx);
      if (ctx.renameMembers && Array.isArray(fnMember.members) && !skipMemberRename) {
        fnMember.members.forEach((member) => renameMemberName(member, ctx));
      }
      if (ctx.renameMembers && fnMember.method && !skipMemberRename) {
        renameMemberName(fnMember.method, ctx);
      }
      if (returnsLocalTableLike && constructorMemberOriginalName) {
        registerConstructorMember(
          ctx,
          [ownerOriginalName, getIdentifierName(fnMember.base)],
          [constructorMemberOriginalName, getIdentifierName(constructorMemberNode)]
        );
      }
    } else if (fnMember.type === "MemberExpression") {
      const skipMemberRename = shouldSkipMemberRename(fnMember.base, scope, ctx);
      renameExpression(fnMember.base, scope, ctx);
      if (!skipMemberRename) {
        renameMemberName(fnMember.identifier, ctx);
      }
    }
  }

  const fnScope = createScope(scope);
  if (fnMember && fnMember.type === "FunctionName" && fnMember.method) {
    fnScope.bindings.set("self", "self");
    const skipImplicitSelfMemberRename = shouldSkipMemberRename(fnMember.base, scope, ctx);
    if (!skipImplicitSelfMemberRename) {
      markLocalMemberSafety(fnScope, "self", "self", true);
    }
  }
  if (stmt.parameters && stmt.parameters.length) {
    const safeParameterIndexes =
      fnOriginalName && ctx.safeFunctionParameterHints
        ? ctx.safeFunctionParameterHints.get(fnOriginalName) || null
        : null;
    stmt.parameters.forEach((param, index) => {
      if (param && param.type === "Identifier") {
        const originalName = param.name;
        const newName = defineName(fnScope, originalName, ctx);
        const safe = Boolean(safeParameterIndexes && safeParameterIndexes.has(Array.isArray(stmt.parameters) ? stmt.parameters.indexOf(param) : -1));
        markLocalMemberSafety(fnScope, originalName, newName, safe);
        param.name = newName;
        if (EXTERNAL_SCHEMA_PARAM_NAME.test(originalName) && !safe) {
          markExternalShapeBinding(fnScope, originalName, newName);
        }
        if (fnOriginalName === "register" && index === 0 && originalName === "deps") {
          markExternalShapeMemberBinding(fnScope, originalName, newName, "input");
        }
      }
    });
  }
  if (stmt.body) {
    if (Array.isArray(stmt.body)) {
      renameStatementList(stmt.body, fnScope, ctx);
    } else if (stmt.body.body && Array.isArray(stmt.body.body)) {
      renameStatementList(stmt.body.body, fnScope, ctx);
    }
  }
}

function renameFunctionExpression(expr, scope, ctx) {
  const fnScope = createScope(scope);
  if (expr.__obf_rename_return_table_fields) {
    fnScope.shouldRenameReturnTableFields = true;
  }
  const isRegisterStyleCallback = Boolean(
    expr.__obf_safe_param_indexes &&
    expr.__obf_safe_param_indexes instanceof Set &&
    (expr.__obf_safe_param_indexes.has(0) || expr.__obf_safe_param_indexes.has(2) || expr.__obf_safe_param_indexes.has(3))
  );
  if (expr.parameters && expr.parameters.length) {
    const safeParameterIndexes = expr.__obf_safe_param_indexes || null;
    expr.parameters.forEach((param, index) => {
      if (param && param.type === "Identifier") {
        const originalName = param.name;
        const newName = defineName(fnScope, originalName, ctx);
        const safe = Boolean(safeParameterIndexes && safeParameterIndexes.has(index));
        markLocalMemberSafety(fnScope, originalName, newName, safe);
        param.name = newName;
        if (EXTERNAL_SCHEMA_PARAM_NAME.test(originalName) && !safe) {
          markExternalShapeBinding(fnScope, originalName, newName);
        }
        if (isRegisterStyleCallback && index === 0 && originalName === "deps") {
          markExternalShapeMemberBinding(fnScope, originalName, newName, "input");
        }
      }
    });
  }
  if (expr.body) {
    if (Array.isArray(expr.body)) {
      renameStatementList(expr.body, fnScope, ctx);
    } else if (expr.body.body && Array.isArray(expr.body.body)) {
      renameStatementList(expr.body.body, fnScope, ctx);
    }
  }
}

function renameIfStatement(stmt, scope, ctx) {
  if (!stmt.clauses || !stmt.clauses.length) {
    return;
  }
  const firstClause = stmt.clauses[0];
  if (firstClause && typeof firstClause.type === "string") {
    stmt.clauses.forEach((clause) => {
      if (clause.type !== "ElseClause") {
        renameExpression(clause.condition, scope, ctx);
      }
      const clauseScope = createScope(scope);
      renameStatementList(clause.body, clauseScope, ctx);
    });
    return;
  }
  stmt.clauses.forEach((clause) => {
    renameExpression(clause.condition, scope, ctx);
    const clauseScope = createScope(scope);
    if (clause.body && clause.body.body) {
      renameStatementList(clause.body.body, clauseScope, ctx);
    }
  });
  if (stmt.elseBody) {
    const elseScope = createScope(scope);
    if (stmt.elseBody.body) {
      renameStatementList(stmt.elseBody.body, elseScope, ctx);
    }
  }
}

function renameLuau(ast, ctx) {
  const userReserved = ctx.options.renameOptions?.reserved || [];
  const preserveTopReturnNames = ctx.options.renameOptions?.preserveTopReturnNames !== false;
  const topReturnExportNames = preserveTopReturnNames ? collectTopReturnExportNames(ast) : new Set();
  const reserved = new Set([
    ...LUA_KEYWORDS,
    ...LUA_RESERVED_GLOBALS,
    ...userReserved,
  ]);
  const used = collectIdentifiers(ast);
  const readNames =
    ctx && typeof ctx.getSSA === "function"
      ? getCachedSSAReadNamesFromRoot(ctx.getSSA())
      : null;
  const useHomoglyphs = Boolean(ctx.options.renameOptions?.homoglyphs);
  const alphabets = useHomoglyphs
    ? { first: "lI", rest: "lI1" }
    : null;
  const generator = new LuaNameGenerator({
    rng: ctx.rng,
    reserved: [...reserved, ...used],
    alphabets,
  });
  const renameGlobals = Boolean(ctx.options.renameOptions?.renameGlobals);
  const renameMembers = Boolean(ctx.options.renameOptions?.renameMembers);
  const globalDeclared = renameGlobals ? collectGlobalBindings(ast) : new Set();
  const envAliasName = ast && typeof ast.__obf_env_alias_name === "string" ? ast.__obf_env_alias_name : null;
  const dynamicIndexBaseNames = ctx.dynamicIndexBaseNames || collectDynamicIndexBaseNames(ast);
  const dynamicIndexRecordBaseNames = ctx.dynamicIndexRecordBaseNames || collectDynamicIndexRecordBaseNames(ast);
  const dynamicIndexRecordBaseMemberNames =
    ctx.dynamicIndexRecordBaseMemberNames || collectDynamicIndexRecordBaseMemberNames(ast);
  const dynamicIndexRecordMemberNames = ctx.dynamicIndexRecordMemberNames || collectDynamicIndexRecordMemberNames(ast);
  const dynamicIndexMemberNames = ctx.dynamicIndexMemberNames || collectDynamicIndexMemberNames(ast);
  const externalSchemaLocalNames = ctx.externalSchemaLocalNames || collectExternalSchemaLocalNames(ast);
  const dynamicMapFunctionNames = new Set();
  walk(ast, (stmt) => {
    if (!stmt || stmt.type !== "FunctionDeclaration") {
      return;
    }
    if (!functionReturnsDynamicKeyMap(stmt)) {
      return;
    }
    let fnName = null;
    if (stmt.name && stmt.name.type === "FunctionName") {
      fnName = getIdentifierName(
        stmt.name.method || (Array.isArray(stmt.name.members) ? stmt.name.members[stmt.name.members.length - 1] : stmt.name.base)
      );
    } else if (stmt.identifier && stmt.identifier.type === "Identifier") {
      fnName = stmt.identifier.name;
    }
    if (fnName) {
      dynamicMapFunctionNames.add(fnName);
    }
  });
  const safeFunctionParameterHints = ctx.safeFunctionParameterHints || collectSafeFunctionParameterHints(ast);
  const state = {
    generator,
    reserved,
    used: new Set(used),
    globals: new Map(),
    globalDeclared,
    renameGlobals,
    renameMembers,
    memberMap: new Map(),
    constructorMembers: new Map(),
    dynamicIndexBaseNames,
    dynamicIndexRecordBaseNames,
    dynamicIndexRecordBaseMemberNames,
    dynamicIndexRecordMemberNames,
    dynamicIndexMemberNames,
    externalSchemaLocalNames,
    dynamicMapFunctionNames,
    safeFunctionParameterHints,
    readNames,
    envAliasName,
    topReturnExportNames,
    debugTrace: ctx.debugTrace,
  };
  const rootScope = createScope(null);
  rootScope.isRoot = true;
  if (Array.isArray(ast.body)) {
    renameStatementList(ast.body, rootScope, state);
  }
}

module.exports = {
  collectConstructorMemberHints,
  collectDynamicIndexBaseNames,
  collectDynamicIndexRecordBaseNames,
  collectDynamicIndexRecordBaseMemberNames,
  collectDynamicIndexRecordMemberNames,
  collectDynamicIndexMemberNames,
  collectExternalSchemaLocalNames,
  collectSafeFunctionParameterHints,
  renameLuau,
};
