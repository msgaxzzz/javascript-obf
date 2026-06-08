const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const rename = require("../src/luau/rename");
const maskGlobals = require("../src/luau/maskGlobals");
const strings = require("../src/luau/strings");
const { obfuscateLuau } = require("../src/luau");
const { parse: parseCustom } = require("../src/luau/custom/parser");
const { walk } = require("../src/luau/ast");
const { renameLuau } = rename;
const { parseLuau } = require("../src/luau/custom");
const { RNG } = require("../src/utils/rng");

assert.ok(rename, "rename transform should still load");
assert.ok(maskGlobals, "maskGlobals transform should still load");
assert.ok(strings, "strings transform should still load");

const source = [
  "local function demo()",
  "  local a = 1",
  "  local b = a + 1",
  "  local t = { a = a, [b] = a }",
  "  print(b)",
  "  return b",
  "end",
].join("\n");

function collectLocalNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (!node || node.type !== "LocalStatement") {
      return;
    }
    if (Array.isArray(node.variables)) {
      node.variables.forEach((variable) => {
        if (variable && variable.type === "Identifier") {
          names.add(variable.name);
        }
      });
    }
  });
  return names;
}

function hasTableKeyA(ast) {
  let found = false;
  walk(ast, (node) => {
    if (found || !node) {
      return;
    }
    if (node.type === "TableConstructorExpression") {
      const fields = node.fields || [];
      for (const field of fields) {
        if (field.kind === "name" && field.name && field.name.name === "a") {
          found = true;
          return;
        }
        if (field.type === "TableKeyString" && field.key && field.key.name === "a") {
          found = true;
          return;
        }
      }
    }
  });
  return found;
}

function hasPrintCall(ast) {
  let found = false;
  walk(ast, (node) => {
    if (found || !node) {
      return;
    }
    if (node.type === "CallExpression" && node.base && node.base.type === "Identifier" && node.base.name === "print") {
      found = true;
    }
  });
  return found;
}

function hasMemberName(ast, name) {
  let found = false;
  walk(ast, (node) => {
    if (found || !node || node.type !== "MemberExpression") {
      return;
    }
    if (node.identifier && node.identifier.type === "Identifier" && node.identifier.name === name) {
      found = true;
    }
  });
  return found;
}

function countMemberName(ast, name) {
  let count = 0;
  walk(ast, (node) => {
    if (!node || node.type !== "MemberExpression") {
      return;
    }
    if (node.identifier && node.identifier.type === "Identifier" && node.identifier.name === name) {
      count += 1;
    }
  });
  return count;
}

function runLuau(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "js-obf-luau-rename-"));
  const file = path.join(dir, "case.luau");
  try {
    fs.writeFileSync(file, code, "utf8");
    const result = spawnSync("luau", [file], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `luau exited with code ${result.status}`);
    }
    return result.stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runEnvAliasMemberGuard() {
  const ast = parseCustom(
    [
      "local e = _G",
      "local i = 1",
      "local x = e[i].byte",
      "return x",
    ].join("\n")
  );
  ast.__obf_env_alias_name = "e";
  renameLuau(ast, {
    options: {
      renameOptions: {
        renameMembers: true,
        renameGlobals: false,
        reserved: [],
      },
    },
    rng: new RNG("rename-env-alias-member"),
  });
  assert.ok(hasMemberName(ast, "byte"), "custom: env alias lookup member should preserve 'byte'");
}

function runExternalServiceMemberGuard() {
  const ast = parseCustom(
    [
      "local Players = game:GetService(\"Players\")",
      "local lp = Players.LocalPlayer",
      "return lp",
    ].join("\n")
  );
  renameLuau(ast, {
    options: {
      renameOptions: {
        renameMembers: true,
        renameGlobals: false,
        reserved: [],
      },
    },
    rng: new RNG("rename-external-service-guard"),
  });
  assert.ok(hasMemberName(ast, "LocalPlayer"), "custom: external service member should be preserved");
}

