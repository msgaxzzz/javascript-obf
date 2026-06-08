const { encodeString } = require("../../utils/string");

const DECOY_WORDS = [
  "state",
  "slot",
  "page",
  "delta",
  "cursor",
  "frame",
  "trace",
  "chunk",
  "node",
  "edge",
  "queue",
  "token",
];

function buildDecoyString(rng) {
  const parts = [];
  const count = rng.int(3, 6);
  for (let i = 0; i < count; i += 1) {
    const word = rng.pick(DECOY_WORDS);
    const value = rng.int(16, 0xffff).toString(36);
    parts.push(`${word}_${value}`);
  }
  return parts.join(".");
}

function isDirectiveLiteral(path) {
  return (
    path.parentPath &&
    path.parentPath.isExpressionStatement() &&
    Boolean(path.parentPath.node.directive)
  );
}

function isModuleString(path) {
  return (
    path.parentPath &&
    (path.parentPath.isImportDeclaration() ||
      path.parentPath.isExportAllDeclaration() ||
      path.parentPath.isExportNamedDeclaration()) &&
    path.parentPath.node.source === path.node
  );
}

function encodeStrings(ast, ctx) {
  const { traverse, t, options, rng } = ctx;
  const minLength = options.stringsOptions.minLength;
  const maxCount = options.stringsOptions.maxCount;
  const segmentSize = options.stringsOptions.segmentSize ?? maxCount;
  const sampleRate = options.stringsOptions.sampleRate ?? 1;

  const segments = [];
  const encodedMap = new Map();
  const decisionMap = new Map();
  let totalCount = 0;
  let programPathRef = null;

  function createSegment() {
    // Increased key length: 24-32 bytes (192-256 bits)
    const keyLength = rng.int(24, 32);
    const key = Array.from({ length: keyLength }, () => rng.int(0, 255));
    const indexShift = rng.int(40, 900);
    const segment = {
      pool: [],
      indexMap: new Map(),
      key,
      indexShift,
      decoderId: null,
      keyId: null,
      cacheId: null,
    };
    segments.push(segment);
    return segment;
  }

  let currentSegment = createSegment();

  function ensureIds(segment) {
    if (!segment.decoderId) {
      segment.decoderId = t.identifier(ctx.nameGen.next());
      segment.keyId = t.identifier(ctx.nameGen.next());
      segment.cacheId = t.identifier(ctx.nameGen.next());
    }
  }

  function encodeStringValue(value) {
    if (typeof value !== "string") {
      return { node: t.stringLiteral(String(value)), encoded: false };
    }
    if (value.length < minLength) {
      return { node: t.stringLiteral(value), encoded: false };
    }

    const existing = encodedMap.get(value);
    if (existing) {
      return {
        node: t.callExpression(existing.segment.decoderId, [
          t.numericLiteral(existing.index + existing.segment.indexShift),
        ]),
        encoded: true,
      };
    }

    if (totalCount >= maxCount) {
      return { node: t.stringLiteral(value), encoded: false };
    }

    const decision = decisionMap.get(value);
    if (decision === false) {
      return { node: t.stringLiteral(value), encoded: false };
    }
    if (decision === undefined && sampleRate < 1 && !rng.bool(sampleRate)) {
      decisionMap.set(value, false);
      return { node: t.stringLiteral(value), encoded: false };
    }
    decisionMap.set(value, true);

    if (currentSegment.pool.length >= segmentSize) {
      if (totalCount >= maxCount) {
        return { node: t.stringLiteral(value), encoded: false };
      }
      currentSegment = createSegment();
    }

    ensureIds(currentSegment);

    let index = currentSegment.indexMap.get(value);
    if (index === undefined) {
      index = currentSegment.pool.length;
      currentSegment.pool.push(encodeString(value, currentSegment.key));
      currentSegment.indexMap.set(value, index);
      totalCount += 1;
    }
    encodedMap.set(value, { segment: currentSegment, index });

    return {
      node: t.callExpression(currentSegment.decoderId, [
        t.numericLiteral(index + currentSegment.indexShift),
      ]),
      encoded: true,
    };
  }

  traverse(ast, {
    Program(path) {
      programPathRef = path;
    },
    StringLiteral(path) {
      if (!programPathRef) {
        return;
      }
      if (isDirectiveLiteral(path) || isModuleString(path)) {
        return;
      }
      const parentPath = path.parentPath;
      const isJsxAttrValue =
        parentPath &&
        parentPath.isJSXAttribute() &&
        parentPath.node.value === path.node;
      const isObjectKey =
        parentPath &&
        (parentPath.isObjectProperty() || parentPath.isObjectMethod()) &&
        path.parentKey === "key";
      const isObjectLiteralKey =
        isObjectKey &&
        parentPath.parentPath &&
        parentPath.parentPath.isObjectExpression();
      if (isJsxAttrValue && options.stringsOptions.encodeJSXAttributes === false) {
        return;
      }
      const value = path.node.value;
      if (
        isObjectKey &&
        (!isObjectLiteralKey ||
          value === "__proto__" ||
          parentPath.node.computed ||
          options.stringsOptions.encodeObjectKeys === false)
      ) {
        return;
      }
      const decoded = encodeStringValue(value);
      if (!decoded.encoded) {
        return;
      }
      if (isJsxAttrValue) {
        parentPath.node.value = t.jsxExpressionContainer(decoded.node);
        return;
      }
      if (isObjectKey && isObjectLiteralKey) {
        parentPath.node.key = decoded.node;
        parentPath.node.computed = true;
        return;
      }
      path.replaceWith(decoded.node);
    },
    TemplateLiteral(path) {
      if (path.parentPath && path.parentPath.isTaggedTemplateExpression()) {
        return;
      }
      if (!programPathRef) {
        return;
      }
      if (path.node.expressions.length > 0) {
        if (options.stringsOptions.encodeTemplateChunks === false) {
          return;
        }
        const parts = [];
        let encodedAny = false;
        for (let i = 0; i < path.node.quasis.length; i += 1) {
          const quasi = path.node.quasis[i];
          const value = quasi.value.cooked || "";
          const encoded = encodeStringValue(value);
          parts.push(encoded.node);
          if (encoded.encoded) {
            encodedAny = true;
          }
          if (i < path.node.expressions.length) {
            parts.push(path.node.expressions[i]);
          }
        }
        if (!encodedAny) {
          return;
        }
        let expr = parts[0];
        for (let i = 1; i < parts.length; i += 1) {
          expr = t.binaryExpression("+", expr, parts[i]);
        }
        path.replaceWith(expr);
        return;
      }
      const value = path.node.quasis[0].value.cooked || "";
      const decoded = encodeStringValue(value);
      if (!decoded.encoded) {
        return;
      }
      path.replaceWith(decoded.node);
    },
  });

  function forceInjectBait() {
    if (currentSegment.pool.length >= segmentSize) {
      currentSegment = createSegment();
    }
    ensureIds(currentSegment);
    currentSegment.pool.push(encodeString(buildDecoyString(rng), currentSegment.key));
  }

  forceInjectBait();

  return {
    segments,
    programPathRef,
  };
}

module.exports = {
  encodeStrings,
};
