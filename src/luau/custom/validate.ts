// @ts-nocheck
function isNode(value) {
  return value && typeof value === "object" && typeof value.type === "string";
}

const { normalizeLegacyNodeShape } = require("./compat");

function isIdentifier(node) {
  return isNode(node) && node.type === "Identifier" && typeof node.name === "string";
}

function ensure(condition, errors, message) {
  if (!condition) {
    errors.push(message);
  }
}

function ensureArray(value, errors, path) {
  ensure(Array.isArray(value), errors, `${path} must be an array`);
}

function ensureNode(value, errors, path) {
  ensure(isNode(value), errors, `${path} must be a node`);
}

function ensureOptionalNode(value, errors, path) {
  if (value !== null && value !== undefined) {
    ensureNode(value, errors, path);
  }
}

function ensureString(value, errors, path) {
  ensure(typeof value === "string", errors, `${path} must be a string`);
}

function ensureBoolean(value, errors, path) {
  ensure(typeof value === "boolean", errors, `${path} must be a boolean`);
}

function ensureArrayOfNodes(value, errors, path) {
  ensureArray(value, errors, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      ensureNode(item, errors, `${path}[${index}]`);
    });
  }
}

function validateNode(node, errors, path) {
  if (!isNode(node)) {
    errors.push(`${path} is not a node`);
    return;
  }
  switch (node.type) {
    case "Chunk":
    case "Block":
      ensureArray(node.body, errors, `${path}.body`);
      return;
    case "LocalStatement":
      ensureArrayOfNodes(node.variables, errors, `${path}.variables`);
      ensureArray(node.init, errors, `${path}.init`);
      if (node.isConst !== undefined) {
        ensureBoolean(node.isConst, errors, `${path}.isConst`);
      }
      return;
    case "AssignmentStatement":
      ensureArrayOfNodes(node.variables, errors, `${path}.variables`);
      ensureArrayOfNodes(node.init, errors, `${path}.init`);
      return;
    case "CompoundAssignmentStatement":
      ensureString(node.operator, errors, `${path}.operator`);
      ensureNode(node.variable, errors, `${path}.variable`);
      ensureNode(node.value, errors, `${path}.value`);
      return;
    case "CallStatement":
      ensureNode(node.expression, errors, `${path}.expression`);
      return;
    case "FunctionDeclaration":
      ensureNode(node.name, errors, `${path}.name`);
      ensureArrayOfNodes(node.parameters, errors, `${path}.parameters`);
      ensureBoolean(node.isLocal, errors, `${path}.isLocal`);
      if (node.isConst !== undefined) {
        ensureBoolean(node.isConst, errors, `${path}.isConst`);
      }
      ensureNode(node.body, errors, `${path}.body`);
      return;
    case "FunctionExpression":
      ensureArrayOfNodes(node.parameters, errors, `${path}.parameters`);
      ensureNode(node.body, errors, `${path}.body`);
      return;
    case "IfStatement":
      ensureArray(node.clauses, errors, `${path}.clauses`);
      ensureOptionalNode(node.elseBody, errors, `${path}.elseBody`);
      return;
    case "IfExpression":
      ensureArray(node.clauses, errors, `${path}.clauses`);
      ensureNode(node.elseValue, errors, `${path}.elseValue`);
      return;
    case "WhileStatement":
      ensureNode(node.condition, errors, `${path}.condition`);
      ensureNode(node.body, errors, `${path}.body`);
      return;
    case "RepeatStatement":
      ensureNode(node.condition, errors, `${path}.condition`);
      ensureNode(node.body, errors, `${path}.body`);
      return;
    case "ForNumericStatement":
      ensureNode(node.variable, errors, `${path}.variable`);
      ensureNode(node.start, errors, `${path}.start`);
      ensureNode(node.end, errors, `${path}.end`);
      ensureOptionalNode(node.step, errors, `${path}.step`);
      ensureNode(node.body, errors, `${path}.body`);
      return;
    case "ForGenericStatement":
      ensureArrayOfNodes(node.variables, errors, `${path}.variables`);
      ensureArrayOfNodes(node.iterators, errors, `${path}.iterators`);
      ensureNode(node.body, errors, `${path}.body`);
      return;
    case "DoStatement":
      ensureNode(node.body, errors, `${path}.body`);
      return;
    case "ReturnStatement":
      ensureArrayOfNodes(node.arguments, errors, `${path}.arguments`);
      return;
    case "BreakStatement":
    case "ContinueStatement":
      return;
    case "LabelStatement":
    case "GotoStatement":
      ensureNode(node.name, errors, `${path}.name`);
      return;
    case "TypeAliasStatement":
    case "ExportTypeStatement":
      ensureNode(node.name, errors, `${path}.name`);
      ensureArray(node.typeParameters, errors, `${path}.typeParameters`);
      ensureNode(node.value, errors, `${path}.value`);
      return;
    case "TypeFunctionStatement":
    case "ExportTypeFunctionStatement":
      ensureNode(node.name, errors, `${path}.name`);
      ensureArray(node.typeParameters, errors, `${path}.typeParameters`);
      ensureArrayOfNodes(node.parameters, errors, `${path}.parameters`);
      ensureNode(node.body, errors, `${path}.body`);
      return;
    case "DeclareFunctionStatement":
      ensureNode(node.name, errors, `${path}.name`);
      ensureArray(node.typeParameters, errors, `${path}.typeParameters`);
      ensureArrayOfNodes(node.parameters, errors, `${path}.parameters`);
      ensureOptionalNode(node.returnType, errors, `${path}.returnType`);
      return;
    case "DeclareVariableStatement":
      ensureNode(node.name, errors, `${path}.name`);
      ensureNode(node.annotation, errors, `${path}.annotation`);
      return;
    case "DeclareExternTypeStatement":
      ensureString(node.declarationKind, errors, `${path}.declarationKind`);
      ensureNode(node.name, errors, `${path}.name`);
      ensureOptionalNode(node.superName, errors, `${path}.superName`);
      ensureArrayOfNodes(node.props, errors, `${path}.props`);
      ensureOptionalNode(node.indexer, errors, `${path}.indexer`);
      return;
    case "DeclareExternTypeProperty":
      ensureString(node.kind, errors, `${path}.kind`);
      ensureNode(node.name, errors, `${path}.name`);
      if (node.kind === "method") {
        ensureArrayOfNodes(node.parameters, errors, `${path}.parameters`);
        ensureOptionalNode(node.returnType, errors, `${path}.returnType`);
      } else {
        ensureNode(node.value, errors, `${path}.value`);
      }
      return;
    case "DeclareExternTypeIndexer":
      ensureNode(node.key, errors, `${path}.key`);
      ensureNode(node.value, errors, `${path}.value`);
      return;
    case "FunctionName":
      ensureNode(node.base, errors, `${path}.base`);
      ensureArrayOfNodes(node.members, errors, `${path}.members`);
      ensureOptionalNode(node.method, errors, `${path}.method`);
      return;
    case "Attribute":
      ensureNode(node.name, errors, `${path}.name`);
      if (node.arguments !== null && node.arguments !== undefined) {
        ensureArrayOfNodes(node.arguments, errors, `${path}.arguments`);
      }
      return;
    case "Identifier":
      ensureString(node.name, errors, `${path}.name`);
      return;
    case "NumericLiteral":
      ensure(typeof node.value === "number" || typeof node.raw === "string", errors, `${path} needs value/raw`);
      return;
    case "StringLiteral":
      ensureString(node.raw, errors, `${path}.raw`);
      return;
    case "InterpolatedString":
      if (node.raw !== undefined) {
        ensureString(node.raw, errors, `${path}.raw`);
      } else {
        ensureArray(node.parts, errors, `${path}.parts`);
      }
      return;
    case "InterpolatedStringText":
      ensureString(node.raw, errors, `${path}.raw`);
      return;
    case "BooleanLiteral":
      ensureBoolean(node.value, errors, `${path}.value`);
      return;
    case "NilLiteral":
    case "VarargLiteral":
      return;
    case "UnaryExpression":
      ensureString(node.operator, errors, `${path}.operator`);
      ensureNode(node.argument, errors, `${path}.argument`);
      return;
    case "BinaryExpression":
      ensureString(node.operator, errors, `${path}.operator`);
      ensureNode(node.left, errors, `${path}.left`);
      ensureNode(node.right, errors, `${path}.right`);
      return;
    case "TypeAssertion":
      ensureNode(node.expression, errors, `${path}.expression`);
      ensureNode(node.annotation, errors, `${path}.annotation`);
      return;
    case "GroupExpression":
      ensureNode(node.expression, errors, `${path}.expression`);
      return;
    case "MemberExpression":
      ensureNode(node.base, errors, `${path}.base`);
      ensureNode(node.identifier, errors, `${path}.identifier`);
      return;
    case "IndexExpression":
      ensureNode(node.base, errors, `${path}.base`);
      ensureNode(node.index, errors, `${path}.index`);
      return;
    case "CallExpression":
    case "MethodCallExpression":
      ensureNode(node.base, errors, `${path}.base`);
      ensureArrayOfNodes(node.arguments, errors, `${path}.arguments`);
      return;
    case "TableConstructorExpression":
      ensureArrayOfNodes(node.fields, errors, `${path}.fields`);
      return;
    case "TableField":
      ensureString(node.kind, errors, `${path}.kind`);
      if (node.kind === "index") {
        ensureNode(node.key, errors, `${path}.key`);
        ensureNode(node.value, errors, `${path}.value`);
      } else if (node.kind === "name") {
        ensureNode(node.name, errors, `${path}.name`);
        ensureNode(node.value, errors, `${path}.value`);
      } else if (node.kind === "list") {
        ensureNode(node.value, errors, `${path}.value`);
      }
      return;
    case "UnionType":
    case "IntersectionType":
      ensureArrayOfNodes(node.types, errors, `${path}.types`);
      return;
    case "OptionalType":
      ensureNode(node.base, errors, `${path}.base`);
      return;
    case "TypePack":
    case "VariadicType":
      ensureNode(node.value, errors, `${path}.value`);
      return;
    case "TypeLiteral":
      ensureString(node.raw, errors, `${path}.raw`);
      return;
    case "TypeofType":
      ensureNode(node.expression, errors, `${path}.expression`);
      return;
    case "TypeReference":
      ensure(Array.isArray(node.name), errors, `${path}.name must be array`);
      ensureArray(node.typeArguments ?? [], errors, `${path}.typeArguments`);
      return;
    case "TableType":
      ensureArrayOfNodes(node.fields, errors, `${path}.fields`);
      return;
    case "TableTypeField":
      ensureString(node.kind, errors, `${path}.kind`);
      if (node.kind === "index") {
        ensureNode(node.key, errors, `${path}.key`);
        ensureNode(node.value, errors, `${path}.value`);
      } else if (node.kind === "name") {
        ensureNode(node.name, errors, `${path}.name`);
        ensureNode(node.value, errors, `${path}.value`);
      } else if (node.kind === "list") {
        ensureNode(node.value, errors, `${path}.value`);
      }
      return;
    case "FunctionType":
      ensureArrayOfNodes(node.parameters, errors, `${path}.parameters`);
      ensureArrayOfNodes(node.returnTypes, errors, `${path}.returnTypes`);
      return;
    case "ParenthesizedType":
      ensureNode(node.value, errors, `${path}.value`);
      return;
    case "TupleType":
      ensureArrayOfNodes(node.items, errors, `${path}.items`);
      return;
    case "TypeParameter":
      ensureOptionalNode(node.name, errors, `${path}.name`);
      ensureNode(node.value, errors, `${path}.value`);
      return;
    default:
      return;
  }
}