function runLocalTableMemberRename() {
  const ast = parseCustom(
    [
      "local t = { foo = { bar = 1 } }",
      "return t.foo.bar",
    ].join("\n")
  );
  renameLuau(ast, {
    options: {
      renameOptions: {
        renameMembers: true,
        renameGlobals: false,
        reserved: [],
      },
    },
    rng: new RNG("rename-local-table-members"),
  });
  assert.strictEqual(countMemberName(ast, "foo"), 0, "custom: local table member 'foo' should be renamed");
  assert.strictEqual(countMemberName(ast, "bar"), 0, "custom: nested local table member 'bar' should be renamed");
}

function runCanonicalOfficialShapeRename() {
  const ast = parseLuau("local t = { foo = 1 } return t.foo");
  renameLuau(ast, {
    options: {
      renameOptions: {
        renameMembers: true,
        renameGlobals: false,
        reserved: [],
      },
    },
    rng: new RNG("official-shape"),
  });
  assert.ok(ast && ast.type === "Chunk", "rename should accept canonical official-shape AST");
}

async function runCustom() {
  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: false,
    cff: false,
    renameOptions: { maskGlobals: false },
    seed: "rename-custom",
  });
  const ast = parseCustom(code);
  const locals = collectLocalNames(ast);
  assert.ok(!locals.has("a"), "custom: local a should be renamed");
  assert.ok(!locals.has("b"), "custom: local b should be renamed");
  assert.ok(hasTableKeyA(ast), "custom: table key 'a' should remain");
  assert.ok(hasPrintCall(ast), "custom: print call should remain global");
}

async function runShortNameOrderRegression() {
  const names = Array.from({ length: 60 }, (_, index) => `v${index}`);
  const shortNameSource = [
    "local function demo()",
    ...names.map((name, index) => `  local ${name} = ${index}`),
    `  print(${names.slice(0, 3).join(" + ")})`,
    "end",
    "demo()",
  ].join("\n");

  const { code } = await obfuscateLuau(shortNameSource, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: false,
    cff: false,
    dead: false,
    numbers: false,
    renameOptions: { maskGlobals: false },
    seed: "rename-short-name-order",
  });
  const ast = parseCustom(code);
  const locals = collectLocalNames(ast);
  assert.ok(locals.has("b"), "Luau rename should use one-character names first");
  assert.ok(locals.has("_"), "Luau rename should exhaust one-character names before two-character names");
  assert.ok(locals.has("aa"), "Luau rename should continue into two-character names after one-character names");
  assert.ok(locals.has("ah"), "Luau rename should keep allocating short two-character names without a three-character cap");
  assert.ok(!locals.has("v0"), "original local names should be renamed");
  assert.strictEqual(runLuau(code), "3", "short-name Luau rename should preserve behavior");
}

async function runTopReturnNamePreserveRegression() {
  const sourceWithTopReturn = [
    "local function score()",
    "  local total = 7",
    "  return total",
    "end",
    "local function wrapper()",
    "  local score = 5",
    "  return score",
    "end",
    "print(wrapper())",
    "return score",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithTopReturn, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: false,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    wrap: false,
    renameOptions: {
      maskGlobals: false,
    },
    seed: "rename-top-return-preserve",
  });

  parseCustom(code);
  assert.ok(/\blocal function score\b/.test(code), "top-level returned function name should be preserved by default");
  assert.ok(/\breturn score\b/.test(code), "top-level return should keep the exported name by default");
  assert.ok(!/\blocal score\s*=/.test(code), "non-exported nested locals with the same name should still be renamed");
  assert.strictEqual(runLuau(code), "5", "top-level return name preservation should preserve script behavior");

  const { code: optOutCode } = await obfuscateLuau(sourceWithTopReturn, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: false,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    wrap: false,
    renameOptions: {
      maskGlobals: false,
      preserveTopReturnNames: false,
    },
    seed: "rename-top-return-opt-out",
  });

  parseCustom(optOutCode);
  assert.ok(!/\blocal function score\b/.test(optOutCode), "top-level return name preservation should be opt-out");
  assert.strictEqual(runLuau(optOutCode), "5", "opted-out top-level return rename should remain internally consistent");
}

async function runRenameMembersWithStrings() {
  const sourceWithMemberCalls = [
    "local t = {}",
    "function t.foo()",
    "  return 42",
    "end",
    "print(t.foo())",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithMemberCalls, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: true,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    renameOptions: {
      renameMembers: true,
      maskGlobals: false,
    },
    seed: "rename-members-with-strings",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "42", "member renaming should stay aligned with encoded member calls");
}

