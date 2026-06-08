const { walk } = require("./ast");
const { collectIdentifierNames, makeShortNameFactory } = require("./names");

const SUPPORTED_STATEMENTS = new Set([
  "LocalStatement",
  "AssignmentStatement",
  "CompoundAssignmentStatement",
  "CallStatement",
  "ReturnStatement",
]);

const WOVEN_STATIC_STATEMENTS = new Set([
  "TypeAliasStatement",
  "ExportTypeStatement",
  "TypeFunctionStatement",
  "ExportTypeFunctionStatement",
  "DeclareFunctionStatement",
  "DeclareVariableStatement",
]);

const WOVEN_UNSAFE_TOP_LEVEL = new Set([
  "BreakStatement",
  "ContinueStatement",
  "GotoStatement",
  "LabelStatement",
]);

function buildStateValues(count, rng) {
  const poolSize = Math.max(count * 3, count + 5);
  const pool = Array.from({ length: poolSize }, (_, i) => i + 1);
  rng.shuffle(pool);
  const isLinearStep = (values) => {
    if (values.length < 3) {
      return true;
    }
    const step = values[1] - values[0];
    for (let i = 2; i < values.length; i += 1) {
      if (values[i] - values[i - 1] !== step) {
        return false;
      }
    }
    return true;
  };
  let values = pool.slice(0, count);
  for (let attempt = 0; attempt < 5 && isLinearStep(values); attempt += 1) {
    rng.shuffle(pool);
    values = pool.slice(0, count);
  }
  return values;
}

function pickUnusedNumber(used, rng, min, max) {
  let value = rng.int(min, max);
  let attempts = 0;
  while (used.has(value)) {
    value = rng.int(min, max);
    attempts += 1;
    if (attempts > 24) {
      value = max + attempts;
    }
  }
  used.add(value);
  return value;
}

function markTopReturnExportName(ast, name) {
  if (!ast || typeof name !== "string" || !name) {
    return;
  }
  if (!ast.__obf_top_return_export_names) {
    ast.__obf_top_return_export_names = new Set();
  }
  ast.__obf_top_return_export_names.add(name);
}

function getFunctionStatements(node) {
  if (!node || !node.body) {
    return null;
  }
  if (Array.isArray(node.body)) {
    return { statements: node.body, style: "luaparse" };
  }
  if (node.body && Array.isArray(node.body.body)) {
    return { statements: node.body.body, style: "custom" };
  }
  return null;
}

function getFunctionName(fnNode) {
  if (!fnNode) {
    return null;
  }
  if (fnNode.name && fnNode.name.type === "FunctionName") {
    const parts = [fnNode.name.base.name, ...(fnNode.name.members || []).map((m) => m.name)];
    if (fnNode.name.method) {
      parts.push(fnNode.name.method.name);
    }
    return parts.join(".");
  }
  if (fnNode.identifier && fnNode.identifier.type === "Identifier") {
    return fnNode.identifier.name;
  }
  return null;
}

function shouldSkipForVm(node, options) {
  if (!options || !options.vm || options.vm.enabled === false || !node) {
    return false;
  }
  const include = Array.isArray(options.vm.include) ? options.vm.include : [];
  if (options.vm.all || include.length === 0) {
    return true;
  }
  const name = getFunctionName(node);
  return Boolean(name && include.includes(name));
}

function setFunctionStatements(node, statements, style) {
  if (style === "luaparse") {
    node.body = statements;
  } else if (node.body && node.body.type === "Block") {
    node.body.body = statements;
  }
}

function hasUnsupportedStatements(statements) {
  for (const stmt of statements) {
    if (!stmt || !stmt.type || !SUPPORTED_STATEMENTS.has(stmt.type)) {
      return true;
    }
  }
  return false;
}

function numericLiteral(value) {
  return { type: "NumericLiteral", value, raw: String(value) };
}

function stringLiteral(value) {
  return { type: "StringLiteral", value, raw: JSON.stringify(value) };
}

function escapedByteStringLiteral(value) {
  const bytes = Array.from(Buffer.from(String(value), "utf8"));
  const raw = `"${bytes.map((byte) => `\\${String(byte).padStart(3, "0")}`).join("")}"`;
  return { type: "StringLiteral", value, raw };
}

function identifier(name) {
  return { type: "Identifier", name };
}

function binaryExpression(operator, left, right) {
  return { type: "BinaryExpression", operator, left, right };
}

function unaryExpression(operator, argument) {
  return { type: "UnaryExpression", operator, argument };
}

function logicalAnd(left, right, style) {
  if (style === "luaparse") {
    return { type: "LogicalExpression", operator: "and", left, right };
  }
  return { type: "BinaryExpression", operator: "and", left, right };
}

function logicalOr(left, right, style) {
  if (style === "luaparse") {
    return { type: "LogicalExpression", operator: "or", left, right };
  }
  return { type: "BinaryExpression", operator: "or", left, right };
}

function indexExpression(base, index) {
  return { type: "IndexExpression", base, index };
}

function callExpression(base, args = []) {
  return { type: "CallExpression", base, arguments: args };
}

function assignmentStatement(variable, value) {
  return { type: "AssignmentStatement", variables: [variable], init: [value] };
}

function localStatement(variable, value) {
  return { type: "LocalStatement", variables: [variable], init: [value] };
}

function callStatement(expression) {
  return { type: "CallStatement", expression };
}

function returnStatement(args = []) {
  return { type: "ReturnStatement", arguments: args };
}

function booleanLiteral(value) {
  return { type: "BooleanLiteral", value: Boolean(value) };
}

function cloneNode(node) {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => cloneNode(item));
  }
  const out = {};
  Object.keys(node).forEach((key) => {
    out[key] = cloneNode(node[key]);
  });
  return out;
}

function buildTableList(values, style) {
  const fields = values.map((value) => {
    if (style === "luaparse") {
      return { type: "TableValue", value };
    }
    return { type: "TableField", kind: "list", value };
  });
  return { type: "TableConstructorExpression", fields };
}

function buildTableIndex(pairs, style) {
  const fields = pairs.map(({ key, value }) => {
    if (style === "luaparse") {
      return { type: "TableKey", key, value };
    }
    return { type: "TableField", kind: "index", key, value };
  });
  return { type: "TableConstructorExpression", fields };
}

function buildBlock(body, style) {
  if (style === "luaparse") {
    return body;
  }
  return { type: "Block", body };
}

function buildFunctionExpression(body, style) {
  if (style === "luaparse") {
    return {
      cffGenerated: true,
      type: "FunctionDeclaration",
      identifier: null,
      parameters: [],
      isLocal: false,
      body,
    };
  }
  return {
    cffGenerated: true,
    type: "FunctionExpression",
    parameters: [],
    hasVararg: false,
    varargAnnotation: null,
    returnType: null,
    typeParameters: [],
    body: buildBlock(body, style),
  };
}

function buildIfStatement(cases, elseBody, style) {
  if (style === "luaparse") {
    const clauses = cases.map((entry, idx) => ({
      type: idx === 0 ? "IfClause" : "ElseifClause",
      condition: entry.condition,
      body: entry.body,
    }));
    clauses.push({ type: "ElseClause", body: elseBody });
    return { type: "IfStatement", clauses };
  }
  const clauses = cases.map((entry) => ({
    condition: entry.condition,
    body: buildBlock(entry.body, style),
  }));
  return { type: "IfStatement", clauses, elseBody: buildBlock(elseBody, style) };
}

function buildWhileStatement(condition, body, style) {
  return { type: "WhileStatement", condition, body: buildBlock(body, style) };
}

function buildRepeatStatement(condition, body, style) {
  return { cffGenerated: true, type: "RepeatStatement", condition, body: buildBlock(body, style) };
}

