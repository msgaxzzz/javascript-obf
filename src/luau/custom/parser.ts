// @ts-nocheck
import type { Chunk } from "./nodes";
import type { Token, TokenizerInstance } from "./tokenizer";

const { Tokenizer } = require("./tokenizer");
const { makeDiagnosticError } = require("./diagnostics");

const PRECEDENCE = {
  or: 1,
  and: 2,
  "<": 3,
  ">": 3,
  "<=": 3,
  ">=": 3,
  "~=": 3,
  "==": 3,
  "|": 4,
  "~": 5,
  "&": 6,
  "<<": 7,
  ">>": 7,
  "..": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "//": 10,
  "%": 10,
  "^": 12,
};

const RIGHT_ASSOC = new Set(["..", "^"]);
const COMPOUND_ASSIGN = new Set(["+=", "-=", "*=", "/=", "%=", "^=", "//=", "..="]);
const CONTINUE_EXPRESSION_START = new Set(["=", ",", ".", "[", ":", "(", "{"]);

export interface ParserInstance {
  tokenizer: TokenizerInstance;
  current: Token;
  last: Token | null;
  parse(): Chunk;
  advance(): Token;
  is(type: string, value?: string): boolean;
  eat(type: string, value?: string): Token | null;
  expect(type: string, value?: string): Token;
  raise(message: string, token?: Token, expected?: string | null): never;
  peek(): Token;
}

export interface ParserConstructor {
  new (source: string): ParserInstance;
}

class Parser {
  constructor(source) {
    this.tokenizer = new Tokenizer(source);
    this.current = this.tokenizer.next();
    this.last = null;
  }

  parse() {
    const start = this.current;
    const block = this.parseBlock([]);
    return this.finishNode({ type: "Chunk", body: block.body }, start, this.last || start);
  }

  advance() {
    const token = this.current;
    this.current = this.tokenizer.next();
    this.last = token;
    return token;
  }

  is(type, value) {
    if (this.current.type !== type) {
      return false;
    }
    if (value !== undefined) {
      return this.current.value === value;
    }
    return true;
  }

  eat(type, value) {
    if (this.is(type, value)) {
      return this.advance();
    }
    return null;
  }

  expect(type, value) {
    const tok = this.eat(type, value);
    if (!tok) {
      const got = this.current.value ? `${this.current.type}(${this.current.value})` : this.current.type;
      const expected = value !== undefined ? `${type}(${value})` : type;
      throw makeDiagnosticError(`Unexpected token ${got}`, this.current, expected);
    }
    return tok;
  }

  raise(message, token = this.current, expected = null) {
    throw makeDiagnosticError(message, token, expected);
  }

  peek() {
    return this.tokenizer.peek();
  }

  clonePosition(pos) {
    return pos ? { line: pos.line, column: pos.column } : null;
  }

  nodeStart(node) {
    if (!node || !node.range || !node.loc) {
      return null;
    }
    const startPos = this.clonePosition(node.loc.start || node.loc.begin);
    return {
      range: [node.range[0], node.range[0]],
      loc: {
        start: startPos,
        begin: startPos,
        end: startPos,
      },
    };
  }

  finishNode(node, startToken, endToken = this.last || startToken) {
    const start = startToken || endToken;
    const end = endToken || startToken;
    if (!start || !end || !start.range || !end.range || !start.loc || !end.loc) {
      return node;
    }
    const startPos = this.clonePosition(start.loc.start || start.loc.begin);
    const endPos = this.clonePosition(end.loc.end);
    node.range = [start.range[0], end.range[1]];
    node.loc = {
      start: startPos,
      begin: startPos,
      end: endPos,
    };
    return node;
  }

  parseStatement() {
    const start = this.current;
    const attributes = this.parseAttributes();
    let stmt;

    if (this.is("symbol", "::")) {
      stmt = this.parseLabelStatement();
    } else if (this.is("keyword", "export") && this.peek().type === "keyword" && this.peek().value === "type") {
      stmt = this.parseTypeStatement(true);
    } else if (
      this.is("keyword", "type") &&
      (this.peek().type === "identifier" || (this.peek().type === "keyword" && this.peek().value === "function"))
    ) {
      stmt = this.parseTypeStatement(false);
    } else if (this.is("keyword", "declare")) {
      stmt = this.parseDeclareStatement();
    } else if (this.is("keyword", "local")) {
      stmt = this.parseLocalStatement();
    } else if (
      this.is("identifier", "const") &&
      (this.peek().type === "identifier" || (this.peek().type === "keyword" && this.peek().value === "function"))
    ) {
      stmt = this.parseConstStatement();
    } else if (this.is("keyword", "function")) {
      stmt = this.parseFunctionDeclaration(false);
    } else if (this.is("keyword", "if")) {
      stmt = this.parseIfStatement();
    } else if (this.is("keyword", "while")) {
      stmt = this.parseWhileStatement();
    } else if (this.is("keyword", "repeat")) {
      stmt = this.parseRepeatStatement();
    } else if (this.is("keyword", "for")) {
      stmt = this.parseForStatement();
    } else if (this.is("keyword", "do")) {
      stmt = this.parseDoStatement();
    } else if (this.is("keyword", "return")) {
      stmt = this.parseReturnStatement();
    } else if (this.is("keyword", "break")) {
      this.eat("keyword", "break");
      stmt = { type: "BreakStatement" };
    } else if (this.isContinueStatement()) {
      this.consumeContinueStatement();
      stmt = { type: "ContinueStatement" };
    } else if (this.is("keyword", "goto")) {
      stmt = this.parseGotoStatement();
    } else {
      const expr = this.parsePrefixExpression();
      if (expr.type === "CallExpression" || expr.type === "MethodCallExpression") {
        stmt = { type: "CallStatement", expression: expr };
      } else {
        const variables = [expr];
        while (this.eat("symbol", ",")) {
          variables.push(this.parsePrefixExpression());
        }

        if (this.is("symbol") && COMPOUND_ASSIGN.has(this.current.value)) {
          if (variables.length !== 1) {
            this.raise("Compound assignment only supports single target");
          }
          const operator = this.current.value;
          this.advance();
          const value = this.parseExpression();
          stmt = { type: "CompoundAssignmentStatement", operator, variable: variables[0], value };
        } else {
          this.expect("symbol", "=");
          const init = this.parseExpressionList();
          stmt = { type: "AssignmentStatement", variables, init };
        }
      }
    }

    if (attributes.length && !this.statementAllowsAttributes(stmt)) {
      this.raise("Attributes can only be applied to function declarations", start);
    }
    stmt = this.attachAttributes(stmt, attributes);
    return this.finishNode(stmt, start);
  }