function collectChildren(node) {
  const children = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range") {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (isNode(item)) {
          children.push(item);
        }
      });
      continue;
    }
    if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

function checkTerminators(body, errors, path) {
  if (!Array.isArray(body)) {
    return;
  }
  for (let i = 0; i < body.length - 1; i += 1) {
    const stmt = body[i];
    if (!isNode(stmt)) {
      continue;
    }
    if (stmt.type === "ReturnStatement" || stmt.type === "BreakStatement" || stmt.type === "ContinueStatement") {
      errors.push(`${path}[${i}] ${stmt.type} must be last statement in block`);
    }
  }
}

function collectFunctionRoots(node, roots, path = "root") {
  if (!isNode(node)) {
    return;
  }
  if (node.type === "Chunk") {
    roots.push({ node, body: node.body, path });
  }
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "TypeFunctionStatement" ||
    node.type === "ExportTypeFunctionStatement"
  ) {
    const body = node.body && node.body.body ? node.body.body : [];
    roots.push({ node, body, path });
  }
  const children = collectChildren(node);
  for (const child of children) {
    collectFunctionRoots(child, roots, `${path}.${child.type}`);
  }
}

function collectLabelsAndGotos(statements, labels, gotos) {
  if (!Array.isArray(statements)) {
    return;
  }
  for (const stmt of statements) {
    if (!isNode(stmt)) {
      continue;
    }
    switch (stmt.type) {
      case "LabelStatement":
        if (stmt.name && stmt.name.name) {
          if (labels.has(stmt.name.name)) {
            labels.duplicates.add(stmt.name.name);
          }
          labels.add(stmt.name.name);
        }
        break;
      case "GotoStatement":
        gotos.push(stmt);
        break;
      case "IfStatement":
        stmt.clauses.forEach((clause) => collectLabelsAndGotos(clause.body.body, labels, gotos));
        if (stmt.elseBody) {
          collectLabelsAndGotos(stmt.elseBody.body, labels, gotos);
        }
        break;
      case "WhileStatement":
      case "RepeatStatement":
      case "ForNumericStatement":
      case "ForGenericStatement":
      case "DoStatement":
        collectLabelsAndGotos(stmt.body.body, labels, gotos);
        break;
      case "FunctionDeclaration":
      case "TypeFunctionStatement":
      case "ExportTypeFunctionStatement":
        break;
      default:
        break;
    }
  }
}