async function runExternalPayloadKeyGuard() {
  const sourceWithPayload = [
    "local RemoteEvent = {}",
    "function RemoteEvent:FireServer(payload)",
    "  return payload.keep and 'ok' or 'bad'",
    "end",
    "print(RemoteEvent:FireServer({ keep = true }))",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithPayload, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: false,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    renameOptions: {
      renameMembers: true,
      maskGlobals: false,
    },
    seed: "rename-external-payload",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "ok", "table literal payload keys should stay stable for external-style APIs");
}

async function runMetatableMethodRenameRoundtrip() {
  const sourceWithMetatableMethods = [
    "local Engine = {}",
    "Engine.__index = Engine",
    "function Engine.new()",
    "  local self = { nodes = {} }",
    "  return setmetatable(self, Engine)",
    "end",
    "function Engine:register(name)",
    "  self.nodes[name] = true",
    "end",
    "local engine = Engine.new()",
    "engine:register(\"ok\")",
    "print(engine.nodes[\"ok\"] and \"ok\" or \"bad\")",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithMetatableMethods, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: true,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    renameOptions: {
      renameMembers: true,
      maskGlobals: false,
    },
    seed: "rename-metatable-methods",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "ok", "metatable-backed method calls should stay aligned with renamed methods");
}

async function runAliasedContainerRecordGuard() {
  const sourceWithAliasedRecord = [
    "local Engine = {}",
    "Engine.__index = Engine",
    "function Engine.new()",
    "  local self = { nodes = {} }",
    "  return setmetatable(self, Engine)",
    "end",
    "function Engine:register(name, deps)",
    "  self.nodes[name] = { deps = deps }",
    "end",
    "function Engine:ready(node, state)",
    "  for _, dep in ipairs(node.deps) do",
    "    if state[dep] == nil then",
    "      return false",
    "    end",
    "  end",
    "  return true",
    "end",
    "local engine = Engine.new()",
    "engine:register(\"task\", { \"ok\" })",
    "local node = engine.nodes[\"task\"]",
    "print(engine:ready(node, { ok = true }) and \"ok\" or \"bad\")",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithAliasedRecord, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: true,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    renameOptions: {
      renameMembers: true,
      maskGlobals: false,
    },
    seed: "rename-aliased-container-record",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "ok", "record fields stored in local containers should remain readable through aliases");
}

async function runDynamicMapMemberAccessGuard() {
  const sourceWithDynamicMapMemberAccess = [
    "local function shallowClone(input)",
    "  local out = {}",
    "  for key, value in pairs(input) do",
    "    out[key] = value",
    "  end",
    "  return out",
    "end",
    "local Engine = {}",
    "Engine.__index = Engine",
    "function Engine.new()",
    "  local self = { nodes = {}, order = {} }",
    "  return setmetatable(self, Engine)",
    "end",
    "function Engine:register(name, deps)",
    "  self.nodes[name] = { deps = shallowClone(deps) }",
    "  table.insert(self.order, name)",
    "end",
    "function Engine:run()",
    "  return #self.nodes.a.deps .. '|' .. self.order[1]",
    "end",
    "local engine = Engine.new()",
    "engine:register(\"a\", { \"x\" })",
    "print(engine:run())",
  ].join("\n");

  const { code } = await obfuscateLuau(sourceWithDynamicMapMemberAccess, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: false,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    wrap: true,
    renameOptions: {
      renameMembers: true,
      maskGlobals: true,
      renameGlobals: false,
    },
    seed: "rename-dynamic-map-member-access",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "1|a", "member reads through dynamic-key maps should preserve runtime keys");
}

