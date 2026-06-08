const { insertAtTop } = require("../../utils/ast");
const { encodeStrings } = require("./encode");
const {
  BASE64_ALPHABET,
  buildHiddenPools,
  buildPoolGroups,
  shiftBase64,
} = require("./pool");
const { buildRuntime } = require("./runtime");

const RUNTIME_ERROR_MESSAGES = [
  "decode unavailable",
  "codec unavailable",
  "stream unavailable",
  "buffer decode failed",
  "text decode failed",
];

function stringEncode(ast, ctx) {
  const { segments, programPathRef } = encodeStrings(ast, ctx);

  if (!programPathRef || !segments.length) {
    return;
  }

  const runtimeNodes = [];
  for (const segment of segments) {
    if (!segment.pool.length || !segment.decoderId || !segment.keyId || !segment.cacheId) {
      continue;
    }

    const { t, rng } = ctx;
    const shiftId = t.identifier(ctx.nameGen.next());
    const orderId = t.identifier(ctx.nameGen.next());
    const groupId = t.identifier(ctx.nameGen.next());
    const indexId = t.identifier(ctx.nameGen.next());
    const rotKeyId = t.identifier(ctx.nameGen.next());
    const alphabetId = t.identifier(ctx.nameGen.next());
    const b64LabelId = t.identifier(ctx.nameGen.next());
    const errId = t.identifier(ctx.nameGen.next());
    const b64Id = t.identifier(ctx.nameGen.next());
    const chachaId = t.identifier(ctx.nameGen.next());
    const u8ToStrId = t.identifier(ctx.nameGen.next());
    const unshiftId = t.identifier(ctx.nameGen.next());
    const poolSelectId = t.identifier(ctx.nameGen.next());
    const getEncodedId = t.identifier(ctx.nameGen.next());
    const valueName = ctx.nameGen.next();
    const bytesName = ctx.nameGen.next();
    const rotKeyLength = rng.int(3, 8);
    const rotKey = Array.from(
      { length: rotKeyLength },
      () => rng.int(1, BASE64_ALPHABET.length - 1)
    );
    const rotOffset = rng.int(0, 1000);
    const shiftedPool = segment.pool.map((value) => shiftBase64(value, rotKey, rotOffset));
    const order = Array.from({ length: segment.pool.length }, (_, i) => i);
    rng.shuffle(order);
    const orderMap = new Array(segment.pool.length);
    for (let i = 0; i < order.length; i += 1) {
      orderMap[order[i]] = i;
    }
    const shuffledPool = order.map((idx) => shiftedPool[idx]);
    const groupCount = Math.min(Math.max(1, segment.pool.length), rng.int(2, 6));
    const { groups, groupMap, indexMap } = buildPoolGroups(
      shuffledPool,
      rng,
      groupCount
    );
    const hiddenPools = buildHiddenPools(groups, rng);
    const poolNames = groups.map(() => t.identifier(ctx.nameGen.next()));
    const runtime = buildRuntime({
      poolNames: poolNames.map((id) => id.name),
      poolMeta: hiddenPools,
      orderName: orderId.name,
      groupName: groupId.name,
      indexName: indexId.name,
      keyName: segment.keyId.name,
      cacheName: segment.cacheId.name,
      decodeName: segment.decoderId.name,
      getEncodedName: getEncodedId.name,
      shiftName: shiftId.name,
      rotKeyName: rotKeyId.name,
      alphabetName: alphabetId.name,
      b64LabelName: b64LabelId.name,
      errName: errId.name,
      rotOffset,
      b64Name: b64Id.name,
      chachaName: chachaId.name,
      u8ToStrName: u8ToStrId.name,
      unshiftName: unshiftId.name,
      poolSelectName: poolSelectId.name,
      order: orderMap,
      groupMap,
      indexMap,
      key: segment.key,
      shift: segment.indexShift,
      rotKey,
      valueName,
      bytesName,
      errMessage: rng.pick(RUNTIME_ERROR_MESSAGES),
    });
    runtimeNodes.push(...runtime);
  }

  if (runtimeNodes.length) {
    insertAtTop(programPathRef, runtimeNodes);
  }
}

module.exports = stringEncode;
