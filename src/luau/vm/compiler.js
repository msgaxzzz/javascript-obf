const { decodeRawString } = require("../strings");
const { makeDiagnosticErrorFromNode } = require("../custom/diagnostics");
const { BINARY_OP_MAP, UNARY_OP_MAP } = require("./opcodes");

function isCallLikeExpression(expr) {
  return Boolean(
    expr &&
    (expr.type === "CallExpression" ||
      expr.type === "MethodCallExpression" ||
      expr.type === "TableCallExpression" ||
      expr.type === "StringCallExpression")
  );
}

function isMultiReturnExpression(expr) {
  return Boolean(expr && (expr.type === "VarargLiteral" || isCallLikeExpression(expr)));
}

function isFunctionNode(node) {
  return Boolean(node && (node.type === "FunctionDeclaration" || node.type === "FunctionExpression"));
}

function isReferenceIdentifier(node, parent, key) {
  if (!node || node.type !== "Identifier" || !parent) {
    return true;
  }
  if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression") && key === "parameters") {
    return false;
  }
  if (parent.type === "FunctionName") {
    return false;
  }
  if (parent.type === "LocalStatement" && key === "variables") {
    return false;
  }
  if (parent.type === "ForNumericStatement" && key === "variable") {
    return false;
  }
  if (parent.type === "ForGenericStatement" && key === "variables") {
    return false;
  }
  if (parent.type === "MemberExpression" && key === "identifier") {
    return false;
  }
  if (parent.type === "TableField" && key === "name") {
    return false;
  }
  return true;
}

function walkOwnedFunctionNodes(root, visitor, parent = null, key = null) {
  if (!root || typeof root !== "object") {
    return;
  }
  if (Array.isArray(root)) {
    root.forEach((item, index) => walkOwnedFunctionNodes(item, visitor, parent, key || index));
    return;
  }
  visitor(root, parent, key);
  if (root !== parent && isFunctionNode(root) && root !== visitor.root) {
    return;
  }
  Object.keys(root).forEach((childKey) => {
    walkOwnedFunctionNodes(root[childKey], visitor, root, childKey);
  });
}

function collectDeclaredNamesInFunction(fnNode) {
  const names = new Set();
  const params = Array.isArray(fnNode && fnNode.parameters) ? fnNode.parameters : [];
  params.forEach((param) => {
    if (param && param.type === "Identifier" && param.name) {
      names.add(param.name);
    }
  });
  const visitor = (node, parent, key) => {
    if (!node || typeof node !== "object" || node === fnNode) {
      return;
    }
    if (node.type === "LocalStatement" && Array.isArray(node.variables)) {
      node.variables.forEach((variable) => {
        if (variable && variable.type === "Identifier" && variable.name) {
          names.add(variable.name);
        }
      });
      return;
    }
    if (node.type === "FunctionDeclaration" && node.isLocal && node.name && node.name.base && node.name.base.name) {
      names.add(node.name.base.name);
      return;
    }
    if (node.type === "ForNumericStatement" && node.variable && node.variable.name) {
      names.add(node.variable.name);
      return;
    }
    if (node.type === "ForGenericStatement" && Array.isArray(node.variables)) {
      node.variables.forEach((variable) => {
        if (variable && variable.type === "Identifier" && variable.name) {
          names.add(variable.name);
        }
      });
    }
  };
  visitor.root = fnNode;
  walkOwnedFunctionNodes(fnNode, visitor);
  return names;
}

function collectUsedIdentifierOrderInFunction(fnNode) {
  const names = [];
  const seen = new Set();
  const visitor = (node, parent, key) => {
    if (!node || node.type !== "Identifier" || !node.name) {
      return;
    }
    if (!isReferenceIdentifier(node, parent, key)) {
      return;
    }
    if (seen.has(node.name)) {
      return;
    }
    seen.add(node.name);
    names.push(node.name);
  };
  visitor.root = fnNode;
  walkOwnedFunctionNodes(fnNode, visitor);
  return names;
}

function appendUniqueName(names, seen, name) {
  if (!name || seen.has(name)) {
    return;
  }
  seen.add(name);
  names.push(name);
}

function collectFreeIdentifierOrderInFunction(fnNode) {
  const declared = collectDeclaredNamesInFunction(fnNode);
  const names = [];
  const seen = new Set();

  const visit = (node, parent = null, key = null) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, parent, key));
      return;
    }
    if (node !== fnNode && isFunctionNode(node)) {
      collectFreeIdentifierOrderInFunction(node).forEach((name) => {
        if (!declared.has(name)) {
          appendUniqueName(names, seen, name);
        }
      });
      return;
    }
    if (node.type === "Identifier" && node.name && isReferenceIdentifier(node, parent, key)) {
      if (!declared.has(node.name)) {
        appendUniqueName(names, seen, node.name);
      }
      return;
    }
    Object.keys(node).forEach((childKey) => {
      visit(node[childKey], node, childKey);
    });
  };

  visit(fnNode);
  return names;
}

function raise(message, node = null) {
  throw makeDiagnosticErrorFromNode(message, node);
}

class Emitter {
  constructor() {
    this.instructions = [];
    this.labels = new Map();
    this.jumps = [];
  }

  emit(op, a = 0, b = 0) {
    this.instructions.push([op, a, b]);
    return this.instructions.length - 1;
  }

  label(name) {
    this.labels.set(name, this.instructions.length);
  }

  emitJump(op, label) {
    const idx = this.emit(op, 0, 0);
    this.jumps.push({ idx, label, slot: 1 });
  }

  emitJumpB(op, a, label) {
    const idx = this.emit(op, a, 0);
    this.jumps.push({ idx, label, slot: 2 });
  }

  patch() {
    for (const entry of this.jumps) {
      const target = this.labels.get(entry.label);
      if (target === undefined) {
        raise(`Missing label ${entry.label}`);
      }
      this.instructions[entry.idx][entry.slot || 1] = target + 1;
    }
  }
}

class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.bindings = new Map();
  }

  define(name, index, meta = null) {
    this.bindings.set(name, { index, meta: meta || {} });
  }

  resolveBinding(name) {
    let current = this;
    while (current) {
      if (current.bindings.has(name)) {
        return current.bindings.get(name);
      }
      current = current.parent;
    }
    return null;
  }

  resolve(name) {
    const binding = this.resolveBinding(name);
    return binding ? binding.index : null;
  }
}

class VmCompiler {
  constructor({ style, options }) {
    this.style = style;
    this.options = options;
    this.emitter = new Emitter();
    this.consts = [];
    this.constMap = new Map();
    this.localCount = 0;
    this.scope = new Scope();
    this.loopStack = [];
    this.tempCount = 0;
    this.userLabelNames = new Map();
    this.functionHasVararg = false;
    this.closures = [];
  }

  nextTemp() {
    this.tempCount += 1;
    this.localCount += 1;
    return this.localCount;
  }

  reserveLocal() {
    this.localCount += 1;
    return this.localCount;
  }

  packRegisterPair(leftIdx, rightIdx) {
    return (((leftIdx || 0) & 0xffff) * 0x10000) + (((rightIdx || 0) & 0xffff));
  }

  addConst(value) {
    const key = `${typeof value}:${String(value)}`;
    if (this.constMap.has(key)) {
      return this.constMap.get(key);
    }
    const idx = this.consts.length + 1;
    this.consts.push(value);
    this.constMap.set(key, idx);
    return idx;
  }

  defineLocal(name, meta = null) {
    this.localCount += 1;
    this.scope.define(name, this.localCount, meta);
    return this.localCount;
  }

  resolveLocal(name) {
    return this.scope.resolve(name);
  }