async function runHardProjectLikeRoundtrip() {
  const source = [
    "local function shallowClone(input)",
    "  local out = {}",
    "  for key, value in pairs(input) do",
    "    out[key] = value",
    "  end",
    "  return out",
    "end",
    "",
    "local Engine = {}",
    "Engine.__index = Engine",
    "",
    "function Engine.new(seed)",
    "  local self = {",
    "    seed = seed,",
    "    nodes = {},",
    "    order = {},",
    "    cache = {},",
    "    trace = {},",
    "    metrics = { attempts = 0, retries = 0, checksum = 0 },",
    "  }",
    "  return setmetatable(self, Engine)",
    "end",
    "",
    "function Engine:register(name, deps, handler)",
    "  self.nodes[name] = {",
    "    name = name,",
    "    deps = shallowClone(deps),",
    "    handler = handler,",
    "  }",
    "  table.insert(self.order, name)",
    "end",
    "",
    "function Engine:_ready(node, state)",
    "  for _, dep in ipairs(node.deps) do",
    "    if state[dep] == nil then",
    "      return false",
    "    end",
    "  end",
    "  return true",
    "end",
    "",
    "function Engine:_resolve(node, state)",
    "  local resolved = {}",
    "  for _, dep in ipairs(node.deps) do",
    "    resolved[dep] = state[dep]",
    "  end",
    "  return resolved",
    "end",
    "",
    "function Engine:run(payload)",
    "  local state = { input = shallowClone(payload) }",
    "  for _, name in ipairs(self.order) do",
    "    local node = self.nodes[name]",
    "    if self:_ready(node, state) then",
    "      local deps = self:_resolve(node, state)",
    "      state[name] = node.handler(deps, payload, 1, self)",
    "    end",
    "  end",
    "  return state",
    "end",
    "",
    "local engine = Engine.new(13)",
    "engine:register(\"normalize\", { \"input\" }, function(deps)",
    "  return { rows = deps.input.items }",
    "end)",
    "engine:register(\"expand\", { \"normalize\" }, function(deps)",
    "  return { total = #deps.normalize.rows }",
    "end)",
    "local result = engine:run({ items = { 1, 2, 3 } })",
    "print(result.expand.total)",
  ].join("\n");

  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    filename: "hard-project-like.lua",
    sourceMap: true,
    preset: "high",
    strings: true,
    cff: true,
    dead: true,
    rename: true,
    wrap: true,
    numbers: true,
    constArray: true,
    padFooter: true,
    proxifyLocals: false,
    vm: {
      enabled: true,
      include: [],
    },
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: true,
      homoglyphs: false,
    },
    seed: "hard-project-like-roundtrip",
  });

  parseCustom(code);
  assert.strictEqual(runLuau(code), "3", "hard-project-like member graphs should survive full luau pipeline");
}

async function runNonVmClonedPayloadSchemaGuard() {
  const source = [
    "local function shallowClone(input)",
    "  local out = {}",
    "  for key, value in pairs(input) do",
    "    out[key] = value",
    "  end",
    "  return out",
    "end",
    "",
    "local Engine = {}",
    "Engine.__index = Engine",
    "",
    "function Engine.new()",
    "  local self = { nodes = {}, order = {} }",
    "  return setmetatable(self, Engine)",
    "end",
    "",
    "function Engine:register(name, deps, handler)",
    "  self.nodes[name] = { deps = shallowClone(deps), handler = handler }",
    "  table.insert(self.order, name)",
    "end",
    "",
    "function Engine:_ready(node, state)",
    "  for _, dep in ipairs(node.deps) do",
    "    if state[dep] == nil then",
    "      return false",
    "    end",
    "  end",
    "  return true",
    "end",
    "",
    "function Engine:_resolve(node, state)",
    "  local resolved = {}",
    "  for _, dep in ipairs(node.deps) do",
    "    resolved[dep] = state[dep]",
    "  end",
    "  return resolved",
    "end",
    "",
    "function Engine:run(payload)",
    "  local state = { input = shallowClone(payload) }",
    "  for _, name in ipairs(self.order) do",
    "    local node = self.nodes[name]",
    "    if self:_ready(node, state) then",
    "      local deps = self:_resolve(node, state)",
    "      state[name] = node.handler(deps, payload)",
    "    end",
    "  end",
    "  return state",
    "end",
    "",
    "local engine = Engine.new()",
    "engine:register(\"normalize\", { \"input\" }, function(deps, payload)",
    "  return { total = #deps.input.items, mode = payload.mode }",
    "end)",
    "",
    "local result = engine:run({ mode = \"amplify\", items = { 1, 2, 3 } })",
    "print(result.normalize.total .. \":\" .. result.normalize.mode)",
  ].join("\n");

  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: true,
    cff: true,
    dead: true,
    vm: false,
    constArray: true,
    numbers: true,
    proxifyLocals: false,
    padFooter: true,
    wrap: true,
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: true,
      homoglyphs: false,
    },
    seed: "non-vm-cloned-payload-schema-guard",
  });

  parseCustom(code);
  assert.strictEqual(
    runLuau(code),
    "3:amplify",
    "non-VM payload schemas cloned into deps.input should keep member access aligned"
  );
}

