#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  estimateWeeklyCredits,
  readSessionSnapshots
} from "./src/index.mjs";
import { captureDailyUsageWithExternalBrowser } from "./src/browser-capture.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(rootDir, "renderer");
const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
const dataDir = path.join(os.homedir(), ".codex-credit-stats");
const host = process.env.CODEX_CREDIT_HOST || "127.0.0.1";
const defaultPort = Number(process.env.CODEX_CREDIT_PORT || 4317);
const sessionToken = randomBytes(32).toString("hex");
const browserDataDir = process.env.CODEX_CREDIT_DATA_DIR || dataDir;
const browserProfileDir = process.env.CODEX_CREDIT_PROFILE_DIR || path.join(browserDataDir, "external-browser-profile");

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const state = {
  busy: false,
  report: null,
  status: { phase: "idle", message: "准备就绪。点击刷新后自动切分周期。", mode: "idle" }
};
const eventClients = new Set();

function jsonResponse(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function authorized(request) {
  const cookies = String(request.headers.cookie || "")
    .split(";")
    .map((item) => item.trim().split("="))
    .filter(([key]) => key)
    .reduce((result, [key, ...value]) => ({ ...result, [key]: value.join("=") }), {});
  return cookies.codex_credit_session === sessionToken;
}

function stateSnapshot() {
  return {
    busy: state.busy,
    report: state.report,
    status: state.status
  };
}

function sendEvent(response, value) {
  response.write(`event: state\ndata: ${JSON.stringify(value)}\n\n`);
}

function publishStatus(message, phase = "busy", mode = "busy") {
  state.status = { message, phase, mode };
  const snapshot = stateSnapshot();
  for (const client of eventClients) sendEvent(client, snapshot);
}

function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(rendererDir, requested);
  if (!filePath.startsWith(`${rendererDir}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  readFile(filePath).then((body) => {
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(body);
  }).catch(() => {
    response.writeHead(404);
    response.end("Not found");
  });
}

async function runSync() {
  if (state.busy) return;
  state.busy = true;
  state.report = null;
  publishStatus("正在连接外部浏览器中的 ChatGPT analytics…", "auth", "busy");
  try {
    const captured = await captureDailyUsageWithExternalBrowser({
      dataDir: browserDataDir,
      profileDir: browserProfileDir,
      onStatus: ({ message, phase }) => publishStatus(message, phase || "auth", "busy")
    });
    publishStatus("正在读取本地 Codex session 用量快照…", "sessions", "busy");
    if (!existsSync(sessionsDir)) {
      throw new Error(`没有找到本地 Codex sessions：${sessionsDir}`);
    }
    const { snapshots } = await readSessionSnapshots(sessionsDir);
    publishStatus("正在按额度更新点切分周期并估算周限额…", "calculate", "busy");
    const report = estimateWeeklyCredits({
      dailyRows: captured.daily,
      snapshots,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    });
    report.source = "authenticated-browser";
    report.plan = captured.plan;
    state.report = report;
    state.busy = false;
    publishStatus("统计完成。周期估计已更新。", "ready", "ready");
  } catch (error) {
    state.busy = false;
    publishStatus(error?.message || "统计失败，请重试。", "error", "error");
  }
}

function openLocalUrl(port) {
  const url = `http://${host}:${port}/?token=${sessionToken}`;
  const command = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${host}`);

  if (requestUrl.pathname === "/api/state" || requestUrl.pathname === "/api/events" || requestUrl.pathname === "/api/sync") {
    if (!authorized(request)) {
      jsonResponse(response, 401, { error: "请从 npm start 自动打开的 localhost 页面访问。" });
      return;
    }
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/state") {
    jsonResponse(response, 200, stateSnapshot());
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    response.write(": connected\n\n");
    sendEvent(response, stateSnapshot());
    eventClients.add(response);
    request.on("close", () => eventClients.delete(response));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/sync") {
    if (state.busy) {
      jsonResponse(response, 409, { error: "统计正在进行中。" });
      return;
    }
    void runSync();
    jsonResponse(response, 202, { ok: true });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/" && requestUrl.searchParams.get("token") === sessionToken) {
    response.writeHead(302, {
      Location: "/",
      "Set-Cookie": `codex_credit_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`
    });
    response.end();
    return;
  }

  if (request.method === "GET") {
    serveStatic(response, requestUrl.pathname);
    return;
  }

  response.writeHead(405);
  response.end("Method not allowed");
});

const port = Number(process.argv.find((value) => value.startsWith("--port="))?.split("=")[1] || defaultPort);
const shouldOpen = !process.argv.includes("--no-open");

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`localhost 端口 ${port} 已被占用，请使用 --port=PORT 或 CODEX_CREDIT_PORT=PORT。`);
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}/?token=${sessionToken}`;
  console.log(`Codex Credit Stats running at ${url}`);
  if (shouldOpen) void openLocalUrl(port);
});