function checkGotoLabels(ast, errors) {
  const roots = [];
  collectFunctionRoots(ast, roots);
  for (const root of roots) {
    const labelSet = new Set();
    labelSet.duplicates = new Set();
    const gotos = [];
    collectLabelsAndGotos(root.body, labelSet, gotos);
    labelSet.duplicates.forEach((name) => {
      errors.push(`${root.path}: duplicate label '${name}'`);
    });
    for (const stmt of gotos) {
      const name = stmt.name && stmt.name.name;
      if (name && !labelSet.has(name)) {
        errors.push(`${root.path}: goto label '${name}' not found`);
      }
    }
  }
}

function checkLoopControls(ast, errors) {
  const visitStatements = (statements, depth, path) => {
    if (!Array.isArray(statements)) {
      return;
    }
    for (let i = 0; i < statements.length; i += 1) {
      const stmt = statements[i];
      if (!isNode(stmt)) {
        continue;
      }
      switch (stmt.type) {
        case "BreakStatement":
        case "ContinueStatement":
          if (depth === 0) {
            errors.push(`${path}[${i}] ${stmt.type} must be inside a loop`);
          }
          break;
        case "IfStatement":
          stmt.clauses.forEach((clause, idx) =>
            visitStatements(clause.body.body, depth, `${path}[${i}].clauses[${idx}].body.body`),
          );
          if (stmt.elseBody) {
            visitStatements(stmt.elseBody.body, depth, `${path}[${i}].elseBody.body`);
          }
          break;
        case "WhileStatement":
        case "RepeatStatement":
        case "ForNumericStatement":
        case "ForGenericStatement":
          visitStatements(stmt.body.body, depth + 1, `${path}[${i}].body.body`);
          break;
        case "DoStatement":
          visitStatements(stmt.body.body, depth, `${path}[${i}].body.body`);
          break;
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "TypeFunctionStatement":
        case "ExportTypeFunctionStatement":
          break;
        default:
          break;
      }
    }
  };
  visitStatements(ast.body || [], 0, "root.body");
}

