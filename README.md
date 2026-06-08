# js-obf

A modular JavaScript and Luau obfuscation CLI with control-flow flattening (CFF) and optional VM virtualization.

## Features
- CLI input/output for JavaScript and Luau projects (including a dedicated `luau-obf` wrapper)
- AST-level obfuscation: identifier renaming, string encryption, dead-code injection, control-flow flattening
- JavaScript output minified via Terser (disable with `--no-minify`)
- Optional VM virtualization (both JS + Luau, with Luau VM-CFF support)
- Optional anti-hook runtime guard
- VM opcode randomization, fake opcode insertion, runtime bytecode keying/splitting, and const pool decoding
- Luau-specific options: member/key encoding, string splitting, global masking, globals/members rename, homoglyph rename mode
- Modular plugin architecture for easy extension

## Install
```
npm install
```

## Usage
```
node bin/js-obf input.js -o output.js --preset high --vm --seed my-seed
```

Supports stdin (use `-` as input):
```
cat input.js | node bin/js-obf - -o output.js
```

Luau (two options):
```
node bin/js-obf input.lua --lang luau -o output.obf.lua
```
or
```
node bin/luau-obf input.lua -o output.obf.lua
```

### Interactive script
Use the interactive script to choose features and specify input file/directory and output directory:
```
bash bin/obf.sh
```
If an input directory is provided, it will recursively obfuscate all `.js` files and overwrite them, automatically ignoring `node_modules` (also tolerates common misspellings of that directory name).
When string encryption is enabled, the script also prompts whether to skip encoding object literal keys, JSX attribute string values, or template literal static chunks.

## Web UI
Start the local web console (default port `6589`):
```
node webstart.js
```
Then open `http://localhost:6589` to upload or paste JavaScript/Luau, pick options, run obfuscation, and download results.

### Run obfuscation on Appwrite backend
By default, `webstart.js` obfuscates locally through the CLI.  
To run obfuscation on Appwrite Functions instead, deploy this function entrypoint:

- Runtime: Node.js
- Entrypoint: `appwrite/functions/obfuscate/main.js`
- Source root: repository root (so `src/` is included)

Create a `.env` file before starting the web UI (you can copy `.env.example`):
```
APPWRITE_ENDPOINT="https://<region>.cloud.appwrite.io/v1"
APPWRITE_PROJECT_ID="<your_project_id>"
APPWRITE_OBF_FUNCTION_ID="<your_function_id>"
APPWRITE_API_KEY="<optional_api_key>"
```
Then start:
```
node webstart.js
```

Notes:
- `APPWRITE_ENDPOINT` and `APPWRITE_PROJECT_ID` are required for Appwrite requests.
- `APPWRITE_OBF_FUNCTION_ID` enables remote obfuscation mode.
- `APPWRITE_API_KEY` is optional if your function execution permissions allow unauthenticated calls.
- The server still runs locally, but `/api/obfuscate` forwards execution to your Appwrite Function.

### GitHub Actions
If you run this project in GitHub Actions, configure repository secrets:

- `APPWRITE_ENDPOINT`
- `APPWRITE_PROJECT_ID`
- `APPWRITE_OBF_FUNCTION_ID`
- `APPWRITE_API_KEY` (optional)

The default workflow (`.github/workflows/node.js.yml`) reads these secrets into CI environment variables.
It also installs the latest official Luau CLI for Linux from `luau-lang/luau` and runs the JavaScript obfuscation smoke test plus the Luau custom-scope, classic-CFF, VM, and roundtrip regression suites.

