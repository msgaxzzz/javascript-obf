import type { CustomAstTypeMetadata } from "./types";
import type { Chunk } from "./nodes";
import { rootType, nodeTypes, sharedNodeFields } from "./nodes";
import { positionFields, locationFields, sourceLocationFields, baseNodeFields } from "./locations";
import {
  diagnosticFields,
  diagnosticTokenFields,
  fields,
  tokenFields,
} from "./diagnostic-types";
import { normalizeOfficialNodeShape } from "./compat";

export interface ParserConstructor {
  new (source: string): {
    parse(): Chunk;
  };
}

export interface TokenizerConstructor {
  new (source: string): {
    next(): unknown;
    peek(): unknown;
  };
}

export interface PrintOptions {
  sourceMap?: boolean;
  compact?: boolean;
}

export interface SourceMapEntry {
  generatedLine: number;
  generatedColumn: number;
  sourceLine: number;
  sourceColumn: number;
}

export interface PrintedSourceMap {
  code: string;
  mappings: SourceMapEntry[];
}

export type PrintResult = string | PrintedSourceMap;

const parserModule = require("./parser") as {
  parse: (source: string) => Chunk;
  Parser: ParserConstructor;
};
const tokenizerModule = require("./tokenizer") as {
  Tokenizer: TokenizerConstructor;
};
const printerModule = require("./printer") as {
  printChunk: (ast: Chunk, options?: PrintOptions) => PrintResult;
};
const walkModule = require("./walk") as {
  walk: unknown;
};
const traverseModule = require("./traverse") as {
  traverse: unknown;
};
const scopeModule = require("./scope") as {
  buildScope: unknown;
};
const factory = require("./factory") as unknown;
const validateModule = require("./validate") as {
  validate: unknown;
};
const cfgModule = require("./cfg") as {
  buildCFG: unknown;
};
const ssaModule = require("./ssa") as {
  buildSSA: unknown;
};
const irModule = require("./ir") as {
  buildIR: unknown;
  buildIRSSA: unknown;
};
const irPrinterModule = require("./ir-printer") as {
  printIR: unknown;
};
const diagnostics = require("./diagnostics") as unknown;

export const nodes = {
  rootType,
  nodeTypes,
  sharedNodeFields,
};

export const locations = {
  positionFields,
  locationFields,
  sourceLocationFields,
  baseNodeFields,
};

export const diagnosticTypes = {
  diagnosticFields,
  diagnosticTokenFields,
  fields,
  tokenFields,
};

export const types: CustomAstTypeMetadata = {
  nodes,
  locations,
  diagnosticTypes,
};

export function parseLuau(source: string): Chunk {
  return normalizeOfficialNodeShape(parserModule.parse(source));
}

export function generateLuau(ast: Chunk, options?: PrintOptions): PrintResult {
  return printerModule.printChunk(ast, options);
}

export const walk = walkModule.walk;
export const traverse = traverseModule.traverse;
export const buildScope = scopeModule.buildScope;
export const validate = validateModule.validate;
export { factory };
export const buildCFG = cfgModule.buildCFG;
export const buildSSA = ssaModule.buildSSA;
export const buildIR = irModule.buildIR;
export const buildIRSSA = irModule.buildIRSSA;
export const printIR = irPrinterModule.printIR;
export { diagnostics };
export const Parser = parserModule.Parser;
export const Tokenizer = tokenizerModule.Tokenizer;
