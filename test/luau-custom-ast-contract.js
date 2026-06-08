const assert = require("assert");
const { execFileSync } = require("child_process");
const path = require("path");

const custom = require("../src/luau/custom");
const repoRoot = path.resolve(__dirname, "..");
const buildCustomPath = path.join(repoRoot, "build", "src", "luau", "custom");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

assert.ok(custom.types, "custom frontend should export AST types");
assert.ok(custom.nodes, "custom frontend should export node contracts");
assert.ok(custom.locations, "custom frontend should export location contracts");
assert.ok(custom.diagnosticTypes, "custom frontend should export diagnostic contracts");
assert.ok(typeof custom.parseLuau === "function", "custom frontend should still export parseLuau");

assert.strictEqual(custom.nodes.rootType, "Chunk", "node contracts should define the Chunk root type");
assert.ok(custom.nodes.nodeTypes.includes("LocalStatement"), "node contracts should include internal AST nodes");
assert.ok(custom.nodes.nodeTypes.includes("StatTypeAlias"), "node contracts should keep public normalized aliases");
assert.deepStrictEqual(custom.locations.positionFields, ["line", "column"], "location contracts should describe positions");
assert.ok(custom.diagnosticTypes.fields.includes("message"), "diagnostic contracts should include the message field");
assert.strictEqual(custom.types.nodes, custom.nodes, "AST types should include the node contract metadata");
assert.strictEqual(custom.types.locations, custom.locations, "AST types should include the location contract metadata");
assert.strictEqual(
  custom.types.diagnosticTypes,
  custom.diagnosticTypes,
  "AST types should include the diagnostic contract metadata",
);

const ast = custom.parseLuau("local value = 1");
assert.strictEqual(ast.type, custom.nodes.rootType, "parseLuau should keep returning the custom Chunk AST");
assert.ok(Array.isArray(ast.range), "parsed nodes should expose ranges");
assert.ok(ast.loc && typeof ast.loc.start.line === "number", "parsed nodes should expose locations");

execFileSync(npmCommand, ["run", "build:ts"], {
  cwd: repoRoot,
  stdio: "pipe",
});

const builtCustom = require(path.join(buildCustomPath, "index.js"));

assert.ok(builtCustom.types, "built custom frontend should export AST types");
assert.ok(builtCustom.nodes, "built custom frontend should export node contracts");
assert.ok(builtCustom.locations, "built custom frontend should export location contracts");
assert.ok(builtCustom.diagnosticTypes, "built custom frontend should export diagnostic contracts");
assert.ok(typeof builtCustom.parseLuau === "function", "built custom frontend should still export parseLuau");
assert.strictEqual(builtCustom.nodes.rootType, "Chunk", "built custom frontend should expose node contracts");
assert.ok(builtCustom.nodes.nodeTypes.includes("LocalStatement"), "built node contracts should include internal AST nodes");
assert.strictEqual(
  builtCustom.types.diagnosticTypes.fields.includes("message"),
  true,
  "built custom frontend should preserve diagnostic contract metadata",
);