function buildDoStatement(body, style) {
  return { cffGenerated: true, type: "DoStatement", body: buildBlock(body, style) };
}

function buildForNumericStatement(variable, start, end, step, body, style) {
  return {
    cffGenerated: true,
    type: "ForNumericStatement",
    variable,
    start,
    end,
    step,
    body: buildBlock(body, style),
  };
}

function buildOpaquePredicate(stateName, rng) {
  const subject = identifier(stateName);
  const template = rng.int(0, 3);
  if (template === 0) {
    const seed = rng.int(2, 13);
    return binaryExpression(
      "==",
      binaryExpression(
        "%",
        binaryExpression("*", subject, numericLiteral(seed)),
        numericLiteral(seed)
      ),
      numericLiteral(0)
    );
  }
  if (template === 1) {
    return binaryExpression(
      "==",
      binaryExpression("-", subject, subject),
      numericLiteral(0)
    );
  }
  if (template === 2) {
    const seed = rng.int(3, 19);
    return binaryExpression(
      "==",
      binaryExpression(
        "-",
        binaryExpression("+", subject, numericLiteral(seed)),
        subject
      ),
      numericLiteral(seed)
    );
  }
  return binaryExpression(
    "==",
    binaryExpression("%", subject, numericLiteral(1)),
    numericLiteral(0)
  );
}

function buildFakeAssignment(targetName, sourceExpr, modulusValue) {
  return assignmentStatement(
    identifier(targetName),
    binaryExpression(
      "%",
      binaryExpression("+", identifier(targetName), sourceExpr),
      numericLiteral(modulusValue)
    )
  );
}

function buildModuloExpression(left, right, modulusValue) {
  return binaryExpression(
    "%",
    binaryExpression("+", left, right),
    numericLiteral(modulusValue)
  );
}

function buildConstantNumberExpression(value, rng) {
  if (value < 0) {
    return numericLiteral(value);
  }
  const template = rng.int(0, 4);
  if (template === 0) {
    return numericLiteral(value);
  }
  if (template === 1) {
    const salt = rng.int(3, 97);
    return binaryExpression("-", numericLiteral(value + salt), numericLiteral(salt));
  }
  if (template === 2) {
    const left = value > 0 ? rng.int(0, value) : 0;
    return binaryExpression("+", numericLiteral(left), numericLiteral(value - left));
  }
  if (template === 3) {
    const mod = value + rng.int(17, 101);
    const mul = rng.int(2, 6);
    return binaryExpression("%", numericLiteral(value + mod * mul), numericLiteral(mod));
  }
  const scale = rng.int(2, 9);
  return binaryExpression("/", numericLiteral(value * scale), numericLiteral(scale));
}

function buildWovenNumber(value, rng, names = null) {
  let expr = buildConstantNumberExpression(value, rng);
  if (!names || rng.int(0, 2) === 0) {
    return expr;
  }
  let noOp;
  if (names.anchorTableName && names.anchorKeyName && names.anchorValueName) {
    noOp = binaryExpression(
      "-",
      indexExpression(identifier(names.anchorTableName), identifier(names.anchorKeyName)),
      identifier(names.anchorValueName)
    );
  } else {
    const noOpNames = [
      names.guardName,
      names.trashAName,
      names.trashBName,
      names.stateName,
    ].filter(Boolean);
    const noOpName = noOpNames[rng.int(0, noOpNames.length - 1)];
    noOp = binaryExpression("-", identifier(noOpName), identifier(noOpName));
  }
  if (rng.int(0, 1) === 0) {
    return binaryExpression("+", expr, noOp);
  }
  return binaryExpression("-", expr, noOp);
}

function createLinearCodec(rng, scaleMin, scaleMax, biasMin, biasMax) {
  const scale = rng.int(scaleMin, scaleMax);
  const bias = rng.int(biasMin, biasMax);
  return {
    scale,
    bias,
    encode(value) {
      return value * scale + bias;
    },
  };
}

function buildShardLookup(names, keyExpr, style) {
  const lookups = names.map((name) => indexExpression(identifier(name), cloneNode(keyExpr)));
  if (lookups.length === 1) {
    return lookups[0];
  }
  return lookups.slice(1).reduce((left, right) => logicalOr(left, right, style), lookups[0]);
}

function buildFakeStateBody(rng, names, index) {
  const {
    trashAName,
    trashBName,
    slotName,
    stateName,
  } = names;
  const modA = rng.int(97, 251);
  const modB = rng.int(127, 283);
  const template = rng.int(0, 2);

  if (template === 0) {
    return [
      buildFakeAssignment(trashAName, identifier(slotName), modA),
      buildFakeAssignment(
        trashBName,
        binaryExpression("+", identifier(stateName), numericLiteral(index + 1)),
        modB
      ),
    ];
  }

  if (template === 1) {
    return [
      assignmentStatement(
        identifier(trashAName),
        buildModuloExpression(
          binaryExpression("*", identifier(trashAName), numericLiteral(rng.int(2, 5))),
          identifier(slotName),
          modA
        )
      ),
      assignmentStatement(
        identifier(trashBName),
        buildModuloExpression(
          binaryExpression("+", identifier(trashBName), identifier(trashAName)),
          numericLiteral(index + 1),
          modB
        )
      ),
    ];
  }

  return [
    assignmentStatement(
      identifier(trashAName),
      buildModuloExpression(
        identifier(trashBName),
        identifier(stateName),
        modA
      )
    ),
    assignmentStatement(
      identifier(trashBName),
      buildModuloExpression(
        identifier(slotName),
        numericLiteral(index + rng.int(2, 9)),
        modB
      )
    ),
  ];
}

function addNamesFromSSA(ssa, used) {
  if (!ssa || !used) {
    return;
  }
  if (Array.isArray(ssa.variables)) {
    ssa.variables.forEach((name) => {
      if (name) {
        used.add(name);
      }
    });
  }
  const addVersioned = (value) => {
    if (!value || typeof value !== "string") {
      return;
    }
    const base = value.split("$", 1)[0];
    if (base) {
      used.add(base);
    }
  };
  if (ssa.uses && typeof ssa.uses.forEach === "function") {
    ssa.uses.forEach((value) => addVersioned(value));
  }
  if (ssa.defs && typeof ssa.defs.forEach === "function") {
    ssa.defs.forEach((value) => addVersioned(value));
  }
  if (ssa.blocks) {
    Object.values(ssa.blocks).forEach((block) => {
      if (block && Array.isArray(block.phi)) {
        block.phi.forEach((phi) => {
          if (phi && phi.variable) {
            used.add(phi.variable);
          }
        });
      }
    });
  }
}

function findSSAForNode(ssaRoot, node) {
  if (!ssaRoot || !Array.isArray(ssaRoot.functions)) {
    return null;
  }
  for (const cfg of ssaRoot.functions) {
    if (cfg && cfg.node === node) {
      return cfg.ssa || null;
    }
  }
  return null;
}

function extractLocalName(variable) {
  if (!variable || variable.type !== "Identifier" || typeof variable.name !== "string") {
    return null;
  }
  return variable.name;
}

function prepareFlattenStatements(statements) {
  const hoisted = [];
  const seen = new Set();
  const rewritten = [];
  for (const stmt of statements) {
    if (!stmt || stmt.type !== "LocalStatement") {
      rewritten.push(stmt);
      continue;
    }
    const variables = Array.isArray(stmt.variables) ? stmt.variables : [];
    for (const variable of variables) {
      const name = extractLocalName(variable);
      if (!name || seen.has(name)) {
        return null;
      }
      seen.add(name);
      hoisted.push(cloneNode(variable));
    }
    const init = Array.isArray(stmt.init) && stmt.init.length
      ? cloneNode(stmt.init)
      : variables.map(() => ({ type: "NilLiteral", value: null }));
    rewritten.push({
      type: "AssignmentStatement",
      variables: cloneNode(variables),
      init,
    });
  }
  return { hoisted, rewritten };
}