  resolveBinding(name) {
    return this.scope.resolveBinding(name);
  }

  enterScope() {
    this.scope = new Scope(this.scope);
  }

  exitScope() {
    if (this.scope.parent) {
      this.scope = this.scope.parent;
    }
  }

  emit(op, a = 0, b = 0) {
    this.emitter.emit(op, a, b);
  }

  emitJump(op, label) {
    this.emitter.emitJump(op, label);
  }

  emitJumpB(op, a, label) {
    this.emitter.emitJumpB(op, a, label);
  }

  label(name) {
    this.emitter.label(name);
  }

  getUserLabelName(labelNode) {
    const raw = labelNode && labelNode.type === "Identifier"
      ? labelNode.name
      : (typeof labelNode === "string" ? labelNode : null);
    if (!raw) {
      raise("Invalid goto/label target", labelNode || null);
    }
    let name = this.userLabelNames.get(raw);
    if (!name) {
      name = this.makeLabel(`user_${raw}`);
      this.userLabelNames.set(raw, name);
    }
    return name;
  }

  normalizePreboundLocal(entry) {
    if (typeof entry === "string") {
      return { name: entry, init: entry, set: entry };
    }
    if (entry && typeof entry.name === "string") {
      return {
        name: entry.name,
        init: entry.init !== undefined ? entry.init : entry.name,
        set: entry.set !== undefined ? entry.set : entry.name,
      };
    }
    return null;
  }

  compileFunction(node, extraPreboundLocals = []) {
    const params = this.getFunctionParams(node);
    const preboundMap = new Map();
    [
      ...extraPreboundLocals,
      ...this.getFunctionPreboundLocals(node),
    ].forEach((entry) => {
      const normalized = this.normalizePreboundLocal(entry);
      if (normalized && !preboundMap.has(normalized.name)) {
        preboundMap.set(normalized.name, normalized);
      }
    });
    const preboundLocals = Array.from(preboundMap.values());
    const previousHasVararg = this.functionHasVararg;
    this.functionHasVararg = Boolean(node && node.hasVararg);
    this.enterScope();
    preboundLocals.forEach((entry) => {
      this.defineLocal(entry.name, { prebound: true });
    });
    this.enterScope();
    params.forEach((param) => {
      if (param) {
        this.defineLocal(param);
      } else {
        this.reserveLocal();
      }
    });
    const body = this.getFunctionBody(node);
    this.compileStatements(body);
    this.emit("RETURN", 0, 0);
    this.emitter.patch();
    this.exitScope();
    this.exitScope();
    this.functionHasVararg = previousHasVararg;
    return {
      instructions: this.emitter.instructions,
      consts: this.consts,
      closures: this.closures,
      localCount: this.localCount,
      paramCount: params.length,
      paramNames: params,
      localInitValues: [...preboundLocals.map((entry) => entry.init), ...params],
      localSetTargets: [...preboundLocals.map((entry) => entry.set), ...params],
      hasVararg: Boolean(node && node.hasVararg),
    };
  }

  compileChunk(node, {
    statements = null,
    preboundLocals = null,
  } = {}) {
    const body = Array.isArray(statements)
      ? statements
      : (node && Array.isArray(node.body) ? node.body : []);
    const locals = Array.isArray(preboundLocals)
      ? preboundLocals.filter((name) => typeof name === "string" && name.length > 0)
      : [];
    this.enterScope();
    locals.forEach((name) => {
      this.defineLocal(name);
    });
    const previousHasVararg = this.functionHasVararg;
    this.functionHasVararg = false;
    this.compileStatements(body);
    this.emit("RETURN", 0, 0);
    this.emitter.patch();
    this.exitScope();
    this.functionHasVararg = previousHasVararg;
    return {
      instructions: this.emitter.instructions,
      consts: this.consts,
      closures: this.closures,
      localCount: this.localCount,
      paramCount: locals.length,
      paramNames: locals,
      localInitValues: locals,
      localSetTargets: locals,
      hasVararg: false,
    };
  }

  getFunctionPreboundLocals(node) {
    if (!node || !node.isLocal) {
      return [];
    }
    if (this.style === "custom") {
      if (!node.name || node.name.type !== "FunctionName") {
        return [];
      }
      if ((node.name.members && node.name.members.length) || node.name.method) {
        return [];
      }
      return node.name.base && node.name.base.name ? [node.name.base.name] : [];
    }
    return node.identifier && node.identifier.type === "Identifier"
      ? [node.identifier.name]
      : [];
  }

  getFunctionParams(node) {
    const params = node.parameters || [];
    const names = params.map((param) => {
      if (param && typeof param.name === "string") {
        return param.name;
      }
      return null;
    });
    if (this.isMethodFunction(node) && names[0] !== "self") {
      names.unshift("self");
    }
    return names;
  }

  isMethodFunction(node) {
    if (!node || node.type !== "FunctionDeclaration") {
      return false;
    }
    if (this.style === "custom") {
      return Boolean(node.name && node.name.method);
    }
    const identifier = node.identifier;
    return Boolean(
      identifier &&
      identifier.type === "MemberExpression" &&
      identifier.indexer === ":"
    );
  }

  getFunctionBody(node) {
    if (this.style === "custom") {
      return node.body && node.body.body ? node.body.body : [];
    }
    return Array.isArray(node.body) ? node.body : [];
  }

  compileStatements(statements) {
    for (const stmt of statements) {
      this.compileStatement(stmt);
    }
  }

  compileStatement(stmt) {
    if (!stmt || !stmt.type) {
      return;
    }
    switch (stmt.type) {
      case "LocalStatement":
        this.compileLocalStatement(stmt);
        return;
      case "AssignmentStatement":
        this.compileAssignmentStatement(stmt);
        return;
      case "CompoundAssignmentStatement":
        this.compileCompoundAssignment(stmt);
        return;
      case "CallStatement":
        this.compileCallStatement(stmt);
        return;
      case "FunctionDeclaration":
        this.compileFunctionDeclaration(stmt);
        return;
      case "ReturnStatement":
        this.compileReturnStatement(stmt);
        return;
      case "IfStatement":
        this.compileIfStatement(stmt);
        return;
      case "WhileStatement":
        this.compileWhileStatement(stmt);
        return;
      case "RepeatStatement":
        this.compileRepeatStatement(stmt);
        return;
      case "ForNumericStatement":
        this.compileForNumeric(stmt);
        return;
      case "ForGenericStatement":
        this.compileForGeneric(stmt);
        return;
      case "DoStatement":
        this.enterScope();
        this.compileStatements(this.getBlockStatements(stmt.body));
        this.exitScope();
        return;
      case "BreakStatement":
        this.compileBreak();
        return;
      case "ContinueStatement":
        this.compileContinue();
        return;
      case "LabelStatement":
        this.compileLabelStatement(stmt);
        return;
      case "GotoStatement":
        this.compileGotoStatement(stmt);
        return;
      case "TypeAliasStatement":
      case "ExportTypeStatement":
      case "TypeFunctionStatement":
      case "ExportTypeFunctionStatement":
      case "DeclareFunctionStatement":
      case "DeclareVariableStatement":
      case "DeclareExternTypeStatement":
        return;
      default:
        raise(`Unsupported statement ${stmt.type}`, stmt);
    }
  }

  getBlockStatements(body) {
    if (!body) {
      return [];
    }
    if (Array.isArray(body)) {
      return body;
    }
    if (body.body && Array.isArray(body.body)) {
      return body.body;
    }
    return [];
  }

