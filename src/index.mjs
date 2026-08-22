import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const ANALYTICS_URL = "https://chatgpt.com/codex/cloud/settings/analytics";
export const DAILY_USAGE_PATH = "/backend-api/wham/analytics/daily-workspace-usage-counts";
export const PLAN_REFERENCES = [
  { id: "pro-20x", label: "Pro 20x", credits: 60000, displayCredits: "约 60,000" },
  { id: "pro-5x", label: "Pro 5x", credits: 15000, displayCredits: "约 15,000" },
  { id: "plus", label: "Plus", credits: 3000, displayCredits: "约 3,000" }
];

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const RESET_TOLERANCE_SECONDS = 10;

export function expandHome(input) {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

export function todayIso(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  return dateInTimeZone(Date.now(), timeZone);
}

export function dateInTimeZone(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function parseDailyUsage(payload) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const data = Array.isArray(parsed) ? parsed : parsed?.data ?? [];

  return data
    .map((row) => {
      const totals = row.totals ?? row.total ?? row;
      return {
        date: String(row.date),
        credits: Number(totals.credits ?? 0),
        users: Number(totals.users ?? 0),
        threads: Number(totals.threads ?? 0),
        turns: Number(totals.turns ?? 0)
      };
    })
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.credits))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function sumDailyCredits(rows, from, to) {
  return rows
    .filter((row) => row.date >= from && row.date <= to)
    .reduce((sum, row) => sum + row.credits, 0);
}

async function* walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield fullPath;
    }
  }
}

export async function readSessionSnapshots(sessionsDir) {
  const snapshots = [];
  const sessions = [];
  let filesRead = 0;
  let malformedLines = 0;

  for await (const file of walkFiles(sessionsDir)) {
    filesRead += 1;
    let sessionMeta = null;
    const input = createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });

    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }

      if (record.type === "session_meta") {
        const payload = record.payload ?? {};
        sessionMeta = {
          id: payload.id ?? payload.session_id ?? null,
          timestamp: payload.timestamp ?? record.timestamp ?? null
        };
      }

      const payload = record.payload ?? {};
      const primary = payload.rate_limits?.primary;
      if (record.type !== "event_msg" || payload.type !== "token_count" || !primary) continue;

      const timestamp = record.timestamp ?? null;
      const usedPercent = Number(primary.used_percent);
      const windowMinutes = Number(primary.window_minutes);
      const resetsAt = Number(primary.resets_at);
      if (!timestamp || !Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes) || !Number.isFinite(resetsAt)) continue;

      snapshots.push({
        file,
        sessionId: sessionMeta?.id ?? null,
        timestamp,
        usedPercent,
        windowMinutes,
        resetsAt
      });
    }

    sessions.push({
      file,
      id: sessionMeta?.id ?? null,
      timestamp: sessionMeta?.timestamp ?? null
    });
  }

  snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { filesRead, malformedLines, sessions, snapshots };
}

function roundedPercentRange(percent, error = 0.5) {
  return {
    lowerPercent: percent - error,
    upperPercent: percent + error
  };
}

function impliedQuota(credits, usedPercent) {
  if (!(usedPercent > 0)) return null;
  return credits / (usedPercent / 100);
}

function estimateWithRounding(credits, usedPercent, error = 0.5) {
  if (!(usedPercent > 0)) return null;
  const range = roundedPercentRange(usedPercent, error);
  return {
    credits,
    usedPercent,
    impliedWeeklyCredits: impliedQuota(credits, usedPercent),
    roundingRange: {
      lower: credits / (range.upperPercent / 100),
      upper: credits / (Math.max(0.01, range.lowerPercent) / 100)
    }
  };
}