function getBlockStatementsFromStatement(stmt) {
  if (!stmt || !stmt.type) {
    return [];
  }
  if (stmt.type === "IfStatement") {
    const out = [];
    if (Array.isArray(stmt.clauses)) {
      stmt.clauses.forEach((clause) => {
        if (clause && clause.body) {
          out.push(...getBlockBody(clause.body));
        }
      });
    }
    if (stmt.elseBody) {
      out.push(...getBlockBody(stmt.elseBody));
    }
    return out;
  }
  if (
    stmt.type === "WhileStatement" ||
    stmt.type === "RepeatStatement" ||
    stmt.type === "ForNumericStatement" ||
    stmt.type === "ForGenericStatement" ||
    stmt.type === "DoStatement" ||
    stmt.type === "FunctionDeclaration" ||
    stmt.type === "FunctionExpression" ||
    stmt.type === "TypeFunctionStatement" ||
    stmt.type === "ExportTypeFunctionStatement"
  ) {
    return getBlockBody(stmt.body);
  }
  return [];
}

function getBlockBody(block) {
  if (!block) {
    return [];
  }
  if (Array.isArray(block)) {
    return block;
  }
  if (Array.isArray(block.body)) {
    return block.body;
  }
  return [];
}

function isLoopStatement(stmt) {
  return Boolean(stmt && (
    stmt.type === "WhileStatement" ||
    stmt.type === "RepeatStatement" ||
    stmt.type === "ForNumericStatement" ||
    stmt.type === "ForGenericStatement"
  ));
}

function statementTreeHasUnsafeControl(stmt, loopDepth = 0) {
  if (!stmt || !stmt.type) {
    return false;
  }
  if (stmt.type === "GotoStatement" || stmt.type === "LabelStatement") {
    return true;
  }
  if ((stmt.type === "BreakStatement" || stmt.type === "ContinueStatement") && loopDepth <= 0) {
    return true;
  }
  const nextLoopDepth = loopDepth + (isLoopStatement(stmt) ? 1 : 0);
  const body = getBlockStatementsFromStatement(stmt);
  if (!body.length) {
    return false;
  }
  return body.some((child) => statementTreeHasUnsafeControl(child, nextLoopDepth));
}

function collectReferencedNames(node, out, options = {}) {
  const ignoreLocalDeclarations = Boolean(options.ignoreLocalDeclarations);
  const visit = (value, parent, key) => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, parent, key));
      return;
    }
    if (value.type === "Identifier") {
      if (
        ignoreLocalDeclarations &&
        parent &&
        (
          (parent.type === "LocalStatement" && key === "variables") ||
          (parent.type === "FunctionDeclaration" && parent.isLocal && key === "name") ||
          (parent.type === "FunctionName" && key === "base")
        )
      ) {
        return;
      }
      if (typeof value.name === "string") {
        out.add(value.name);
      }
      return;
    }
    Object.keys(value).forEach((childKey) => {
      if (
        childKey === "loc" ||
        childKey === "range" ||
        childKey === "type" ||
        childKey === "raw" ||
        childKey === "value" ||
        childKey.startsWith("__")
      ) {
        return;
      }
      visit(value[childKey], value, childKey);
    });
  };
  visit(node, null, null);
  return out;
}

function nodeReferencesAnyName(node, names) {
  if (!names || !names.size) {
    return false;
  }
  const refs = collectReferencedNames(node, new Set(), { ignoreLocalDeclarations: true });
  for (const name of names) {
    if (refs.has(name)) {
      return true;
    }
  }
  return false;
}

function stripIdentifierForAssignment(node) {
  const out = cloneNode(node);
  if (out && typeof out === "object") {
    delete out.annotation;
    delete out.attributes;
  }
  return out;
}

function makeFunctionExpressionFromDeclaration(stmt, style) {
  if (style === "luaparse") {
    return {
      type: "FunctionDeclaration",
      identifier: null,
      parameters: cloneNode(stmt.parameters || []),
      isLocal: false,
      body: cloneNode(stmt.body || []),
    };
  }
  return {
    type: "FunctionExpression",
    parameters: cloneNode(stmt.parameters || []),
    hasVararg: Boolean(stmt.hasVararg),
    varargAnnotation: cloneNode(stmt.varargAnnotation || null),
    returnType: cloneNode(stmt.returnType || null),
    typeParameters: cloneNode(stmt.typeParameters || []),
    body: cloneNode(stmt.body || { type: "Block", body: [] }),
    attributes: cloneNode(stmt.attributes || []),
  };
}

function getFunctionDeclarationLocalName(stmt) {
  if (!stmt || stmt.type !== "FunctionDeclaration" || !stmt.isLocal || !stmt.name) {
    return null;
  }
  if (stmt.name.base && typeof stmt.name.base.name === "string") {
    if ((stmt.name.members && stmt.name.members.length) || stmt.name.method) {
      return null;
    }
    return stmt.name.base.name;
  }
  if (stmt.identifier && typeof stmt.identifier.name === "string") {
    return stmt.identifier.name;
  }
  return null;
}

function getParameterNames(fnNode) {
  const out = new Set();
  const params = Array.isArray(fnNode && fnNode.parameters) ? fnNode.parameters : [];
  params.forEach((param) => {
    if (param && param.type === "Identifier" && typeof param.name === "string") {
      out.add(param.name);
    }
  });
  return out;
}

function prepareWovenStatements(statements, fnNode, style) {
  const staticPrefix = [];
  const hoisted = [];
  const steps = [];
  const seenLocals = new Set(getParameterNames(fnNode));
  const priorRefs = new Set();

  for (const stmt of statements) {
    if (!stmt || !stmt.type) {
      continue;
    }
    if (stmt.cffGenerated) {
      steps.push(cloneNode(stmt));
      continue;
    }
    if (WOVEN_STATIC_STATEMENTS.has(stmt.type)) {
      staticPrefix.push(cloneNode(stmt));
      collectReferencedNames(stmt, priorRefs, { ignoreLocalDeclarations: true });
      continue;
    }
    if (WOVEN_UNSAFE_TOP_LEVEL.has(stmt.type) || statementTreeHasUnsafeControl(stmt)) {
      return null;
    }
    if (stmt.attributes && stmt.attributes.length) {
      return null;
    }
    if (stmt.type === "LocalStatement") {
      const variables = Array.isArray(stmt.variables) ? stmt.variables : [];
      const localNames = new Set();
      for (const variable of variables) {
        const name = extractLocalName(variable);
        if (!name || seenLocals.has(name) || priorRefs.has(name)) {
          return null;
        }
        localNames.add(name);
      }
      if (nodeReferencesAnyName(stmt.init || [], localNames)) {
        return null;
      }
      variables.forEach((variable) => {
        const name = extractLocalName(variable);
        seenLocals.add(name);
        hoisted.push(cloneNode(variable));
      });
      if (Array.isArray(stmt.init) && stmt.init.length) {
        steps.push({
          type: "AssignmentStatement",
          variables: variables.map((variable) => stripIdentifierForAssignment(variable)),
          init: cloneNode(stmt.init),
        });
      }
      collectReferencedNames(stmt.init || [], priorRefs, { ignoreLocalDeclarations: true });
      continue;
    }
    if (stmt.type === "FunctionDeclaration" && stmt.isLocal) {
      const name = getFunctionDeclarationLocalName(stmt);
      if (!name || seenLocals.has(name) || priorRefs.has(name)) {
        return null;
      }
      seenLocals.add(name);
      hoisted.push(identifier(name));
      steps.push({
        type: "AssignmentStatement",
        variables: [identifier(name)],
        init: [makeFunctionExpressionFromDeclaration(stmt, style)],
      });
      collectReferencedNames(stmt.body || [], priorRefs, { ignoreLocalDeclarations: true });
      continue;
    }

    steps.push(cloneNode(stmt));
    collectReferencedNames(stmt, priorRefs, { ignoreLocalDeclarations: true });
  }

  return { staticPrefix, hoisted, steps };
}