  compileLocalStatement(stmt) {
    const variables = stmt.variables || [];
    const init = stmt.init || [];
    if (variables.length <= 1 && init.length <= 1) {
      if (init.length === 1) {
        this.compileExpression(init[0]);
      } else {
        const nilIdx = this.addConst(null);
        this.emit("PUSH_CONST", nilIdx, 0);
      }
      const name = variables[0] ? variables[0].name : null;
      const localIdx = name ? this.defineLocal(name) : this.nextTemp();
      this.emit("DECLARE_LOCAL", localIdx, 0);
      return;
    }
    this.compileMultiAssign(variables, init, true);
  }

  compileAssignmentStatement(stmt) {
    const variables = stmt.variables || [];
    const init = stmt.init || [];
    if (variables.length <= 1 && init.length <= 1) {
      if (this.tryCompileRegisterizedAssignment(variables[0], init[0])) {
        return;
      }
      const preparedTargets = this.prepareMultiAssignTargets(variables);
      if (init.length === 1) {
        this.compileValueExpression(init[0], 1);
      } else {
        const nilIdx = this.addConst(null);
        this.emit("PUSH_CONST", nilIdx, 0);
      }
      this.compilePreparedAssignTarget(preparedTargets[0]);
      return;
    }
    this.compileMultiAssign(variables, init, false);
  }

  compileMultiAssign(variables, init, isLocal) {
    const temp = this.nextTemp();
    this.emit("NEW_TABLE", 0, 0);
    this.emit("SET_LOCAL", temp, 0);
    const preparedTargets = this.prepareMultiAssignTargets(variables);

    let writeIndex = 0;
    for (let idx = 0; idx < init.length && writeIndex < variables.length; idx += 1) {
      const expr = init[idx];
      const isLast = idx === init.length - 1;
      const remaining = variables.length - writeIndex;
      if (expr && isLast && remaining > 1 && isMultiReturnExpression(expr)) {
        const resultTemps = Array.from({ length: remaining }, () => this.nextTemp());
        this.compileValueExpression(expr, remaining);
        for (let j = remaining - 1; j >= 0; j -= 1) {
          this.emit("SET_LOCAL", resultTemps[j], 0);
        }
        for (let j = 0; j < remaining; j += 1) {
          this.emit("PUSH_LOCAL", temp, 0);
          this.emit("PUSH_CONST", this.addConst(writeIndex + j + 1), 0);
          this.emit("PUSH_LOCAL", resultTemps[j], 0);
          this.emit("SET_TABLE", 0, 0);
        }
        writeIndex = variables.length;
        break;
      }
      this.emit("PUSH_LOCAL", temp, 0);
      const keyIdx = this.addConst(writeIndex + 1);
      this.emit("PUSH_CONST", keyIdx, 0);
      this.compileValueExpression(expr, 1);
      this.emit("SET_TABLE", 0, 0);
      writeIndex += 1;
    }

    variables.forEach((variable, idx) => {
      this.emit("PUSH_LOCAL", temp, 0);
      const keyIdx = this.addConst(idx + 1);
      this.emit("PUSH_CONST", keyIdx, 0);
      this.emit("GET_TABLE", 0, 0);
      const prepared = preparedTargets[idx];
      if (isLocal && prepared && prepared.type === "Identifier") {
        const localIdx = this.defineLocal(prepared.name);
        this.emit("DECLARE_LOCAL", localIdx, 0);
      } else {
        this.compilePreparedAssignTarget(prepared);
      }
    });
  }

  compileCompoundAssignment(stmt) {
    if (!stmt || !stmt.variable) {
      return;
    }
    const normalizedOperator = typeof stmt.operator === "string" && stmt.operator.endsWith("=")
      ? stmt.operator.slice(0, -1)
      : stmt.operator;
    const opName = BINARY_OP_MAP.get(normalizedOperator);
    if (!opName) {
      raise(`Unsupported compound operator ${stmt.operator}`, stmt);
    }
    const target = stmt.variable;
    if (target.type === "Identifier") {
      if (this.tryCompileRegisterizedCompoundAssignment(target, normalizedOperator, stmt.value)) {
        return;
      }
      this.compileExpression(target);
      this.compileExpression(stmt.value);
      this.emit(opName, 0, 0);
      this.compileAssignTarget(target);
      return;
    }
    if (target.type === "MemberExpression") {
      const baseTmp = this.nextTemp();
      const valueTmp = this.nextTemp();
      this.compileExpression(target.base);
      this.emit("SET_LOCAL", baseTmp, 0);
      this.emit("PUSH_LOCAL", baseTmp, 0);
      this.emit("PUSH_CONST", this.addConst(target.identifier.name), 0);
      this.emit("GET_TABLE", 0, 0);
      this.compileExpression(stmt.value);
      this.emit(opName, 0, 0);
      this.emit("SET_LOCAL", valueTmp, 0);
      this.emit("PUSH_LOCAL", baseTmp, 0);
      this.emit("PUSH_CONST", this.addConst(target.identifier.name), 0);
      this.emit("PUSH_LOCAL", valueTmp, 0);
      this.emit("SET_TABLE", 0, 0);
      return;
    }
    if (target.type === "IndexExpression") {
      const baseTmp = this.nextTemp();
      const indexTmp = this.nextTemp();
      const valueTmp = this.nextTemp();
      this.compileExpression(target.base);
      this.emit("SET_LOCAL", baseTmp, 0);
      this.compileExpression(target.index);
      this.emit("SET_LOCAL", indexTmp, 0);
      this.emit("PUSH_LOCAL", baseTmp, 0);
      this.emit("PUSH_LOCAL", indexTmp, 0);
      this.emit("GET_TABLE", 0, 0);
      this.compileExpression(stmt.value);
      this.emit(opName, 0, 0);
      this.emit("SET_LOCAL", valueTmp, 0);
      this.emit("PUSH_LOCAL", baseTmp, 0);
      this.emit("PUSH_LOCAL", indexTmp, 0);
      this.emit("PUSH_LOCAL", valueTmp, 0);
      this.emit("SET_TABLE", 0, 0);
      return;
    }
    raise("Compound assignment supports identifiers/member/index targets only", target);
  }

  compileCallStatement(stmt) {
    this.compileCallExpression(stmt.expression, 0);
  }

  compileReturnStatement(stmt) {
    const args = stmt.arguments || [];
    if (!args.length) {
      this.emit("RETURN", 0, 0);
      return;
    }
    const tailExpr = args[args.length - 1];
    if (isMultiReturnExpression(tailExpr)) {
      for (let i = 0; i < args.length - 1; i += 1) {
        this.compileValueExpression(args[i], 1);
      }
      if (tailExpr.type === "VarargLiteral") {
        this.compileVarargPack(tailExpr);
        this.emit("RETURN_VARARGS", args.length - 1, 0);
        return;
      }
      if (this.callHasExpandedTail(tailExpr)) {
        this.emitExpandedReturnCall(tailExpr, args.length - 1);
      } else {
        const argc = this.compileCallFrame(tailExpr);
        this.emit("RETURN_CALL", argc, args.length - 1);
      }
      return;
    }
    args.forEach((expr) => this.compileValueExpression(expr, 1));
    this.emit("RETURN", args.length, 0);
  }

  compileIfStatement(stmt) {
    const clauses = this.getIfClauses(stmt);
    const endLabel = this.makeLabel("ifend");
    let idx = 0;
    for (const clause of clauses) {
      if (!clause.condition) {
        this.enterScope();
        this.compileStatements(clause.body);
        this.exitScope();
        this.emitJump("JMP", endLabel);
        break;
      }
      const nextLabel = this.makeLabel(`ifnext_${idx}`);
      const directJump = this.tryCompileRegisterizedFalseJump(clause.condition, nextLabel);
      if (!directJump) {
        this.compileExpression(clause.condition);
        this.emitJump("JMP_IF_FALSE", nextLabel);
        this.emit("POP", 0, 0);
      }
      this.enterScope();
      this.compileStatements(clause.body);
      this.exitScope();
      this.emitJump("JMP", endLabel);
      this.label(nextLabel);
      if (!directJump) {
        this.emit("POP", 0, 0);
      }
      idx += 1;
    }
    this.label(endLabel);
  }