## CLI options
- `-o, --output <file>` Output file
- `--preset <high|balanced|low>` Preset strength (default `high`)
- `--scheme <classic|stealth|runtime>` JavaScript scheme (default `classic`): `classic` preserves current defaults, `stealth` reduces fixed output traits and varies string/runtime layout, `runtime` enables JS VM defaults unless VM is explicitly configured
- `--no-rename` Disable variable renaming
- `--rename-globals` Rename global bindings (Luau)
- `--rename-members` Rename member/table keys (Luau)
- `--rename-homoglyphs` Use l/I/1 homoglyph alphabet (Luau)
- `--mask-globals` Mask global reads via `_ENV` (Luau)
- `--no-mask-globals` Skip masking global reads
- `--no-strings` Disable string encryption
- `--strings-split` Split long strings into fragments (Luau)
- `--strings-split-min <n>` Minimum length to split (Luau)
- `--strings-split-max-parts <n>` Maximum fragments (Luau)
- `--strings-segment-size <n>` Max entries per Luau string pool (default 120)
- `--const-array` Extract constants into a table (Luau)
- `--no-const-array` Disable constant extraction (Luau)
- `--const-array-threshold <0-1>` Constant extraction probability (Luau)
- `--const-array-strings-only` Extract strings only (Luau)
- `--no-const-array-strings-only` Include numbers/booleans (Luau)
- `--const-array-shuffle` Shuffle constant table (default on)
- `--no-const-array-shuffle` Disable constant shuffle
- `--const-array-rotate` Rotate constant table (default on)
- `--no-const-array-rotate` Disable constant rotate
- `--const-array-encoding <none|base64>` Encode string constants (Luau)
- `--const-array-wrapper` Wrap indices with offset indirection (default on)
- `--no-const-array-wrapper` Disable wrapper indirection
- `--numbers-expr` Convert numeric literals to expressions (Luau)
- `--no-numbers-expr` Disable numeric expression conversion (Luau)
- `--numbers-expr-threshold <0-1>` Numeric conversion probability (Luau)
- `--numbers-expr-inner <0-1>` Nested conversion probability (Luau)
- `--numbers-expr-max-depth <n>` Max nested depth (Luau)
- `--no-strings-object-keys` Skip encoding object literal keys
- `--strings-object-keys` Force encoding object literal keys
- `--no-strings-jsx-attrs` Skip encoding JSX attribute string values
- `--strings-jsx-attrs` Force encoding JSX attribute string values
- `--no-strings-template-chunks` Skip encoding template literal static chunks
- `--strings-template-chunks` Force encoding template literal static chunks
- `--wrap` Wrap chunk in a function (Luau)
- `--wrap-iterations <n>` Wrap iterations (Luau, default 1)
- `--proxify-locals` Proxy locals via table indirection (Luau)
- `--no-proxify-locals` Disable proxy locals (Luau)
- `--pad-footer` Append fake Luau blocks after real code (Luau)
- `--no-pad-footer` Disable footer padding
- `--pad-footer-blocks <n>` Number of fake blocks (Luau, default 2)
- `--no-cff` Disable control-flow flattening
- `--cff-downlevel` Allow CFF to downlevel `let/const` to `var`
- `--cff-mode <vm|classic|woven>` Luau CFF mode (default `classic`; `woven` uses nested/range-dispatch flow for broader statement coverage and short generated CFF names)
- `--cff-opaque` Enable opaque predicates (default on)
- `--cff-hide-top-return-expr` Hide simple top-level return call targets with local table indirection (Luau woven CFF, opt-in)
- `--no-dead` Disable dead-code injection
- `--vm` Enable VM virtualization (see limitations)
- `--vm-layers <n>` VM layers (Luau)
- `--vm-top-level` Virtualize Luau top-level chunk
- `--no-vm-top-level` Disable Luau top-level chunk virtualization (default)
- `--vm-include name1,name2` Only virtualize the specified function names
- `--vm-opcode-shuffle` Enable VM opcode random mapping (default on)
- `--no-vm-opcode-shuffle` Disable VM opcode random mapping
- `--vm-fake-opcodes <0-1>` Fake opcode injection probability (default 0.15)
- `--vm-bytecode` Enable VM bytecode runtime decryption (default on)
- `--no-vm-bytecode` Disable VM bytecode runtime decryption
- `--vm-consts` Enable VM const pool runtime decryption (default on)
- `--no-vm-consts` Disable VM const pool runtime decryption
- `--vm-consts-encoding <table|string>` VM const pool storage (default `table`)
- `--vm-consts-split` Split VM const pool into parts (default on)
- `--no-vm-consts-split` Disable VM const pool splitting
- `--vm-consts-split-size <n>` Approximate const chunk size (default 24)
- `--vm-runtime-key` Luau VM runtime key (default on)
- `--vm-runtime-split` Luau VM runtime split (default on)
- `--vm-block-dispatch` Use block-dispatch VM (Luau)
- `--vm-downlevel` Allow VM to downlevel `let/const` to `var`
- `--vm-debug` Log Luau VM compile failures
- `--anti-hook` Enable anti-hook runtime guard
- `--anti-hook-lock` Enable anti-hook and freeze built-in prototype chains
- `--seed <value>` PRNG seed
- `--ecma <version>` Terser output ECMAScript version (default 2020)
- `--sourcemap` Emit source map
- `--compact` Compact output (JS) / one-line Luau output
- `--no-minify` Skip Terser minification
- `--beautify` Beautify Terser output (multi-line, requires minify)
- `--timing` Print per-plugin timings (ms precision, default off) to stderr
- `--no-timing` Disable per-plugin timings
- `--lang <js|luau>` Select language (default `js`, inferred from `.lua/.luau`)
- `--luau-style <default>` Luau wrapper style (default only)