function makeMultiLocalStatement(namesOrIdentifiers) {
  return {
    type: "LocalStatement",
    variables: namesOrIdentifiers.map((value) => (
      typeof value === "string" ? identifier(value) : cloneNode(value)
    )),
    init: [],
  };
}

function makeMultiLocalInit(names, values) {
  return {
    type: "LocalStatement",
    variables: names.map((name) => identifier(name)),
    init: values,
  };
}

function isTopLevelReturnStep(stmt) {
  return stmt && stmt.type === "ReturnStatement";
}

function makeWovenNameFactory(rng, used) {
  return makeShortNameFactory(rng, used, null, { minLength: 1, maxLength: 3 });
}

function hideTopReturnCallExpression(ast, ctx) {
  if (!ast || ast.type !== "Chunk" || !Array.isArray(ast.body) || !ast.body.length) {
    return;
  }
  const body = ast.body;
  const ret = body[body.length - 1];
  if (!ret || ret.type !== "ReturnStatement" || !Array.isArray(ret.arguments) || ret.arguments.length !== 1) {
    return;
  }
  const call = ret.arguments[0];
  if (!call || call.type !== "CallExpression" || !call.base || call.base.type !== "Identifier") {
    return;
  }

  markTopReturnExportName(ast, call.base.name);
  const used = collectIdentifierNames(ast);
  const nameFor = makeWovenNameFactory(ctx.rng, used);
  const keyName = nameFor("cff_top_return_key");
  const boxName = nameFor("cff_top_return_box");

  body.splice(
    body.length - 1,
    0,
    localStatement(identifier(keyName), buildTableList([], "custom")),
    localStatement(
      identifier(boxName),
      buildTableIndex([
        { key: identifier(keyName), value: cloneNode(call.base) },
      ], "custom")
    )
  );
  call.base = indexExpression(identifier(boxName), identifier(keyName));
}

function buildWovenAnchorLookup(names) {
  if (!names || !names.anchorTableName || !names.anchorKeyName) {
    return identifier(names.guardName);
  }
  return indexExpression(identifier(names.anchorTableName), identifier(names.anchorKeyName));
}

function buildWovenAnchorValue(names) {
  return identifier((names && names.anchorValueName) || (names && names.guardName));
}

function buildWovenOpaqueTrue(names, rng, style) {
  const lookup = () => buildWovenAnchorLookup(names);
  const value = () => buildWovenAnchorValue(names);
  const template = rng.int(0, 4);
  if (template === 0) {
    return binaryExpression("==", lookup(), value());
  }
  if (template === 1) {
    return unaryExpression(
      "not",
      binaryExpression("~=", lookup(), value())
    );
  }
  if (template === 2) {
    return logicalAnd(
      binaryExpression("==", lookup(), value()),
      unaryExpression(
        "not",
        binaryExpression("~=", buildWovenAnchorLookup(names), buildWovenAnchorValue(names))
      ),
      style
    );
  }
  if (template === 3) {
    return logicalAnd(
      binaryExpression(">=", lookup(), value()),
      binaryExpression("<=", lookup(), value()),
      style
    );
  }
  return binaryExpression(
    "==",
    binaryExpression("-", lookup(), value()),
    numericLiteral(0)
  );
}

function buildWovenOpaqueFalse(names, rng, style) {
  const template = rng.int(0, 1);
  if (template === 0) {
    return binaryExpression(
      "~=",
      buildWovenAnchorLookup(names),
      buildWovenAnchorValue(names)
    );
  }
  return unaryExpression("not", buildWovenOpaqueTrue(names, rng, style));
}

function buildWovenNoiseBody(rng, names) {
  const modA = rng.int(91, 263);
  const modB = rng.int(127, 311);
  const body = [
    assignmentStatement(
      identifier(names.trashAName),
      buildModuloExpression(
        binaryExpression("+", identifier(names.trashAName), identifier(names.stateName)),
        numericLiteral(rng.int(3, 97)),
        modA
      )
    ),
    assignmentStatement(
      identifier(names.trashBName),
      buildModuloExpression(
        binaryExpression("*", identifier(names.trashBName), numericLiteral(rng.int(2, 7))),
        identifier(names.trashAName),
        modB
      )
    ),
  ];
  if (rng.int(0, 1) === 1) {
    body.reverse();
  }
  return body;
}

function buildWovenStateCondition(stateName, value, rng, names, style) {
  const state = identifier(stateName);
  const literal = () => buildWovenNumber(value, rng, names);
  const template = rng.int(0, 4);
  let condition;
  if (template === 0) {
    condition = binaryExpression("==", state, literal());
  } else if (template === 1) {
    condition = logicalAnd(
      binaryExpression(">=", state, literal()),
      binaryExpression("<=", identifier(stateName), literal()),
      style
    );
  } else if (template === 2) {
    condition = unaryExpression(
      "not",
      logicalOr(
        binaryExpression("<", state, literal()),
        binaryExpression(">", identifier(stateName), literal()),
        style
      )
    );
  } else if (template === 3) {
    condition = logicalAnd(
      binaryExpression("~=", state, buildWovenNumber(value + rng.int(1, 9), rng, names)),
      binaryExpression("==", identifier(stateName), literal()),
      style
    );
  } else {
    const salt = rng.int(3, 43);
    condition = binaryExpression(
      "==",
      binaryExpression("+", state, numericLiteral(salt)),
      buildWovenNumber(value + salt, rng, names)
    );
  }
  if (rng.int(0, 1) === 1) {
    condition = logicalAnd(condition, buildWovenOpaqueTrue(names, rng, style), style);
  }
  return condition;
}

function buildWovenRangeCondition(stateName, pivot, rng, names, style) {
  const condition = rng.int(0, 1) === 0
    ? binaryExpression("<=", identifier(stateName), buildWovenNumber(pivot, rng, names))
    : unaryExpression("not", binaryExpression(">", identifier(stateName), buildWovenNumber(pivot, rng, names)));
  if (rng.int(0, 2) === 0) {
    return logicalAnd(condition, buildWovenOpaqueTrue(names, rng, style), style);
  }
  return condition;
}

function isSimpleWovenExpression(expr) {
  if (!expr || !expr.type) {
    return false;
  }
  if (
    expr.type === "Identifier" ||
    expr.type === "NumericLiteral" ||
    expr.type === "StringLiteral" ||
    expr.type === "BooleanLiteral" ||
    expr.type === "NilLiteral"
  ) {
    return true;
  }
  if (expr.type === "UnaryExpression") {
    return isSimpleWovenExpression(expr.argument);
  }
  if (expr.type === "BinaryExpression" || expr.type === "LogicalExpression") {
    return isSimpleWovenExpression(expr.left) && isSimpleWovenExpression(expr.right);
  }
  if (expr.type === "IndexExpression") {
    return isSimpleWovenExpression(expr.base) && isSimpleWovenExpression(expr.index);
  }
  if (expr.type === "MemberExpression") {
    return isSimpleWovenExpression(expr.base);
  }
  return false;
}