  getIfClauses(stmt) {
    if (this.style === "custom") {
      const clauses = (stmt.clauses || []).map((clause) => ({
        condition: clause.condition,
        body: this.getBlockStatements(clause.body),
      }));
      if (stmt.elseBody) {
        clauses.push({
          condition: null,
          body: this.getBlockStatements(stmt.elseBody),
        });
      }
      return clauses;
    }
    const clauses = [];
    for (const clause of stmt.clauses || []) {
      if (clause.type === "ElseClause") {
        clauses.push({ condition: null, body: clause.body || [] });
      } else {
        clauses.push({ condition: clause.condition, body: clause.body || [] });
      }
    }
    return clauses;
  }

  compileWhileStatement(stmt) {
    const startLabel = this.makeLabel("while_start");
    const endLabel = this.makeLabel("while_end");
    this.loopStack.push({ breakLabel: endLabel, continueLabel: startLabel });
    this.label(startLabel);
    const directJump = this.tryCompileRegisterizedFalseJump(stmt.condition, endLabel);
    if (!directJump) {
      this.compileExpression(stmt.condition);
      this.emitJump("JMP_IF_FALSE", endLabel);
      this.emit("POP", 0, 0);
    }
    this.enterScope();
    this.compileStatements(this.getBlockStatements(stmt.body));
    this.exitScope();
    this.emitJump("JMP", startLabel);
    this.label(endLabel);
    if (!directJump) {
      this.emit("POP", 0, 0);
    }
    this.loopStack.pop();
  }

  compileRepeatStatement(stmt) {
    const startLabel = this.makeLabel("repeat_start");
    const endLabel = this.makeLabel("repeat_end");
    const condLabel = this.makeLabel("repeat_cond");
    this.loopStack.push({ breakLabel: endLabel, continueLabel: condLabel });
    this.label(startLabel);
    this.enterScope();
    this.compileStatements(this.getBlockStatements(stmt.body));
    this.label(condLabel);
    const directJump = this.tryCompileRegisterizedFalseJump(stmt.condition, startLabel);
    if (!directJump) {
      this.compileExpression(stmt.condition);
      this.emitJump("JMP_IF_FALSE", startLabel);
      this.emit("POP", 0, 0);
    }
    this.exitScope();
    this.label(endLabel);
    this.loopStack.pop();
  }

  compileForNumeric(stmt) {
    const startLabel = this.makeLabel("for_start");
    const endLabel = this.makeLabel("for_end");
    const continueLabel = this.makeLabel("for_continue");

    this.enterScope();
    const varName = stmt.variable ? stmt.variable.name : null;
    const varIdx = varName ? this.defineLocal(varName, { loopVariable: true }) : this.nextTemp();
    const controlIdx = this.nextTemp();
    const limitIdx = this.nextTemp();
    const stepIdx = this.nextTemp();

    this.compileExpression(stmt.start);
    this.emit("SET_LOCAL", controlIdx, 0);
    this.compileExpression(stmt.end);
    this.emit("SET_LOCAL", limitIdx, 0);
    if (stmt.step) {
      this.compileExpression(stmt.step);
    } else {
      const oneIdx = this.addConst(1);
      this.emit("PUSH_CONST", oneIdx, 0);
    }
    this.emit("SET_LOCAL", stepIdx, 0);

    this.loopStack.push({ breakLabel: endLabel, continueLabel });

    this.label(startLabel);
    this.emit("PUSH_LOCAL", stepIdx, 0);
    const zeroIdx = this.addConst(0);
    this.emit("PUSH_CONST", zeroIdx, 0);
    this.emit("GE", 0, 0);
    const branchLabel = this.makeLabel("for_branch");
    this.emitJump("JMP_IF_FALSE", branchLabel);
    this.emit("POP", 0, 0);
    const condOkLabel = this.makeLabel("for_cond_ok");
    this.emitJumpB("JMP_IF_LOCAL_LE", this.packRegisterPair(controlIdx, limitIdx), condOkLabel);
    this.emitJump("JMP", endLabel);
    this.label(branchLabel);
    this.emit("POP", 0, 0);
    this.emitJumpB("JMP_IF_LOCAL_GE", this.packRegisterPair(controlIdx, limitIdx), condOkLabel);
    this.emitJump("JMP", endLabel);
    this.label(condOkLabel);

    this.emit("PUSH_LOCAL", controlIdx, 0);
    this.emit("DECLARE_LOCAL", varIdx, 0);
    this.compileStatements(this.getBlockStatements(stmt.body));

    this.label(continueLabel);
    this.emit("ADD_REG_LOCAL", controlIdx, stepIdx);
    this.emitJump("JMP", startLabel);
    this.label(endLabel);

    this.loopStack.pop();
    this.exitScope();
  }

  compileForGeneric(stmt) {
    const startLabel = this.makeLabel("forg_start");
    const endLabel = this.makeLabel("forg_end");
    const nilLabel = this.makeLabel("forg_nil");

    this.enterScope();

    const fnIdx = this.nextTemp();
    const stateIdx = this.nextTemp();
    const ctrlIdx = this.nextTemp();

    const iterators = stmt.iterators || [];
    const slots = [fnIdx, stateIdx, ctrlIdx];
    const isMultiReturn = (expr) => (
      expr &&
      (expr.type === "CallExpression" ||
        expr.type === "MethodCallExpression" ||
        expr.type === "TableCallExpression" ||
        expr.type === "StringCallExpression")
    );
    let slotIndex = 0;
    for (let i = 0; i < iterators.length && slotIndex < slots.length; i += 1) {
      const expr = iterators[i];
      const isLast = i === iterators.length - 1;
      const remaining = slots.length - slotIndex;
      if (expr && isLast && remaining > 1 && isMultiReturn(expr)) {
        this.compileCallExpression(expr, remaining);
        for (let j = remaining - 1; j >= 0; j -= 1) {
          this.emit("SET_LOCAL", slots[slotIndex + j], 0);
        }
        slotIndex = slots.length;
        break;
      }
      if (expr) {
        this.compileExpression(expr);
      } else {
        this.emit("PUSH_CONST", this.addConst(null), 0);
      }
      this.emit("SET_LOCAL", slots[slotIndex], 0);
      slotIndex += 1;
    }
    while (slotIndex < slots.length) {
      this.emit("PUSH_CONST", this.addConst(null), 0);
      this.emit("SET_LOCAL", slots[slotIndex], 0);
      slotIndex += 1;
    }
    this.emit("PREP_ITER", this.packRegisterPair(fnIdx, stateIdx), ctrlIdx);

    const variables = stmt.variables || [];
    const varLocals = variables.map((variable) => {
      if (variable && variable.type === "Identifier") {
        return this.defineLocal(variable.name, { loopVariable: true });
      }
      return this.nextTemp();
    });

    this.loopStack.push({ breakLabel: endLabel, continueLabel: startLabel });

    this.label(startLabel);
    this.emit("PUSH_LOCAL", fnIdx, 0);
    this.emit("PUSH_LOCAL", stateIdx, 0);
    this.emit("PUSH_LOCAL", ctrlIdx, 0);
    const retCount = Math.max(1, varLocals.length);
    this.emit("CALL", 2, retCount);
    for (let i = varLocals.length - 1; i >= 0; i -= 1) {
      this.emit("DECLARE_LOCAL", varLocals[i], 0);
    }

    if (varLocals.length > 0) {
      this.emit("PUSH_LOCAL", varLocals[0], 0);
      this.emit("PUSH_CONST", this.addConst(null), 0);
      this.emit("EQ", 0, 0);
      this.emitJump("JMP_IF_TRUE", nilLabel);
      this.emit("POP", 0, 0);
      this.emit("PUSH_LOCAL", varLocals[0], 0);
      this.emit("SET_LOCAL", ctrlIdx, 0);
    }

    this.compileStatements(this.getBlockStatements(stmt.body));

    this.emitJump("JMP", startLabel);
    this.label(nilLabel);
    this.emit("POP", 0, 0);
    this.label(endLabel);

    this.loopStack.pop();
    this.exitScope();
  }