async function runClonedPayloadSchemaGuard() {
  const source = [
    "local function shallowClone(input)",
    "  local out = {}",
    "  for key, value in pairs(input) do",
    "    out[key] = value",
    "  end",
    "  return out",
    "end",
    "",
    "local Engine = {}",
    "Engine.__index = Engine",
    "",
    "function Engine.new()",
    "  local self = { nodes = {}, order = {} }",
    "  return setmetatable(self, Engine)",
    "end",
    "",
    "function Engine:register(name, deps, handler)",
    "  self.nodes[name] = { deps = shallowClone(deps), handler = handler }",
    "  table.insert(self.order, name)",
    "end",
    "",
    "function Engine:_ready(node, state)",
    "  for _, dep in ipairs(node.deps) do",
    "    if state[dep] == nil then",
    "      return false",
    "    end",
    "  end",
    "  return true",
    "end",
    "",
    "function Engine:_resolve(node, state)",
    "  local resolved = {}",
    "  for _, dep in ipairs(node.deps) do",
    "    resolved[dep] = state[dep]",
    "  end",
    "  return resolved",
    "end",
    "",
    "function Engine:run(payload)",
    "  local state = { input = shallowClone(payload) }",
    "  for _, name in ipairs(self.order) do",
    "    local node = self.nodes[name]",
    "    if self:_ready(node, state) then",
    "      local deps = self:_resolve(node, state)",
    "      state[name] = node.handler(deps, payload)",
    "    end",
    "  end",
    "  local summary = {",
    "    checksum = 11,",
    "    attempts = 2,",
    "  }",
    "  return state, summary",
    "end",
    "",
    "local engine = Engine.new()",
    "engine:register(\"normalize\", { \"input\" }, function(deps, payload)",
    "  local total = #deps.input.items",
    "  if payload.mode == \"trim\" then",
    "    total -= 1",
    "  end",
    "  return { lines = { tostring(total) }, total = total, mode = payload.mode }",
    "end)",
    "",
    "local payload = {",
    "  mode = \"amplify\",",
    "  items = { 1, 2, 3 },",
    "}",
    "local result, summary = engine:run(payload)",
    "print(result.normalize.total .. \":\" .. result.normalize.mode .. \":\" .. summary.checksum .. \":\" .. result.normalize.lines[1])",
  ].join("\n");

  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    filename: "cloned-payload-schema-guard.lua",
    sourceMap: true,
    preset: "high",
    strings: true,
    cff: true,
    dead: true,
    rename: true,
    wrap: true,
    numbers: true,
    constArray: true,
    padFooter: true,
    proxifyLocals: false,
    vm: {
      enabled: true,
      include: [],
    },
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: true,
      homoglyphs: false,
    },
    seed: "cloned-payload-schema-guard",
  });

  parseCustom(code);
  assert.strictEqual(
    runLuau(code),
    "3:amplify:11:3",
    "payload schemas cloned into deps.input should keep member access aligned"
  );
}

async function runDynamicMapRecordAliasGuard() {
  const source = [
    "local function shallowClone(input)",
    "  local out = {}",
    "  for key, value in pairs(input) do",
    "    out[key] = value",
    "  end",
    "  return out",
    "end",
    "",
    "local Engine = {}",
    "Engine.__index = Engine",
    "",
    "function Engine.new()",
    "  local self = { nodes = {}, order = {}, cache = {} }",
    "  return setmetatable(self, Engine)",
    "end",
    "",
    "function Engine:register(name, deps, handler)",
    "  self.nodes[name] = { deps = shallowClone(deps), handler = handler }",
    "  table.insert(self.order, name)",
    "end",
    "",
    "function Engine:run()",
    "  local node = self.nodes.normalize",
    "  return type(node.handler) .. ':' .. tostring(node.deps[1])",
    "end",
    "",
    "local engine = Engine.new()",
    "engine:register(\"normalize\", { \"input\" }, function() return 1 end)",
    "print(engine:run())",
  ].join("\n");

  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: true,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    wrap: false,
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: true,
      homoglyphs: false,
    },
    seed: "rename-dynamic-map-record-alias",
  });

  parseCustom(code);
  assert.strictEqual(
    runLuau(code),
    "function:input",
    "records stored inside dynamic-key maps should keep aliased field reads aligned"
  );
}

