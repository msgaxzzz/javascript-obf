const { collectIdentifierNames, makeShortNameFactory } = require("./names");

function buildBlock(nameFor, rng) {
  const a = nameFor();
  const b = nameFor();
  const c = nameFor();
  const i = nameFor();
  const n1 = rng.int(2, 9);
  const n2 = rng.int(3, 12);
  const nums = [
    rng.int(3, 19),
    rng.int(5, 23),
    rng.int(7, 29),
    rng.int(11, 31),
  ];
  const sentinel = rng.int(50000, 200000);

  const lines = [
    "do",
    `  local ${a} = ${n1}`,
    `  local ${b} = ${n2}`,
    `  local ${c} = { ${nums.join(", ")} }`,
    `  for ${i} = 1, #${c} do`,
    `    ${a} = ${a} + ${c}[${i}] * ${b}`,
    `    ${b} = ${b} + ${i}`,
    "  end",
    `  if ${a} == ${sentinel} then`,
    `    ${b} = ${b} + 1`,
    "  end",
    "end",
  ];
  return lines.join("\n");
}

function buildBlockAlt(nameFor, rng) {
  const x = nameFor();
  const y = nameFor();
  const z = nameFor();
  const k = nameFor();
  const n1 = rng.int(2, 9);
  const n2 = rng.int(4, 13);
  const n3 = rng.int(10, 70);
  const limit = rng.int(4, 12);
  const sentinel = rng.int(200000, 600000);
  const lines = [
    "do",
    `  local ${x} = ${n1}`,
    `  local ${y} = ${n2}`,
    `  local ${z} = ${x} * ${y} + ${n3}`,
    `  local ${k} = 0`,
    `  while ${k} < ${limit} do`,
    `    ${z} = ${z} + ${k} * ${y}`,
    `    ${k} = ${k} + 1`,
    "  end",
    `  if ${z} < ${sentinel} then`,
    `    ${x} = ${z} - ${y}`,
    "  end",
    "end",
  ];
  return lines.join("\n");
}

function padFooterLuau(ast, ctx) {
  if (!ctx.options.padFooter) {
    return;
  }
  if (!ast || !Array.isArray(ast.body)) {
    return;
  }
  const blocks = ctx.options.padFooterOptions?.blocks ?? 1;
  if (!Number.isFinite(blocks) || blocks < 1) {
    return;
  }
  const usedNames = collectIdentifierNames(ast, ctx);
  const nameFor = makeShortNameFactory(ctx.rng, usedNames);

  const snippets = [];
  for (let i = 0; i < blocks; i += 1) {
    const snippet = ctx.rng.bool(0.5)
      ? buildBlock(nameFor, ctx.rng)
      : buildBlockAlt(nameFor, ctx.rng);
    snippets.push(snippet);
  }
  const source = snippets.join("\n");
  const useCustom = !ctx.options || ctx.options.luauParser !== "luaparse";
  const paddingAst = useCustom
    ? ctx.parseCustom(source)
    : ctx.parseLuaparse(source);
  if (paddingAst && Array.isArray(paddingAst.body)) {
    const style = useCustom ? "custom" : "luaparse";
    const lastIndex = ast.body.length - 1;
    let insertIndex = ast.body.length;
    if (lastIndex >= 0 && ast.body[lastIndex]?.type === "ReturnStatement") {
      const returnStmt = ast.body[lastIndex];
      const wrapped = style === "custom"
        ? { type: "DoStatement", body: { type: "Block", body: [returnStmt] } }
        : { type: "DoStatement", body: [returnStmt] };
      ast.body[lastIndex] = wrapped;
      insertIndex = ast.body.length;
    }
    ast.body.splice(insertIndex, 0, ...paddingAst.body);
  }
}

module.exports = {
  padFooterLuau,
};
