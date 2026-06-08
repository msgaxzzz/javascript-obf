const fs = require("fs");
const path = require("path");
const Module = require("module");

function resolvePrebuiltModulePath(tsPath) {
  if (!tsPath || typeof tsPath !== "string") {
    return null;
  }

  const normalized = path.normalize(tsPath);
  const srcNeedle = `${path.sep}src${path.sep}`;
  const srcIndex = normalized.lastIndexOf(srcNeedle);
  if (srcIndex === -1) {
    return null;
  }

  const rootDir = normalized.slice(0, srcIndex);
  const relativeFromSrc = normalized.slice(srcIndex + srcNeedle.length);
  return path.join(rootDir, "build", "src", relativeFromSrc).replace(/\.ts$/, ".js");
}

function loadPrebuiltModuleIfAvailable(tsPath, parentModule) {
  const builtPath = resolvePrebuiltModulePath(tsPath);
  if (!builtPath || !fs.existsSync(builtPath)) {
    return null;
  }
  try {
    const sourceStat = fs.statSync(tsPath);
    const builtStat = fs.statSync(builtPath);
    if (sourceStat.mtimeMs > builtStat.mtimeMs) {
      return null;
    }
  } catch (_err) {
    return null;
  }

  return require(builtPath);
}

function compileTsModule(tsPath, parentModule) {
  const ts = require("typescript");
  const source = fs.readFileSync(tsPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: tsPath,
  });
  const runtimeModule = new Module(tsPath, parentModule || module);
  runtimeModule.filename = tsPath;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(tsPath));
  runtimeModule._compile(transpiled.outputText, tsPath);
  return runtimeModule.exports;
}

module.exports = {
  resolvePrebuiltModulePath,
  loadPrebuiltModuleIfAvailable,
  compileTsModule,
};
