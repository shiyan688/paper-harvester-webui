const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { searchPapers } = require("./src/search");

const PORT = Number(process.env.PORT || 3005);
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": MIME_TYPES[".json"] });
  res.end(JSON.stringify(payload, null, 2));
}

function sendStreamHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
}

function writeStreamEvent(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "File not found." });
      return;
    }

    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;

      if (size > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function resolveStaticPath(requestPath) {
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const safePath = path.normalize(normalized).replace(/^(\.\.[/\\])+/, "");
  return path.join(PUBLIC_DIR, safePath);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, service: "paper-harvest-webui" });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/search") {
    try {
      const rawBody = await collectBody(req);
      const payload = rawBody ? JSON.parse(rawBody) : {};
      const results = await searchPapers(payload);
      sendJson(res, 200, results);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      sendJson(res, statusCode, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/search/stream") {
    let streamClosed = false;

    res.on("close", () => {
      streamClosed = true;
    });

    try {
      const rawBody = await collectBody(req);
      const payload = rawBody ? JSON.parse(rawBody) : {};

      sendStreamHeaders(res);

      const results = await searchPapers(payload, {
        onEvent: async (event) => {
          if (!streamClosed) {
            writeStreamEvent(res, event);
          }
        }
      });

      if (!streamClosed) {
        writeStreamEvent(res, { type: "done", data: results });
      }
    } catch (error) {
      if (!res.headersSent) {
        const statusCode = error.statusCode || 500;
        sendJson(res, statusCode, { error: error.message || "Unexpected server error." });
        return;
      }

      if (!streamClosed) {
        writeStreamEvent(res, {
          type: "error",
          error: error.message || "Unexpected server error."
        });
      }
    } finally {
      if (!streamClosed) {
        res.end();
      }
    }

    return;
  }

  if (req.method === "GET") {
    const filePath = resolveStaticPath(requestUrl.pathname);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendJson(res, 403, { error: "Forbidden." });
      return;
    }

    sendFile(res, filePath);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
});

server.listen(PORT, () => {
  console.log(`Paper Harvest WebUI running at http://localhost:${PORT}`);
});