Luau parsing always uses the custom AST backend.

Default output is ES2020 to support optional chaining/nullish coalescing. For older targets, set `--ecma 2015` or `--ecma 5`.

## VM virtualization coverage
VM supports most common syntax while keeping performance and memory overhead reasonable:
- Control flow: `if/else`, `for/while/do-while`, `switch`, `break/continue`
- Exceptions: `try/catch/finally` (supports `throw`)
- `async/await` (only inside `async` functions)
- Variables: `var` (`let/const` are skipped by default; use `--vm-downlevel` to force)
- Parameters: defaults, rest params, parameter destructuring (object/array)
- Expressions: literals, member access, optional chaining/nullish coalescing, function calls, object/array literals (including spread), `new`, template strings, etc.

### VM limitations
- Generator function bodies are not virtualized (functions containing `yield` are skipped, but you can declare generators inside normal functions)
- Destructuring assignment expressions are not supported (only parameter/variable declaration destructuring)
- Complex or unsupported nodes are skipped for that function
- VM uses the `Function` constructor to create closures; CSP-restricted environments may not run

## Luau VM coverage
Luau VM targets common Luau syntax and will skip functions containing unsupported nodes:
- Statements: local/assignment, call, return, if/else, while/repeat, numeric and generic `for`, do-blocks, break/continue
- Expressions: literals, unary/binary, member/index, calls/method calls, tables, if-expr, type assertion, interpolated strings
- Skips: `goto/label`, vararg functions, most nested functions
- Nested callback lift: simple zero-arg anonymous callbacks used as first call argument (for example `task.spawn(function() ... end)`) are lifted and can be virtualized in the host function
- Top-level chunk virtualization is opt-in via `--vm-top-level`; unsupported top-level constructs are skipped automatically and leading function prelude is preserved

## Structure
- `src/index.js`: core API
- `src/pipeline.js`: plugin pipeline
- `src/luau/*`: Luau parser + obfuscation plugins
- `src/plugins/*`: obfuscation plugins
- `src/utils/*`: utilities and RNG
- `bin/js-obf`: CLI entry
- `bin/luau-obf`: Luau CLI wrapper

## License
MIT License. See `LICENSE`.

## Third-Party Notices
Some dependencies require preserving author and license notices. See `THIRD_PARTY_NOTICES.md`.
