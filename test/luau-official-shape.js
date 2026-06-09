const assert = require("assert");
const custom = require("../src/luau/custom");
const diagnostics = require("../src/luau/custom/diagnostics");

assert.ok(custom.types.nodes.nodeTypes.includes("StatTypeAlias"));
assert.ok(custom.types.nodes.nodeTypes.includes("ExprIfElse"));
assert.ok(custom.types.nodes.nodeTypes.includes("TypeReference"));
assert.deepStrictEqual(custom.types.locations.sourceLocationFields, ["begin", "end"]);
assert.deepStrictEqual(custom.types.diagnosticTypes.fields, ["message", "expected", "token", "location", "range"]);

const ast = custom.parseLuau([
  "export type Pair<T, U...> = { value: T, rest: (U...) -> () }",
  "local function f<T, U...>(x: T, ...: U...): T",
  "  return x",
  "end",
].join("\n"));

assert.strictEqual(ast.type, "Chunk");
assert.ok(Array.isArray(ast.body), "Chunk body should be an array");
assert.ok(ast.loc && ast.loc.begin && ast.loc.end, "chunk location should use official-style begin/end fields");
assert.strictEqual(ast.body[0].type, "StatTypeAlias", "type alias should use official-style statement naming");
assert.strictEqual(ast.body[1].type, "StatLocalFunction", "local function should use official-style local function naming");
assert.strictEqual(ast.body[0].generics.length, 1, "type alias should split normal generics");
assert.strictEqual(ast.body[0].genericPacks.length, 1, "type alias should split generic type packs");
assert.strictEqual(ast.body[0].genericPacks[0].name, "U", "type alias generic pack name should be preserved");
assert.strictEqual(ast.body[1].generics.length, 1, "function should split normal generics");
assert.strictEqual(ast.body[1].genericPacks.length, 1, "function should split generic type packs");

const diagnostic = diagnostics.makeDiagnostic("x", ast.body[0], ["type"]);
assert.ok(diagnostic && diagnostic.location, "diagnostics should expose official-style location field");
