const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
require("dotenv").config();

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const API_TARGET_ORIGIN = "https://juicewrldapi.com";
const API_PREFIX = "/api/juicewrld";
const LASTFM_PREFIX = "/auth/lastfm";
const LASTFM_API_ORIGIN = "https://ws.audioscrobbler.com";
const LASTFM_AUTH_ORIGIN = "https://www.last.fm";
const LASTFM_API_KEY = process.env.LASTFM_API_KEY || "";
const LASTFM_API_SECRET = process.env.LASTFM_API_SECRET || "";
const SESSION_COOKIE = "juiceplayer_sid";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const AUTH_CODE_TTL_MS = 1000 * 60 * 5;
const FLOW_RESULT_TTL_MS = 1000 * 60 * 10;
const LOGIN_TOKEN_TTL_MS = 1000 * 60 * 15;
const LATEST_FLOW_KEY = "__latest__";

const sessionStore = new Map();
const authCodeStore = new Map();
const flowResultStore = new Map();
const loginTokenStore = new Map();

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

function sendJsonNoStore(res, statusCode, payload) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  sendJson(res, statusCode, payload);
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").reduce((acc, part) => {
    const [name, ...rest] = part.trim().split("=");
    if (!name) {
      return acc;
    }
    acc[name] = decodeURIComponent(rest.join("=") || "");
    return acc;
  }, {});
}

function createSession(res, data) {
  const sid = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;

  sessionStore.set(sid, {
    ...data,
    expiresAt
  });

  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearSession(req, res) {
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE];
  if (sid) {
    sessionStore.delete(sid);
  }

  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) {
    return null;
  }

  const session = sessionStore.get(sid);
  if (!session) {
    return null;
  }

  if (!session.expiresAt || session.expiresAt <= Date.now()) {
    sessionStore.delete(sid);
    return null;
  }

  return session;
}

function createAuthCode(data) {
  const code = crypto.randomUUID();
  authCodeStore.set(code, {
    ...data,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS
  });
  return code;
}

function createLoginFlow(token) {
  const flowId = crypto.randomUUID();
  loginTokenStore.set(flowId, {
    token,
    expiresAt: Date.now() + LOGIN_TOKEN_TTL_MS
  });
  return flowId;
}

function getLoginFlowToken(flowId) {
  if (!flowId) {
    return null;
  }

  const entry = loginTokenStore.get(flowId);
  if (!entry) {
    return null;
  }

  if (!entry.expiresAt || entry.expiresAt <= Date.now()) {
    loginTokenStore.delete(flowId);
    return null;
  }

  return entry.token;
}

function clearLoginFlow(flowId) {
  if (!flowId) {
    return;
  }

  loginTokenStore.delete(flowId);
}

function consumeAuthCode(code) {
  const entry = authCodeStore.get(code);
  if (!entry) {
    return null;
  }

  authCodeStore.delete(code);
  if (!entry.expiresAt || entry.expiresAt <= Date.now()) {
    return null;
  }

  return entry;
}

function setFlowResult(flowId, result) {
  const entry = {
    ...result,
    expiresAt: Date.now() + FLOW_RESULT_TTL_MS
  };

  flowResultStore.set(LATEST_FLOW_KEY, entry);

  if (!flowId) {
    return;
  }

  flowResultStore.set(flowId, entry);
}

function getFlowResult(flowId) {
  const key = flowId || LATEST_FLOW_KEY;
  const entry = flowResultStore.get(key);
  if (!entry) {
    return null;
  }

  if (!entry.expiresAt || entry.expiresAt <= Date.now()) {
    flowResultStore.delete(key);
    return null;
  }

  return entry;
}

function lastFmConfigured() {
  return Boolean(LASTFM_API_KEY && LASTFM_API_SECRET);
}

function buildApiSig(params) {
  const keys = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && key !== "format" && key !== "callback")
    .sort();

  const base = keys.map((key) => `${key}${params[key]}`).join("") + LASTFM_API_SECRET;
  return crypto.createHash("md5").update(base).digest("hex");
}