  compileBreak() {
    const loop = this.loopStack[this.loopStack.length - 1];
    if (!loop) {
      raise("break outside loop");
    }
    this.emitJump("JMP", loop.breakLabel);
  }

  compileContinue() {
    const loop = this.loopStack[this.loopStack.length - 1];
    if (!loop) {
      raise("continue outside loop");
    }
    this.emitJump("JMP", loop.continueLabel);
  }

  compileLabelStatement(stmt) {
    const label = stmt && (stmt.label || stmt.name) ? (stmt.label || stmt.name) : null;
    this.label(this.getUserLabelName(label));
  }

  compileGotoStatement(stmt) {
    const label = stmt && (stmt.label || stmt.name) ? (stmt.label || stmt.name) : null;
    this.emitJump("JMP", this.getUserLabelName(label));
  }

  getFunctionDeclarationTarget(stmt) {
    if (!stmt || !stmt.name || stmt.name.type !== "FunctionName") {
      return null;
    }
    const base = stmt.name.base;
    if (!base || !base.name) {
      return null;
    }
    let target = { type: "Identifier", name: base.name };
    const members = stmt.name.members || [];
    for (const member of members) {
      target = {
        type: "MemberExpression",
        base: target,
        indexer: ".",
        identifier: member,
      };
    }
    if (stmt.name.method) {
      target = {
        type: "MemberExpression",
        base: target,
        indexer: ".",
        identifier: stmt.name.method,
      };
    }
    return target;
  }

  compileFunctionDeclaration(stmt) {
    if (!stmt || stmt.type !== "FunctionDeclaration") {
      return;
    }
    if (stmt.isLocal) {
      const name = stmt.name && stmt.name.base && stmt.name.base.name;
      if (!name || (stmt.name.members && stmt.name.members.length) || stmt.name.method) {
        raise("Unsupported local function declaration target", stmt);
      }
      let localIdx = this.resolveLocal(name);
      if (!localIdx) {
        this.emit("PUSH_CONST", this.addConst(null), 0);
        localIdx = this.defineLocal(name);
        this.emit("DECLARE_LOCAL", localIdx, 0);
      }
      this.compileFunctionClosure(stmt);
      this.emit("SET_LOCAL", localIdx, 0);
      return;
    }

    const target = this.getFunctionDeclarationTarget(stmt);
    if (!target) {
      raise("Unsupported function declaration target", stmt);
    }
    this.compileFunctionClosure(stmt);
    this.compileAssignTarget(target);
  }

  collectClosureCaptures(fnNode) {
    const declared = collectDeclaredNamesInFunction(fnNode);
    const captures = [];
    const seen = new Set();
    collectFreeIdentifierOrderInFunction(fnNode).forEach((name) => {
      if (seen.has(name)) {
        return;
      }
      const binding = this.resolveBinding(name);
      if (!binding || !binding.index) {
        return;
      }
      seen.add(name);
      captures.push({ name, index: binding.index });
    });
    return captures;
  }

  compileFunctionClosure(fnNode) {
    const captures = this.collectClosureCaptures(fnNode);
    const child = new VmCompiler({ style: this.style, options: this.options });
    const prebound = captures.map((capture, index) => ({
      name: capture.name,
      init: { cell: `__vm_captures[${index + 1}]` },
      set: null,
    }));
    const program = child.compileFunction(fnNode, prebound);
    const closureIndex = this.closures.length + 1;
    this.closures.push({
      program,
      captures,
    });
    this.emit("PUSH_CLOSURE", closureIndex, 0);
  }

  compileAssignTarget(target) {
    if (!target) {
      this.emit("POP", 0, 0);
      return;
    }
    if (target.type === "Identifier") {
      const localIdx = this.resolveLocal(target.name);
      if (localIdx) {
        this.emit("SET_LOCAL", localIdx, 0);
      } else {
        const nameIdx = this.addConst(target.name);
        this.emit("SET_GLOBAL", nameIdx, 0);
      }
      return;
    }
    if (target.type === "MemberExpression") {
      const valueTmp = this.nextTemp();
      this.emit("SET_LOCAL", valueTmp, 0);
      this.compileExpression(target.base);
      const keyIdx = this.addConst(target.identifier.name);
      this.emit("PUSH_CONST", keyIdx, 0);
      this.emit("PUSH_LOCAL", valueTmp, 0);
      this.emit("SET_TABLE", 0, 0);
      return;
    }
    if (target.type === "IndexExpression") {
      const valueTmp = this.nextTemp();
      this.emit("SET_LOCAL", valueTmp, 0);
      this.compileExpression(target.base);
      this.compileExpression(target.index);
      this.emit("PUSH_LOCAL", valueTmp, 0);
      this.emit("SET_TABLE", 0, 0);
      return;
    }
    raise(`Unsupported assignment target ${target.type}`, target);
  }

  prepareMultiAssignTargets(variables) {
    return (variables || []).map((target) => {
      if (!target) {
        return null;
      }
      if (target.type === "Identifier") {
        return { type: "Identifier", name: target.name };
      }
      if (target.type === "MemberExpression") {
        const baseTmp = this.nextTemp();
        this.compileExpression(target.base);
        this.emit("SET_LOCAL", baseTmp, 0);
        return {
          type: "MemberExpression",
          baseTmp,
          key: target.identifier.name,
        };
      }
      if (target.type === "IndexExpression") {
        const baseTmp = this.nextTemp();
        const indexTmp = this.nextTemp();
        this.compileExpression(target.base);
        this.emit("SET_LOCAL", baseTmp, 0);
        this.compileExpression(target.index);
        this.emit("SET_LOCAL", indexTmp, 0);
        return {
          type: "IndexExpression",
          baseTmp,
          indexTmp,
        };
      }
      raise(`Unsupported assignment target ${target.type}`, target);
    });
  }

  compilePreparedAssignTarget(target) {
    if (!target) {
      this.emit("POP", 0, 0);
      return;
    }
    if (target.type === "Identifier") {
      const localIdx = this.resolveLocal(target.name);
      if (localIdx) {
        this.emit("SET_LOCAL", localIdx, 0);
      } else {
        const nameIdx = this.addConst(target.name);
        this.emit("SET_GLOBAL", nameIdx, 0);
      }
      return;
    }

    const valueTmp = this.nextTemp();
    this.emit("SET_LOCAL", valueTmp, 0);

    if (target.type === "MemberExpression") {
      this.emit("PUSH_LOCAL", target.baseTmp, 0);
      this.emit("PUSH_CONST", this.addConst(target.key), 0);
      this.emit("PUSH_LOCAL", valueTmp, 0);
      this.emit("SET_TABLE", 0, 0);
      return;
    }
    if (target.type === "IndexExpression") {
      this.emit("PUSH_LOCAL", target.baseTmp, 0);
      this.emit("PUSH_LOCAL", target.indexTmp, 0);
      this.emit("PUSH_LOCAL", valueTmp, 0);
      this.emit("SET_TABLE", 0, 0);
      return;
    }
    raise(`Unsupported assignment target ${target.type}`, target);
  }

