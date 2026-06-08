import type { Chunk } from "./custom/nodes";

export interface RenameOptions {
  renameOptions: {
    reserved?: string[];
    renameGlobals?: boolean;
    renameMembers?: boolean;
    homoglyphs?: boolean;
    preserveTopReturnNames?: boolean;
  };
}

export interface RenameRng {
  int(min: number, max: number): number;
  shuffle<T>(items: T[]): T[];
}

export interface RenameContext {
  options: RenameOptions;
  rng: RenameRng;
  getSSA?: () => unknown;
  constructorMemberHints?: Map<string, Set<string>>;
  dynamicIndexBaseNames?: Set<string>;
  dynamicIndexRecordBaseNames?: Set<string>;
  dynamicIndexRecordBaseMemberNames?: Set<string>;
  dynamicIndexRecordMemberNames?: Set<string>;
  dynamicIndexMemberNames?: Set<string>;
  externalSchemaLocalNames?: Set<string>;
  safeFunctionParameterHints?: Map<string, Set<number>>;
  debugTrace?: (event: unknown) => void;
}

const renameImpl = require("./rename-impl") as {
  collectConstructorMemberHints: (ast: Chunk) => Map<string, Set<string>>;
  collectDynamicIndexBaseNames: (ast: Chunk) => Set<string>;
  collectDynamicIndexRecordBaseNames: (ast: Chunk) => Set<string>;
  collectDynamicIndexRecordBaseMemberNames: (ast: Chunk) => Set<string>;
  collectDynamicIndexRecordMemberNames: (ast: Chunk) => Set<string>;
  collectDynamicIndexMemberNames: (ast: Chunk) => Set<string>;
  collectExternalSchemaLocalNames: (ast: Chunk) => Set<string>;
  collectSafeFunctionParameterHints: (ast: Chunk) => Map<string, Set<number>>;
  renameLuau: (ast: Chunk, ctx: RenameContext) => void;
};

export const collectConstructorMemberHints = renameImpl.collectConstructorMemberHints;
export const collectDynamicIndexBaseNames = renameImpl.collectDynamicIndexBaseNames;
export const collectDynamicIndexRecordBaseNames = renameImpl.collectDynamicIndexRecordBaseNames;
export const collectDynamicIndexRecordBaseMemberNames = renameImpl.collectDynamicIndexRecordBaseMemberNames;
export const collectDynamicIndexRecordMemberNames = renameImpl.collectDynamicIndexRecordMemberNames;
export const collectDynamicIndexMemberNames = renameImpl.collectDynamicIndexMemberNames;
export const collectExternalSchemaLocalNames = renameImpl.collectExternalSchemaLocalNames;
export const collectSafeFunctionParameterHints = renameImpl.collectSafeFunctionParameterHints;

export function renameLuau(ast: Chunk, ctx: RenameContext): void {
  renameImpl.renameLuau(ast, ctx);
}