function isSingleAssignmentStatement(stmt) {
  return Boolean(stmt &&
    stmt.type === "AssignmentStatement" &&
    Array.isArray(stmt.variables) &&
    stmt.variables.length === 1 &&
    Array.isArray(stmt.init) &&
    stmt.init.length === 1 &&
    isSimpleWovenExpression(stmt.variables[0]) &&
    isSimpleWovenExpression(stmt.init[0]));
}

function isSingleCompoundAssignmentStatement(stmt) {
  return Boolean(stmt &&
    stmt.type === "CompoundAssignmentStatement" &&
    isSimpleWovenExpression(stmt.variable) &&
    isSimpleWovenExpression(stmt.value));
}

function buildMicroStateCondition(hName, value, rng, names, style) {
  const h = identifier(hName);
  const literal = () => buildWovenNumber(value, rng, names);
  const template = rng.int(0, 3);
  if (template === 0) {
    return binaryExpression("==", h, literal());
  }
  if (template === 1) {
    return unaryExpression(
      "not",
      logicalOr(
        binaryExpression("<", h, literal()),
        binaryExpression(">", identifier(hName), literal()),
        style
      )
    );
  }
  if (template === 2) {
    return logicalAnd(
      binaryExpression("~=", h, buildWovenNumber(value + rng.int(3, 9), rng, names)),
      binaryExpression("==", identifier(hName), literal()),
      style
    );
  }
  const salt = rng.int(2, 21);
  return binaryExpression(
    "==",
    binaryExpression("+", h, numericLiteral(salt)),
    buildWovenNumber(value + salt, rng, names)
  );
}

function buildMicroDispatch(steps, hName, rng, names, style) {
  const sorted = steps.slice().sort((a, b) => b.value - a.value);
  const cases = sorted.map((step) => ({
    condition: buildMicroStateCondition(hName, step.value, rng, names, style),
    body: cloneNode(step.body),
  }));
  return buildIfStatement(cases, buildWovenNoiseBody(rng, names), style);
}

function wrapMicroWovenSteps(steps, locals, rng, names, style) {
  const hName = names.nameFor("cff_woven_h");
  const nextName = names.nameFor("cff_woven_micro_next");
  const declared = [hName, nextName, ...locals];
  const sortedValues = steps.map((step) => step.value).sort((a, b) => a - b);
  const nextPairs = sortedValues.map((value, index) => ({
    key: buildWovenNumber(value, rng, names),
    value: buildWovenNumber(index < sortedValues.length - 1 ? sortedValues[index + 1] : -2, rng, names),
  }));
  const body = [
    makeMultiLocalStatement(declared),
    assignmentStatement(identifier(hName), buildWovenNumber(0, rng)),
    assignmentStatement(identifier(nextName), buildTableIndex(nextPairs, style)),
    buildWhileStatement(
      binaryExpression(">", identifier(hName), buildWovenNumber(-1, rng)),
      [
        buildMicroDispatch(steps, hName, rng, names, style),
        assignmentStatement(
          identifier(hName),
          logicalOr(
            indexExpression(identifier(nextName), identifier(hName)),
            buildWovenNumber(-2, rng, names),
            style
          )
        ),
      ],
      style
    ),
  ];
  return body;
}

function buildAssignmentMicroWoven(stmt, rng, names, style) {
  if (!isSingleAssignmentStatement(stmt)) {
    return null;
  }
  const target = stmt.variables[0];
  const value = stmt.init[0];
  if (target.type === "Identifier") {
    const tmpName = names.nameFor("cff_woven_v");
    return wrapMicroWovenSteps([
      {
        value: 0,
        body: [assignmentStatement(identifier(tmpName), cloneNode(value))],
      },
      {
        value: 1,
        body: [assignmentStatement(cloneNode(target), identifier(tmpName))],
      },
      {
        value: 2,
        body: [assignmentStatement(identifier(tmpName), { type: "NilLiteral", value: null })],
      },
    ], [tmpName], rng, names, style);
  }
  if (target.type === "IndexExpression") {
    const baseName = names.nameFor("cff_woven_r");
    const keyName = names.nameFor("cff_woven_k");
    const valueName = names.nameFor("cff_woven_v");
    return wrapMicroWovenSteps([
      {
        value: 0,
        body: [assignmentStatement(identifier(baseName), cloneNode(target.base))],
      },
      {
        value: 1,
        body: [assignmentStatement(identifier(keyName), cloneNode(target.index))],
      },
      {
        value: 2,
        body: [assignmentStatement(identifier(valueName), cloneNode(value))],
      },
      {
        value: 3,
        body: [assignmentStatement(indexExpression(identifier(baseName), identifier(keyName)), identifier(valueName))],
      },
      {
        value: 4,
        body: [
          assignmentStatement(identifier(baseName), { type: "NilLiteral", value: null }),
          assignmentStatement(identifier(keyName), { type: "NilLiteral", value: null }),
          assignmentStatement(identifier(valueName), { type: "NilLiteral", value: null }),
        ],
      },
    ], [baseName, keyName, valueName], rng, names, style);
  }
  if (target.type === "MemberExpression") {
    const baseName = names.nameFor("cff_woven_r");
    const valueName = names.nameFor("cff_woven_v");
    return wrapMicroWovenSteps([
      {
        value: 0,
        body: [assignmentStatement(identifier(baseName), cloneNode(target.base))],
      },
      {
        value: 1,
        body: [assignmentStatement(identifier(valueName), cloneNode(value))],
      },
      {
        value: 2,
        body: [assignmentStatement(
          indexExpression(identifier(baseName), stringLiteral(target.identifier.name)),
          identifier(valueName)
        )],
      },
      {
        value: 3,
        body: [
          assignmentStatement(identifier(baseName), { type: "NilLiteral", value: null }),
          assignmentStatement(identifier(valueName), { type: "NilLiteral", value: null }),
        ],
      },
    ], [baseName, valueName], rng, names, style);
  }
  return null;
}

function buildCompoundAssignmentMicroWoven(stmt, rng, names, style) {
  if (!isSingleCompoundAssignmentStatement(stmt)) {
    return null;
  }
  const operator = stmt.operator.slice(0, -1);
  if (!operator) {
    return null;
  }
  const target = stmt.variable;
  const value = stmt.value;
  if (target.type === "Identifier") {
    const rhsName = names.nameFor("cff_woven_v");
    const outName = names.nameFor("cff_woven_a");
    return wrapMicroWovenSteps([
      {
        value: 0,
        body: [assignmentStatement(identifier(rhsName), cloneNode(value))],
      },
      {
        value: 1,
        body: [assignmentStatement(identifier(outName), binaryExpression(operator, cloneNode(target), identifier(rhsName)))],
      },
      {
        value: 2,
        body: [assignmentStatement(cloneNode(target), identifier(outName))],
      },
      {
        value: 3,
        body: [
          assignmentStatement(identifier(rhsName), { type: "NilLiteral", value: null }),
          assignmentStatement(identifier(outName), { type: "NilLiteral", value: null }),
        ],
      },
    ], [rhsName, outName], rng, names, style);
  }
  if (target.type === "IndexExpression") {
    const baseName = names.nameFor("cff_woven_r");
    const keyName = names.nameFor("cff_woven_k");
    const rhsName = names.nameFor("cff_woven_v");
    const outName = names.nameFor("cff_woven_a");
    return wrapMicroWovenSteps([
      {
        value: 0,
        body: [assignmentStatement(identifier(baseName), cloneNode(target.base))],
      },
      {
        value: 1,
        body: [assignmentStatement(identifier(keyName), cloneNode(target.index))],
      },
      {
        value: 2,
        body: [assignmentStatement(identifier(rhsName), cloneNode(value))],
      },
      {
        value: 3,
        body: [assignmentStatement(
          identifier(outName),
          binaryExpression(operator, indexExpression(identifier(baseName), identifier(keyName)), identifier(rhsName))
        )],
      },
      {
        value: 4,
        body: [assignmentStatement(indexExpression(identifier(baseName), identifier(keyName)), identifier(outName))],
      },
      {
        value: 5,
        body: [
          assignmentStatement(identifier(baseName), { type: "NilLiteral", value: null }),
          assignmentStatement(identifier(keyName), { type: "NilLiteral", value: null }),
          assignmentStatement(identifier(rhsName), { type: "NilLiteral", value: null }),
          assignmentStatement(identifier(outName), { type: "NilLiteral", value: null }),
        ],
      },
    ], [baseName, keyName, rhsName, outName], rng, names, style);
  }
  return null;
}

