const optionsImpl = require("./options-impl") as {
  normalizeOptions: (userOptions?: Record<string, unknown>) => NormalizedOptions;
  PRESETS: Record<string, Record<string, unknown>>;
};

export interface NormalizedVmOptions {
  enabled: boolean;
  [key: string]: unknown;
}

export interface NormalizedOptions {
  preset: string;
  scheme: string;
  lang: string;
  luauParser: string;
  filename: string;
  sourceMap: boolean;
  compact: boolean;
  minify: boolean;
  beautify: boolean;
  timing: boolean;
  ecma: number;
  rename: boolean;
  strings: boolean;
  cff: boolean;
  dead: boolean;
  vm: NormalizedVmOptions;
  renameOptions: {
    reserved: string[];
    [key: string]: unknown;
  };
  stringsOptions: Record<string, unknown>;
  cffOptions: Record<string, unknown>;
  deadCodeOptions: Record<string, unknown>;
  wrapOptions: Record<string, unknown>;
  numbersOptions: Record<string, unknown>;
  constArrayOptions: Record<string, unknown>;
  padFooterOptions: Record<string, unknown>;
  antiHook?: Record<string, unknown>;
  [key: string]: unknown;
}

export const normalizeOptions = optionsImpl.normalizeOptions;
export const PRESETS = optionsImpl.PRESETS;
