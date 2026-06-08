const assert = require("assert");
const { parseLuau, buildScope } = require("../src/luau/custom");

function collectTypeReferences(scope, out = []) {
  out.push(...scope.typeReferences);
  scope.children.forEach((child) => collectTypeReferences(child, out));
  return out;
}

const ast = parseLuau("local function f<T>(x: T): T return x end");
const scope = buildScope(ast, { includeTypes: true });
const refs = collectTypeReferences(scope).filter((ref) => ref.name === "T");

assert.strictEqual(refs.length, 2, "expected both generic type references to be recorded");
assert.ok(refs.every((ref) => ref.binding), "generic type references should resolve to the function type parameter");

{
  const constAst = parseLuau("const answer = 42\nprint(answer)");
  const constScope = buildScope(constAst);
  const bindings = constScope.bindings.get("answer") || [];
  assert.strictEqual(bindings.length, 1, "const declaration should create one binding");
  assert.strictEqual(bindings[0].kind, "const", "const binding should be marked distinctly from local");
}

console.log("luau-custom-scope: ok");