  statementAllowsAttributes(stmt) {
    return Boolean(
      stmt &&
        (stmt.type === "FunctionDeclaration" ||
          stmt.type === "TypeFunctionStatement" ||
          stmt.type === "ExportTypeFunctionStatement" ||
          stmt.type === "DeclareFunctionStatement")
    );
  }

  isContinueStatement() {
    if (this.is("keyword", "continue")) {
      return true;
    }
    if (!this.is("identifier", "continue")) {
      return false;
    }
    const next = this.peek();
    if (!next || next.type === "eof") {
      return true;
    }
    if (next.type === "symbol") {
      if (CONTINUE_EXPRESSION_START.has(next.value)) {
        return false;
      }
      if (next.value === ";") {
        return true;
      }
    }
    if (next.type === "string" || next.type === "interpString") {
      return false;
    }
    return true;
  }

  consumeContinueStatement() {
    this.advance();
  }

  attachAttributes(node, attributes) {
    if (attributes.length) {
      node.attributes = attributes;
    }
    return node;
  }

  parseAttributes() {
    const attributes = [];
    while (this.is("symbol", "@")) {
      const atToken = this.current;
      this.eat("symbol", "@");
      if (this.eat("symbol", "[")) {
        if (this.is("symbol", "]")) {
          this.raise("Attribute list cannot be empty");
        }
        while (!this.is("symbol", "]")) {
          attributes.push(this.parseAttributeEntry());
          if (!this.eat("symbol", ",")) {
            break;
          }
        }
        this.expect("symbol", "]");
        continue;
      }
      attributes.push(this.parseAttributeEntry(atToken));
    }
    return attributes;
  }

  parseAttributeEntry(startToken = this.current) {
    const name = this.parseIdentifier();
    let args = null;
    let argumentStyle = null;
    if (this.eat("symbol", "(")) {
      args = [];
      if (!this.is("symbol", ")")) {
        args.push(...this.parseExpressionList());
      }
      this.expect("symbol", ")");
      argumentStyle = "parens";
    } else if (this.is("string")) {
      args = [this.parseStringLiteral()];
      argumentStyle = "bare";
    } else if (this.is("symbol", "{")) {
      args = [this.parseTableConstructor()];
      argumentStyle = "bare";
    }
    if (args && !args.every(isAttributeLiteral)) {
      this.raise("Only literal values can be used as attribute arguments");
    }
    const attr = { type: "Attribute", name, arguments: args };
    if (argumentStyle) {
      attr.argumentStyle = argumentStyle;
    }
    return this.finishNode(attr, startToken);
  }

  parseLabelStatement() {
    const start = this.current;
    this.expect("symbol", "::");
    const name = this.parseIdentifier();
    this.expect("symbol", "::");
    return this.finishNode({ type: "LabelStatement", name }, start);
  }

  parseGotoStatement() {
    const start = this.current;
    this.expect("keyword", "goto");
    const name = this.parseIdentifier();
    return this.finishNode({ type: "GotoStatement", name }, start);
  }

  parseTypeStatement(isExport) {
    const start = this.current;
    if (isExport) {
      this.expect("keyword", "export");
    }
    this.expect("keyword", "type");
    if (this.is("keyword", "function")) {
      const stmt = this.parseTypeFunctionStatement(isExport);
      return this.finishNode(stmt, start);
    }
    const name = this.parseIdentifier();
    const typeParameters = this.parseTypeParameterList(true);
    this.expect("symbol", "=");
    const value = this.parseTypeExpression();
    return this.finishNode({
      type: isExport ? "ExportTypeStatement" : "TypeAliasStatement",
      name,
      typeParameters,
      value,
    }, start);
  }

  parseTypeFunctionStatement(isExport) {
    const start = this.current;
    this.expect("keyword", "function");
    const name = this.parseIdentifier();
    const typeParameters = this.parseTypeParameterList(false);
    this.expect("symbol", "(");
    const { parameters, hasVararg, varargAnnotation } = this.parseFunctionParameters();
    this.expect("symbol", ")");
    let returnTypes = [];
    if (this.eat("symbol", ":")) {
      returnTypes = this.parseTypeExpressionList(true);
    }
    const body = this.parseBlock(["end"]);
    this.expect("keyword", "end");
    return this.finishNode({
      type: isExport ? "ExportTypeFunctionStatement" : "TypeFunctionStatement",
      name,
      typeParameters,
      parameters,
      hasVararg,
      varargAnnotation,
      returnTypes,
      body,
    }, start);
  }

  parseDeclareStatement() {
    const start = this.current;
    this.expect("keyword", "declare");
    if (this.is("keyword", "function")) {
      const stmt = this.parseDeclareFunctionStatement();
      return this.finishNode(stmt, start);
    }
    if (this.is("identifier", "class")) {
      const stmt = this.parseDeclareExternTypeStatement("class");
      return this.finishNode(stmt, start);
    }
    if (this.is("identifier", "extern")) {
      const stmt = this.parseDeclareExternTypeStatement("extern");
      return this.finishNode(stmt, start);
    }
    const name = this.parseIdentifier();
    this.expect("symbol", ":");
    const annotation = this.parseTypeExpression();
    return this.finishNode({ type: "DeclareVariableStatement", name, annotation }, start);
  }

  parseDeclareFunctionStatement() {
    const start = this.current;
    this.expect("keyword", "function");
    const name = this.parseFunctionName(false);
    const typeParameters = this.parseTypeParameterList(false);
    this.expect("symbol", "(");
    const { parameters, hasVararg, varargAnnotation } = this.parseFunctionParameters();
    this.expect("symbol", ")");
    this.validateDeclarationParameters(parameters, hasVararg, varargAnnotation, "All declaration parameters must be annotated");
    let returnType = null;
    if (this.eat("symbol", ":")) {
      returnType = this.parseTypeExpression(true);
    }
    return this.finishNode({
      type: "DeclareFunctionStatement",
      name,
      typeParameters,
      parameters,
      hasVararg,
      varargAnnotation,
      returnType,
    }, start);
  }