function selectWindowSnapshots(snapshots) {
  const weekly = snapshots.filter((snapshot) => snapshot.windowMinutes === 10080);
  const candidates = weekly.length > 0 ? weekly : snapshots;
  const latest = candidates.at(-1);
  if (!latest) return null;

  const currentReset = latest.resetsAt;
  const currentWindowSnapshots = candidates.filter((snapshot) => Math.abs(snapshot.resetsAt - currentReset) <= RESET_TOLERANCE_SECONDS);
  const currentWindowStart = currentWindowSnapshots[0] ?? null;
  const currentWindowLatest = currentWindowSnapshots.at(-1) ?? null;
  const currentWindowStartMs = currentWindowStart ? Date.parse(currentWindowStart.timestamp) : null;
  const beforeCurrentReset = currentWindowStartMs == null
    ? null
    : candidates.filter((snapshot) => Date.parse(snapshot.timestamp) < currentWindowStartMs).at(-1) ?? null;
  const windowMinutes = latest.windowMinutes;
  const currentWindowStartEpoch = currentReset - windowMinutes * 60;
  const previousWindowStart = currentWindowStartEpoch - windowMinutes * 60;

  return {
    currentReset,
    currentWindowStart,
    currentWindowStartEpoch,
    boundaryReset: currentWindowStartEpoch,
    previousWindowStart,
    beforeCurrentReset,
    currentWindowLatest,
    weeklySnapshotCount: candidates.length,
    snapshotCandidates: candidates
  };
}

function snapshotAtOrBefore(snapshots, epochSeconds) {
  const boundaryMs = epochSeconds * 1000;
  return snapshots
    .filter((snapshot) => Date.parse(snapshot.timestamp) <= boundaryMs)
    .at(-1) ?? null;
}

function dateDifferenceInclusive(fromDate, toDate) {
  if (!fromDate || !toDate || fromDate > toDate) return 0;
  const from = Date.parse(`${fromDate}T12:00:00Z`);
  const to = Date.parse(`${toDate}T12:00:00Z`);
  return Math.round((to - from) / 86400000) + 1;
}

function sumDailyCreditsRange(rows, fromDate, toDateExclusive) {
  return rows
    .filter((row) => row.date >= fromDate && row.date < toDateExclusive)
    .reduce((sum, row) => sum + row.credits, 0);
}

function makeCycle({
  rows,
  snapshots,
  selected,
  indexFromLatest,
  fromDate,
  toDate,
  toDateExclusive,
  endEpoch,
  current = false
}) {
  const credits = current
    ? sumDailyCredits(rows, fromDate, toDate)
    : sumDailyCreditsRange(rows, fromDate, toDateExclusive);
  const snapshot = current ? selected.currentWindowLatest : snapshotAtOrBefore(snapshots, endEpoch);
  const usedPercent = snapshot?.usedPercent ?? null;
  const estimate = estimateWithRounding(credits, usedPercent);

  return {
    id: current ? "current" : `cycle-${indexFromLatest}`,
    indexFromLatest,
    kind: current ? "current" : "seven-day",
    fromDate,
    toDate,
    durationDays: dateDifferenceInclusive(fromDate, toDate),
    credits,
    usedPercent,
    estimate,
    snapshotTimestamp: snapshot?.timestamp ?? null,
    snapshotResetsAt: snapshot?.resetsAt ?? null,
    hasDailyData: credits > 0,
    label: current ? `${fromDate} → ${toDate} · 当前` : `${fromDate} → ${toDate}`
  };
}

function buildCreditCycles(rows, selected, timeZone) {
  if (!selected?.currentWindowLatest || selected.currentWindowStartEpoch == null || !rows.length) return [];

  const latestDate = rows.at(-1).date;
  const oldestDate = rows[0].date;
  const anchorEpoch = selected.currentWindowStartEpoch;
  const anchorDate = dateInTimeZone(anchorEpoch * 1000, timeZone);
  const current = makeCycle({
    rows,
    snapshots: selected.snapshotCandidates,
    selected,
    indexFromLatest: 0,
    fromDate: anchorDate,
    toDate: latestDate >= anchorDate ? latestDate : anchorDate,
    endEpoch: Date.now() / 1000,
    current: true
  });

  const historical = [];
  for (let index = 1; index <= 52; index += 1) {
    const endEpoch = anchorEpoch - (index - 1) * WEEK_SECONDS;
    const startEpoch = endEpoch - WEEK_SECONDS;
    const fromDate = dateInTimeZone(startEpoch * 1000, timeZone);
    const toDateExclusive = dateInTimeZone(endEpoch * 1000, timeZone);
    const toDate = addDays(toDateExclusive, -1);
    const hasRows = rows.some((row) => row.date >= fromDate && row.date < toDateExclusive);
    const snapshot = snapshotAtOrBefore(selected.snapshotCandidates, endEpoch);

    if (!hasRows && !snapshot) break;
    if (toDate < oldestDate && !hasRows) break;

    historical.push(makeCycle({
      rows,
      snapshots: selected.snapshotCandidates,
      selected,
      indexFromLatest: index,
      fromDate,
      toDate,
      toDateExclusive,
      endEpoch
    }));

    if (fromDate <= oldestDate && !hasRows) break;
  }

  return [...historical.reverse(), current].filter((cycle) => cycle.hasDailyData || cycle.estimate);
}