  resolveRegisterOperand(expr) {
    if (!expr || !expr.type) {
      return null;
    }
    if (expr.type === "Identifier") {
      const localIdx = this.resolveLocal(expr.name);
      if (localIdx) {
        return { kind: "local", index: localIdx };
      }
      return null;
    }
    if (
      expr.type === "NumericLiteral" ||
      expr.type === "StringLiteral" ||
      expr.type === "BooleanLiteral" ||
      expr.type === "NilLiteral"
    ) {
      const value = expr.type === "NilLiteral" ? null : expr.value ?? this.extractLiteral(expr);
      return { kind: "const", index: this.addConst(value) };
    }
    return null;
  }

  emitRegisterBinaryOp(targetIdx, operator, operand) {
    if (!targetIdx || !operand) {
      return false;
    }
    if (operator === "+") {
      if (operand.kind === "local") {
        this.emit("ADD_REG_LOCAL", targetIdx, operand.index);
        return true;
      }
      if (operand.kind === "const") {
        this.emit("ADD_REG_CONST", targetIdx, operand.index);
        return true;
      }
      return false;
    }
    if (operator === "-") {
      if (operand.kind === "local") {
        this.emit("SUB_REG_LOCAL", targetIdx, operand.index);
        return true;
      }
      if (operand.kind === "const") {
        this.emit("SUB_REG_CONST", targetIdx, operand.index);
        return true;
      }
    }
    return false;
  }

  tryCompileRegisterizedAssignment(target, expr) {
    if (!target || target.type !== "Identifier" || !expr || expr.type !== "BinaryExpression") {
      return false;
    }
    const targetIdx = this.resolveLocal(target.name);
    if (!targetIdx) {
      return false;
    }
    const operator = expr.operator;
    if (operator !== "+" && operator !== "-") {
      return false;
    }
    const leftIsTarget = expr.left && expr.left.type === "Identifier" && expr.left.name === target.name;
    const rightIsTarget = expr.right && expr.right.type === "Identifier" && expr.right.name === target.name;
    if (leftIsTarget) {
      return this.emitRegisterBinaryOp(targetIdx, operator, this.resolveRegisterOperand(expr.right));
    }
    if (operator === "+" && rightIsTarget) {
      return this.emitRegisterBinaryOp(targetIdx, operator, this.resolveRegisterOperand(expr.left));
    }
    return false;
  }

  tryCompileRegisterizedCompoundAssignment(target, operator, valueExpr) {
    if (!target || target.type !== "Identifier") {
      return false;
    }
    if (operator !== "+" && operator !== "-") {
      return false;
    }
    const targetIdx = this.resolveLocal(target.name);
    if (!targetIdx) {
      return false;
    }
    return this.emitRegisterBinaryOp(targetIdx, operator, this.resolveRegisterOperand(valueExpr));
  }

  tryCompileRegisterizedFalseJump(condition, falseLabel) {
    if (!condition || condition.type !== "BinaryExpression") {
      return false;
    }
    const left = this.resolveRegisterOperand(condition.left);
    const right = this.resolveRegisterOperand(condition.right);
    if (!left || !right || left.kind !== "local" || right.kind !== "local") {
      return false;
    }
    const opMap = {
      "<": "JMP_IF_LOCAL_GE",
      "<=": "JMP_IF_LOCAL_GT",
      ">": "JMP_IF_LOCAL_LE",
      ">=": "JMP_IF_LOCAL_LT",
    };
    const jumpOp = opMap[condition.operator];
    if (!jumpOp) {
      return false;
    }
    this.emitJumpB(jumpOp, this.packRegisterPair(left.index, right.index), falseLabel);
    return true;
  }

  compileExpression(expr) {
    if (!expr || !expr.type) {
      const nilIdx = this.addConst(null);
      this.emit("PUSH_CONST", nilIdx, 0);
      return;
    }
    switch (expr.type) {
      case "Identifier": {
        const localIdx = this.resolveLocal(expr.name);
        if (localIdx) {
          this.emit("PUSH_LOCAL", localIdx, 0);
        } else {
          const nameIdx = this.addConst(expr.name);
          this.emit("PUSH_GLOBAL", nameIdx, 0);
        }
        return;
      }
      case "NumericLiteral":
      case "StringLiteral":
      case "BooleanLiteral":
      case "NilLiteral": {
        const value = expr.type === "NilLiteral" ? null : expr.value ?? this.extractLiteral(expr);
        const idx = this.addConst(value);
        this.emit("PUSH_CONST", idx, 0);
        return;
      }
      case "VarargLiteral":
        this.compileVarargValue(expr, 1);
        return;
      case "UnaryExpression": {
        const op = UNARY_OP_MAP.get(expr.operator);
        if (!op) {
          raise(`Unsupported unary ${expr.operator}`, expr);
        }
        this.compileExpression(expr.argument);
        this.emit(op, 0, 0);
        return;
      }
      case "LogicalExpression":
        this.compileLogicalExpression(expr);
        return;
      case "BinaryExpression": {
        if (expr.operator === "and" || expr.operator === "or") {
          this.compileLogicalExpression(expr);
          return;
        }
        const op = BINARY_OP_MAP.get(expr.operator);
        if (!op) {
          raise(`Unsupported binary ${expr.operator}`, expr);
        }
        this.compileExpression(expr.left);
        this.compileExpression(expr.right);
        this.emit(op, 0, 0);
        return;
      }
      case "GroupExpression":
        this.compileExpression(expr.expression);
        return;
      case "MemberExpression":
        this.compileExpression(expr.base);
        this.emit("PUSH_CONST", this.addConst(expr.identifier.name), 0);
        this.emit("GET_TABLE", 0, 0);
        return;
      case "IndexExpression":
        this.compileExpression(expr.base);
        this.compileExpression(expr.index);
        this.emit("GET_TABLE", 0, 0);
        return;
      case "CallExpression":
        this.compileCallExpression(expr, 1);
        return;
      case "MethodCallExpression":
        this.compileMethodCall(expr, 1);
        return;
      case "TableCallExpression":
        this.compileTableCall(expr, 1);
        return;
      case "StringCallExpression":
        this.compileStringCall(expr, 1);
        return;
      case "TableConstructorExpression":
        this.compileTableConstructor(expr);
        return;
      case "IfExpression":
        this.compileIfExpression(expr);
        return;
      case "FunctionExpression":
        this.compileFunctionClosure(expr);
        return;
      case "TypeAssertion":
        this.compileExpression(expr.expression);
        return;
      case "InterpolatedString":
        this.compileInterpolated(expr);
        return;
      default:
        raise(`Unsupported expression ${expr.type}`, expr);
    }
  }

  compileValueExpression(expr, retCount = 1) {
    if (expr && expr.type === "VarargLiteral") {
      this.compileVarargValue(expr, retCount);
      return;
    }
    if (!isCallLikeExpression(expr)) {
      this.compileExpression(expr);
      return;
    }
    switch (expr.type) {
      case "CallExpression":
        this.compileCallExpression(expr, retCount);
        return;
      case "MethodCallExpression":
        this.compileMethodCall(expr, retCount);
        return;
      case "TableCallExpression":
        this.compileTableCall(expr, retCount);
        return;
      case "StringCallExpression":
        this.compileStringCall(expr, retCount);
        return;
      default:
        this.compileExpression(expr);
    }
  }