  parseDeclareExternTypeStatement(kind) {
    const start = this.current;
    if (kind === "class") {
      this.expect("identifier", "class");
    } else {
      this.expect("identifier", "extern");
      this.expect("keyword", "type");
    }
    const name = this.parseIdentifier();
    let superName = null;
    if (this.eat("identifier", "extends")) {
      superName = this.parseIdentifier();
    }
    const props = [];
    let indexer = null;
    let hasBody = kind === "class";
    if (kind === "extern" && this.eat("identifier", "with")) {
      hasBody = true;
    }
    if (hasBody) {
      while (!this.is("eof") && !this.is("keyword", "end")) {
        if (this.eat("symbol", ";")) {
          continue;
        }
        const member = this.parseDeclareExternTypeMember();
        if (member.kind === "indexer") {
          if (indexer) {
            this.raise("Cannot have more than one indexer on an extern type", member);
          }
          indexer = member;
        } else {
          props.push(member);
        }
        this.eat("symbol", ",");
        this.eat("symbol", ";");
      }
      this.expect("keyword", "end");
    }
    return this.finishNode({
      type: "DeclareExternTypeStatement",
      declarationKind: kind,
      name,
      superName,
      props,
      indexer,
      hasBody,
    }, start);
  }

  parseDeclareExternTypeMember() {
    const access = this.parseTableAccess();
    if (this.is("keyword", "function")) {
      if (access) {
        this.raise("Extern type method cannot have a table access modifier");
      }
      return this.parseDeclareExternTypeMethod();
    }
    if (this.eat("symbol", "[")) {
      const start = this.last;
      let indexAccess = access;
      if (!indexAccess && (this.is("identifier", "read") || this.is("identifier", "write"))) {
        indexAccess = this.current.value;
        this.advance();
      }
      const key = this.parseTypeExpression();
      this.expect("symbol", "]");
      this.expect("symbol", ":");
      const value = this.parseTypeExpression();
      return this.finishNode({ type: "DeclareExternTypeIndexer", kind: "indexer", key, value, access: indexAccess }, start);
    }
    const start = this.current;
    const name = this.parseIdentifier();
    this.expect("symbol", ":");
    const value = this.parseTypeExpression();
    return this.finishNode({ type: "DeclareExternTypeProperty", kind: "property", name, value, access }, start);
  }

  parseDeclareExternTypeMethod() {
    const start = this.current;
    this.expect("keyword", "function");
    const name = this.parseIdentifier();
    const typeParameters = this.parseTypeParameterList(false);
    this.expect("symbol", "(");
    const { parameters, hasVararg, varargAnnotation } = this.parseFunctionParameters();
    this.expect("symbol", ")");
    if (!parameters[0] || parameters[0].name !== "self" || parameters[0].annotation) {
      this.raise("'self' must be present as the unannotated first parameter", start);
    }
    this.validateDeclarationParameters(
      parameters.slice(1),
      hasVararg,
      varargAnnotation,
      "All declaration parameters aside from 'self' must be annotated",
    );
    let returnType = null;
    if (this.eat("symbol", ":")) {
      returnType = this.parseTypeExpression(true);
    }
    return this.finishNode({
      type: "DeclareExternTypeProperty",
      kind: "method",
      name,
      parameters,
      hasVararg,
      varargAnnotation,
      returnType,
      typeParameters,
    }, start);
  }

  validateDeclarationParameters(parameters, hasVararg, varargAnnotation, message) {
    for (const param of parameters) {
      if (!param || !param.annotation) {
        this.raise(message, param || this.current);
      }
    }
    if (hasVararg && !varargAnnotation) {
      this.raise(message);
    }
  }

  parseLocalStatement() {
    const start = this.current;
    this.expect("keyword", "local");
    if (this.is("keyword", "function")) {
      const stmt = this.parseFunctionDeclaration(true);
      return this.finishNode(stmt, start);
    }
    if (this.is("keyword", "type")) {
      const stmt = this.parseTypeStatement(false);
      return this.finishNode(stmt, start);
    }
    const variables = [this.parseTypedIdentifier()];
    while (this.eat("symbol", ",")) {
      variables.push(this.parseTypedIdentifier());
    }
    let init = [];
    if (this.eat("symbol", "=")) {
      init = this.parseExpressionList();
    }
    return this.finishNode({ type: "LocalStatement", variables, init }, start);
  }

  parseConstStatement() {
    const start = this.current;
    this.expect("identifier", "const");
    if (this.is("keyword", "function")) {
      const stmt = this.parseFunctionDeclaration(true);
      stmt.isConst = true;
      return this.finishNode(stmt, start);
    }
    const variables = [this.parseTypedIdentifier()];
    while (this.eat("symbol", ",")) {
      variables.push(this.parseTypedIdentifier());
    }
    this.expect("symbol", "=");
    const init = this.parseExpressionList();
    this.validateConstInitializerCount(variables, init);
    return this.finishNode({ type: "LocalStatement", variables, init, isConst: true }, start);
  }

  validateConstInitializerCount(variables, init) {
    if (init.length >= variables.length) {
      return;
    }
    const last = init[init.length - 1];
    if (last && (last.type === "CallExpression" || last.type === "MethodCallExpression" || last.type === "VarargLiteral")) {
      return;
    }
    this.raise("Missing initializer in const declaration", last || this.current);
  }

  parseFunctionName(isLocal) {
    const start = this.current;
    const base = this.parseIdentifier();
    const members = [];
    let method = null;
    while (this.eat("symbol", ".")) {
      members.push(this.parseIdentifier());
    }
    if (this.eat("symbol", ":")) {
      method = this.parseIdentifier();
    }
    if (isLocal && (members.length > 0 || method)) {
      this.raise("Local function name cannot contain '.' or ':'");
    }
    return this.finishNode({ type: "FunctionName", base, members, method }, start);
  }

  parseFunctionParameters() {
    const parameters = [];
    let hasVararg = false;
    let varargAnnotation = null;
    if (!this.is("symbol", ")")) {
      if (this.is("symbol", "...")) {
        hasVararg = true;
        this.eat("symbol", "...");
        if (this.eat("symbol", ":")) {
          varargAnnotation = this.parseTypeExpression(true);
        }
      } else {
        parameters.push(this.parseTypedIdentifier());
        while (this.eat("symbol", ",")) {
          if (this.is("symbol", "...")) {
            hasVararg = true;
            this.eat("symbol", "...");
            if (this.eat("symbol", ":")) {
              varargAnnotation = this.parseTypeExpression(true);
            }
            break;
          }
          parameters.push(this.parseTypedIdentifier());
        }
      }
    }
    return { parameters, hasVararg, varargAnnotation };
  }

