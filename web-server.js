const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const API_TARGET_ORIGIN = "https://juicewrldapi.com";
const API_PREFIX = "/api/juicewrld";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function serveStatic(req, res) {
  let requestedPath = req.url === "/" ? "/index.html" : req.url;
  requestedPath = requestedPath.split("?")[0];

  const safePath = path.normalize(requestedPath).replace(/^\.\.(\/|\\|$)/, "");
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

function proxyApi(req, res) {
  const incomingUrl = new URL(req.url, `http://localhost:${PORT}`);
  const targetPath = incomingUrl.pathname.replace(API_PREFIX, "/juicewrld") + incomingUrl.search;

  const proxyRequest = https.request(
    `${API_TARGET_ORIGIN}${targetPath}`,
    {
      method: req.method,
      headers: {
        Accept: req.headers.accept || "*/*",
        "User-Agent": "JuicePlayer-WebApp"
      }
    },
    (proxyResponse) => {
      const headers = {
        ...proxyResponse.headers,
        "access-control-allow-origin": "*"
      };

      res.writeHead(proxyResponse.statusCode || 502, headers);
      proxyResponse.pipe(res);
    }
  );

  proxyRequest.on("error", (error) => {
    sendJson(res, 502, { error: "API proxy request failed", details: String(error.message || error) });
  });

  if (req.method !== "GET" && req.method !== "HEAD") {
    req.pipe(proxyRequest);
  } else {
    proxyRequest.end();
  }
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }

  if (req.url.startsWith(API_PREFIX)) {
    proxyApi(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`JuicePlayer web app running at http://localhost:${PORT}`);
});
