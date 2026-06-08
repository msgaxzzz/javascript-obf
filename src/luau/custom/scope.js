function isNode(value) {
  return value && typeof value === "object" && typeof value.type === "string";
}

function createScope(parent, node) {
  const scope = {
    type: "Scope",
    node,
    parent,
    children: [],
    bindings: new Map(),
    references: [],
    typeBindings: new Map(),
    typeReferences: [],
    globals: parent ? parent.globals : new Set(),
  };
  if (parent) {
    parent.children.push(scope);
  }
  return scope;
}

function addBinding(scope, name, kind, node) {
  const binding = { name, kind, node, scope };
  const list = scope.bindings.get(name);
  if (list) {
    list.push(binding);
  } else {
    scope.bindings.set(name, [binding]);
  }
  return binding;
}

function addTypeBinding(scope, name, kind, node) {
  const binding = { name, kind, node, scope };
  const list = scope.typeBindings.get(name);
  if (list) {
    list.push(binding);
  } else {
    scope.typeBindings.set(name, [binding]);
  }
  return binding;
}

function resolveBinding(scope, name) {
  let current = scope;
  while (current) {
    const list = current.bindings.get(name);
    if (list && list.length) {
      return list[list.length - 1];
    }
    current = current.parent;
  }
  return null;
}

function resolveTypeBinding(scope, name) {
  let current = scope;
  while (current) {
    const list = current.typeBindings.get(name);
    if (list && list.length) {
      return list[list.length - 1];
    }
    current = current.parent;
  }
  return null;
}

function addReference(scope, name, node, kind) {
  const binding = resolveBinding(scope, name);
  const reference = { name, kind, node, binding };
  scope.references.push(reference);
  if (!binding) {
    scope.globals.add(name);
  }
  return reference;
}

function addTypeReference(scope, name, node) {
  const binding = resolveTypeBinding(scope, name);
  const reference = { name, node, binding };
  scope.typeReferences.push(reference);
  return reference;
}

function processType(typeNode, scope, includeTypes) {
  if (!includeTypes || !isNode(typeNode)) {
    return;
  }
  switch (typeNode.type) {
    case "TypeReference": {
      const name = Array.isArray(typeNode.name)
        ? typeNode.name.map((part) => part.name).join(".")
        : "";
      if (name) {
        addTypeReference(scope, name, typeNode);
      }
      if (typeNode.typeArguments) {
        typeNode.typeArguments.forEach((arg) => processType(arg, scope, includeTypes));
      }
      return;
    }
    case "UnionType":
    case "IntersectionType":
      typeNode.types.forEach((entry) => processType(entry, scope, includeTypes));
      return;
    case "OptionalType":
      processType(typeNode.base, scope, includeTypes);
      return;
    case "TypePack":
    case "VariadicType":
      processType(typeNode.value, scope, includeTypes);
      return;
    case "TypeLiteral":
      return;
    case "TypeofType":
      processExpression(typeNode.expression, scope, includeTypes, "read");
      return;
    case "FunctionType": {
      const typeScope = createScope(scope, typeNode);
      bindTypeParameters(typeScope, typeNode.typeParameters, includeTypes);
      typeNode.parameters.forEach((param) => processType(param, typeScope, includeTypes));
      typeNode.returnTypes.forEach((ret) => processType(ret, typeScope, includeTypes));
      return;
    }
    case "TableType":
      typeNode.fields.forEach((field) => {
        if (field.kind === "index") {
          processType(field.key, scope, includeTypes);
        }
        processType(field.value, scope, includeTypes);
      });
      return;
    case "ParenthesizedType":
      processType(typeNode.value, scope, includeTypes);
      return;
    case "TupleType":
      typeNode.items.forEach((item) => processType(item, scope, includeTypes));
      return;
    case "TypeParameter":
      processType(typeNode.value, scope, includeTypes);
      return;
    default:
      return;
  }
}

function processTypedIdentifier(node, scope, includeTypes) {
  if (includeTypes && node && node.annotation) {
    processType(node.annotation, scope, includeTypes);
  }
}