function buildMicroWovenStatement(stmt, rng, names, style) {
  if (rng.int(0, 2) === 0) {
    return null;
  }
  if (stmt.type === "AssignmentStatement") {
    return buildAssignmentMicroWoven(stmt, rng, names, style);
  }
  if (stmt.type === "CompoundAssignmentStatement") {
    return buildCompoundAssignmentMicroWoven(stmt, rng, names, style);
  }
  return null;
}

function wrapWovenBody(body, rng, names, style) {
  let wrapped = cloneNode(body);
  const falseBody = buildWovenNoiseBody(rng, names);
  if (rng.int(0, 1) === 1) {
    wrapped = [
      buildIfStatement([
        {
          condition: buildWovenOpaqueTrue(names, rng, style),
          body: wrapped,
        },
      ], falseBody, style),
    ];
  }

  const template = rng.int(0, 3);
  if (template === 0) {
    return [
      buildRepeatStatement(booleanLiteral(true), wrapped, style),
    ];
  }
  if (template === 1) {
    const loopName = names.nameFor("cff_woven_i");
    return [
      buildForNumericStatement(
        identifier(loopName),
        numericLiteral(rng.int(13, 47)),
        numericLiteral(rng.int(63, 121)),
        null,
        [
          buildIfStatement([
            {
              condition: buildWovenOpaqueTrue(names, rng, style),
              body: wrapped,
            },
          ], buildWovenNoiseBody(rng, names), style),
          { type: "BreakStatement" },
        ],
        style
      ),
    ];
  }
  if (template === 2) {
    return [
      buildDoStatement([
        buildIfStatement([
          {
            condition: buildWovenOpaqueFalse(names, rng, style),
            body: buildWovenNoiseBody(rng, names),
          },
          {
            condition: buildWovenOpaqueTrue(names, rng, style),
            body: wrapped,
          },
        ], buildWovenNoiseBody(rng, names), style),
      ], style),
    ];
  }
  return wrapped;
}

function buildWovenCaseBody(entry, rng, names, style) {
  const body = [];
  if (entry.kind === "fake") {
    body.push(...buildWovenNoiseBody(rng, names));
  } else {
    const micro = buildMicroWovenStatement(entry.statement, rng, names, style);
    if (micro && micro.length) {
      body.push(...micro);
    } else {
      body.push(cloneNode(entry.statement));
    }
  }
  if (!entry.terminal) {
    body.push(
      assignmentStatement(
        identifier(names.stateName),
        buildShardLookup(names.nextNames, identifier(names.stateName), style)
      )
    );
  }
  return wrapWovenBody(body, rng, names, style);
}

function buildWovenFallback(names, rng) {
  return [
    ...buildWovenNoiseBody(rng, names),
    assignmentStatement(identifier(names.stateName), identifier(names.exitName)),
  ];
}

function buildWovenDispatchTree(entries, rng, names, style, depth = 0) {
  if (!entries.length) {
    return buildWovenFallback(names, rng);
  }
  if (entries.length === 1) {
    const entry = entries[0];
    return [
      buildIfStatement([
        {
          condition: buildWovenStateCondition(names.stateName, entry.value, rng, names, style),
          body: buildWovenCaseBody(entry, rng, names, style),
        },
      ], buildWovenFallback(names, rng), style),
    ];
  }
  if (depth > 7) {
    const cases = entries.map((entry) => ({
      condition: buildWovenStateCondition(names.stateName, entry.value, rng, names, style),
      body: buildWovenCaseBody(entry, rng, names, style),
    }));
    return [
      buildIfStatement(cases, buildWovenFallback(names, rng), style),
    ];
  }

  const sorted = entries.slice().sort((a, b) => a.value - b.value);
  const minPivotIndex = Math.max(1, Math.floor(sorted.length / 3));
  const maxPivotIndex = Math.min(
    sorted.length - 1,
    Math.max(1, Math.ceil((sorted.length * 2) / 3))
  );
  const pivotIndex = rng.int(
    minPivotIndex,
    maxPivotIndex
  );
  const left = sorted.slice(0, pivotIndex);
  const right = sorted.slice(pivotIndex);
  const pivot = left[left.length - 1].value;
  const condition = buildWovenRangeCondition(names.stateName, pivot, rng, names, style);
  const leftBody = buildWovenDispatchTree(left, rng, names, style, depth + 1);
  const rightBody = buildWovenDispatchTree(right, rng, names, style, depth + 1);
  if (rng.int(0, 1) === 0) {
    return [
      buildIfStatement([
        { condition, body: leftBody },
      ], rightBody, style),
    ];
  }
  return [
    buildIfStatement([
      {
        condition: unaryExpression("not", condition),
        body: rightBody,
      },
    ], leftBody, style),
  ];
}