  parseFunctionDeclaration(isLocal) {
    const start = this.current;
    this.expect("keyword", "function");
    const name = this.parseFunctionName(isLocal);
    const typeParameters = this.parseTypeParameterList(false);
    this.expect("symbol", "(");
    const { parameters, hasVararg, varargAnnotation } = this.parseFunctionParameters();
    this.expect("symbol", ")");
    let returnType = null;
    if (this.eat("symbol", ":")) {
      returnType = this.parseTypeExpression(true);
    }
    const body = this.parseBlock(["end"]);
    this.expect("keyword", "end");
    return this.finishNode({
      type: "FunctionDeclaration",
      name,
      parameters,
      hasVararg,
      varargAnnotation,
      returnType,
      typeParameters,
      isLocal,
      body,
    }, start);
  }

  parseFunctionExpression() {
    const start = this.current;
    this.expect("keyword", "function");
    const typeParameters = this.parseTypeParameterList(false);
    this.expect("symbol", "(");
    const { parameters, hasVararg, varargAnnotation } = this.parseFunctionParameters();
    this.expect("symbol", ")");
    let returnType = null;
    if (this.eat("symbol", ":")) {
      returnType = this.parseTypeExpression(true);
    }
    const body = this.parseBlock(["end"]);
    this.expect("keyword", "end");
    return this.finishNode({
      type: "FunctionExpression",
      parameters,
      hasVararg,
      varargAnnotation,
      returnType,
      typeParameters,
      body,
    }, start);
  }

  parseIfExpression() {
    const start = this.current;
    this.expect("keyword", "if");
    const clauses = [];
    const condition = this.parseExpression();
    this.expect("keyword", "then");
    clauses.push({ condition, value: this.parseExpression() });
    while (this.is("keyword", "elseif")) {
      this.eat("keyword", "elseif");
      const cond = this.parseExpression();
      this.expect("keyword", "then");
      clauses.push({ condition: cond, value: this.parseExpression() });
    }
    this.expect("keyword", "else");
    const elseValue = this.parseExpression();
    return this.finishNode({ type: "IfExpression", clauses, elseValue }, start);
  }

  parseIfStatement() {
    const start = this.current;
    this.expect("keyword", "if");
    const clauses = [];
    const condition = this.parseExpression();
    this.expect("keyword", "then");
    clauses.push({ condition, body: this.parseBlock(["elseif", "else", "end"]) });
    while (this.is("keyword", "elseif")) {
      this.eat("keyword", "elseif");
      const cond = this.parseExpression();
      this.expect("keyword", "then");
      clauses.push({ condition: cond, body: this.parseBlock(["elseif", "else", "end"]) });
    }
    let elseBody = null;
    if (this.is("keyword", "else")) {
      this.eat("keyword", "else");
      elseBody = this.parseBlock(["end"]);
    }
    this.expect("keyword", "end");
    return this.finishNode({ type: "IfStatement", clauses, elseBody }, start);
  }

  parseWhileStatement() {
    const start = this.current;
    this.expect("keyword", "while");
    const condition = this.parseExpression();
    this.expect("keyword", "do");
    const body = this.parseBlock(["end"]);
    this.expect("keyword", "end");
    return this.finishNode({ type: "WhileStatement", condition, body }, start);
  }

  parseRepeatStatement() {
    const start = this.current;
    this.expect("keyword", "repeat");
    const body = this.parseBlock(["until"]);
    this.expect("keyword", "until");
    const condition = this.parseExpression();
    return this.finishNode({ type: "RepeatStatement", condition, body }, start);
  }

  parseForStatement() {
    const start = this.current;
    this.expect("keyword", "for");
    const variables = [this.parseTypedIdentifier()];
    while (this.eat("symbol", ",")) {
      variables.push(this.parseTypedIdentifier());
    }
    if (this.eat("symbol", "=")) {
      if (variables.length !== 1) {
        this.raise("Numeric for only supports a single variable");
      }
      const startExpr = this.parseExpression();
      this.expect("symbol", ",");
      const end = this.parseExpression();
      let step = null;
      if (this.eat("symbol", ",")) {
        step = this.parseExpression();
      }
      this.expect("keyword", "do");
      const body = this.parseBlock(["end"]);
      this.expect("keyword", "end");
      return this.finishNode(
        { type: "ForNumericStatement", variable: variables[0], start: startExpr, end, step, body },
        start,
      );
    }

    this.expect("keyword", "in");
    const iterators = this.parseExpressionList();
    this.expect("keyword", "do");
    const body = this.parseBlock(["end"]);
    this.expect("keyword", "end");
    return this.finishNode({ type: "ForGenericStatement", variables, iterators, body }, start);
  }

  parseDoStatement() {
    const start = this.current;
    this.expect("keyword", "do");
    const body = this.parseBlock(["end"]);
    this.expect("keyword", "end");
    return this.finishNode({ type: "DoStatement", body }, start);
  }

  parseReturnStatement() {
    const start = this.current;
    this.expect("keyword", "return");
    if (
      this.is("symbol", ";") ||
      this.is("keyword", "end") ||
      this.is("keyword", "until") ||
      this.is("keyword", "else") ||
      this.is("keyword", "elseif") ||
      this.is("eof")
    ) {
      return this.finishNode({ type: "ReturnStatement", arguments: [] }, start);
    }
    return this.finishNode({ type: "ReturnStatement", arguments: this.parseExpressionList() }, start);
  }

  parseBlock(terminators) {
    const start = this.current;
    const body = [];
    while (!this.is("eof")) {
      if (this.is("keyword") && terminators.includes(this.current.value)) {
        break;
      }
      if (this.eat("symbol", ";")) {
        continue;
      }
      body.push(this.parseStatement());
      const last = body[body.length - 1];
      if (last && (last.type === "ReturnStatement" || last.type === "BreakStatement" || last.type === "ContinueStatement")) {
        while (this.eat("symbol", ";")) {
          // consume trailing semicolons after laststat
        }
        if (!this.is("eof") && !(this.is("keyword") && terminators.includes(this.current.value))) {
          const got = this.current.value ? `${this.current.type}(${this.current.value})` : this.current.type;
          this.raise(`Unexpected token ${got}`);
        }
        break;
      }
    }
    return this.finishNode({ type: "Block", body }, start, this.last || start);
  }

  parseExpressionList() {
    const expressions = [this.parseExpression()];
    while (this.eat("symbol", ",")) {
      expressions.push(this.parseExpression());
    }
    return expressions;
  }