function createConstScope(parent = null) {
  return {
    parent,
    bindings: new Map(),
  };
}

function declareConstScopeName(scope, name, kind) {
  if (!scope || !name) {
    return;
  }
  scope.bindings.set(name, kind);
}

function resolveConstScopeName(scope, name) {
  let current = scope;
  while (current) {
    if (current.bindings.has(name)) {
      return current.bindings.get(name);
    }
    current = current.parent;
  }
  return null;
}

function checkConstWriteTarget(target, scope, errors, path) {
  if (!isNode(target)) {
    return;
  }
  if (target.type === "Identifier" && resolveConstScopeName(scope, target.name) === "const") {
    errors.push(`${path}: cannot assign to const '${target.name}'`);
    return;
  }
}

function checkConstWritesInExpression(expr, scope, errors, path) {
  if (!isNode(expr)) {
    return;
  }
  switch (expr.type) {
    case "FunctionExpression": {
      const fnScope = createConstScope(scope);
      expr.parameters.forEach((param) => {
        if (param && param.name) {
          declareConstScopeName(fnScope, param.name, "local");
        }
      });
      checkConstWritesInStatements(expr.body && expr.body.body ? expr.body.body : [], fnScope, errors, `${path}.body.body`);
      return;
    }
    default: {
      const children = collectChildren(expr);
      children.forEach((child, index) => checkConstWritesInExpression(child, scope, errors, `${path}.${child.type}[${index}]`));
    }
  }
}

