function isNode(value) {
  return Boolean(value && typeof value === "object" && typeof value.type === "string");
}

function stripLocationFields(node, options) {
  if (!isNode(node)) {
    return node;
  }

  if (options.locations === false) {
    delete node.loc;
  }
  if (options.ranges === false) {
    delete node.range;
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (isNode(item)) {
          stripLocationFields(item, options);
        }
      });
    } else if (isNode(value)) {
      stripLocationFields(value, options);
    }
  }

  return node;
}

function normalizeLegacyNodeShape(node, options = {}) {
  if (!isOfficialStyleChunk(node)) {
    throw new Error("Expected a custom Luau Chunk root");
  }
  return stripLocationFields(toLegacyNode(node), options);
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = cloneValue(value[key]);
    }
    return out;
  }
  return value;
}

function withOfficialLocation(loc) {
  if (!loc || typeof loc !== "object") {
    return loc;
  }
  const begin = loc.begin || loc.start || null;
  const end = loc.end || null;
  const out = { ...loc };
  if (begin) {
    out.begin = begin;
    out.start = begin;
  }
  if (end) {
    out.end = end;
  }
  return out;
}

function convertType(node) {
  if (!isNode(node)) {
    return cloneValue(node);
  }

  const out = {};
  for (const key of Object.keys(node)) {
    if (key === "loc") {
      out.loc = withOfficialLocation(node.loc);
      continue;
    }
    out[key] = convertType(node[key]);
  }

  if (node.type === "TypeReference") {
    out.name = Array.isArray(node.name) ? node.name[node.name.length - 1] || node.name : node.name;
    out.prefix = Array.isArray(node.name) && node.name.length > 1 ? node.name.slice(0, -1) : null;
    out.parameters = node.typeArguments || [];
  }

  return out;
}

function splitGenericParameters(params) {
  const generics = [];
  const genericPacks = [];
  if (Array.isArray(params)) {
    for (const param of params) {
      if (param && param.isPack) {
        genericPacks.push(param);
      } else {
        generics.push(param);
      }
    }
  }
  return { generics, genericPacks };
}

function mergeGenericParameters(generics, genericPacks) {
  return [
    ...(Array.isArray(generics) ? generics : []),
    ...(Array.isArray(genericPacks) ? genericPacks : []),
  ];
}

function toOfficialNode(node) {
  if (Array.isArray(node)) {
    return node.map(toOfficialNode);
  }
  if (!isNode(node)) {
    return cloneValue(node);
  }

  const out = {};
  for (const key of Object.keys(node)) {
    if (key === "loc") {
      out.loc = withOfficialLocation(node.loc);
      continue;
    }
    out[key] = toOfficialNode(node[key]);
  }

  switch (node.type) {
    case "Chunk":
      return out;
    case "ExportTypeStatement":
    case "TypeAliasStatement":
      {
        const split = splitGenericParameters(node.typeParameters);
        out.type = "StatTypeAlias";
        out.generics = split.generics;
        out.genericPacks = split.genericPacks;
        out.annotation = convertType(node.value);
        out.exported = node.type === "ExportTypeStatement";
        delete out.typeParameters;
        delete out.value;
        return out;
      }
    case "FunctionDeclaration":
      out.type = node.isLocal ? "StatLocalFunction" : "StatFunction";
      {
        const split = splitGenericParameters(node.typeParameters);
        out.generics = split.generics;
        out.genericPacks = split.genericPacks;
      }
      return out;
    case "DeclareFunctionStatement":
      out.type = "StatDeclareFunction";
      {
        const split = splitGenericParameters(node.typeParameters);
        out.generics = split.generics;
        out.genericPacks = split.genericPacks;
      }
      return out;
    case "DeclareVariableStatement":
      out.type = "StatDeclareGlobal";
      return out;
    case "DeclareExternTypeStatement":
      out.type = "StatDeclareExternType";
      return out;
    case "IfExpression":
      out.type = "ExprIfElse";
      out.condition = node.clauses && node.clauses[0] ? toOfficialNode(node.clauses[0].condition) : null;
      out.trueExpression = node.clauses && node.clauses[0] ? toOfficialNode(node.clauses[0].value) : null;
      out.falseExpression = toOfficialNode(node.elseValue);
      return out;
    case "InterpolatedString":
      out.type = "ExprInterpString";
      return out;
    default:
      return out;
  }
}