  parseExpression(minPrec = 0) {
    let expr = this.parseUnary();
    while (this.current.type === "symbol" || this.current.type === "keyword") {
      const op = this.current.value;
      const prec = PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) {
        break;
      }
      const opToken = this.current;
      this.advance();
      const nextMin = RIGHT_ASSOC.has(op) ? prec : prec + 1;
      const right = this.parseExpression(nextMin);
      const start = this.nodeStart(expr) || opToken;
      expr = this.finishNode({ type: "BinaryExpression", operator: op, left: expr, right }, start);
    }
    return expr;
  }

  parseUnary() {
    if (
      this.is("symbol", "-") ||
      this.is("symbol", "~") ||
      this.is("keyword", "not") ||
      this.is("symbol", "#")
    ) {
      const start = this.current;
      const operator = this.current.value;
      this.advance();
      const argument = this.parseUnary();
      return this.finishNode({ type: "UnaryExpression", operator, argument }, start);
    }
    return this.parseSuffixExpression();
  }

  parsePrefixExpression() {
    return this.parseSuffixExpression();
  }

  parseSuffixExpression() {
    let expr = this.parsePrimary();
    while (true) {
      if (this.eat("symbol", ".")) {
        const id = this.parseIdentifier();
        const start = this.nodeStart(expr) || this.last;
        expr = this.finishNode({ type: "MemberExpression", base: expr, indexer: ".", identifier: id }, start);
        continue;
      }
      if (this.eat("symbol", "[")) {
        const index = this.parseExpression();
        this.expect("symbol", "]");
        const start = this.nodeStart(expr) || this.last;
        expr = this.finishNode({ type: "IndexExpression", base: expr, index }, start);
        continue;
      }
      if (this.is("symbol", ":")) {
        this.eat("symbol", ":");
        const id = this.parseIdentifier();
        const args = this.parseCallArguments();
        const start = this.nodeStart(expr) || this.last;
        expr = this.finishNode({ type: "MethodCallExpression", base: expr, method: id, arguments: args }, start);
        continue;
      }
      if (this.isCallStart()) {
        const args = this.parseCallArguments();
        const start = this.nodeStart(expr) || this.last;
        expr = this.finishNode({ type: "CallExpression", base: expr, arguments: args }, start);
        continue;
      }
      if (this.eat("symbol", "::")) {
        const annotation = this.parseTypeExpression();
        const start = this.nodeStart(expr) || this.last;
        expr = this.finishNode({ type: "TypeAssertion", expression: expr, annotation }, start);
        continue;
      }
      break;
    }
    return expr;
  }

  isCallStart() {
    return this.is("symbol", "(") || this.is("string") || this.is("symbol", "{") || this.is("interpString");
  }

  parseCallArguments() {
    if (this.eat("symbol", "(")) {
      const args = [];
      if (!this.is("symbol", ")")) {
        args.push(...this.parseExpressionList());
      }
      this.expect("symbol", ")");
      return args;
    }
    if (this.is("string")) {
      const str = this.parseStringLiteral();
      return [str];
    }
    if (this.is("interpString")) {
      this.raise("Interpolated string call arguments must use parentheses");
    }
    if (this.is("symbol", "{")) {
      return [this.parseTableConstructor()];
    }
    this.raise("Invalid call arguments");
  }

  parsePrimary() {
    if (this.is("symbol", "@")) {
      const start = this.current;
      const attributes = this.parseAttributes();
      if (!this.is("keyword", "function")) {
        this.raise("Attributes on expressions must precede a function");
      }
      const expr = this.parseFunctionExpression();
      expr.attributes = attributes;
      return this.finishNode(expr, start);
    }
    if (this.is("identifier")) {
      return this.parseIdentifier();
    }
    if (this.is("keyword", "type")) {
      const tok = this.advance();
      return this.finishNode({ type: "Identifier", name: tok.value }, tok, tok);
    }
    if (this.is("number")) {
      const tok = this.advance();
      return this.finishNode({ type: "NumericLiteral", value: parseNumericLiteral(tok.value), raw: tok.value }, tok, tok);
    }
    if (this.is("string")) {
      return this.parseStringLiteral();
    }
    if (this.is("interpString")) {
      return this.parseInterpolatedString();
    }
    if (this.is("keyword", "nil")) {
      const start = this.current;
      this.eat("keyword", "nil");
      return this.finishNode({ type: "NilLiteral" }, start);
    }
    if (this.is("keyword", "true") || this.is("keyword", "false")) {
      const value = this.current.value === "true";
      const start = this.current;
      this.advance();
      return this.finishNode({ type: "BooleanLiteral", value }, start);
    }
    if (this.is("symbol", "...")) {
      const start = this.current;
      this.eat("symbol", "...");
      return this.finishNode({ type: "VarargLiteral" }, start);
    }
    if (this.is("keyword", "function")) {
      return this.parseFunctionExpression();
    }
    if (this.is("keyword", "if")) {
      return this.parseIfExpression();
    }
    if (this.is("symbol", "{")) {
      return this.parseTableConstructor();
    }
    if (this.eat("symbol", "(")) {
      const start = this.last;
      const expr = this.parseExpression();
      this.expect("symbol", ")");
      return this.finishNode({ type: "GroupExpression", expression: expr }, start);
    }
    this.raise(`Unexpected token ${this.current.type}(${this.current.value})`);
  }

  parseTableConstructor() {
    const start = this.current;
    this.expect("symbol", "{");
    const fields = [];
    while (!this.is("symbol", "}")) {
      if (this.eat("symbol", "[")) {
        const fieldStart = this.last;
        const key = this.parseExpression();
        this.expect("symbol", "]");
        this.expect("symbol", "=");
        const value = this.parseExpression();
        fields.push(this.finishNode({ type: "TableField", kind: "index", key, value }, fieldStart));
      } else if (this.is("identifier") && this.peek().type === "symbol" && this.peek().value === "=") {
        const fieldStart = this.current;
        const name = this.parseIdentifier();
        this.expect("symbol", "=");
        const value = this.parseExpression();
        fields.push(this.finishNode({ type: "TableField", kind: "name", name, value }, fieldStart));
      } else {
        const fieldStart = this.current;
        const value = this.parseExpression();
        fields.push(this.finishNode({ type: "TableField", kind: "list", value }, fieldStart));
      }
      if (!this.eat("symbol", ",")) {
        this.eat("symbol", ";");
      }
    }
    this.expect("symbol", "}");
    return this.finishNode({ type: "TableConstructorExpression", fields }, start);
  }

  parseTypedIdentifier() {
    const id = this.parseIdentifier();
    if (this.eat("symbol", ":")) {
      id.annotation = this.parseTypeExpression();
    }
    return id;
  }

  parseTypeParameterList(allowDefault = true) {
    if (!this.is("symbol", "<")) {
      return [];
    }
    this.expect("symbol", "<");
    const params = [];
    let seenPack = false;
    let seenDefault = false;
    do {
      let isPack = false;
      let packStyle = null;
      if (this.eat("symbol", "...")) {
        isPack = true;
        packStyle = "prefix";
      }
      const param = this.parseIdentifier();
      if (this.eat("symbol", "...")) {
        if (isPack) {
          this.raise("Type pack parameter cannot use both prefix and postfix ellipsis");
        }
        isPack = true;
        packStyle = "postfix";
      }
      if (!isPack && seenPack) {
        this.raise("Generic types come before generic type packs", param);
      }
      if (isPack) {
        seenPack = true;
        param.isPack = true;
        param.packStyle = packStyle;
      }
      if (this.eat("symbol", "=")) {
        if (!allowDefault) {
          this.raise("Generic function type parameters cannot have defaults");
        }
        seenDefault = true;
        param.default = this.parseTypeExpression(isPack);
        if (isPack && !isTypePackDefault(param.default)) {
          this.raise("Expected type pack after '=', got type", param.default);
        }
      } else if (seenDefault) {
        this.raise(isPack ? "Expected default type pack after type pack name" : "Expected default type after type name", param);
      }
      params.push(param);
    } while (this.eat("symbol", ","));
    this.expect("symbol", ">" );
    return params;
  }

  parseTypeExpression(allowTypePack = false) {
    return this.parseTypeUnion(allowTypePack);
  }

  parseTypeExpressionList(allowTypePack = false) {
    const types = [this.parseTypeExpression(allowTypePack)];
    while (this.eat("symbol", ",")) {
      types.push(this.parseTypeExpression(allowTypePack));
    }
    return types;
  }

  parseTypeUnion(allowTypePack = false) {
    let type = this.parseTypeIntersection(allowTypePack);
    const types = [type];
    while (this.eat("symbol", "|")) {
      types.push(this.parseTypeIntersection(allowTypePack));
    }
    if (types.length > 1) {
      const start = this.nodeStart(types[0]) || this.current;
      return this.finishNode({ type: "UnionType", types }, start);
    }
    return type;
  }

  parseTypeIntersection(allowTypePack = false) {
    let type = this.parseTypePostfix(allowTypePack);
    const types = [type];
    while (this.eat("symbol", "&")) {
      types.push(this.parseTypePostfix(allowTypePack));
    }
    if (types.length > 1) {
      const start = this.nodeStart(types[0]) || this.current;
      return this.finishNode({ type: "IntersectionType", types }, start);
    }
    return type;
  }

  parseTypePostfix(allowTypePack = false) {
    let type = this.parseTypePrimary(allowTypePack);
    while (true) {
      if (this.is("symbol", "<") && type.type === "TypeReference") {
        const argsInfo = this.parseTypeArgumentList();
        type.typeArguments = argsInfo.args;
        type.typeArgumentsExplicit = argsInfo.explicit;
        const start = this.nodeStart(type) || this.current;
        type = this.finishNode(type, start);
        continue;
      }
      if (this.eat("symbol", "?")) {
        const start = this.nodeStart(type) || this.last;
        type = this.finishNode({ type: "OptionalType", base: type }, start);
        continue;
      }
      if (this.eat("symbol", "...")) {
        if (!allowTypePack) {
          this.raise("Unexpected '...' after type name; type pack is not allowed in this context", this.last);
        }
        const start = this.nodeStart(type) || this.last;
        type = this.finishNode({ type: "TypePack", value: type, postfix: true }, start);
        continue;
      }
      break;
    }
    return type;
  }

  parseTypeArgumentList() {
    this.expect("symbol", "<");
    if (this.eat("symbol", ">")) {
      return { args: [], explicit: true };
    }
    const args = [this.parseTypeExpression(true)];
    while (this.eat("symbol", ",")) {
      args.push(this.parseTypeExpression(true));
    }
    this.expect("symbol", ">" );
    return { args, explicit: true };
  }

  parseTypePrimary(allowTypePack = false) {
    if (this.is("symbol", "...")) {
      if (!allowTypePack) {
        this.raise("Unexpected '...' in type annotation", this.current);
      }
      const start = this.current;
      this.eat("symbol", "...");
      const type = this.parseTypePrimary(false);
      return this.finishNode({ type: "VariadicType", value: type }, start);
    }
    if (this.is("symbol", "<")) {
      const typeParameters = this.parseTypeParameterList(false);
      if (!this.is("symbol", "(")) {
        this.raise("Generic function types must be followed by parameter list");
      }
      return this.parseFunctionOrTupleType(typeParameters, true);
    }
    if (this.is("symbol", "{")) {
      return this.parseTableType();
    }
    if (this.is("symbol", "(")) {
      return this.parseFunctionOrTupleType(null, allowTypePack);
    }
    if (this.is("keyword", "typeof")) {
      const start = this.current;
      this.eat("keyword", "typeof");
      const expression = this.parseExpression();
      return this.finishNode({ type: "TypeofType", expression }, start);
    }
    if (this.is("string")) {
      const tok = this.expect("string");
      return this.finishNode({ type: "TypeLiteral", raw: tok.value }, tok, tok);
    }
    if (this.is("number")) {
      const tok = this.expect("number");
      return this.finishNode({ type: "TypeLiteral", raw: tok.value }, tok, tok);
    }
    if (this.is("keyword", "true") || this.is("keyword", "false") || this.is("keyword", "nil")) {
      const tok = this.advance();
      return this.finishNode({ type: "TypeLiteral", raw: tok.value }, tok, tok);
    }
    const start = this.current;
    const name = this.parseTypeName();
    return this.finishNode({ type: "TypeReference", name, typeArguments: [] }, start);
  }

  parseTypeName() {
    const parts = [this.parseIdentifier()];
    while (this.eat("symbol", ".")) {
      parts.push(this.parseIdentifier());
    }
    return parts;
  }

  parseTableType() {
    const start = this.current;
    this.expect("symbol", "{");
    const fields = [];
    while (!this.is("symbol", "}")) {
      if (this.is("identifier", "read") || this.is("identifier", "write")) {
        const next = this.peek();
        if (next && next.type === "symbol" && next.value === "[") {
          this.raise("Table access modifier must appear inside indexer brackets");
        }
      }
      const access = this.parseTableAccess();
      if (this.eat("symbol", "[")) {
        const fieldStart = this.last;
        let indexAccess = access;
        if (indexAccess && (this.is("identifier", "read") || this.is("identifier", "write"))) {
          this.raise("Duplicate table access modifier");
        }
        if (!indexAccess && (this.is("identifier", "read") || this.is("identifier", "write"))) {
          indexAccess = this.current.value;
          this.advance();
        }
        const key = this.parseTypeExpression();
        this.expect("symbol", "]");
        this.expect("symbol", ":");
        const value = this.parseTypeExpression();
        fields.push(this.finishNode({ type: "TableTypeField", kind: "index", key, value, access: indexAccess }, fieldStart));
      } else if (this.is("identifier") && this.peek().type === "symbol" && this.peek().value === ":") {
        const fieldStart = this.current;
        const name = this.parseIdentifier();
        this.expect("symbol", ":");
        const value = this.parseTypeExpression();
        fields.push(this.finishNode({ type: "TableTypeField", kind: "name", name, value, access }, fieldStart));
      } else {
        if (access) {
          this.raise("Table field access modifier must precede a named or indexer field");
        }
        const fieldStart = this.current;
        const value = this.parseTypeExpression();
        fields.push(this.finishNode({ type: "TableTypeField", kind: "list", value }, fieldStart));
      }
      if (!this.eat("symbol", ",")) {
        this.eat("symbol", ";");
      }
    }
    this.expect("symbol", "}");
    return this.finishNode({ type: "TableType", fields }, start);
  }

  parseTableAccess() {
    if (this.is("identifier", "read") || this.is("identifier", "write")) {
      const next = this.peek();
      if (next && next.type === "identifier") {
        const access = this.current.value;
        this.advance();
        return access;
      }
    }
    return null;
  }

  parseFunctionOrTupleType(typeParameters, allowTuplePack = false) {
    const start = this.current;
    this.expect("symbol", "(");
    const params = [];
    if (!this.is("symbol", ")")) {
      if (this.is("symbol", "...")) {
        const packStart = this.current;
        this.eat("symbol", "...");
        const value = this.parseTypeExpression();
        params.push(this.finishNode({ type: "TypePack", value }, packStart));
      } else {
        params.push(this.parseTypeParameter(true));
        while (this.eat("symbol", ",")) {
          if (isTypePackNode(params[params.length - 1])) {
            this.raise("Variadic type pack must be last in a type list", this.last);
          }
          if (this.is("symbol", "...")) {
            const packStart = this.current;
            this.eat("symbol", "...");
            const value = this.parseTypeExpression();
            params.push(this.finishNode({ type: "TypePack", value }, packStart));
            break;
          }
          params.push(this.parseTypeParameter(true));
        }
      }
    }
    this.expect("symbol", ")");
    if (this.eat("symbol", "->")) {
      const returnTypes = this.parseTypeExpressionList(true);
      return this.finishNode({ type: "FunctionType", parameters: params, returnTypes, typeParameters }, start);
    }
    if (typeParameters !== null && typeParameters !== undefined) {
      this.raise("Generic function types must specify return types");
    }
    if (!allowTuplePack && params.some(isTypePackNode)) {
      this.raise("Unexpected '...' after type annotation", start);
    }
    if (params.length === 1 && params[0].type === "TypeParameter") {
      return this.finishNode({ type: "ParenthesizedType", value: params[0].value }, start);
    }
    const items = params.map((param) => (param.type === "TypeParameter" ? param.value : param));
    return this.finishNode({ type: "TupleType", items }, start);
  }

  parseTypeParameter(allowTypePack = false) {
    if (this.is("identifier") && this.peek().type === "symbol" && this.peek().value === ":") {
      const start = this.current;
      const name = this.parseIdentifier();
      this.expect("symbol", ":");
      const value = this.parseTypeExpression(allowTypePack);
      return this.finishNode({ type: "TypeParameter", name, value }, start);
    }
    const start = this.current;
    return this.finishNode({ type: "TypeParameter", name: null, value: this.parseTypeExpression(allowTypePack) }, start);
  }

  parseIdentifier() {
    if (this.is("identifier")) {
      const tok = this.advance();
      return this.finishNode({ type: "Identifier", name: tok.value }, tok, tok);
    }
    if (this.is("keyword", "type")) {
      const tok = this.advance();
      return this.finishNode({ type: "Identifier", name: tok.value }, tok, tok);
    }
    const tok = this.expect("identifier");
    return this.finishNode({ type: "Identifier", name: tok.value }, tok, tok);
  }

  parseStringLiteral() {
    const tok = this.expect("string");
    return this.finishNode({ type: "StringLiteral", raw: tok.value }, tok, tok);
  }

  parseInterpolatedString() {
    const tok = this.expect("interpString");
    const raw = tok.value;
    if (!raw || raw.length < 2 || raw[0] !== "`" || raw[raw.length - 1] !== "`") {
      this.raise("Incomplete interpolated string", tok);
    }
    const content = raw.slice(1, -1);
    const parts = [];
    let cursor = 0;
    while (cursor < content.length) {
      const startInfo = findInterpolationStart(content, cursor);
      if (startInfo === -1) {
        break;
      }
      if (typeof startInfo === "object" && startInfo.error === "double-open") {
        const offset = 1 + startInfo.index;
        const errorToken = makeOffsetToken(tok, offset, 2);
        throw makeDiagnosticError("Interpolated string cannot contain '{{'", errorToken);
      }
      const next = startInfo;
      const text = content.slice(cursor, next);
      if (text) {
        parts.push({ type: "InterpolatedStringText", raw: text });
      }
      const end = findInterpolationEnd(content, next + 1);
      if (end === -1) {
        const errorToken = makeOffsetToken(tok, next, 1);
        throw makeDiagnosticError("Unterminated interpolation expression", errorToken);
      }
      const exprSource = content.slice(next + 1, end);
      const expr = parseInterpolationExpression(exprSource);
      if (!expr) {
        const errorToken = makeOffsetToken(tok, next + 1, Math.max(1, exprSource.length));
        throw makeDiagnosticError("Expected expression in interpolated string", errorToken);
      }
      parts.push(expr);
      cursor = end + 1;
    }
    const tail = content.slice(cursor);
    if (tail) {
      parts.push({ type: "InterpolatedStringText", raw: tail });
    }
    return this.finishNode({ type: "InterpolatedString", parts }, tok, tok);
  }
}