  callHasExpandedTail(expr) {
    if (!expr) {
      return false;
    }
    if (expr.type !== "CallExpression" && expr.type !== "MethodCallExpression") {
      return false;
    }
    const args = expr.arguments || [];
    return args.length > 0 && isMultiReturnExpression(args[args.length - 1]);
  }

  assertVarargAvailable(expr) {
    if (!this.functionHasVararg) {
      raise("vararg outside vararg function", expr);
    }
  }

  compileVarargValue(expr, retCount = 1) {
    this.assertVarargAvailable(expr);
    const count = Math.max(1, retCount || 1);
    for (let i = 1; i <= count; i += 1) {
      this.emit("PUSH_VARARG", i, 0);
    }
  }

  compileVarargPack(expr) {
    this.assertVarargAvailable(expr);
    this.emit("PUSH_VARARGS", 0, 0);
  }

  emitTableValue(tableIdx, itemIndex, expr, retCount = 1) {
    this.emit("PUSH_LOCAL", tableIdx, 0);
    this.emit("PUSH_CONST", this.addConst(itemIndex), 0);
    this.compileValueExpression(expr, retCount);
    this.emit("SET_TABLE", 0, 0);
  }

  emitPackedTableCount(tableIdx, count) {
    this.emit("PUSH_LOCAL", tableIdx, 0);
    this.emit("PUSH_CONST", this.addConst("n"), 0);
    this.emit("PUSH_CONST", this.addConst(count), 0);
    this.emit("SET_TABLE", 0, 0);
  }

  compilePackCallResults(expr) {
    const temp = this.nextTemp();
    this.emit("NEW_TABLE", 0, 0);
    this.emit("SET_LOCAL", temp, 0);
    this.emitPackedTableCount(temp, 0);
    this.emit("PUSH_LOCAL", temp, 0);
    this.compileAppendCallLike(expr, 1);
    return temp;
  }

  compilePackMultiResults(expr) {
    if (expr && expr.type === "VarargLiteral") {
      const temp = this.nextTemp();
      this.compileVarargPack(expr);
      this.emit("SET_LOCAL", temp, 0);
      return temp;
    }
    return this.compilePackCallResults(expr);
  }

  compileExpandedCallExpressionPreparation(expr) {
    const fnIdx = this.nextTemp();
    const prefixIdx = this.nextTemp();
    const args = expr.arguments || [];
    const tailExpr = args[args.length - 1];

    if (expr.base && expr.base.type === "MemberExpression" && expr.base.indexer === ":") {
      const selfIdx = this.nextTemp();
      this.compileExpression(expr.base.base);
      this.emit("SET_LOCAL", selfIdx, 0);
      this.emit("PUSH_LOCAL", selfIdx, 0);
      this.emit("PUSH_CONST", this.addConst(expr.base.identifier.name), 0);
      this.emit("GET_TABLE", 0, 0);
      this.emit("SET_LOCAL", fnIdx, 0);

      this.emit("NEW_TABLE", 0, 0);
      this.emit("SET_LOCAL", prefixIdx, 0);
      this.emit("PUSH_LOCAL", prefixIdx, 0);
      this.emit("PUSH_CONST", this.addConst(1), 0);
      this.emit("PUSH_LOCAL", selfIdx, 0);
      this.emit("SET_TABLE", 0, 0);
      for (let i = 0; i < args.length - 1; i += 1) {
        this.emitTableValue(prefixIdx, i + 2, args[i], 1);
      }
      this.emitPackedTableCount(prefixIdx, args.length);
      const tailIdx = this.compilePackMultiResults(tailExpr);
      return { fnIdx, prefixIdx, tailIdx };
    }

    this.compileExpression(expr.base);
    this.emit("SET_LOCAL", fnIdx, 0);
    this.emit("NEW_TABLE", 0, 0);
    this.emit("SET_LOCAL", prefixIdx, 0);
    for (let i = 0; i < args.length - 1; i += 1) {
      this.emitTableValue(prefixIdx, i + 1, args[i], 1);
    }
    this.emitPackedTableCount(prefixIdx, args.length - 1);
    const tailIdx = this.compilePackMultiResults(tailExpr);
    return { fnIdx, prefixIdx, tailIdx };
  }

  compileExpandedMethodCallPreparation(expr) {
    const fnIdx = this.nextTemp();
    const prefixIdx = this.nextTemp();
    const baseIdx = this.nextTemp();
    const args = expr.arguments || [];
    const tailExpr = args[args.length - 1];

    this.compileExpression(expr.base);
    this.emit("SET_LOCAL", baseIdx, 0);
    this.emit("PUSH_LOCAL", baseIdx, 0);
    this.emit("PUSH_CONST", this.addConst(expr.method.name), 0);
    this.emit("GET_TABLE", 0, 0);
    this.emit("SET_LOCAL", fnIdx, 0);

    this.emit("NEW_TABLE", 0, 0);
    this.emit("SET_LOCAL", prefixIdx, 0);
    this.emit("PUSH_LOCAL", prefixIdx, 0);
    this.emit("PUSH_CONST", this.addConst(1), 0);
    this.emit("PUSH_LOCAL", baseIdx, 0);
    this.emit("SET_TABLE", 0, 0);
    for (let i = 0; i < args.length - 1; i += 1) {
      this.emitTableValue(prefixIdx, i + 2, args[i], 1);
    }
    this.emitPackedTableCount(prefixIdx, args.length);
    const tailIdx = this.compilePackMultiResults(tailExpr);
    return { fnIdx, prefixIdx, tailIdx };
  }

  compileExpandedCallPreparation(expr) {
    if (expr.type === "CallExpression") {
      return this.compileExpandedCallExpressionPreparation(expr);
    }
    if (expr.type === "MethodCallExpression") {
      return this.compileExpandedMethodCallPreparation(expr);
    }
    raise(`Unsupported expanded call expression ${expr.type}`, expr);
  }

  emitExpandedCall(expr, retCount) {
    const { fnIdx, prefixIdx, tailIdx } = this.compileExpandedCallPreparation(expr);
    this.emit("PUSH_LOCAL", fnIdx, 0);
    this.emit("PUSH_LOCAL", prefixIdx, 0);
    this.emit("PUSH_LOCAL", tailIdx, 0);
    this.emit("CALL_EXPAND", retCount, 0);
  }

  emitExpandedReturnCall(expr, prefixCount) {
    const { fnIdx, prefixIdx, tailIdx } = this.compileExpandedCallPreparation(expr);
    this.emit("PUSH_LOCAL", fnIdx, 0);
    this.emit("PUSH_LOCAL", prefixIdx, 0);
    this.emit("PUSH_LOCAL", tailIdx, 0);
    this.emit("RETURN_CALL_EXPAND", prefixCount, 0);
  }

  compileAppendCallLike(expr, startIndex) {
    if (expr && expr.type === "VarargLiteral") {
      this.compileVarargPack(expr);
      this.emit("APPEND_VARARGS", startIndex, 0);
      return;
    }
    if (this.callHasExpandedTail(expr)) {
      const { fnIdx, prefixIdx, tailIdx } = this.compileExpandedCallPreparation(expr);
      this.emit("PUSH_LOCAL", fnIdx, 0);
      this.emit("PUSH_LOCAL", prefixIdx, 0);
      this.emit("PUSH_LOCAL", tailIdx, 0);
      this.emit("APPEND_CALL_EXPAND", startIndex, 0);
      return;
    }
    const argc = this.compileCallFrame(expr);
    this.emit("APPEND_CALL", argc, startIndex);
  }