function normalizeOfficialNodeShape(node) {
  if (!isOfficialStyleChunk(node)) {
    throw new Error("Expected a custom Luau Chunk root");
  }
  return toOfficialNode(node);
}

function toLegacyNode(node) {
  if (Array.isArray(node)) {
    return node.map(toLegacyNode);
  }
  if (!isNode(node)) {
    return cloneValue(node);
  }

  const out = {};
  for (const key of Object.keys(node)) {
    if (key === "loc") {
      out.loc = withLegacyLocation(node.loc);
      continue;
    }
    out[key] = toLegacyNode(node[key]);
  }

  switch (node.type) {
    case "Chunk":
      return out;
    case "StatTypeAlias":
      out.type = node.exported ? "ExportTypeStatement" : "TypeAliasStatement";
      out.typeParameters = mergeGenericParameters(node.generics, node.genericPacks);
      out.value = toLegacyType(node.annotation);
      delete out.generics;
      delete out.genericPacks;
      delete out.annotation;
      delete out.exported;
      return out;
    case "StatLocalFunction":
      out.type = "FunctionDeclaration";
      out.isLocal = true;
      out.typeParameters = mergeGenericParameters(node.generics, node.genericPacks);
      delete out.generics;
      delete out.genericPacks;
      return out;
    case "StatFunction":
      out.type = "FunctionDeclaration";
      out.isLocal = false;
      out.typeParameters = mergeGenericParameters(node.generics, node.genericPacks);
      delete out.generics;
      delete out.genericPacks;
      return out;
    case "StatDeclareFunction":
      out.type = "DeclareFunctionStatement";
      out.typeParameters = mergeGenericParameters(node.generics, node.genericPacks);
      delete out.generics;
      delete out.genericPacks;
      return out;
    case "StatDeclareGlobal":
      out.type = "DeclareVariableStatement";
      return out;
    case "StatDeclareExternType":
      out.type = "DeclareExternTypeStatement";
      return out;
    case "ExprIfElse":
      out.type = "IfExpression";
      out.clauses = [
        {
          condition: toLegacyNode(node.condition),
          value: toLegacyNode(node.trueExpression),
        },
      ];
      out.elseValue = toLegacyNode(node.falseExpression);
      delete out.condition;
      delete out.trueExpression;
      delete out.falseExpression;
      return out;
    case "ExprInterpString":
      out.type = "InterpolatedString";
      return out;
    default:
      return out;
  }
}

function withLegacyLocation(loc) {
  if (!loc || typeof loc !== "object") {
    return loc;
  }
  const start = loc.start || loc.begin || null;
  const end = loc.end || null;
  const out = { ...loc };
  if (start) {
    out.start = start;
  }
  if (end) {
    out.end = end;
  }
  delete out.begin;
  return out;
}

function toLegacyType(node) {
  if (Array.isArray(node)) {
    return node.map(toLegacyType);
  }
  if (!isNode(node)) {
    return cloneValue(node);
  }

  const out = {};
  for (const key of Object.keys(node)) {
    if (key === "loc") {
      out.loc = withLegacyLocation(node.loc);
      continue;
    }
    out[key] = toLegacyType(node[key]);
  }

  switch (node.type) {
    case "TypeReference":
      if (node.prefix) {
        const prefix = Array.isArray(node.prefix) ? node.prefix : [node.prefix];
        out.name = [...prefix, node.name];
      } else {
        out.name = Array.isArray(node.name) ? node.name : [node.name];
      }
      if (node.parameters) {
        out.typeArguments = toLegacyType(node.parameters);
      }
      delete out.prefix;
      delete out.parameters;
      return out;
    default:
      return out;
  }
}

function isOfficialStyleChunk(node) {
  return Boolean(
    node &&
    typeof node === "object" &&
    node.type === "Chunk" &&
    Array.isArray(node.body)
  );
}

module.exports = {
  normalizeLegacyNodeShape,
  normalizeOfficialNodeShape,
  isOfficialStyleChunk,
};
