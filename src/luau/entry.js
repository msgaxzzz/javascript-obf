const { walk } = require("./ast");
const { collectIdentifierNames, makeShortNameFactory } = require("./names");

function stringLiteral(value, ctx) {
  const raw = JSON.stringify(value);
  if (ctx && ctx.factory && typeof ctx.factory.makeStringLiteral === "function") {
    return ctx.factory.makeStringLiteral(raw, value);
  }
  return { type: "StringLiteral", value, raw };
}

function isGlobalEnv(node) {
  return node && node.type === "Identifier" && (node.name === "_G" || node.name === "_ENV");
}

function entryLuau(ast, ctx) {
  let replacement = null;
  const used = collectIdentifierNames(ast, ctx);
  const nameGen = makeShortNameFactory(ctx.rng, used);
  walk(ast, (node, parent, key, index) => {
    if (!node || !parent || key === null || key === undefined) {
      return;
    }
    if (node.type === "MemberExpression") {
      if (!isGlobalEnv(node.base)) {
        return;
      }
      if (node.indexer === ":") {
        return;
      }
      const name = node.identifier && node.identifier.name;
      if (name !== "__r") {
        return;
      }
      if (!replacement) {
        replacement = nameGen();
      }
      node.identifier.name = replacement;
      return;
    }
    if (node.type === "IndexExpression") {
      if (!isGlobalEnv(node.base)) {
        return;
      }
      if (!node.index || node.index.type !== "StringLiteral") {
        return;
      }
      const value = node.index.value ?? node.index.raw?.slice(1, -1);
      if (value !== "__r") {
        return;
      }
      if (!replacement) {
        replacement = nameGen();
      }
      node.index = stringLiteral(replacement, ctx);
      if (index === null || index === undefined) {
        parent[key] = node;
      } else {
        parent[key][index] = node;
      }
    }
  });
}

module.exports = {
  entryLuau,
};
