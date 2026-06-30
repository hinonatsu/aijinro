import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelQueue,
  createGuestSession,
  gameEvents,
  getMe,
  getRoomState,
  getStats,
  joinQueue,
  leaveRoom,
  reportTarget,
  startDuelMatch,
  submitAction,
  submitVote
} from "./game.js";
import { publicError } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const iconPath = path.join(__dirname, "icon.png");
const clients = new Set();
const port = Number(process.env.PORT ?? 3000);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, {
        status: "ok",
        service: "ai-werewolf-mvp",
        uptimeSeconds: Math.round(process.uptime())
      });
    }

    if (req.method === "GET" && url.pathname === "/events") {
      return handleEvents(req, res, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    if (req.method === "GET" && (url.pathname === "/icon.png" || url.pathname === "/favicon.ico")) {
      return serveIcon(res);
    }

    return serveStatic(req, res, url);
  } catch (error) {
    return sendError(res, error);
  }
});

gameEvents.on("change", () => {
  const payload = `event: refresh\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
});

server.listen(port, () => {
  console.log(`AI人狼 MVP running at http://localhost:${port}`);
});

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/session") {
    return sendJson(res, createGuestSession());
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    return sendJson(res, getMe(readToken(req, url)));
  }

  if (req.method === "GET" && url.pathname === "/api/me/stats") {
    return sendJson(res, getStats(readToken(req, url)));
  }

  if (req.method === "POST" && url.pathname === "/api/match") {
    const body = await readBody(req);
    return sendJson(res, joinQueue(body.guestToken));
  }

  if (req.method === "POST" && url.pathname === "/api/duel") {
    const body = await readBody(req);
    return sendJson(res, startDuelMatch(body.guestToken));
  }

  if (req.method === "POST" && url.pathname === "/api/match/cancel") {
    const body = await readBody(req);
    return sendJson(res, cancelQueue(body.guestToken));
  }

  const roomActionMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/([^/]+))?$/);
  if (roomActionMatch) {
    const [, roomId, action] = roomActionMatch;

    if (req.method === "GET" && !action) {
      return sendJson(res, getRoomState(readToken(req, url), roomId));
    }

    const body = await readBody(req);
    if (req.method === "POST" && action === "action") {
      return sendJson(res, await submitAction(body.guestToken, roomId, body));
    }
    if (req.method === "POST" && action === "vote") {
      return sendJson(res, submitVote(body.guestToken, roomId, body.targetParticipantId));
    }
    if (req.method === "POST" && action === "report") {
      return sendJson(res, reportTarget(body.guestToken, roomId, body));
    }
    if (req.method === "POST" && action === "leave") {
      return sendJson(res, leaveRoom(body.guestToken, roomId));
    }
  }

  throw publicError("APIが見つかりません。", 404);
}

function handleEvents(req, res, url) {
  readToken(req, url);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`event: refresh\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

function serveStatic(req, res, url) {
  const safePath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    throw publicError("不正なパスです。", 403);
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    throw publicError("ファイルが見つかりません。", 404);
  }
  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(filePath).pipe(res);
}

function serveIcon(res) {
  if (!fs.existsSync(iconPath)) {
    throw publicError("icon.png not found", 404);
  }
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=3600"
  });
  fs.createReadStream(iconPath).pipe(res);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function readToken(req, url) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  const token = url.searchParams.get("token");
  if (!token) {
    throw publicError("セッションが必要です。", 401);
  }
  return token;
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, error) {
  const status = error.status ?? 500;
  sendJson(
    res,
    {
      error: error.message || "サーバーエラーが発生しました。"
    },
    status
  );
}
