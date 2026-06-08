const assert = require("assert");
const custom = require("../src/luau/custom");
const { parse } = require("../src/luau/custom/parser");
const { printChunk } = require("../src/luau/custom/printer");

function roundTrip(name, source) {
  const ast = parse(source);
  const printed = printChunk(ast);
  const ast2 = parse(printed);
  assert.ok(ast2 && ast2.body, `${name}: round-trip failed`);
  return { ast, printed, ast2 };
}

function shouldThrow(name, fn) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
  }
  assert.ok(threw, `${name}: expected error`);
}

{
  const source = "local x = 1\nreturn x";
  const ast = custom.parseLuau(source);
  const printed = custom.generateLuau(ast);

  assert.ok(typeof printed === "string", "public printer API should return a string by default");
  assert.ok(printed.includes("local x = 1"), "public printer API should round-trip local statements");
  assert.ok(printed.includes("return x"), "public printer API should round-trip return statements");
}

{
  const source = "const answer = 42\nreturn answer";
  const ast = custom.parseLuau(source);
  const printed = custom.generateLuau(ast);

  assert.ok(printed.includes("const answer = 42"), "public printer API should preserve const declarations");
  assert.ok(printed.includes("return answer"), "public printer API should round-trip const reads");
}

{
  const source = "local x = if ok then 1 else 2";
  const ast = custom.parseLuau(source);
  const printed = custom.generateLuau(ast);

  assert.ok(printed.includes("if ok then 1 else 2"), "public printer API should print canonical if-expressions");
}

{
  const source = "local function f() return 1 end";
  const ast = custom.parseLuau(source);
  const printed = custom.generateLuau(ast);

  assert.ok(printed.includes("local function f"), "public printer API should print canonical local functions");
}

roundTrip(
  "const-declaration",
  [
    "const answer: number = 42",
    "const a, b, c = 42, f()",
    "const function getAnswer() return answer end",
    "local const = 1",
    "return answer + const",
  ].join("\n"),
);

roundTrip(
  "numeric-literals",
  [
    "local a = 0xff",
    "local b = 0x1.8p1",
    "local c = 0b1010_0011",
    "local d = 1_000_000",
    "local e = 1.2_3e+4",
  ].join("\n"),
);

roundTrip(
  "compound-continue",
  [
    "local continue = 1",
    "local x = 10",
    "x //= 3",
    "x ..= \"a\"",
    "continue",
  ].join("\n"),
);

roundTrip(
  "types-and-attrs",
  [
    "type Pair<T = number, U = string> = { read a: T, write b: U, [read number]: string }",
    "local f: <T>(T) -> T = nil",
    "local g: (...number) -> number = nil",
    "type function Foo<T>(self: T, x: number): number",
    "  return x",
    "end",
    "@[native, deprecated(\"x\"), info({ foo = \"bar\" })] function f2() end",
    "local f3 = @native function() return 1 end",
    "@native \"str\" function f4() end",
    "@native { foo = \"bar\" } function f5() end",
    "type Signal<T, U...> = { data: T, f: (T, U...) -> () }",
    "type EmptyArgs = Returns<>",
  ].join("\n"),
);

roundTrip(
  "interpolated-string",
  "local s = `hello {name}`",
);

roundTrip(
  "nested-interpolated-string",
  "local s = `outer {`inner {name}`}`",
);

roundTrip(
  "interpolated-escapes",
  [
    "local s = `hello \\{name\\}`",
    "local t = `a\\z",
    "  b`",
  ].join("\n"),
);

roundTrip(
  "semicolons",
  "local a = 1; local b = 2; return a + b;",
);

roundTrip(
  "string-escape-z",
  "local s = \"a\\\\z\\n  b\"",
);

roundTrip(
  "declare-statements",
  [
    "declare foo: number",
    "declare function bar(x: number, y: number): number",
    "declare function baz<T>(x: T): T",
    "declare function pack<T...>(...: T...): T...",
    "declare class Foo",
    "  prop: number",
    "  function method(self, foo: number): string",
    "  [string]: number",
    "end",
    "declare extern type Bar extends Foo with",
    "  prop2: string",
    "end",
    "declare extern type Empty",
  ].join("\n"),
);

shouldThrow("interp-double-open", () => parse("local s = `bad {{`"));
shouldThrow("interp-call-sugar", () => parse("f `hi`"));
shouldThrow("attr-nonliteral-arg", () => parse("@native(1 + 2) function f() end"));
shouldThrow("table-access-before-indexer", () => parse("type T = { read [number]: string }"));
shouldThrow("return-not-laststat", () => parse("do return 1; local x = 2 end"));
shouldThrow("break-not-laststat", () => parse("while true do break; local x = 1 end"));
shouldThrow("continue-not-laststat", () => parse("while true do continue; local x = 1 end"));
shouldThrow("function-default-type-params", () => parse("function id<T = number>(x: T): T return x end"));
shouldThrow("type-function-default-type-params", () => parse("type function Foo<T = number>() end"));
shouldThrow("const-missing-init", () => parse("const c"));
shouldThrow("const-missing-multi-init", () => parse("const a, b = nil"));
shouldThrow("const-missing-after-call", () => parse("const a, b, c = f(), 42"));
shouldThrow("generic-type-after-pack", () => parse("type Y<T..., U> = {}"));
shouldThrow("generic-default-missing", () => parse("type Y<T = number, U> = {}"));
shouldThrow("generic-pack-default-missing", () => parse("type Y<T... = ...number, U...> = {}"));
shouldThrow("generic-pack-default-not-pack", () => parse("type Y<T... = (string) -> number> = {}"));
shouldThrow("type-pack-in-table-field", () => parse("type Y<T...> = { a: T... }"));
shouldThrow("interp-missing-expression", () => parse("local s = `bad {}`"));
shouldThrow("interp-missing-close", () => parse("local s = `bad {name`"));
shouldThrow("attr-on-if", () => parse("@checked if true then end"));
shouldThrow("declare-param-missing-type", () => parse("declare function foo(x)"));
shouldThrow("declare-method-missing-self", () => parse("declare class Foo\n  function method(foo: number)\nend"));
shouldThrow("declare-method-missing-type", () => parse("declare class Foo\n  function method(self, foo)\nend"));

{
  assert.deepStrictEqual(
    custom.validate(custom.parseLuau("const x = 1\nlocal x = 2\nx = 3")),
    [],
    "local shadow should allow assignment to the shadowed binding",
  );
  assert.ok(
    custom.validate(custom.parseLuau("const x = 1\nx = 2")).some((msg) => msg.includes("cannot assign to const 'x'")),
    "assignment to const should be rejected by semantic validation",
  );
  assert.ok(
    custom.validate(custom.parseLuau("const x = 1\nx += 2")).some((msg) => msg.includes("cannot assign to const 'x'")),
    "compound assignment to const should be rejected by semantic validation",
  );
  assert.ok(
    custom.validate(custom.parseLuau("const x = 1\nlocal f = function() x = 2 end")).some((msg) => msg.includes("cannot assign to const 'x'")),
    "closure assignment to outer const should be rejected by semantic validation",
  );
}

console.log("luau-custom-roundtrip: ok");