function lastFmRequest(method, params = {}) {
  const allParams = {
    method,
    api_key: LASTFM_API_KEY,
    ...params,
    format: "json"
  };

  allParams.api_sig = buildApiSig(allParams);

  const body = new URLSearchParams(allParams).toString();

  return new Promise((resolve, reject) => {
    const request = https.request(
      `${LASTFM_API_ORIGIN}/2.0/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Accept: "application/json",
          "User-Agent": "JuicePlayer-WebApp"
        }
      },
      (response) => {
        let responseBody = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });

        response.on("end", () => {
          let data = {};
          try {
            data = responseBody ? JSON.parse(responseBody) : {};
          } catch (error) {
            reject(new Error(`Invalid Last.fm response: ${error.message}`));
            return;
          }

          if (data?.error) {
            const apiError = new Error(data.message || "Last.fm API error");
            apiError.lastFmCode = data.error;
            reject(apiError);
            return;
          }

          if ((response.statusCode || 500) >= 400) {
            reject(new Error(`Last.fm request failed with status ${response.statusCode}`));
            return;
          }

          resolve(data);
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;

      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function getRequestOrigin(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function sendLastFmPopupResult(res, requestOrigin, payload) {
  const jsonPayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Last.fm Authorization</title>
</head>
<body>
  <p>Authorization complete. You can close this tab.</p>
  <script>
    (function () {
      var payload = ${jsonPayload};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, ${JSON.stringify(requestOrigin)});
        }
      } catch (err) {
        // ignore cross-window messaging issues
      }
      window.close();
      setTimeout(function () {
        window.location.replace('/');
      }, 700);
    })();
  </script>
</body>
</html>`;

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache"
  });
  res.end(html);
}

async function handleLastFm(req, res) {
  const incomingUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = incomingUrl.pathname;
  const requestOrigin = getRequestOrigin(req);
  const isPopupFlow = incomingUrl.searchParams.get("popup") === "1";
  const flowId = incomingUrl.searchParams.get("flow_id") || "";

  if (pathname === `${LASTFM_PREFIX}/status`) {
    const session = getSession(req);
    sendJsonNoStore(res, 200, {
      enabled: lastFmConfigured(),
      authenticated: Boolean(session?.sessionKey),
      username: session?.username || null
    });
    return;
  }

  if (pathname === `${LASTFM_PREFIX}/flow-status`) {
    const flowResult = getFlowResult(flowId);
    if (!flowResult) {
      const pendingToken = getLoginFlowToken(flowId);
      if (!pendingToken) {
        sendJsonNoStore(res, 200, { status: "pending" });
        return;
      }

      try {
        const sessionResponse = await lastFmRequest("auth.getSession", { token: pendingToken });
        const session = sessionResponse?.session;

        if (!session?.key || !session?.name) {
          clearLoginFlow(flowId);
          setFlowResult(flowId, {
            status: "failed",
            error: "missing_session_data"
          });
          sendJsonNoStore(res, 200, {
            status: "failed",
            username: null,
            error: "missing_session_data",
            authCode: null
          });
          return;
        }

        clearLoginFlow(flowId);
        createSession(res, {
          sessionKey: session.key,
          username: session.name
        });
        setFlowResult(flowId, {
          status: "connected",
          username: session.name
        });

        sendJsonNoStore(res, 200, {
          status: "connected",
          username: session.name,
          error: null,
          authCode: null
        });
        return;
      } catch (error) {
        if (error?.lastFmCode === 14) {
          sendJsonNoStore(res, 200, { status: "pending" });
          return;
        }

        clearLoginFlow(flowId);
        setFlowResult(flowId, {
          status: "failed",
          error: String(error?.message || error)
        });
        sendJsonNoStore(res, 200, {
          status: "failed",
          username: null,
          error: String(error?.message || error),
          authCode: null
        });
        return;
      }
    }

    sendJsonNoStore(res, 200, {
      status: flowResult.status,
      username: flowResult.username || null,
      error: flowResult.error || null,
      authCode: flowResult.authCode || null
    });
    return;
  }

  if (pathname === `${LASTFM_PREFIX}/login-init`) {
    try {
      const tokenResponse = await lastFmRequest("auth.getToken");
      const token = tokenResponse?.token;

      if (!token) {
        sendJson(res, 502, { error: "Failed to create Last.fm login token" });
        return;
      }

      const generatedFlowId = createLoginFlow(token);
      sendJsonNoStore(res, 200, {
        flowId: generatedFlowId,
        authorizeUrl: `${LASTFM_AUTH_ORIGIN}/api/auth/?api_key=${encodeURIComponent(LASTFM_API_KEY)}&token=${encodeURIComponent(token)}`
      });
    } catch (error) {
      sendJson(res, 502, { error: "Failed to initialize Last.fm login", details: String(error.message || error) });
    }
    return;
  }

  if (!lastFmConfigured()) {
    sendJson(res, 503, {
      error: "Last.fm integration is not configured on this server.",
      details: "Set LASTFM_API_KEY and LASTFM_API_SECRET to enable login and scrobbling."
    });
    return;
  }

  if (pathname === `${LASTFM_PREFIX}/login`) {
    try {
      const tokenResponse = await lastFmRequest("auth.getToken");
      const token = tokenResponse?.token;

      if (!token) {
        sendJson(res, 502, { error: "Failed to create Last.fm login token" });
        return;
      }

      const callbackUrlObj = new URL(`${requestOrigin}${LASTFM_PREFIX}/callback`);
      callbackUrlObj.searchParams.set("popup", "1");
      if (flowId) {
        callbackUrlObj.searchParams.set("flow_id", flowId);
      }
      const callbackUrl = callbackUrlObj.toString();
      const redirectUrl = `${LASTFM_AUTH_ORIGIN}/api/auth/?api_key=${encodeURIComponent(LASTFM_API_KEY)}&token=${encodeURIComponent(token)}&cb=${encodeURIComponent(callbackUrl)}`;

      res.writeHead(302, { Location: redirectUrl });
      res.end();
    } catch (error) {
      sendJson(res, 502, { error: "Failed to start Last.fm login", details: String(error.message || error) });
    }
    return;
  }

  if (pathname === `${LASTFM_PREFIX}/callback`) {
    const token = incomingUrl.searchParams.get("token");

    if (!token) {
      setFlowResult(flowId, {
        status: "missing_token"
      });

      if (isPopupFlow) {
        sendLastFmPopupResult(res, requestOrigin, {
          source: "lastfm-auth",
          status: "missing_token"
        });
        return;
      }

      res.writeHead(302, { Location: "/?lastfm=missing_token" });
      res.end();
      return;
    }

    try {
      const sessionResponse = await lastFmRequest("auth.getSession", { token });
      const session = sessionResponse?.session;

      if (!session?.key || !session?.name) {
        setFlowResult(flowId, {
          status: "failed",
          error: "missing_session_data"
        });

        if (isPopupFlow) {
          sendLastFmPopupResult(res, requestOrigin, {
            source: "lastfm-auth",
            status: "failed",
            error: "missing_session_data"
          });
          return;
        }

        res.writeHead(302, { Location: "/?lastfm=failed&lastfm_error=missing_session_data" });
        res.end();
        return;
      }

      createSession(res, {
        sessionKey: session.key,
        username: session.name
      });

      const authCode = createAuthCode({
        sessionKey: session.key,
        username: session.name
      });

      setFlowResult(flowId, {
        status: "connected",
        username: session.name,
        authCode
      });

      if (isPopupFlow) {
        sendLastFmPopupResult(res, requestOrigin, {
          source: "lastfm-auth",
          status: "connected",
          username: session.name,
          authCode
        });
        return;
      }

      res.writeHead(302, { Location: "/?lastfm=connected" });
      res.end();
    } catch (error) {
      setFlowResult(flowId, {
        status: "failed",
        error: String(error?.message || "session_exchange_failed")
      });

      if (isPopupFlow) {
        sendLastFmPopupResult(res, requestOrigin, {
          source: "lastfm-auth",
          status: "failed",
          error: String(error?.message || "session_exchange_failed")
        });
        return;
      }

      const reason = encodeURIComponent(String(error?.message || "session_exchange_failed"));
      res.writeHead(302, { Location: `/?lastfm=failed&lastfm_error=${reason}` });
      res.end();
    }
    return;
  }

  if (pathname === `${LASTFM_PREFIX}/logout`) {
    clearSession(req, res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === `${LASTFM_PREFIX}/complete`) {
    try {
      const body = await readJsonBody(req);
      const code = String(body.code || "").trim();

      if (!code) {
        sendJson(res, 400, { error: "code is required" });
        return;
      }

      const authData = consumeAuthCode(code);
      if (!authData?.sessionKey || !authData?.username) {
        sendJson(res, 400, { error: "invalid_or_expired_code" });
        return;
      }

      createSession(res, {
        sessionKey: authData.sessionKey,
        username: authData.username
      });

      sendJson(res, 200, {
        ok: true,
        username: authData.username
      });
    } catch (error) {
      sendJson(res, 400, { error: "Failed to finalize Last.fm login", details: String(error.message || error) });
    }
    return;
  }

  if (pathname === `${LASTFM_PREFIX}/now-playing`) {
    const session = getSession(req);

    if (!session?.sessionKey) {
      sendJson(res, 401, { error: "Not authenticated with Last.fm" });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const artist = String(body.artist || "").trim();
      const track = String(body.track || "").trim();

      if (!artist || !track) {
        sendJson(res, 400, { error: "artist and track are required" });
        return;
      }

      await lastFmRequest("track.updateNowPlaying", {
        sk: session.sessionKey,
        artist,
        track,
        album: String(body.album || "").trim(),
        duration: Number.isFinite(Number(body.duration)) ? String(Math.max(0, Math.floor(Number(body.duration)))) : undefined
      });

      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 502, { error: "Failed to update now playing", details: String(error.message || error) });
    }
    return;
  }

  if (pathname === `${LASTFM_PREFIX}/scrobble`) {
    const session = getSession(req);

    if (!session?.sessionKey) {
      sendJson(res, 401, { error: "Not authenticated with Last.fm" });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const artist = String(body.artist || "").trim();
      const track = String(body.track || "").trim();
      const timestamp = Number(body.timestamp);

      if (!artist || !track || !Number.isFinite(timestamp) || timestamp <= 0) {
        sendJson(res, 400, { error: "artist, track, and a valid timestamp are required" });
        return;
      }

      await lastFmRequest("track.scrobble", {
        sk: session.sessionKey,
        artist,
        track,
        timestamp: String(Math.floor(timestamp)),
        album: String(body.album || "").trim(),
        duration: Number.isFinite(Number(body.duration)) ? String(Math.max(0, Math.floor(Number(body.duration)))) : undefined
      });

      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 502, { error: "Failed to scrobble track", details: String(error.message || error) });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
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
  const forwardedHeaders = {
    Accept: req.headers.accept || "*/*",
    "User-Agent": "JuicePlayer-WebApp"
  };

  [
    "range",
    "if-range",
    "if-none-match",
    "if-modified-since",
    "accept-encoding"
  ].forEach((headerName) => {
    const headerValue = req.headers[headerName];
    if (headerValue) {
      forwardedHeaders[headerName] = headerValue;
    }
  });

  const proxyRequest = https.request(
    `${API_TARGET_ORIGIN}${targetPath}`,
    {
      method: req.method,
      headers: forwardedHeaders
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

  if (req.url.startsWith(LASTFM_PREFIX)) {
    if (req.method !== "GET" && req.method !== "POST" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    handleLastFm(req, res);
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