function buildWovenStatements(statements, ctx, style, usedNames = null) {
  const { rng } = ctx;
  const used = usedNames || collectIdentifierNames({ type: "Chunk", body: statements });
  const nameFor = makeWovenNameFactory(rng, used);
  const names = {
    nameFor,
    stateName: nameFor("cff_woven_state"),
    exitName: nameFor("cff_woven_exit"),
    guardName: nameFor("cff_woven_guard"),
    trashAName: nameFor("cff_woven_trash"),
    trashBName: nameFor("cff_woven_trash"),
    nextNames: [nameFor("cff_woven_next"), nameFor("cff_woven_next")],
    anchorKeyName: nameFor("cff_woven_anchor_key"),
    anchorValueName: nameFor("cff_woven_anchor_value"),
    anchorTableName: nameFor("cff_woven_anchor"),
  };

  const count = statements.length;
  const fakeCount = count >= 4 ? rng.int(1, Math.max(1, Math.min(count, Math.floor(count * 0.75)))) : 0;
  const usedStates = new Set();
  const stateCodec = createLinearCodec(rng, 3, 11, 37, 211);
  const rawStateValues = buildStateValues(count + fakeCount + 1, rng);
  const encodedValues = rawStateValues.map((value) => stateCodec.encode(value));
  encodedValues.forEach((value) => usedStates.add(value));
  const realValues = encodedValues.slice(0, count);
  const fakeValues = encodedValues.slice(count, count + fakeCount);
  const exitValue = pickUnusedNumber(
    usedStates,
    rng,
    stateCodec.encode((count + fakeCount + 5) * 3),
    stateCodec.encode((count + fakeCount + 80) * 7)
  );

  const fakeEntries = [];
  const fakeQueue = fakeValues.slice();
  const realEntries = statements.map((stmt, index) => {
    const terminal = isTopLevelReturnStep(stmt);
    const semanticNext = index < statements.length - 1 ? realValues[index + 1] : exitValue;
    let nextValue = semanticNext;
    if (!terminal && fakeQueue.length && rng.int(0, 2) !== 0) {
      const fakeValue = fakeQueue.shift();
      nextValue = fakeValue;
      fakeEntries.push({
        kind: "fake",
        value: fakeValue,
        nextValue: semanticNext,
        terminal: false,
      });
    }
    return {
      kind: "real",
      value: realValues[index],
      nextValue,
      terminal,
      statement: stmt,
    };
  });
  while (fakeQueue.length) {
    const fakeValue = fakeQueue.shift();
    const targetIndex = rng.int(0, Math.max(0, realValues.length - 1));
    fakeEntries.push({
      kind: "fake",
      value: fakeValue,
      nextValue: realValues[targetIndex] || exitValue,
      terminal: false,
    });
  }

  const dispatchEntries = [...realEntries, ...fakeEntries];
  rng.shuffle(dispatchEntries);
  const nextPairs = [[], []];
  dispatchEntries.forEach((entry) => {
    if (entry.terminal) {
      return;
    }
    nextPairs[rng.int(0, nextPairs.length - 1)].push({
      key: buildWovenNumber(entry.value, rng, names),
      value: buildWovenNumber(entry.nextValue, rng, names),
    });
  });
  const loopBody = buildWovenDispatchTree(dispatchEntries, rng, names, style);
  const loopCondition = logicalAnd(
    binaryExpression("~=", identifier(names.stateName), identifier(names.exitName)),
    buildWovenOpaqueTrue(names, rng, style),
    style
  );

  return [
    localStatement(
      identifier(names.anchorKeyName),
      buildTableList([], style)
    ),
    localStatement(
      identifier(names.anchorValueName),
      buildWovenNumber(rng.int(101, 997), rng)
    ),
    localStatement(
      identifier(names.anchorTableName),
      buildTableIndex([
        {
          key: identifier(names.anchorKeyName),
          value: identifier(names.anchorValueName),
        },
      ], style)
    ),
    makeMultiLocalInit(
      [names.stateName, names.exitName, names.guardName, names.trashAName, names.trashBName],
      [
        buildWovenNumber(realValues[0], rng, names),
        buildWovenNumber(exitValue, rng, names),
        buildWovenNumber(rng.int(17, 997), rng, names),
        numericLiteral(0),
        numericLiteral(0),
      ]
    ),
    ...names.nextNames.map((name, idx) => localStatement(
      identifier(name),
      buildTableIndex(nextPairs[idx], style)
    )),
    buildWhileStatement(loopCondition, loopBody, style),
  ];
}

function flattenFunctionWoven(node, ctx) {
  if (node && node.cffGenerated) {
    return;
  }
  if (shouldSkipForVm(node, ctx && ctx.options)) {
    return;
  }
  const info = getFunctionStatements(node);
  if (!info) {
    return;
  }
  const { statements, style } = info;
  const minStatements = ctx.options.cffOptions?.minStatements ?? 3;
  if (!statements || statements.length < minStatements) {
    return;
  }

  const prepared = prepareWovenStatements(statements, node, style);
  if (!prepared || !prepared.steps.length) {
    return;
  }

  const usedNames = collectIdentifierNames({ type: "Chunk", body: statements });
  if (ctx && typeof ctx.getSSA === "function") {
    const ssaRoot = ctx.getSSA();
    const ssa = findSSAForNode(ssaRoot, node);
    if (ssa) {
      addNamesFromSSA(ssa, usedNames);
    }
  }
  const flattened = [
    ...prepared.staticPrefix,
  ];
  if (prepared.hoisted.length) {
    flattened.push(makeMultiLocalStatement(prepared.hoisted));
  }
  flattened.push(...buildWovenStatements(prepared.steps, ctx, style, usedNames));
  setFunctionStatements(node, flattened, style);
}