function bindTypeParameters(scope, params, includeTypes) {
  if (!includeTypes || !Array.isArray(params)) {
    return;
  }
  params.forEach((param) => {
    if (param && param.name) {
      addTypeBinding(scope, param.name, "type-param", param);
    }
    if (param && param.default) {
      processType(param.default, scope, includeTypes);
    }
  });
}

function processFunctionExpression(node, scope, includeTypes) {
  const fnScope = createScope(scope, node);
  bindTypeParameters(fnScope, node.typeParameters, includeTypes);
  node.parameters.forEach((param) => {
    if (param && param.name) {
      addBinding(fnScope, param.name, "param", param);
    }
    processTypedIdentifier(param, fnScope, includeTypes);
  });
  if (node.hasVararg && includeTypes && node.varargAnnotation) {
    processType(node.varargAnnotation, fnScope, includeTypes);
  }
  if (includeTypes && node.returnType) {
    processType(node.returnType, fnScope, includeTypes);
  }
  processStatementList(node.body.body, fnScope, includeTypes);
}

function processAssignmentTarget(node, scope, includeTypes, kind) {
  if (!isNode(node)) {
    return;
  }
  switch (node.type) {
    case "Identifier":
      addReference(scope, node.name, node, kind);
      return;
    case "MemberExpression":
      processExpression(node.base, scope, includeTypes, "read");
      return;
    case "IndexExpression":
      processExpression(node.base, scope, includeTypes, "read");
      processExpression(node.index, scope, includeTypes, "read");
      return;
    default:
      processExpression(node, scope, includeTypes, "read");
  }
}

function processExpression(node, scope, includeTypes, kind = "read") {
  if (!isNode(node)) {
    return;
  }
  switch (node.type) {
    case "Identifier":
      addReference(scope, node.name, node, kind);
      return;
    case "BinaryExpression":
      processExpression(node.left, scope, includeTypes, "read");
      processExpression(node.right, scope, includeTypes, "read");
      return;
    case "UnaryExpression":
      processExpression(node.argument, scope, includeTypes, "read");
      return;
    case "TypeAssertion":
      processExpression(node.expression, scope, includeTypes, "read");
      processType(node.annotation, scope, includeTypes);
      return;
    case "IfExpression":
      node.clauses.forEach((clause) => {
        processExpression(clause.condition, scope, includeTypes, "read");
        processExpression(clause.value, scope, includeTypes, "read");
      });
      processExpression(node.elseValue, scope, includeTypes, "read");
      return;
    case "GroupExpression":
      processExpression(node.expression, scope, includeTypes, "read");
      return;
    case "MemberExpression":
      processExpression(node.base, scope, includeTypes, "read");
      return;
    case "IndexExpression":
      processExpression(node.base, scope, includeTypes, "read");
      processExpression(node.index, scope, includeTypes, "read");
      return;
    case "CallExpression":
      processExpression(node.base, scope, includeTypes, "read");
      node.arguments.forEach((arg) => processExpression(arg, scope, includeTypes, "read"));
      return;
    case "MethodCallExpression":
      processExpression(node.base, scope, includeTypes, "read");
      node.arguments.forEach((arg) => processExpression(arg, scope, includeTypes, "read"));
      return;
    case "FunctionExpression":
      processFunctionExpression(node, scope, includeTypes);
      return;
    case "TableConstructorExpression":
      node.fields.forEach((field) => {
        if (field.kind === "index") {
          processExpression(field.key, scope, includeTypes, "read");
          processExpression(field.value, scope, includeTypes, "read");
          return;
        }
        if (field.kind === "name") {
          processExpression(field.value, scope, includeTypes, "read");
          return;
        }
        processExpression(field.value, scope, includeTypes, "read");
      });
      return;
    case "InterpolatedString":
      if (node.parts) {
        node.parts.forEach((part) => {
          if (isNode(part) && part.type !== "InterpolatedStringText") {
            processExpression(part, scope, includeTypes, "read");
          }
        });
      }
      return;
    case "NumericLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
    case "VarargLiteral":
      return;
    default:
      return;
  }
}

function processStatementList(list, scope, includeTypes) {
  if (!Array.isArray(list)) {
    return;
  }
  for (const stmt of list) {
    processStatement(stmt, scope, includeTypes);
  }
}