function parse(source) {
  const parser = new Parser(source);
  return parser.parse();
}

function offsetLocFromRaw(raw, baseLoc, offset) {
  let line = baseLoc.line;
  let column = baseLoc.column;
  let i = 0;
  while (i < offset && i < raw.length) {
    const ch = raw[i];
    if (ch === "\r") {
      if (raw[i + 1] === "\n") {
        i += 1;
      }
      line += 1;
      column = 1;
      i += 1;
      continue;
    }
    if (ch === "\n") {
      line += 1;
      column = 1;
      i += 1;
      continue;
    }
    column += 1;
    i += 1;
  }
  return { line, column };
}

function makeOffsetToken(token, offset, length = 1) {
  if (!token || !token.loc || !token.range) {
    return token;
  }
  const raw = token.value || "";
  const start = offsetLocFromRaw(raw, token.loc.start, offset);
  const end = offsetLocFromRaw(raw, token.loc.start, offset + length);
  const startRange = token.range[0] + offset;
  return {
    type: token.type,
    value: token.value,
    loc: { start, end },
    range: [startRange, startRange + length],
  };
}

function isAttributeLiteral(node) {
  if (!node || typeof node !== "object") {
    return false;
  }
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
      return true;
    case "TableConstructorExpression":
      return node.fields.every((field) => {
        if (field.kind === "name") {
          return isAttributeLiteral(field.value);
        }
        if (field.kind === "index") {
          return isAttributeLiteral(field.key) && isAttributeLiteral(field.value);
        }
        return isAttributeLiteral(field.value);
      });
    default:
      return false;
  }
}

