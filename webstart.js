const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const {
  pingAppwrite,
  isRemoteObfuscationEnabled,
  obfuscateViaAppwrite,
} = require("./src/lib/appwrite");
const { buildCliArgs } = require("./src/lib/web-cli-args");

const WEB_DIR = path.join(__dirname, "web");
const PORT = Number(process.env.PORT) || 6589;
const MAX_BODY_SIZE = 5 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function safePath(requestPath) {
  const normalized = path.normalize(requestPath).replace(/^([\/\\])+/, "");
  const fullPath = path.join(WEB_DIR, normalized);
  const base = WEB_DIR.endsWith(path.sep) ? WEB_DIR : WEB_DIR + path.sep;
  if (fullPath !== WEB_DIR && !fullPath.startsWith(base)) {
    return null;
  }
  return fullPath;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_SIZE) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

async function handleObfuscate(req, res) {
  try {
    const body = await readJson(req);
    const source = body.source || body.code || "";

    if (!source.trim()) {
      sendJson(res, 400, { error: "No source code provided." });
      return;
    }

    const filename = body.filename || "input.js";
    const options = body.options || {};
    const payload = { source, filename, options };

    const result = isRemoteObfuscationEnabled()
      ? await obfuscateViaAppwrite(payload)
      : await runCliObfuscate(source, filename, options);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Obfuscation failed." });
  }
}

function safeFilename(name) {
  const base = path.basename(name || "input.js");
  return base || "input.js";
}

async function runCliObfuscate(source, filename, options) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "js-obf-"));
  const safeName = safeFilename(filename);
  const inputPath = path.join(tempDir, safeName);
  const ext = path.extname(safeName);
  const inferredLang =
    ext === ".lua" || ext === ".luau" ? "luau" : "js";
  const lang = options.lang || inferredLang;
  const outputExt = lang === "luau"
    ? (ext === ".lua" || ext === ".luau" ? ext : ".lua")
    : ".js";
  const outputPath = path.join(
    tempDir,
    `${path.basename(safeName, path.extname(safeName))}.obf${outputExt}`
  );

  fs.writeFileSync(inputPath, source, "utf8");

  const args = ["bin/js-obf", inputPath, "-o", outputPath, ...buildCliArgs(options)];

  try {
    const { stdout, stderr, code } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: __dirname,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutData = "";
      let stderrData = "";

      child.stdout.on("data", (chunk) => {
        stdoutData += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderrData += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({ stdout: stdoutData, stderr: stderrData, code: exitCode });
      });
    });

    if (code !== 0) {
      throw new Error((stderr || stdout || "").trim() || "Obfuscation failed.");
    }

    const result = {
      code: fs.readFileSync(outputPath, "utf8"),
      map: null,
    };
    const mapPath = `${outputPath}.map`;
    if (fs.existsSync(mapPath)) {
      try {
        result.map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
      } catch {
        result.map = null;
      }
    }

    return result;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const fullPath = safePath(requestPath);

  if (!fullPath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/api/obfuscate")) {
    handleObfuscate(req, res);
    return;
  }

  if (req.method === "GET") {
    handleStatic(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`JS Obfuscator web UI running at http://localhost:${PORT}`);
  if (isRemoteObfuscationEnabled()) {
    console.log("Obfuscation backend: Appwrite Function");
  } else {
    console.log("Obfuscation backend: Local CLI");
  }
  if (isRemoteObfuscationEnabled()) {
    Promise.resolve()
      .then(() => pingAppwrite())
      .then(() => {
        console.log("Appwrite ping successful.");
      })
      .catch((error) => {
        console.warn(`Appwrite ping failed: ${error.message}`);
      });
  }
});
