import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ANALYTICS_URL, DAILY_USAGE_PATH } from "./index.mjs";

const RESET_TOLERANCE_SECONDS = 10;

function browserCandidates() {
  if (process.env.CODEX_CHROME_PATH) {
    return [{ name: "Configured browser", executable: process.env.CODEX_CHROME_PATH }];
  }
  if (process.platform === "darwin") {
    const roots = ["/Applications", path.join(os.homedir(), "Applications")];
    const appPath = (name, executable) => roots.map((root) => ({
      name,
      executable: path.join(root, `${name}.app`, "Contents", "MacOS", executable)
    }));
    return [
      ...appPath("Google Chrome", "Google Chrome"),
      ...appPath("Microsoft Edge", "Microsoft Edge"),
      ...appPath("Brave Browser", "Brave Browser")
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    return [
      { name: "Google Chrome", executable: path.join(local, "Google", "Chrome", "Application", "chrome.exe") },
      { name: "Google Chrome", executable: path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe") },
      { name: "Google Chrome", executable: path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") },
      { name: "Microsoft Edge", executable: path.join(local, "Microsoft", "Edge", "Application", "msedge.exe") },
      { name: "Microsoft Edge", executable: path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe") }
    ];
  }
  return [
    { name: "Google Chrome", executable: "/usr/bin/google-chrome" },
    { name: "Google Chrome", executable: "/usr/bin/google-chrome-stable" },
    { name: "Chromium", executable: "/usr/bin/chromium" },
    { name: "Microsoft Edge", executable: "/usr/bin/microsoft-edge" }
  ];
}

function findExternalBrowser() {
  return browserCandidates().find((candidate) => existsSync(candidate.executable)) || null;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function connectToExternalBrowser(chromium, port, attempts = 40) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(`无法连接外部浏览器调试通道：${lastError?.message || "timeout"}`);
}

function readStoredBrowserPort(portFile) {
  try {
    const value = JSON.parse(readFileSync(portFile, "utf8"));
    return Number.isInteger(value.port) ? value.port : null;
  } catch {
    return null;
  }
}

function storeBrowserPort(portFile, port) {
  writeFileSync(portFile, JSON.stringify({ port, updatedAt: new Date().toISOString() }, null, 2));
}

function isChatGptHome(url) {
  try {
    const parsed = new URL(url);
    if (!(parsed.hostname === "chatgpt.com" || parsed.hostname.endsWith(".chatgpt.com"))) return false;
    return ["/", "/codex", "/codex/", "/codex/cloud", "/codex/cloud/"].includes(parsed.pathname);
  } catch {
    return false;
  }
}

function isAnalyticsPage(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === "chatgpt.com" || parsed.hostname.endsWith(".chatgpt.com")) && parsed.pathname.startsWith("/codex/cloud/settings/analytics");
  } catch {
    return false;
  }
}

async function pageLooksAuthenticated(page) {
  const signals = await page.evaluate(() => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const controls = [...document.querySelectorAll("button, a")]
      .filter(visible)
      .map((element) => (element.innerText || element.getAttribute("aria-label") || "").trim())
      .filter(Boolean)
      .join(" ");
    return {
      controls,
      body: document.body?.innerText || ""
    };
  }).catch(() => null);
  if (!signals) return null;

  const controls = signals.controls.replace(/\s+/g, " ").toLowerCase();
  const body = signals.body.replace(/\s+/g, " ").toLowerCase();
  if (!controls && !body) return null;
  if (/\b(log in|login|sign up)\b|登录|注册/.test(controls)) return false;
  return /\b(new chat|codex|workspace|chatgpt)\b|新对话|新聊天|工作区/.test(body);
}

function planFromText(text, source) {
  const lower = String(text || "").replace(/\s+/g, " ").trim().toLowerCase().replaceAll("×", "x");
  const compact = lower.replace(/[^a-z0-9]+/g, " ").trim();
  const reference = compact.includes("pro 20x") || compact.includes("20x pro") ? { id: "pro-20x", label: "Pro 20x", credits: 60000 } :
    compact.includes("pro 5x") || compact.includes("5x pro") ? { id: "pro-5x", label: "Pro 5x", credits: 15000 } :
      /\bplus\b/.test(compact) ? { id: "plus", label: "Plus", credits: 3000 } :
        /\bpro\b/.test(compact) ? { id: null, label: "Pro", credits: null } : null;
  return reference ? { ...reference, source } : null;
}

function collectPlanFields(value, key = "", depth = 0, fields = []) {
  if (depth > 4 || value == null) return fields;
  if (typeof value === "string" && /plan|tier|subscription|product|billing/i.test(key)) {
    fields.push(value);
    return fields;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlanFields(item, key, depth + 1, fields);
    return fields;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectPlanFields(childValue, childKey, depth + 1, fields);
    }
  }
  return fields;
}

async function detectPlanFromAnalyticsPage(page, payload) {
  const payloadPlan = planFromText(collectPlanFields(payload).join(" "), "analytics-response");
  if (payloadPlan) return payloadPlan;
  const pageText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  return planFromText(pageText, "analytics-page");
}

function openExternalUrl(url) {
  const command = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
}

