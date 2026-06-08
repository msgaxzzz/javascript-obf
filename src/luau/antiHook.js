const { insertAtTop, walk } = require("./ast");
const { makeShortNameFactory } = require("./names");

function luaString(value) {
  const text = String(value);
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/"/g, "\\\"");
  return `"${escaped}"`;
}

function luaByteString(value) {
  const bytes = Array.from(Buffer.from(String(value), "utf8"));
  if (!bytes.length) {
    return '""';
  }
  let out = "\"";
  for (const value of bytes) {
    const num = Math.max(0, Math.min(255, Number(value) || 0));
    out += `\\${String(num).padStart(3, "0")}`;
  }
  out += "\"";
  return out;
}

function luaCharCall(fnName, value) {
  const bytes = Array.from(Buffer.from(String(value), "utf8"));
  if (!bytes.length) {
    return '""';
  }
  return `${fnName}(${bytes.join(", ")})`;
}

function luaHiddenIndex(baseExpr, key) {
  return `${baseExpr}[${luaByteString(key)}]`;
}

function buildRuntime({ lock, rng }) {
  const used = new Set();
  const nameFor = makeShortNameFactory(rng, used);
  const failName = nameFor();
  const envResolverName = nameFor();
  const checkName = nameFor();
  const rootName = nameFor();
  const typeName = nameFor();
  const charName = nameFor();
  const getfenvName = nameFor();
  const getmetatableName = nameFor();
  const setmetatableName = nameFor();
  const pcallName = nameFor();
  const debugName = nameFor();
  const functionTag = luaByteString("function");
  const tableTag = luaByteString("table");
  const lockedValue = luaByteString("locked");
  const errIntegrity = luaCharCall(charName, "invalid state");
  const errRuntime = luaCharCall(charName, "operation unavailable");
  const hiddenString = luaHiddenIndex(rootName, "string");
  const hiddenType = luaHiddenIndex(rootName, "type");
  const hiddenGetfenv = luaHiddenIndex(rootName, "getfenv");
  const hiddenGetmetatable = luaHiddenIndex(rootName, "getmetatable");
  const hiddenSetmetatable = luaHiddenIndex(rootName, "setmetatable");
  const hiddenPcall = luaHiddenIndex(rootName, "pcall");
  const hiddenDebug = luaHiddenIndex(rootName, "debug");
  const hiddenChar = luaHiddenIndex(hiddenString, "char");
  const envLocalName = nameFor();
  const getfLocalName = nameFor();
  const getmtLocalName = nameFor();
  const mtLocalName = nameFor();
  const rootLocalName = nameFor();
  const dbgLocalName = nameFor();
  const gethookLocalName = nameFor();
  const okLocalName = nameFor();
  const hookLocalName = nameFor();
  const lockEnvName = nameFor();
  const setmtLocalName = nameFor();
  const envLockLocalName = nameFor();
  const mtLockLocalName = nameFor();
  const okSetmtLocalName = nameFor();
  return [
    "do",
    `  local ${rootName} = _G`,
    `  local ${typeName} = ${hiddenType} or type`,
    `  local ${charName} = ${hiddenChar} or string.char`,
    `  local ${getfenvName} = ${hiddenGetfenv} or getfenv`,
    `  local ${getmetatableName} = ${hiddenGetmetatable} or getmetatable`,
    `  local ${setmetatableName} = ${hiddenSetmetatable} or setmetatable`,
    `  local ${pcallName} = ${hiddenPcall} or pcall`,
    `  local ${debugName} = ${hiddenDebug}`,
    `  local function ${failName}(msg)`,
    `    ((${luaHiddenIndex(rootName, "error")} or error))(msg, 0)`,
    "  end",
    `  if ${typeName} == nil then`,
    `    ${failName}(${errIntegrity})`,
    "  end",
    `  local function ${envResolverName}()`,
    `    local ${envLocalName}`,
    `    local ${getfLocalName} = ${getfenvName}`,
    `    if ${typeName}(${getfLocalName}) == ${functionTag} then`,
    `      ${envLocalName} = ${getfLocalName}(1)`,
    "    end",
    `    if ${typeName}(${envLocalName}) ~= ${tableTag} then`,
    `      ${envLocalName} = ${rootName}`,
    "    end",
    `    local ${getmtLocalName} = ${getmetatableName}`,
    `    if ${typeName}(${getmtLocalName}) == ${functionTag} then`,
    `      local ${mtLocalName} = ${getmtLocalName}(${envLocalName})`,
    `      if ${mtLocalName} ~= nil then`,
    `        local ${rootLocalName} = ${rootName}`,
    `        if ${typeName}(${rootLocalName}) == ${tableTag} then`,
    `          ${envLocalName} = ${rootLocalName}`,
    "        end",
    "      end",
    "    end",
    `    return ${envLocalName}`,
    "  end",
    `  local function ${checkName}()`,
    `    local ${envLocalName} = ${envResolverName}()`,
    `    if ${typeName}(${envLocalName}) ~= ${tableTag} then`,
    `      ${failName}(${errIntegrity})`,
    "    end",
    `    local ${dbgLocalName} = ${debugName}`,
    `    if ${typeName}(${dbgLocalName}) == ${tableTag} then`,
    `      local ${gethookLocalName} = ${luaHiddenIndex(dbgLocalName, "gethook")}`,
    `      if ${typeName}(${gethookLocalName}) == ${functionTag} then`,
    `        local ${okLocalName}, ${hookLocalName} = ${pcallName}(${gethookLocalName})`,
    `        if ${okLocalName} and ${hookLocalName} ~= nil then`,
    `          ${failName}(${errIntegrity})`,
    "        end",
    "      end",
    "    end",
    `    local ${getmtLocalName} = ${getmetatableName}`,
    `    if ${typeName}(${getmtLocalName}) == ${functionTag} then`,
    `      local ${mtLocalName} = ${getmtLocalName}(${envLocalName})`,
    `      if ${mtLocalName} ~= nil then`,
    `        ${failName}(${errIntegrity})`,
    "      end",
    "    end",
    "  end",
    `  ${checkName}()`,
    lock ? `  local ${lockEnvName} = true` : `  local ${lockEnvName} = false`,
    `  if ${lockEnvName} then`,
    `    local ${setmtLocalName} = ${setmetatableName}`,
    `    if ${typeName}(${setmtLocalName}) == ${functionTag} then`,
    `      local ${envLockLocalName} = ${envResolverName}()`,
    `      local ${mtLockLocalName} = ${getmetatableName}(${envLockLocalName})`,
    `      if ${mtLockLocalName} == nil then`,
    `        ${mtLockLocalName} = {}`,
    `        local ${okSetmtLocalName} = ${pcallName}(${setmtLocalName}, ${envLockLocalName}, ${mtLockLocalName})`,
    `        if not ${okSetmtLocalName} then`,
    `          ${mtLockLocalName} = nil`,
    `        end`,
    `      end`,
    `      if ${mtLockLocalName} ~= nil and ${luaHiddenIndex(mtLockLocalName, "__metatable")} == nil then`,
    `        ${luaHiddenIndex(mtLockLocalName, "__metatable")} = ${lockedValue}`,
    `      end`,
    `      if ${mtLockLocalName} ~= nil and ${luaHiddenIndex(mtLockLocalName, "__newindex")} == nil then`,
    `        ${luaHiddenIndex(mtLockLocalName, "__newindex")} = function() ((${luaHiddenIndex(rootName, "error")} or error))(${errRuntime}, 0) end`,
    `      end`,
    "    end",
    "  end",
    "end",
  ].join("\n");
}

function antiHookLuau(ast, ctx) {
  if (!ctx.options.antiHook || !ctx.options.antiHook.enabled) {
    return;
  }
  const runtime = buildRuntime({ lock: ctx.options.antiHook.lock, rng: ctx.rng });
  const useCustom = !ctx.options || ctx.options.luauParser !== "luaparse";
  const runtimeAst = useCustom
    ? ctx.parseCustom(runtime)
    : ctx.parseLuaparse(runtime);
  if (runtimeAst && Array.isArray(runtimeAst.body)) {
    runtimeAst.body.forEach((stmt) => {
      stmt.__obf_skip_mask = true;
      walk(stmt, (node) => {
        node.__obf_skip_mask = true;
      });
    });
  }
  insertAtTop(ast, runtimeAst.body);
}

module.exports = {
  antiHookLuau,
};
