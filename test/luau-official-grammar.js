const assert = require("assert");
const cp = require("child_process");
const custom = require("../src/luau/custom");
const { Tokenizer } = require("../src/luau/custom/tokenizer");

function tokenValues(source) {
  const tokenizer = new Tokenizer(source);
  const values = [];
  for (;;) {
    const token = tokenizer.next();
    if (token.type === "eof") {
      return values;
    }
    values.push([token.type, token.value]);
  }
}

assert.deepStrictEqual(
  tokenValues("type Pack = (...number) -> number"),
  [
    ["keyword", "type"],
    ["identifier", "Pack"],
    ["symbol", "="],
    ["symbol", "("],
    ["symbol", "..."],
    ["identifier", "number"],
    ["symbol", ")"],
    ["symbol", "->"],
    ["identifier", "number"],
  ],
);

assert.deepStrictEqual(
  tokenValues("local x = if ok then 1 else 2"),
  [
    ["keyword", "local"],
    ["identifier", "x"],
    ["symbol", "="],
    ["keyword", "if"],
    ["identifier", "ok"],
    ["keyword", "then"],
    ["number", "1"],
    ["keyword", "else"],
    ["number", "2"],
  ],
);

const sourceLoad = cp.spawnSync(
  process.execPath,
  ["--no-experimental-strip-types", "-e", "require('./src/luau/custom/tokenizer.js')"],
  {
    cwd: require("path").join(__dirname, ".."),
    encoding: "utf8",
  },
);

assert.strictEqual(
  sourceLoad.status,
  0,
  `tokenizer.js should load without Node strip-types support: ${sourceLoad.stderr || sourceLoad.stdout}`,
);

const accepted = [
  "type Result<T, E> = T | E",
  "declare function id<T>(x: T): T",
  "declare function pack<T...>(...: T...): T...",
  "declare class Foo\n  prop: number\n  function method(self, foo: number): string\n  [string]: number\nend",
  "declare extern type Bar extends Foo with\n  prop2: string\nend",
  "declare extern type Empty",
  "const answer = 42",
  "const a, b, c = 42, f()",
  "const a, b, c = 42, ...",
  "const function getAnswer() return 42 end",
  "local x = if ok then 1 else 2",
  "continue",
  "x += 1",
  "@native function f() end",
  "local s = `hello {name}`",
  "local s = `outer {`inner {name}`}`",
];

for (const source of accepted) {
  assert.doesNotThrow(() => custom.parseLuau(source), source);
}

{
  const ast = custom.parseLuau("local x = if ok then 1 else 2");
  assert.strictEqual(ast.body[0].init[0].type, "ExprIfElse");
  assert.strictEqual(ast.body[0].init[0].condition.name, "ok");
}

{
  const ast = custom.parseLuau("const answer = 42");
  assert.strictEqual(ast.body[0].type, "LocalStatement");
  assert.strictEqual(ast.body[0].isConst, true);
  assert.strictEqual(ast.body[0].variables[0].name, "answer");
}

{
  const ast = custom.parseLuau("const function getAnswer() return 42 end");
  assert.strictEqual(ast.body[0].type, "StatLocalFunction");
  assert.strictEqual(ast.body[0].isConst, true);
  assert.strictEqual(ast.body[0].name.base.name, "getAnswer");
}

{
  const ast = custom.parseLuau("declare class Foo\n  prop: number\n  function method(self, foo: number): string\nend");
  assert.strictEqual(ast.body[0].type, "StatDeclareExternType");
  assert.strictEqual(ast.body[0].declarationKind, "class");
  assert.strictEqual(ast.body[0].props.length, 2);
}

{
  const ast = custom.parseLuau("x += 1");
  assert.strictEqual(ast.body[0].type, "CompoundAssignmentStatement");
  assert.strictEqual(ast.body[0].operator, "+=");
}

{
  const ast = custom.parseLuau("local s = `hello {name}`");
  assert.strictEqual(ast.body[0].init[0].type, "ExprInterpString");
  assert.strictEqual(ast.body[0].init[0].parts[0].raw, "hello ");
}

{
  const ast = custom.parseLuau("local s = `outer {`inner {name}`}`");
  assert.strictEqual(ast.body[0].init[0].type, "ExprInterpString");
  assert.strictEqual(ast.body[0].init[0].parts[1].type, "ExprInterpString");
}
