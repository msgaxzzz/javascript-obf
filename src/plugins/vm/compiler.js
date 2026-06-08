const { OPCODES } = require("./constants");

function createLabel() {
  return { position: null, patches: [] };
}

class VmCompiler {
  constructor(ctx, locals, opcodeMapping) {
    this.ctx = ctx;
    this.locals = locals;
    this.code = [];
    this.consts = [];
    this.constMap = new Map();
    this.tempIndex = 0;
    this.rng = ctx.rng;
    this.opcodeEncode = opcodeMapping.encode;
    this.opcodeMask = opcodeMapping.mask || 0;
    const fakeOpcodes = ctx.options.vm.fakeOpcodes;
    this.fakeOpcodeProbability =
      typeof fakeOpcodes === "number" ? fakeOpcodes : 0;
    this.fakeOpcodeKinds = [
      OPCODES.FAKE_ADD,
      OPCODES.FAKE_POP_PUSH,
      OPCODES.FAKE_JMP,
    ];
  }

  addConst(value) {
    const key = `${typeof value}:${String(value)}`;
    if (this.constMap.has(key)) {
      return this.constMap.get(key);
    }
    const index = this.consts.length;
    this.consts.push(value);
    this.constMap.set(key, index);
    return index;
  }

  emitRaw(op, ...args) {
    this.code.push(this.opcodeEncode[op] ^ this.opcodeMask, ...args);
  }

  emit(op, ...args) {
    this.emitRaw(op, ...args);
    this.maybeEmitFake();
  }

  emitJump(op, label) {
    this.emitRaw(op);
    const idx = this.code.length;
    this.code.push(0);
    if (label.position !== null) {
      this.code[idx] = label.position;
    } else {
      label.patches.push(idx);
    }
    this.maybeEmitFake();
  }

  emitTry(catchLabel, finallyLabel, endLabel) {
    this.emitRaw(OPCODES.TRY);
    const catchIdx = this.code.length;
    this.code.push(0);
    const finallyIdx = this.code.length;
    this.code.push(0);
    const endIdx = this.code.length;
    this.code.push(0);
    if (catchLabel) catchLabel.patches.push(catchIdx);
    else this.code[catchIdx] = -1;
    if (finallyLabel) finallyLabel.patches.push(finallyIdx);
    else this.code[finallyIdx] = -1;
    if (endLabel) endLabel.patches.push(endIdx);
    this.maybeEmitFake();
  }

  maybeEmitFake() {
    if (this.fakeOpcodeProbability <= 0) {
      return;
    }
    if (!this.rng.bool(this.fakeOpcodeProbability)) {
      return;
    }
    this.emitFakeOpcode();
  }

  emitFakeOpcode() {
    const opcode = this.rng.pick(this.fakeOpcodeKinds);
    if (opcode === OPCODES.FAKE_JMP) {
      const target = this.rng.int(0, this.code.length);
      this.emitRaw(OPCODES.FAKE_JMP, target);
      return;
    }
    this.emitRaw(opcode);
  }

  mark(label) {
    label.position = this.code.length;
    for (const idx of label.patches) {
      this.code[idx] = label.position;
    }
  }

  createTempName() {
    let name = this.ctx.nameGen.next();
    while (this.locals.has(name)) {
      name = this.ctx.nameGen.next();
    }
    this.tempIndex += 1;
    this.locals.add(name);
    return name;
  }
}

module.exports = { createLabel, VmCompiler };