export async function captureDailyUsageWithExternalBrowser({
  onStatus = () => {},
  dataDir = path.join(os.homedir(), ".codex-credit-stats"),
  profileDir = path.join(os.homedir(), ".codex-credit-stats", "external-browser-profile"),
  interactive = true
} = {}) {
  const { chromium } = await import("playwright");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  const portFile = path.join(dataDir, "external-browser-port.json");
  let connectedBrowser = null;
  let port = readStoredBrowserPort(portFile);

  if (port != null) {
    try {
      connectedBrowser = await connectToExternalBrowser(chromium, port, 20);
      onStatus({ phase: "auth", message: "正在复用已经登录的外部浏览器…" });
    } catch {
      connectedBrowser = null;
    }
  }

  if (!connectedBrowser) {
    const browser = findExternalBrowser();
    if (!browser) {
      if (interactive) openExternalUrl(ANALYTICS_URL);
      throw new Error(interactive
        ? "已打开系统默认浏览器。当前系统没有检测到可自动回传 response 的 Chrome/Edge；请安装 Chrome 或 Edge。"
        : "无法使用已保存的 ChatGPT 连接；请点击连接按钮重新连接 ChatGPT。");
    }

    const previousPort = port;
    port = 9222 + Math.floor(Math.random() * 500);
    onStatus({ phase: "auth", message: `正在打开外部浏览器 ${browser.name}…` });
    const child = spawn(browser.executable, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      ANALYTICS_URL
    ], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    try {
      connectedBrowser = await connectToExternalBrowser(chromium, port);
      storeBrowserPort(portFile, port);
    } catch (launchError) {
      if (previousPort != null) {
        try {
          connectedBrowser = await connectToExternalBrowser(chromium, previousPort, 10);
          port = previousPort;
          storeBrowserPort(portFile, port);
        } catch {
          // Preserve the original launch error below.
        }
      }
      if (!connectedBrowser) throw launchError;
    }
  }

  const context = connectedBrowser.contexts()[0];
  if (!context) {
    await connectedBrowser.close().catch(() => {});
    throw new Error("外部浏览器没有可用的浏览器上下文。");
  }

  let settled = false;
  let timeoutHandle;
  let redirectTimer;
  let redirectInProgress = false;
  let loginStatus = null;
  let resolveCapture;
  let rejectCapture;
  const capturePromise = new Promise((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  const onResponse = async (response) => {
    if (settled || !response.url().includes(DAILY_USAGE_PATH) || response.status() !== 200) return;
    try {
      const payload = await response.json();
      if (Array.isArray(payload?.data)) {
        settled = true;
        resolveCapture(payload);
      }
    } catch {
      // Keep listening for the next matching response.
    }
  };
  context.on("response", onResponse);

  const returnToAnalyticsAfterLogin = async () => {
    if (settled || redirectInProgress) return;
    const page = context.pages().find((candidate) => isChatGptHome(candidate.url()));
    if (!page) return;
    const authenticated = await pageLooksAuthenticated(page);
    if (authenticated !== true) {
      if (!interactive) {
        settled = true;
        rejectCapture(new Error("已保存的 ChatGPT 连接已失效；请点击连接按钮重新连接 ChatGPT。"));
        return;
      }
      if (loginStatus !== "waiting") {
        loginStatus = "waiting";
        onStatus({ phase: "auth", message: "外部浏览器尚未登录 ChatGPT，请完成登录；localhost 页面会自动等待。" });
      }
      return;
    }
    loginStatus = "authenticated";
    redirectInProgress = true;
    try {
      onStatus({ phase: "auth", message: "检测到登录已返回 ChatGPT，正在重新打开 Codex analytics…" });
      await page.goto(ANALYTICS_URL, { waitUntil: "domcontentloaded" });
    } catch {
      // The page may be replaced by the authentication redirect. The next poll retries.
    } finally {
      redirectInProgress = false;
    }
  };

  const pageCreated = (page) => {
    page.on("framenavigated", () => void returnToAnalyticsAfterLogin());
  };
  context.on("page", pageCreated);
  for (const page of context.pages()) pageCreated(page);

  timeoutHandle = setTimeout(() => {
    if (!settled) {
      rejectCapture(new Error(interactive
        ? "等待外部浏览器登录或 analytics 响应超时。"
        : "无法使用已保存的 ChatGPT 连接；请点击连接按钮重新连接 ChatGPT。"));
    }
  }, 300000);
  redirectTimer = setInterval(() => void returnToAnalyticsAfterLogin(), 1200);

  try {
    onStatus({
      phase: "auth",
      message: interactive
        ? "请在外部浏览器中完成 ChatGPT 登录；登录后会自动读取 analytics response…"
        : "正在验证已保存的 ChatGPT 连接…"
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(ANALYTICS_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    const payload = await capturePromise;
    const analyticsPage = context.pages().find((candidate) => isAnalyticsPage(candidate.url())) || page;
    const plan = await detectPlanFromAnalyticsPage(analyticsPage, payload);
    onStatus({ phase: "auth", message: "已从外部浏览器取得 analytics response。" });
    return { daily: payload, plan };
  } finally {
    clearTimeout(timeoutHandle);
    clearInterval(redirectTimer);
    context.off("response", onResponse);
    context.off("page", pageCreated);
    await connectedBrowser.close().catch(() => {});
  }
}