function buildFlattenedStatements(statements, ctx, style, usedNames = null) {
  const { rng } = ctx;
  const used = usedNames || collectIdentifierNames({ type: "Chunk", body: statements });
  const nameFor = makeShortNameFactory(rng, used);
  const stateName = nameFor("cff_state");
  const exitName = nameFor("cff_exit");
  const nextNames = [nameFor("cff_next"), nameFor("cff_next")];
  const dispatchNames = [nameFor("cff_dispatch"), nameFor("cff_dispatch")];
  const valuesName = nameFor("cff_vals");
  const slotName = nameFor("cff_slot");
  const handlerName = nameFor("cff_handler");
  const handlerNames = [nameFor("cff_handlers"), nameFor("cff_handlers")];
  const packName = nameFor("cff_pack");
  const unpackName = nameFor("cff_unpack");
  const returnPackName = nameFor("cff_ret");
  const trashAName = nameFor("cff_trash");
  const trashBName = nameFor("cff_trash");

  const count = statements.length;
  const stateValues = buildStateValues(count, rng);
  const stateCodec = createLinearCodec(rng, 2, 7, 11, 79);
  const dispatchCodec = createLinearCodec(rng, 2, 9, 17, 113);
  const usedStates = new Set(stateValues);
  const usedDispatch = new Set();
  const exitState = pickUnusedNumber(usedStates, rng, count * 4 + 7, count * 12 + 97);
  const dispatchValues = stateValues.map(() =>
    pickUnusedNumber(usedDispatch, rng, count * 5 + 11, count * 15 + 131)
  );
  const nextStates = stateValues.map((_, idx) => (idx < count - 1 ? stateValues[idx + 1] : exitState));
  const nonTerminalIndices = statements
    .map((stmt, index) => (stmt.type === "ReturnStatement" ? null : index))
    .filter((index) => index !== null);
  rng.shuffle(nonTerminalIndices);
  const maxFakeTransitions = Math.min(
    3,
    Math.max(0, Math.min(nonTerminalIndices.length, Math.floor(count / 2)))
  );
  const fakeTransitionCount = count >= 4 && maxFakeTransitions > 0
    ? rng.int(1, maxFakeTransitions)
    : 0;
  const fakeTransitions = new Map();
  for (let i = 0; i < fakeTransitionCount; i += 1) {
    const realIndex = nonTerminalIndices[i];
    if (typeof realIndex !== "number") {
      continue;
    }
    fakeTransitions.set(realIndex, {
      state: pickUnusedNumber(usedStates, rng, count * 16 + 23, count * 40 + 211),
      dispatch: pickUnusedNumber(usedDispatch, rng, count * 18 + 31, count * 44 + 257),
    });
  }
  const order = Array.from({ length: count }, (_, i) => ({ kind: "real", index: i }));
  const nextPairs = [[], []];
  const dispatchPairs = [[], []];
  const directCases = [];
  const handlerPairs = [[], []];
  const allowIndirectHandlers = ctx.allowIndirectHandlers !== false;
  const hasReturnState = allowIndirectHandlers && statements.some((stmt) => stmt && stmt.type === "ReturnStatement");
  const useOpaque = ctx.options.cffOptions?.opaque !== false;
  const loopOpaque = useOpaque ? buildOpaquePredicate(stateName, rng) : null;

  // Real states dispatch through a second randomized token table. Some of them
  // intentionally bounce through fake states so the runtime path includes junk.
  stateValues.forEach((value, idx) => {
    const fake = fakeTransitions.get(idx);
    nextPairs[rng.int(0, nextPairs.length - 1)].push({
      key: numericLiteral(stateCodec.encode(value)),
      value: numericLiteral(stateCodec.encode(fake ? fake.state : nextStates[idx])),
    });
    dispatchPairs[rng.int(0, dispatchPairs.length - 1)].push({
      key: numericLiteral(stateCodec.encode(value)),
      value: numericLiteral(dispatchCodec.encode(dispatchValues[idx])),
    });
    if (fake) {
      nextPairs[rng.int(0, nextPairs.length - 1)].push({
        key: numericLiteral(stateCodec.encode(fake.state)),
        value: numericLiteral(stateCodec.encode(nextStates[idx])),
      });
      dispatchPairs[rng.int(0, dispatchPairs.length - 1)].push({
        key: numericLiteral(stateCodec.encode(fake.state)),
        value: numericLiteral(dispatchCodec.encode(fake.dispatch)),
      });
      order.push({ kind: "fake", index: idx });
    }
  });
  rng.shuffle(order);

  order.forEach((entry) => {
    const isFake = entry.kind === "fake";
    const index = entry.index;
    const stmt = statements[index];
    const dispatchValue = isFake
      ? fakeTransitions.get(index).dispatch
      : dispatchValues[index];
    const body = [];
    if (isFake) {
      body.push(...buildFakeStateBody(rng, {
        trashAName,
        trashBName,
        slotName,
        stateName,
      }, index));
    } else {
      body.push(stmt);
    }
    const caseOpaque = useOpaque ? buildOpaquePredicate(slotName, rng) : null;
    const condition = binaryExpression(
      "==",
      identifier(slotName),
      numericLiteral(dispatchCodec.encode(dispatchValue))
    );
    const caseEntry = {
      condition: caseOpaque ? logicalAnd(condition, caseOpaque, style) : condition,
      body,
    };
    if (!isFake && stmt.type === "ReturnStatement") {
      if (!allowIndirectHandlers) {
        directCases.push(caseEntry);
        return;
      }
      handlerPairs[rng.int(0, handlerPairs.length - 1)].push({
        key: numericLiteral(dispatchCodec.encode(dispatchValue)),
        value: buildFunctionExpression([
          assignmentStatement(
            identifier(returnPackName),
            callExpression(identifier(packName), cloneNode(stmt.arguments || []))
          ),
          assignmentStatement(identifier(stateName), identifier(exitName)),
        ], style),
      });
      return;
    } else {
      body.push(
        assignmentStatement(
          identifier(stateName),
          buildShardLookup(nextNames, identifier(stateName), style)
        )
      );
      if (!allowIndirectHandlers) {
        directCases.push(caseEntry);
      } else {
        handlerPairs[rng.int(0, handlerPairs.length - 1)].push({
          key: numericLiteral(dispatchCodec.encode(dispatchValue)),
          value: buildFunctionExpression(body, style),
        });
      }
    }
  });

  const elseBody = [
    assignmentStatement(identifier(stateName), identifier(exitName)),
  ];

  const whileBody = [
    localStatement(
      identifier(slotName),
      buildShardLookup(dispatchNames, identifier(stateName), style)
    ),
  ];
  if (!allowIndirectHandlers) {
    whileBody.push(buildIfStatement(directCases, elseBody, style));
  } else {
    const handlerCondition = useOpaque
      ? logicalAnd(identifier(handlerName), buildOpaquePredicate(slotName, rng), style)
      : identifier(handlerName);
    const cases = [
      {
        condition: handlerCondition,
        body: [
          callStatement(callExpression(identifier(handlerName))),
        ],
      },
    ];
    whileBody.push(
      localStatement(
        identifier(handlerName),
        buildShardLookup(handlerNames, identifier(slotName), style)
      )
    );
    whileBody.push(buildIfStatement(cases, elseBody, style));
  }

  const flattened = [
    localStatement(
      identifier(valuesName),
      buildTableList([
        numericLiteral(stateCodec.encode(stateValues[0])),
        numericLiteral(stateCodec.encode(exitState)),
      ], style)
    ),
    ...nextNames.map((name, idx) => localStatement(
      identifier(name),
      buildTableIndex(nextPairs[idx], style)
    )),
    ...dispatchNames.map((name, idx) => localStatement(
      identifier(name),
      buildTableIndex(dispatchPairs[idx], style)
    )),
    {
      type: "LocalStatement",
      variables: [identifier(trashAName), identifier(trashBName)],
      init: [numericLiteral(0), numericLiteral(0)],
    },
    localStatement(
      identifier(stateName),
      indexExpression(identifier(valuesName), numericLiteral(1))
    ),
    localStatement(
      identifier(exitName),
      indexExpression(identifier(valuesName), numericLiteral(2))
    ),
    buildWhileStatement(
      loopOpaque
        ? logicalAnd(
          binaryExpression("~=", identifier(stateName), identifier(exitName)),
          loopOpaque,
          style
        )
        : binaryExpression("~=", identifier(stateName), identifier(exitName)),
      whileBody,
      style
    ),
  ];
  if (allowIndirectHandlers) {
    if (hasReturnState) {
      flattened.splice(1, 0,
        localStatement(
          identifier(packName),
          indexExpression(
            indexExpression(identifier("_G"), escapedByteStringLiteral("table")),
            escapedByteStringLiteral("pack")
          )
        ),
        localStatement(
          identifier(unpackName),
          logicalOr(
            indexExpression(
              indexExpression(identifier("_G"), escapedByteStringLiteral("table")),
              escapedByteStringLiteral("unpack")
            ),
            indexExpression(identifier("_G"), escapedByteStringLiteral("unpack")),
            style
          )
        ),
        {
          type: "LocalStatement",
          variables: [identifier(returnPackName)],
          init: [],
        }
      );
    }
    flattened.splice(3, 0, ...handlerNames.map((name, idx) => localStatement(
      identifier(name),
      buildTableIndex(handlerPairs[idx], style)
    )));
  }
  if (hasReturnState) {
    flattened.push(
      returnStatement([
        callExpression(identifier(unpackName), [
          identifier(returnPackName),
          numericLiteral(1),
          indexExpression(identifier(returnPackName), stringLiteral("n")),
        ]),
      ])
    );
  }
  return flattened;
}

function flattenFunction(node, ctx) {
  if (node && node.cffGenerated) {
    return;
  }
  if (shouldSkipForVm(node, ctx && ctx.options)) {
    return;
  }
  const info = getFunctionStatements(node);
  if (!info) {
    return;
  }
  const { statements, style } = info;
  const minStatements = ctx.options.cffOptions?.minStatements ?? 3;
  if (!statements || statements.length < minStatements) {
    return;
  }
  if (hasUnsupportedStatements(statements)) {
    return;
  }

  const usedNames = collectIdentifierNames({ type: "Chunk", body: statements });
  if (ctx && typeof ctx.getSSA === "function") {
    const ssaRoot = ctx.getSSA();
    const ssa = findSSAForNode(ssaRoot, node);
    if (ssa) {
      addNamesFromSSA(ssa, usedNames);
    }
  }
  const prepared = prepareFlattenStatements(statements);
  if (!prepared) {
    return;
  }
  const flattened = buildFlattenedStatements(prepared.rewritten, {
    ...ctx,
    allowIndirectHandlers: !(node.hasVararg || node.isVararg),
  }, style, usedNames);
  if (prepared.hoisted.length) {
    flattened.unshift({
      type: "LocalStatement",
      variables: prepared.hoisted,
      init: [],
    });
  }
  setFunctionStatements(node, flattened, style);
}

function controlFlowFlatten(ast, ctx) {
  if (ctx && typeof ctx.getCFG === "function") {
    ctx.cfg = ctx.getCFG();
  }
  const mode = ctx && ctx.options && ctx.options.cffOptions
    ? ctx.options.cffOptions.mode
    : "classic";
  if (mode === "woven" && ctx && ctx.options && ctx.options.cffOptions?.hideTopReturnExpr) {
    hideTopReturnCallExpression(ast, ctx);
  }
  walk(ast, (node) => {
    if (!node || !node.type) {
      return;
    }
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
      if (mode === "woven") {
        flattenFunctionWoven(node, ctx);
      } else {
        flattenFunction(node, ctx);
      }
    }
  });
}

module.exports = {
  controlFlowFlatten,
};