function isTypePackNode(node) {
  if (!node) {
    return false;
  }
  if (node.type === "TypePack" || node.type === "VariadicType") {
    return true;
  }
  return node.type === "TypeParameter" && isTypePackNode(node.value);
}

function isTypePackDefault(node) {
  if (!node) {
    return false;
  }
  return (
    node.type === "TypePack" ||
    node.type === "VariadicType" ||
    node.type === "TupleType" ||
    node.type === "ParenthesizedType"
  );
}

function parseInterpolationExpression(source) {
  if (!source || !source.trim()) {
    return null;
  }
  const parser = new Parser(source);
  const expr = parser.parseExpression();
  if (parser.current && parser.current.type !== "eof") {
    return null;
  }
  return expr;
}

function parseNumericLiteral(raw) {
  if (typeof raw !== "string") {
    return Number(raw);
  }
  const sanitized = raw.replace(/_/g, "");
  if (/^0[bB][01]/.test(sanitized)) {
    return parseInt(sanitized.slice(2), 2);
  }
  if (/^0[xX]/.test(sanitized)) {
    if (/[pP]/.test(sanitized) || sanitized.includes(".")) {
      return parseHexFloat(sanitized);
    }
    return parseInt(sanitized.slice(2), 16);
  }
  return Number(sanitized);
}