export function estimateWeeklyCredits({ dailyRows, snapshots, timeZone }) {
  const rows = parseDailyUsage(dailyRows);
  const resolvedTimeZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const latestDate = rows.at(-1)?.date ?? todayIso(resolvedTimeZone);
  const dailyCreditsInAvailableRange = rows.reduce((sum, row) => sum + row.credits, 0);
  const selected = selectWindowSnapshots(snapshots);

  if (!selected?.currentWindowLatest) {
    return {
      method: "unavailable",
      timezone: resolvedTimeZone,
      planReferences: PLAN_REFERENCES,
      daily: {
        availableFrom: rows[0]?.date ?? null,
        availableTo: rows.at(-1)?.date ?? null,
        creditsInAvailableRange: dailyCreditsInAvailableRange,
        creditsInRequestedRange: dailyCreditsInAvailableRange,
        rows
      },
      cycles: [],
      estimates: { cycles: [] },
      message: "没有找到本地 Codex session 的 weekly rate-limit snapshot。"
    };
  }

  const current = selected.currentWindowLatest;
  const cycles = buildCreditCycles(rows, selected, resolvedTimeZone);
  const currentCycle = cycles.at(-1) ?? null;
  const previousCycle = cycles.length > 1 ? cycles.at(-2) : null;
  const referenceCycle = previousCycle?.estimate?.impliedWeeklyCredits > 0
    ? previousCycle
    : null;
  const referenceQuota = referenceCycle?.estimate?.impliedWeeklyCredits
    ?? currentCycle?.estimate?.impliedWeeklyCredits
    ?? null;
  const currentWindowCredits = currentCycle?.credits ?? null;
  const currentWindowUsedPercent = referenceQuota > 0 && currentWindowCredits != null
    ? (currentWindowCredits / referenceQuota) * 100
    : current.usedPercent ?? null;
  const currentWindowRemainingPercent = currentWindowUsedPercent == null
    ? null
    : Math.max(0, 100 - currentWindowUsedPercent);
  const currentWindowRemainingCredits = referenceQuota > 0 && currentWindowCredits != null
    ? Math.max(0, referenceQuota - currentWindowCredits)
    : null;
  const boundaryResetDate = selected.currentWindowStartEpoch == null
    ? null
    : dateInTimeZone(selected.currentWindowStartEpoch * 1000, resolvedTimeZone);
  const previousWindowStartDate = selected.previousWindowStart == null
    ? null
    : dateInTimeZone(selected.previousWindowStart * 1000, resolvedTimeZone);

  return {
    method: "rolling-seven-day-cycles",
    timezone: resolvedTimeZone,
    planReferences: PLAN_REFERENCES,
    daily: {
      availableFrom: rows[0]?.date ?? null,
      availableTo: rows.at(-1)?.date ?? null,
      creditsInAvailableRange: dailyCreditsInAvailableRange,
      creditsInRequestedRange: dailyCreditsInAvailableRange,
      rows
    },
    local: {
      filesRead: new Set(snapshots.map((snapshot) => snapshot.file)).size,
      snapshotCount: snapshots.length,
      weeklySnapshotCount: selected.weeklySnapshotCount,
      currentReset: selected.currentReset,
      currentWindowStart: selected.currentWindowStart,
      currentWindowStartEpoch: selected.currentWindowStartEpoch,
      boundaryReset: selected.boundaryReset,
      previousWindowStart: selected.previousWindowStart,
      previousWindowStartDate,
      boundaryResetDate,
      beforeCurrentReset: selected.beforeCurrentReset,
      currentWindowLatest: current
    },
    cycles,
    estimates: {
      cycles,
      latest: currentCycle?.estimate ?? previousCycle?.estimate ?? null,
      previousWindowApprox: previousCycle?.estimate ?? null,
      currentWindowApprox: currentCycle?.estimate ?? null,
      currentWindow: {
        usedCredits: currentWindowCredits,
        referenceQuota,
        referenceCycle: referenceCycle?.label ?? null,
        usedPercent: currentWindowUsedPercent,
        remainingPercent: currentWindowRemainingPercent,
        remainingCredits: currentWindowRemainingCredits,
        source: referenceCycle ? "latest-completed-cycle" : "local-snapshot-fallback"
      },
      naiveRequestedRange: estimateWithRounding(dailyCreditsInAvailableRange, current.usedPercent)
    },
    notes: [
      "当前周期从最近一次额度更新到网页数据最新日期；历史周期从该更新点向前按 7 天切分。",
      "daily-workspace-usage-counts 只有日粒度，因此更新日的 credits 不能精确拆分到小时。",
      "当前窗口比例优先使用当前窗口 credits ÷ 最近完成周期的预估周限额；没有历史完整周期时才回退到本地 used_percent。"
    ]
  };
}