  extractLiteral(node) {
    if (node.type === "StringLiteral") {
      if (typeof node.value === "string") {
        return node.value;
      }
      if (typeof node.raw === "string") {
        const decoded = decodeRawString(node.raw);
        if (decoded !== null) {
          return decoded;
        }
        if (node.raw.length >= 2) {
          return node.raw.slice(1, -1);
        }
      }
      return "";
    }
    if (node.type === "NumericLiteral") {
      if (typeof node.value === "number") {
        return node.value;
      }
      if (typeof node.raw === "string") {
        return Number(node.raw);
      }
      return Number(node.value);
    }
    return node.value;
  }

  compileLogicalExpression(expr) {
    const endLabel = this.makeLabel("logic_end");
    if (expr.operator === "and") {
      this.compileExpression(expr.left);
      this.emitJump("JMP_IF_FALSE", endLabel);
      this.emit("POP", 0, 0);
      this.compileExpression(expr.right);
      this.label(endLabel);
      return;
    }
    this.compileExpression(expr.left);
    this.emitJump("JMP_IF_TRUE", endLabel);
    this.emit("POP", 0, 0);
    this.compileExpression(expr.right);
    this.label(endLabel);
  }

  compileCallExpression(expr, retCount) {
    if (this.callHasExpandedTail(expr)) {
      this.emitExpandedCall(expr, retCount);
      return;
    }
    const argc = this.compileCallFrame(expr);
    this.emit("CALL", argc, retCount);
  }

  compileCallFrame(expr) {
    switch (expr && expr.type) {
      case "CallExpression":
        return this.compileCallFrameExpression(expr);
      case "MethodCallExpression":
        return this.compileMethodCallFrame(expr);
      case "TableCallExpression":
        return this.compileTableCallFrame(expr);
      case "StringCallExpression":
        return this.compileStringCallFrame(expr);
      default:
        raise(`Unsupported call expression ${expr && expr.type}`, expr);
    }
  }

  compileCallFrameExpression(expr) {
    if (expr.base && expr.base.type === "MemberExpression" && expr.base.indexer === ":") {
      this.compileExpression(expr.base.base);
      this.emit("DUP", 0, 0);
      this.emit("PUSH_CONST", this.addConst(expr.base.identifier.name), 0);
      this.emit("GET_TABLE", 0, 0);
      this.emit("SWAP", 0, 0);
      const args = expr.arguments || [];
      args.forEach((arg) => this.compileExpression(arg));
      return args.length + 1;
    }
    this.compileExpression(expr.base);
    const args = expr.arguments || [];
    args.forEach((arg) => this.compileExpression(arg));
    return args.length;
  }

  compileMethodCall(expr, retCount) {
    if (this.callHasExpandedTail(expr)) {
      this.emitExpandedCall(expr, retCount);
      return;
    }
    const argc = this.compileMethodCallFrame(expr);
    this.emit("CALL", argc, retCount);
  }

  compileMethodCallFrame(expr) {
    this.compileExpression(expr.base);
    this.emit("DUP", 0, 0);
    this.emit("PUSH_CONST", this.addConst(expr.method.name), 0);
    this.emit("GET_TABLE", 0, 0);
    this.emit("SWAP", 0, 0);
    const args = expr.arguments || [];
    args.forEach((arg) => this.compileExpression(arg));
    return args.length + 1;
  }

  compileTableCall(expr, retCount) {
    const argc = this.compileTableCallFrame(expr);
    this.emit("CALL", argc, retCount);
  }

  compileTableCallFrame(expr) {
    this.compileExpression(expr.base);
    this.compileExpression(expr.arguments);
    return 1;
  }

  compileStringCall(expr, retCount) {
    const argc = this.compileStringCallFrame(expr);
    this.emit("CALL", argc, retCount);
  }

  compileStringCallFrame(expr) {
    this.compileExpression(expr.base);
    this.compileExpression(expr.argument);
    return 1;
  }

  compileTableConstructor(expr) {
    this.emit("NEW_TABLE", 0, 0);
    let listIndex = 1;
    const fields = expr.fields || [];
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      const field = fields[fieldIndex];
      const isLastField = fieldIndex === fields.length - 1;
      if (field.type === "TableKey") {
        this.emit("DUP", 0, 0);
        this.compileExpression(field.key);
        this.compileExpression(field.value);
        this.emit("SET_TABLE", 0, 0);
      } else if (field.type === "TableKeyString") {
        this.emit("DUP", 0, 0);
        this.emit("PUSH_CONST", this.addConst(field.key.name), 0);
        this.compileExpression(field.value);
        this.emit("SET_TABLE", 0, 0);
      } else if (field.type === "TableValue") {
        this.emit("DUP", 0, 0);
        if (isLastField && isMultiReturnExpression(field.value)) {
          this.compileAppendCallLike(field.value, listIndex);
          this.emit("POP", 0, 0);
        } else {
          this.emit("PUSH_CONST", this.addConst(listIndex), 0);
          this.compileValueExpression(field.value, 1);
          this.emit("SET_TABLE", 0, 0);
          listIndex += 1;
        }
      } else if (field.kind === "index") {
        this.emit("DUP", 0, 0);
        this.compileExpression(field.key);
        this.compileExpression(field.value);
        this.emit("SET_TABLE", 0, 0);
      } else if (field.kind === "name") {
        this.emit("DUP", 0, 0);
        this.emit("PUSH_CONST", this.addConst(field.name.name), 0);
        this.compileExpression(field.value);
        this.emit("SET_TABLE", 0, 0);
      } else if (field.kind === "list") {
        this.emit("DUP", 0, 0);
        if (isLastField && isMultiReturnExpression(field.value)) {
          this.compileAppendCallLike(field.value, listIndex);
          this.emit("POP", 0, 0);
        } else {
          this.emit("PUSH_CONST", this.addConst(listIndex), 0);
          this.compileValueExpression(field.value, 1);
          this.emit("SET_TABLE", 0, 0);
          listIndex += 1;
        }
      }
    }
  }

  compileIfExpression(expr) {
    const endLabel = this.makeLabel("ifexpr_end");
    const clauses = expr.clauses || [];
    let idx = 0;
    for (const clause of clauses) {
      const nextLabel = this.makeLabel(`ifexpr_next_${idx}`);
      this.compileExpression(clause.condition);
      this.emitJump("JMP_IF_FALSE", nextLabel);
      this.emit("POP", 0, 0);
      this.compileExpression(clause.value);
      this.emitJump("JMP", endLabel);
      this.label(nextLabel);
      this.emit("POP", 0, 0);
      idx += 1;
    }
    this.compileExpression(expr.elseValue);
    this.label(endLabel);
  }

  compileInterpolated(expr) {
    if (expr.raw) {
      const idx = this.addConst(expr.raw.slice(1, -1));
      this.emit("PUSH_CONST", idx, 0);
      return;
    }
    const parts = expr.parts || [];
    if (!parts.length) {
      const idx = this.addConst("");
      this.emit("PUSH_CONST", idx, 0);
      return;
    }
    let first = true;
    for (const part of parts) {
      if (part.type === "InterpolatedStringText") {
        this.emit("PUSH_CONST", this.addConst(part.raw), 0);
      } else {
        this.compileExpression(part);
      }
      if (first) {
        first = false;
      } else {
        this.emit("CONCAT", 0, 0);
      }
    }
  }

  makeLabel(prefix) {
    if (!this.labelCount) {
      this.labelCount = 0;
    }
    const name = `${prefix}_${this.labelCount}`;
    this.labelCount += 1;
    return name;
  }
}

module.exports = {
  VmCompiler,
};