async function runExternalIpairsValueShapeGuard() {
  const source = [
    "local function test(payload)",
    "  local total = 0",
    "  for _, item in ipairs(payload.items) do",
    "    total += item.weight",
    "  end",
    "  return total",
    "end",
    "print(test({ items = { { id = 'a', weight = 3 }, { id = 'b', weight = 2 } } }))",
  ].join("\n");

  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: false,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    wrap: false,
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: false,
      homoglyphs: false,
    },
    seed: "rename-external-ipairs-value-shape",
  });

  parseCustom(code);
  assert.strictEqual(
    runLuau(code),
    "5",
    "ipairs values sourced from external payload arrays should preserve member names"
  );
}

async function runLocalSortComparatorShapeGuard() {
  const source = [
    "local function rank()",
    "  local ranked = {}",
    "  table.insert(ranked, { id = 'a', score = 7, tag = 'warm' })",
    "  table.insert(ranked, { id = 'b', score = 7, tag = 'warm' })",
    "  table.sort(ranked, function(a, b)",
    "    if a.score == b.score then",
    "      return a.id < b.id",
    "    end",
    "    return a.score > b.score",
    "  end)",
    "  return ranked[1].id .. ':' .. ranked[1].score",
    "end",
    "print(rank())",
  ].join("\n");

  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: false,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    wrap: false,
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: false,
      homoglyphs: false,
    },
    seed: "rename-local-sort-comparator-shape",
  });

  parseCustom(code);
  assert.strictEqual(
    runLuau(code),
    "a:7",
    "table.sort comparators over local record arrays should preserve aligned member access"
  );
}

async function runMetatableDirectFieldRoundtrip() {
  const source = [
    "local Engine = {}",
    "Engine.__index = Engine",
    "function Engine.new()",
    "  return setmetatable({ handler = nil }, Engine)",
    "end",
    "function Engine:register(handler)",
    "  self.handler = handler",
    "end",
    "local engine = Engine.new()",
    "engine:register(function()",
    "  local report = { lines = { 'ok' }, value = 1 }",
    "  return report",
    "end)",
    "local state = { report = engine.handler() }",
    "print(state.report.lines[1], state.report.value)",
  ].join("\n");

  const { code } = await obfuscateLuau(source, {
    lang: "luau",
    luauParser: "custom",
    rename: true,
    strings: false,
    cff: false,
    dead: false,
    vm: false,
    constArray: false,
    numbers: false,
    proxifyLocals: false,
    padFooter: false,
    wrap: false,
    renameOptions: {
      renameGlobals: false,
      renameMembers: true,
      maskGlobals: false,
      homoglyphs: false,
    },
    seed: "rename-metatable-direct-field-roundtrip",
  });

  parseCustom(code);
  assert.strictEqual(
    runLuau(code),
    "ok\t1",
    "metatable-backed direct instance fields should stay aligned across constructor, method writes, and reads"
  );
}

(async () => {
  runCanonicalOfficialShapeRename();
  runEnvAliasMemberGuard();
  runExternalServiceMemberGuard();
  runLocalTableMemberRename();
  await runCustom();
  await runShortNameOrderRegression();
  await runTopReturnNamePreserveRegression();
  await runRenameMembersWithStrings();
  await runExternalPayloadKeyGuard();
  await runMetatableMethodRenameRoundtrip();
  await runAliasedContainerRecordGuard();
  await runDynamicMapMemberAccessGuard();
  await runDynamicMapRecordAliasGuard();
  await runExternalIpairsValueShapeGuard();
  await runLocalSortComparatorShapeGuard();
  await runMetatableDirectFieldRoundtrip();
  await runHardProjectLikeRoundtrip();
  await runNonVmClonedPayloadSchemaGuard();
  await runClonedPayloadSchemaGuard();
  console.log("luau-rename: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