export async function readDailyJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function waitForCapture(page, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for the authenticated daily usage response.")), timeoutMs);
    page.__codexCreditCapture = (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    };
  });
}

export async function fetchDailyUsageWithBrowser({
  profileDir = expandHome("~/.codex-credit-stats/browser-profile"),
  headed = true,
  loginWaitMs = 180000
} = {}) {
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !headed,
    viewport: null
  });
  const page = context.pages()[0] ?? await context.newPage();

  const responseHandler = async (response) => {
    if (!response.url().includes(DAILY_USAGE_PATH) || response.status() !== 200) return;
    try {
      const payload = await response.json();
      if (Array.isArray(payload?.data)) page.__codexCreditCapture?.(payload);
    } catch {
      // Ignore unrelated or incomplete response bodies.
    }
  };
  page.on("response", responseHandler);

  try {
    let capture = waitForCapture(page, 20000);
    await page.goto(ANALYTICS_URL, { waitUntil: "domcontentloaded" });
    try {
      return await capture;
    } catch {
      if (!headed) throw new Error("未登录或未捕获 analytics 响应；请先用 headed 模式完成登录。");
      console.error("请在弹出的 Codex 浏览器窗口中登录 ChatGPT。登录完成后回到终端按 Enter 继续。");
      await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once("data", resolve);
      });
      capture = waitForCapture(page, loginWaitMs);
      await page.reload({ waitUntil: "domcontentloaded" });
      return await capture;
    }
  } finally {
    page.off("response", responseHandler);
    await context.close();
  }
}

export function formatReport(report) {
  const number = (value) => value == null ? "n/a" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const cycles = report.cycles ?? report.estimates?.cycles ?? [];
  const lines = [
    "Codex credit estimate",
    `daily data: ${report.daily?.availableFrom ?? "n/a"} .. ${report.daily?.availableTo ?? "n/a"}`,
    `daily credits: ${number(report.daily?.creditsInAvailableRange ?? report.daily?.creditsInRequestedRange)}`,
    `current window used: ${report.local?.currentWindowLatest?.usedPercent ?? "n/a"}%`,
    "",
    "cycle estimates:",
    ...cycles.map((cycle) => `  ${cycle.label}: ${number(cycle.estimate?.impliedWeeklyCredits)} credits/week (${cycle.usedPercent ?? "n/a"}% used)`),
    "",
    ...(report.notes ?? []).map((note) => `note: ${note}`)
  ];
  return lines.join("\n");
}