function checkConstWritesInStatements(statements, scope, errors, path) {
  if (!Array.isArray(statements)) {
    return;
  }
  for (let i = 0; i < statements.length; i += 1) {
    const stmt = statements[i];
    if (!isNode(stmt)) {
      continue;
    }
    const stmtPath = `${path}[${i}]`;
    switch (stmt.type) {
      case "LocalStatement":
        stmt.init.forEach((expr, idx) => checkConstWritesInExpression(expr, scope, errors, `${stmtPath}.init[${idx}]`));
        stmt.variables.forEach((id) => {
          if (id && id.name) {
            declareConstScopeName(scope, id.name, stmt.isConst ? "const" : "local");
          }
        });
        break;
      case "AssignmentStatement":
        stmt.init.forEach((expr, idx) => checkConstWritesInExpression(expr, scope, errors, `${stmtPath}.init[${idx}]`));
        stmt.variables.forEach((target, idx) => {
          checkConstWritesInExpression(target, scope, errors, `${stmtPath}.variables[${idx}]`);
          checkConstWriteTarget(target, scope, errors, `${stmtPath}.variables[${idx}]`);
        });
        break;
      case "CompoundAssignmentStatement":
        checkConstWritesInExpression(stmt.value, scope, errors, `${stmtPath}.value`);
        checkConstWritesInExpression(stmt.variable, scope, errors, `${stmtPath}.variable`);
        checkConstWriteTarget(stmt.variable, scope, errors, `${stmtPath}.variable`);
        break;
      case "CallStatement":
        checkConstWritesInExpression(stmt.expression, scope, errors, `${stmtPath}.expression`);
        break;
      case "ReturnStatement":
        stmt.arguments.forEach((expr, idx) => checkConstWritesInExpression(expr, scope, errors, `${stmtPath}.arguments[${idx}]`));
        break;
      case "IfStatement":
        stmt.clauses.forEach((clause, idx) => {
          checkConstWritesInExpression(clause.condition, scope, errors, `${stmtPath}.clauses[${idx}].condition`);
          checkConstWritesInStatements(clause.body.body, createConstScope(scope), errors, `${stmtPath}.clauses[${idx}].body.body`);
        });
        if (stmt.elseBody) {
          checkConstWritesInStatements(stmt.elseBody.body, createConstScope(scope), errors, `${stmtPath}.elseBody.body`);
        }
        break;
      case "WhileStatement":
        checkConstWritesInExpression(stmt.condition, scope, errors, `${stmtPath}.condition`);
        checkConstWritesInStatements(stmt.body.body, createConstScope(scope), errors, `${stmtPath}.body.body`);
        break;
      case "RepeatStatement": {
        const repeatScope = createConstScope(scope);
        checkConstWritesInStatements(stmt.body.body, repeatScope, errors, `${stmtPath}.body.body`);
        checkConstWritesInExpression(stmt.condition, repeatScope, errors, `${stmtPath}.condition`);
        break;
      }
      case "ForNumericStatement": {
        const loopScope = createConstScope(scope);
        checkConstWritesInExpression(stmt.start, scope, errors, `${stmtPath}.start`);
        checkConstWritesInExpression(stmt.end, scope, errors, `${stmtPath}.end`);
        if (stmt.step) {
          checkConstWritesInExpression(stmt.step, scope, errors, `${stmtPath}.step`);
        }
        if (stmt.variable && stmt.variable.name) {
          declareConstScopeName(loopScope, stmt.variable.name, "local");
        }
        checkConstWritesInStatements(stmt.body.body, loopScope, errors, `${stmtPath}.body.body`);
        break;
      }
      case "ForGenericStatement": {
        const loopScope = createConstScope(scope);
        stmt.iterators.forEach((expr, idx) => checkConstWritesInExpression(expr, scope, errors, `${stmtPath}.iterators[${idx}]`));
        stmt.variables.forEach((id) => {
          if (id && id.name) {
            declareConstScopeName(loopScope, id.name, "local");
          }
        });
        checkConstWritesInStatements(stmt.body.body, loopScope, errors, `${stmtPath}.body.body`);
        break;
      }
      case "DoStatement":
        checkConstWritesInStatements(stmt.body.body, createConstScope(scope), errors, `${stmtPath}.body.body`);
        break;
      case "FunctionDeclaration": {
        if (stmt.isLocal && stmt.name && stmt.name.base && stmt.name.base.name) {
          declareConstScopeName(scope, stmt.name.base.name, "local");
        }
        const fnScope = createConstScope(scope);
        if (stmt.name && stmt.name.method) {
          declareConstScopeName(fnScope, "self", "local");
        }
        stmt.parameters.forEach((param) => {
          if (param && param.name) {
            declareConstScopeName(fnScope, param.name, "local");
          }
        });
        checkConstWritesInStatements(stmt.body && stmt.body.body ? stmt.body.body : [], fnScope, errors, `${stmtPath}.body.body`);
        break;
      }
      default:
        break;
    }
  }
}

function checkConstWrites(ast, errors) {
  checkConstWritesInStatements(ast.body || [], createConstScope(null), errors, "root.body");
}

function validate(ast, options = {}) {
  ast = normalizeLegacyNodeShape(ast, options);
  const errors = [];
  const checkSemantics = options.checkSemantics !== false;
  const stack = [{ node: ast, path: "root" }];
  while (stack.length) {
    const { node, path } = stack.pop();
    validateNode(node, errors, path);
    if (checkSemantics && isNode(node) && (node.type === "Chunk" || node.type === "Block")) {
      checkTerminators(node.body, errors, `${path}.body`);
    }
    if (!isNode(node)) {
      continue;
    }
    const children = collectChildren(node);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], path: `${path}.${children[i].type}` });
    }
  }

  if (checkSemantics) {
    checkGotoLabels(ast, errors);
    checkLoopControls(ast, errors);
    checkConstWrites(ast, errors);
  }

  if (options.throw && errors.length) {
    const err = new Error(errors.join("\n"));
    err.errors = errors;
    throw err;
  }
  return errors;
}

module.exports = {
  validate,
};