function processStatement(stmt, scope, includeTypes) {
  if (!isNode(stmt)) {
    return;
  }
  switch (stmt.type) {
    case "LocalStatement":
      if (stmt.init) {
        stmt.init.forEach((expr) => processExpression(expr, scope, includeTypes, "read"));
      }
      stmt.variables.forEach((id) => {
        if (id && id.name) {
          addBinding(scope, id.name, stmt.isConst ? "const" : "local", id);
        }
        processTypedIdentifier(id, scope, includeTypes);
      });
      return;
    case "AssignmentStatement":
      stmt.variables.forEach((variable) => processAssignmentTarget(variable, scope, includeTypes, "write"));
      stmt.init.forEach((expr) => processExpression(expr, scope, includeTypes, "read"));
      return;
    case "CompoundAssignmentStatement":
      processAssignmentTarget(stmt.variable, scope, includeTypes, "readwrite");
      processExpression(stmt.value, scope, includeTypes, "read");
      return;
    case "CallStatement":
      processExpression(stmt.expression, scope, includeTypes, "read");
      return;
    case "FunctionDeclaration":
    case "StatFunction":
    case "StatLocalFunction": {
      if ((stmt.isLocal || stmt.type === "StatLocalFunction") && stmt.name && stmt.name.base) {
        addBinding(scope, stmt.name.base.name, stmt.isConst ? "const" : "local", stmt.name.base);
      } else if (stmt.name && stmt.name.base) {
        const hasMembers = (stmt.name.members && stmt.name.members.length) || stmt.name.method;
        addReference(scope, stmt.name.base.name, stmt.name.base, hasMembers ? "read" : "write");
      }
      const fnScope = createScope(scope, stmt);
      bindTypeParameters(fnScope, stmt.typeParameters, includeTypes);
      stmt.parameters.forEach((param) => {
        if (param && param.name) {
          addBinding(fnScope, param.name, "param", param);
        }
        processTypedIdentifier(param, fnScope, includeTypes);
      });
      if (stmt.hasVararg && includeTypes && stmt.varargAnnotation) {
        processType(stmt.varargAnnotation, fnScope, includeTypes);
      }
      if (includeTypes && stmt.returnType) {
        processType(stmt.returnType, fnScope, includeTypes);
      }
      processStatementList(stmt.body.body, fnScope, includeTypes);
      return;
    }
    case "IfStatement":
      stmt.clauses.forEach((clause) => {
        processExpression(clause.condition, scope, includeTypes, "read");
        const clauseScope = createScope(scope, clause.body);
        processStatementList(clause.body.body, clauseScope, includeTypes);
      });
      if (stmt.elseBody) {
        const elseScope = createScope(scope, stmt.elseBody);
        processStatementList(stmt.elseBody.body, elseScope, includeTypes);
      }
      return;
    case "WhileStatement": {
      processExpression(stmt.condition, scope, includeTypes, "read");
      const bodyScope = createScope(scope, stmt.body);
      processStatementList(stmt.body.body, bodyScope, includeTypes);
      return;
    }
    case "RepeatStatement": {
      const repeatScope = createScope(scope, stmt.body);
      processStatementList(stmt.body.body, repeatScope, includeTypes);
      processExpression(stmt.condition, repeatScope, includeTypes, "read");
      return;
    }
    case "ForNumericStatement": {
      processExpression(stmt.start, scope, includeTypes, "read");
      processExpression(stmt.end, scope, includeTypes, "read");
      if (stmt.step) {
        processExpression(stmt.step, scope, includeTypes, "read");
      }
      const loopScope = createScope(scope, stmt.body);
      if (stmt.variable && stmt.variable.name) {
        addBinding(loopScope, stmt.variable.name, "for", stmt.variable);
      }
      processTypedIdentifier(stmt.variable, loopScope, includeTypes);
      processStatementList(stmt.body.body, loopScope, includeTypes);
      return;
    }
    case "ForGenericStatement": {
      stmt.iterators.forEach((expr) => processExpression(expr, scope, includeTypes, "read"));
      const loopScope = createScope(scope, stmt.body);
      stmt.variables.forEach((variable) => {
        if (variable && variable.name) {
          addBinding(loopScope, variable.name, "for", variable);
        }
        processTypedIdentifier(variable, loopScope, includeTypes);
      });
      processStatementList(stmt.body.body, loopScope, includeTypes);
      return;
    }
    case "DoStatement": {
      const bodyScope = createScope(scope, stmt.body);
      processStatementList(stmt.body.body, bodyScope, includeTypes);
      return;
    }
    case "ReturnStatement":
      stmt.arguments.forEach((expr) => processExpression(expr, scope, includeTypes, "read"));
      return;
    case "TypeAliasStatement":
    case "ExportTypeStatement":
      if (includeTypes && stmt.name && stmt.name.name) {
        addTypeBinding(scope, stmt.name.name, "type", stmt.name);
        const typeScope = createScope(scope, stmt);
        bindTypeParameters(typeScope, stmt.typeParameters, includeTypes);
        processType(stmt.value, typeScope, includeTypes);
      }
      return;
    case "TypeFunctionStatement":
    case "ExportTypeFunctionStatement":
      if (includeTypes && stmt.name && stmt.name.name) {
        addTypeBinding(scope, stmt.name.name, "type", stmt.name);
        const typeScope = createScope(scope, stmt);
        bindTypeParameters(typeScope, stmt.typeParameters, includeTypes);
        stmt.parameters.forEach((param) => processTypedIdentifier(param, typeScope, includeTypes));
        if (stmt.hasVararg && stmt.varargAnnotation) {
          processType(stmt.varargAnnotation, typeScope, includeTypes);
        }
        if (stmt.returnTypes) {
          stmt.returnTypes.forEach((ret) => processType(ret, typeScope, includeTypes));
        }
      }
      return;
    case "DeclareFunctionStatement":
      if (includeTypes && stmt.name) {
        const name = stmt.name.base ? stmt.name.base.name : null;
        if (name) {
          addTypeBinding(scope, name, "declare", stmt.name.base);
        }
        const declareScope = createScope(scope, stmt);
        bindTypeParameters(declareScope, stmt.typeParameters, includeTypes);
        stmt.parameters.forEach((param) => processTypedIdentifier(param, declareScope, includeTypes));
        if (stmt.hasVararg && stmt.varargAnnotation) {
          processType(stmt.varargAnnotation, declareScope, includeTypes);
        }
        if (stmt.returnType) {
          processType(stmt.returnType, declareScope, includeTypes);
        }
      }
      return;
    case "DeclareVariableStatement":
      if (includeTypes && stmt.name && stmt.name.name) {
        addTypeBinding(scope, stmt.name.name, "declare", stmt.name);
        processType(stmt.annotation, scope, includeTypes);
      }
      return;
    case "DeclareExternTypeStatement":
      if (includeTypes && stmt.name && stmt.name.name) {
        addTypeBinding(scope, stmt.name.name, "declare", stmt.name);
        if (stmt.superName) {
          addTypeReference(scope, stmt.superName.name, stmt.superName);
        }
        if (Array.isArray(stmt.props)) {
          stmt.props.forEach((prop) => {
            if (prop.kind === "method") {
              const memberScope = createScope(scope, prop);
              bindTypeParameters(memberScope, prop.typeParameters, includeTypes);
              if (Array.isArray(prop.parameters)) {
                prop.parameters.forEach((param) => processTypedIdentifier(param, memberScope, includeTypes));
              }
              if (prop.hasVararg && prop.varargAnnotation) {
                processType(prop.varargAnnotation, memberScope, includeTypes);
              }
              if (prop.returnType) {
                processType(prop.returnType, memberScope, includeTypes);
              }
            } else if (prop.value) {
              processType(prop.value, scope, includeTypes);
            }
          });
        }
        if (stmt.indexer) {
          processType(stmt.indexer.key, scope, includeTypes);
          processType(stmt.indexer.value, scope, includeTypes);
        }
      }
      return;
    case "BreakStatement":
    case "ContinueStatement":
    case "LabelStatement":
    case "GotoStatement":
      return;
    default:
      return;
  }
}

function buildScope(ast, options = {}) {
  const includeTypes = Boolean(options.includeTypes);
  const root = createScope(null, ast);
  if (ast && Array.isArray(ast.body)) {
    processStatementList(ast.body, root, includeTypes);
  }
  return root;
}

module.exports = {
  buildScope,
};