function parseHexFloat(raw) {
  const match = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/.exec(raw);
  if (!match) {
    return Number(raw);
  }
  const intPart = match[1] || "";
  const fracPart = match[2] || "";
  const exponent = match[3] ? parseInt(match[3], 10) : 0;
  const intValue = intPart ? parseInt(intPart, 16) : 0;
  let fracValue = 0;
  for (let i = 0; i < fracPart.length; i += 1) {
    const digit = parseInt(fracPart[i], 16);
    if (Number.isNaN(digit)) {
      break;
    }
    fracValue += digit / Math.pow(16, i + 1);
  }
  return (intValue + fracValue) * Math.pow(2, exponent);
}

function findInterpolationStart(source, start) {
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === "z") {
        i += 2;
        while (i < source.length) {
          const ws = source[i];
          if (ws === " " || ws === "\t" || ws === "\v" || ws === "\f" || ws === "\r" || ws === "\n") {
            i += 1;
            continue;
          }
          break;
        }
        continue;
      }
      if (next === "\r") {
        i += source[i + 2] === "\n" ? 3 : 2;
        continue;
      }
      if (next === "\n") {
        i += 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === "{") {
      if (source[i + 1] === "{") {
        return { error: "double-open", index: i };
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

function readLongBracket(source, index) {
  if (source[index] !== "[") {
    return null;
  }
  let i = index + 1;
  let eqCount = 0;
  while (source[i] === "=") {
    eqCount += 1;
    i += 1;
  }
  if (source[i] !== "[") {
    return null;
  }
  return {
    openLength: i - index + 1,
    close: `]${"=".repeat(eqCount)}]`,
  };
}

function skipString(source, index, quote) {
  let i = index + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === "z") {
        i += 2;
        while (i < source.length) {
          const ws = source[i];
          if (ws === " " || ws === "\t" || ws === "\v" || ws === "\f" || ws === "\r" || ws === "\n") {
            i += 1;
            continue;
          }
          break;
        }
        continue;
      }
      if (next === "\r") {
        i += source[i + 2] === "\n" ? 3 : 2;
        continue;
      }
      if (next === "\n") {
        i += 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i += 1;
  }
  return source.length;
}

function findInterpolationEnd(source, start) {
  let depth = 1;
  let i = start;
  let long = null;
  while (i < source.length) {
    if (long) {
      if (source.startsWith(long.close, i)) {
        i += long.close.length;
        long = null;
        continue;
      }
      i += 1;
      continue;
    }

    const ch = source[i];
    if (ch === "'" || ch === "\"" || ch === "`") {
      i = skipString(source, i, ch);
      continue;
    }
    if (ch === "-" && source[i + 1] === "-") {
      const longComment = readLongBracket(source, i + 2);
      if (longComment) {
        long = longComment;
        i += 2 + longComment.openLength;
        continue;
      }
      i += 2;
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") {
        i += 1;
      }
      continue;
    }
    if (ch === "[") {
      const longString = readLongBracket(source, i);
      if (longString) {
        long = longString;
        i += longString.openLength;
        continue;
      }
    }

    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

const ParserExport: ParserConstructor = Parser;
const parseExport: (source: string) => Chunk = parse;

module.exports = {
  parse,
  Parser,
};

export { ParserExport as Parser, parseExport as parse };
