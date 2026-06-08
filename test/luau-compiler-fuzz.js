const assert = require("assert");
const custom = require("../src/luau/custom");
const { Tokenizer } = require("../src/luau/custom/tokenizer");
const { parse } = require("../src/luau/custom/parser");
const { printChunk } = require("../src/luau/custom/printer");

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(rng, values) {
  return values[Math.floor(rng() * values.length)];
}

function tokenizeAll(source) {
  const tokenizer = new Tokenizer(source);
  const tokens = [];
  for (let i = 0; i < 10000; i += 1) {
    const token = tokenizer.next();
    tokens.push(token);
    if (token.type === "eof") {
      return tokens;
    }
  }
  throw new Error("tokenizer did not terminate");
}

function genLeaf(rng) {
  return pick(rng, [
    "0",
    "1",
    "2",
    "true",
    "false",
    "nil",
    "x",
    "y",
    "z",
    "'s'",
  ]);
}

function genExpr(rng, depth = 0, options = {}) {
  if (depth > 3) {
    return genLeaf(rng);
  }
  const choices = options.noTable
    ? ["leaf", "group", "if", "binary", "unary", "index", "interp"]
    : ["leaf", "group", "if", "binary", "unary", "table", "index", "interp"];
  const kind = pick(rng, choices);
  if (kind === "leaf") {
    return genLeaf(rng);
  }
  if (kind === "group") {
    return `(${genExpr(rng, depth + 1, options)})`;
  }
  if (kind === "if") {
    return `if ${genExpr(rng, depth + 1, { noTable: true })} then ${genExpr(rng, depth + 1, options)} else ${genExpr(rng, depth + 1, options)}`;
  }
  if (kind === "binary") {
    return `${genExpr(rng, depth + 1, options)} ${pick(rng, ["+", "-", "*", "/", "//", "%", "^", "..", "==", "~=", "<", "<=", ">", ">=", "and", "or"])} ${genExpr(rng, depth + 1, options)}`;
  }
  if (kind === "unary") {
    const op = pick(rng, ["not ", "-", "#"]);
    const arg = genExpr(rng, depth + 1, { noTable: true });
    return op === "-" ? `-(${arg})` : `${op}${arg}`;
  }
  if (kind === "table") {
    return `{${genExpr(rng, depth + 1)}, a = ${genExpr(rng, depth + 1)}}`;
  }
  if (kind === "index") {
    return `t[${genExpr(rng, depth + 1, { noTable: true })}]`;
  }
  const inner = genExpr(rng, depth + 1, { noTable: true });
  return rng() < 0.15 ? "`outer {`inner {x}`}`" : `\`v={${inner}}\``;
}

function genStatement(rng, allowReturn) {
  const kind = pick(rng, ["local", "const", "assign", "if", "while", "repeat", "forn", "forg", "do", "call"]);
  if (allowReturn && rng() < 0.12) {
    return `return ${genExpr(rng)}`;
  }
  if (kind === "local") {
    return `local x = ${genExpr(rng)}`;
  }
  if (kind === "const") {
    return `const y = ${genExpr(rng)}`;
  }
  if (kind === "assign") {
    return `x ${pick(rng, ["=", "+=", "-=", "*=", "//=", "%=", "^=", "..="])} ${genExpr(rng)}`;
  }
  if (kind === "if") {
    return `if ${genExpr(rng, 0, { noTable: true })} then local z = ${genExpr(rng)} else local z = ${genExpr(rng)} end`;
  }
  if (kind === "while") {
    return `while ${genExpr(rng, 0, { noTable: true })} do break end`;
  }
  if (kind === "repeat") {
    return `repeat local z = ${genExpr(rng)} until ${genExpr(rng, 0, { noTable: true })}`;
  }
  if (kind === "forn") {
    return "for i = 1, 3 do local z = i end";
  }
  if (kind === "forg") {
    return "for _, v in {1, 2, 3} do local z = v end";
  }
  if (kind === "do") {
    return `do local z = ${genExpr(rng)} end`;
  }
  return "print(x)";
}

function genProgram(seed) {
  const rng = makeRng(seed);
  const statements = [
    "local t = {1, 2, 3}",
    "local x = 1",
    "local y = 2",
    "local z = 3",
  ];
  const count = 1 + Math.floor(rng() * 7);
  for (let i = 0; i < count; i += 1) {
    const statement = genStatement(rng, i === count - 1);
    statements.push(statement);
    if (statement.startsWith("return ")) {
      break;
    }
  }
  return statements.join("\n");
}

function validatePipeline(name, source) {
  try {
    tokenizeAll(source);
    const ast = parse(source);
    const validation = custom.validate(ast);
    assert.deepStrictEqual(validation, [], `${name}: AST validation failed`);
    const cfg = custom.buildCFG(ast);
    assert.ok(cfg.functions.length >= 1, `${name}: CFG should contain at least one function`);
    const ssa = custom.buildSSA(cfg);
    assert.ok(ssa.functions[0].ssa, `${name}: SSA should be attached to CFG`);
    const printed = printChunk(ast);
    parse(printed);
    const compact = printChunk(ast, { compact: true });
    parse(compact);
  } catch (err) {
    err.message = `${name}: ${err.message}\n${source}`;
    throw err;
  }
}

const fixtures = [
  "const answer = 42\nreturn answer",
  "local const = 1\nreturn const",
  "local s = `outer {`inner {name}`}`",
  "type Signal<T, U...> = { data: T, f: (T, U...) -> () }",
  "while true do continue end",
  "repeat continue until true",
];

fixtures.forEach((source, index) => validatePipeline(`fixture-${index}`, source));

for (let seed = 1; seed <= 3000; seed += 1) {
  validatePipeline(`fuzz-${seed}`, genProgram(seed));
}

const malformed = [
  "local =",
  "function f(",
  "local s = `bad {{`",
  "while true do return 1; local x = 2 end",
  "type T = { read [number]: string }",
];

malformed.forEach((source) => {
  assert.throws(() => parse(source), Error, `malformed source should fail cleanly: ${source}`);
});

console.log("luau-compiler-fuzz: ok");
