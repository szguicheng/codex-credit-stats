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
const WEEK_WINDOW_MINUTES = 10080;
const FIVE_HOUR_WINDOW_MINUTES = 300;
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
      const rateLimits = payload.rate_limits;
      if (record.type !== "event_msg" || payload.type !== "token_count" || !rateLimits) continue;

      const timestamp = record.timestamp ?? null;
      if (!timestamp) continue;

      for (const slot of ["primary", "secondary"]) {
        const limit = rateLimits[slot];
        if (!limit) continue;

        const usedPercent = Number(limit.used_percent);
        const windowMinutes = Number(limit.window_minutes);
        const resetsAt = Number(limit.resets_at);
        if (!Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes) || !Number.isFinite(resetsAt)) continue;

        snapshots.push({
          file,
          sessionId: sessionMeta?.id ?? null,
          timestamp,
          slot,
          limitId: rateLimits.limit_id ?? null,
          planType: rateLimits.plan_type ?? null,
          usedPercent,
          windowMinutes,
          resetsAt
        });
      }
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

function selectWindowSnapshots(snapshots, windowMinutes) {
  const candidates = snapshots.filter((snapshot) => snapshot.windowMinutes === windowMinutes);
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
    snapshotCount: candidates.length,
    windowMinutes,
    snapshotCandidates: candidates
  };
}

function summarizeWindow(selected) {
  if (!selected?.currentWindowLatest) return null;
  const latest = selected.currentWindowLatest;
  return {
    windowMinutes: selected.windowMinutes,
    snapshotCount: selected.snapshotCount,
    currentReset: selected.currentReset,
    currentWindowStartEpoch: selected.currentWindowStartEpoch,
    currentWindowStart: selected.currentWindowStart,
    latest,
    usedPercent: latest.usedPercent,
    remainingPercent: Math.max(0, 100 - latest.usedPercent)
  };
}

function dateDifferenceInclusive(fromDate, toDate) {
  if (!fromDate || !toDate || fromDate > toDate) return 0;
  const from = Date.parse(`${fromDate}T12:00:00Z`);
  const to = Date.parse(`${toDate}T12:00:00Z`);
  return Math.round((to - from) / 86400000) + 1;
}

function timeZoneOffsetMilliseconds(value, timeZone) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return representedAsUtc - date.getTime();
}

function dayStartEpoch(isoDate, timeZone) {
  const utcMidnight = Date.parse(`${isoDate}T00:00:00Z`);
  let epoch = utcMidnight - timeZoneOffsetMilliseconds(utcMidnight, timeZone);
  epoch = utcMidnight - timeZoneOffsetMilliseconds(epoch, timeZone);
  return epoch / 1000;
}

function integrateDailyCredits(rows, startEpoch, endEpoch, timeZone) {
  let prorated = 0;
  let fullDays = 0;
  let overlappingDays = 0;

  for (const row of rows) {
    const dayStart = dayStartEpoch(row.date, timeZone);
    const dayEnd = dayStartEpoch(addDays(row.date, 1), timeZone);
    const overlap = Math.max(0, Math.min(dayEnd, endEpoch) - Math.max(dayStart, startEpoch));
    if (overlap <= 0) continue;

    prorated += row.credits * (overlap / (dayEnd - dayStart));
    overlappingDays += row.credits;
    if (startEpoch <= dayStart && endEpoch >= dayEnd) fullDays += row.credits;
  }

  return {
    prorated,
    lower: fullDays,
    upper: overlappingDays
  };
}

function clusterRateLimitCohorts(snapshots, planType) {
  const positive = snapshots
    .filter((snapshot) => snapshot.usedPercent > 0 && (!planType || !snapshot.planType || snapshot.planType === planType))
    .sort((a, b) => a.resetsAt - b.resetsAt || a.timestamp.localeCompare(b.timestamp));
  const groups = [];

  for (const snapshot of positive) {
    let group = groups.at(-1);
    if (!group || snapshot.resetsAt - group.maxReset > RESET_TOLERANCE_SECONDS) {
      group = { minReset: snapshot.resetsAt, maxReset: snapshot.resetsAt, snapshots: [] };
      groups.push(group);
    }
    group.maxReset = Math.max(group.maxReset, snapshot.resetsAt);
    group.snapshots.push(snapshot);
  }

  return groups.map((group) => {
    let peak = group.snapshots[0];
    for (const snapshot of group.snapshots) {
      if (snapshot.usedPercent > peak.usedPercent || (
        snapshot.usedPercent === peak.usedPercent && snapshot.timestamp > peak.timestamp
      )) peak = snapshot;
    }
    return {
      resetEpoch: Math.round((group.minReset + group.maxReset) / 2),
      minReset: group.minReset,
      maxReset: group.maxReset,
      usedPercent: peak.usedPercent,
      observation: peak,
      snapshotCount: group.snapshots.length
    };
  });
}

function makeHistoricalCohortCycle({ cohort, rows, timeZone }) {
  const startEpoch = cohort.resetEpoch - WEEK_SECONDS;
  const observationEpoch = Math.min(Date.parse(cohort.observation.timestamp) / 1000, cohort.resetEpoch);
  const fromDate = dateInTimeZone(startEpoch * 1000, timeZone);
  const toDate = dateInTimeZone(observationEpoch * 1000, timeZone);
  const coverage = integrateDailyCredits(rows, startEpoch, observationEpoch, timeZone);
  const estimate = estimateWithRounding(coverage.prorated, cohort.usedPercent);

  return {
    id: `cohort-${cohort.resetEpoch}`,
    kind: "observed-window",
    fromDate,
    toDate,
    durationDays: dateDifferenceInclusive(fromDate, toDate),
    credits: coverage.prorated,
    creditsRange: { lower: coverage.lower, upper: coverage.upper },
    creditMethod: "prorated-boundary-days",
    usedPercent: cohort.usedPercent,
    estimate,
    snapshotTimestamp: cohort.observation.timestamp,
    snapshotResetsAt: cohort.resetEpoch,
    snapshotCount: cohort.snapshotCount,
    hasDailyData: coverage.upper > 0,
    label: `${fromDate} → ${toDate}`
  };
}

function weightedReferenceEstimate(cycles) {
  if (!cycles.length) return null;
  const sorted = [...cycles].sort((a, b) => a.estimate.impliedWeeklyCredits - b.estimate.impliedWeeklyCredits);
  const median = sorted[Math.floor(sorted.length / 2)].estimate.impliedWeeklyCredits;
  const aligned = sorted.filter((cycle) => {
    const value = cycle.estimate.impliedWeeklyCredits;
    return value >= median * 0.5 && value <= median * 2;
  });
  const totalWeight = aligned.reduce((sum, cycle) => sum + cycle.usedPercent, 0);
  if (!(totalWeight > 0)) return null;
  const weighted = (selector) => aligned.reduce((sum, cycle) => sum + selector(cycle) * cycle.usedPercent, 0) / totalWeight;

  return {
    impliedWeeklyCredits: weighted((cycle) => cycle.estimate.impliedWeeklyCredits),
    roundingRange: {
      lower: weighted((cycle) => cycle.estimate.roundingRange.lower),
      upper: weighted((cycle) => cycle.estimate.roundingRange.upper)
    },
    cohortCount: aligned.length,
    usedPercentWeight: totalWeight,
    cycleIds: aligned.map((cycle) => cycle.id)
  };
}

function buildAlignedCreditCycles(rows, selected, timeZone) {
  if (!selected?.currentWindowLatest || selected.currentWindowStartEpoch == null || !rows.length) {
    return { cycles: [], reference: null, currentCycle: null, historicalCycles: [] };
  }

  const oldestDate = rows[0].date;
  const latestDate = rows.at(-1).date;
  const current = selected.currentWindowLatest;
  const currentPlan = current.planType ?? null;
  const cohorts = clusterRateLimitCohorts(selected.snapshotCandidates, currentPlan);
  const historicalCycles = cohorts
    .filter((cohort) => Math.abs(cohort.resetEpoch - selected.currentReset) > RESET_TOLERANCE_SECONDS)
    .map((cohort) => makeHistoricalCohortCycle({ cohort, rows, timeZone }))
    .filter((cycle) => cycle.fromDate >= oldestDate && cycle.toDate <= latestDate && cycle.estimate);

  const reliable = historicalCycles
    .filter((cycle) => cycle.usedPercent >= 5)
    .slice(-6);
  const reference = weightedReferenceEstimate(reliable);
  const visibleHistorical = historicalCycles
    .filter((cycle) => cycle.usedPercent >= 3)
    .filter((cycle) => {
      if (!reference) return true;
      const value = cycle.estimate.impliedWeeklyCredits;
      return value >= reference.impliedWeeklyCredits * 0.4 && value <= reference.impliedWeeklyCredits * 2.5;
    })
    .slice(-7);

  const currentFromDate = dateInTimeZone(selected.currentWindowStartEpoch * 1000, timeZone);
  const currentToDate = latestDate >= currentFromDate ? latestDate : currentFromDate;
  const currentCredits = current.usedPercent > 0
    ? sumDailyCredits(rows, currentFromDate, currentToDate)
    : 0;
  const currentObservationEpoch = Date.parse(current.timestamp) / 1000;
  const currentCoverage = integrateDailyCredits(
    rows,
    selected.currentWindowStartEpoch,
    currentObservationEpoch,
    timeZone
  );
  const currentCycle = {
    id: "current",
    kind: "current",
    fromDate: currentFromDate,
    toDate: currentToDate,
    durationDays: dateDifferenceInclusive(currentFromDate, currentToDate),
    credits: currentCredits,
    creditsRange: { lower: currentCoverage.lower, upper: currentCoverage.upper },
    alignedCredits: currentCoverage.prorated,
    creditMethod: "daily-upper-bound",
    usedPercent: current.usedPercent,
    estimate: estimateWithRounding(currentCredits, current.usedPercent),
    snapshotTimestamp: current.timestamp,
    snapshotResetsAt: current.resetsAt,
    hasDailyData: currentCredits > 0,
    label: `${currentFromDate} → ${currentToDate} · 当前`
  };
  const cycles = [...visibleHistorical, currentCycle];
  cycles.forEach((cycle, index) => {
    cycle.indexFromLatest = cycles.length - index - 1;
  });

  return { cycles, reference, currentCycle, historicalCycles };
}

export function estimateWeeklyCredits({ dailyRows, snapshots, timeZone }) {
  const rows = parseDailyUsage(dailyRows);
  const resolvedTimeZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dailyCreditsInAvailableRange = rows.reduce((sum, row) => sum + row.credits, 0);
  const selected = selectWindowSnapshots(snapshots, WEEK_WINDOW_MINUTES);
  const fiveHourSelected = selectWindowSnapshots(snapshots, FIVE_HOUR_WINDOW_MINUTES);
  const fiveHourWindow = summarizeWindow(fiveHourSelected);

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
      local: {
        filesRead: new Set(snapshots.map((snapshot) => snapshot.file)).size,
        snapshotCount: snapshots.length,
        weeklySnapshotCount: 0,
        fiveHourSnapshotCount: fiveHourSelected?.snapshotCount ?? 0,
        weeklyWindow: null,
        fiveHourWindow
      },
      cycles: [],
      estimates: { cycles: [] },
      message: "没有找到本地 Codex session 的 weekly rate-limit snapshot。"
    };
  }

  const current = selected.currentWindowLatest;
  const aligned = buildAlignedCreditCycles(rows, selected, resolvedTimeZone);
  const { cycles, currentCycle, historicalCycles } = aligned;
  const previousCycle = historicalCycles.at(-1) ?? null;
  const referenceEstimate = aligned.reference ?? currentCycle?.estimate ?? null;
  const referenceQuota = referenceEstimate?.impliedWeeklyCredits
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
    method: "aligned-rate-limit-cohorts",
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
      weeklySnapshotCount: selected.snapshotCount,
      fiveHourSnapshotCount: fiveHourSelected?.snapshotCount ?? 0,
      weeklyWindow: summarizeWindow(selected),
      fiveHourWindow,
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
      latest: referenceEstimate,
      reference: referenceEstimate,
      referenceWindowCount: aligned.reference?.cohortCount ?? 0,
      previousWindowApprox: previousCycle?.estimate ?? null,
      currentWindowApprox: currentCycle?.estimate ?? null,
      currentWindow: {
        usedCredits: currentWindowCredits,
        referenceQuota,
        referenceCycle: aligned.reference
          ? `${aligned.reference.cohortCount} 个已对齐历史窗口`
          : null,
        usedPercent: currentWindowUsedPercent,
        remainingPercent: currentWindowRemainingPercent,
        remainingCredits: currentWindowRemainingCredits,
        source: aligned.reference ? "aligned-historical-cohorts" : "current-cohort-fallback"
      },
      naiveRequestedRange: estimateWithRounding(dailyCreditsInAvailableRange, current.usedPercent)
    },
    notes: [
      "历史估计按真实 resets_at cohort 对齐，不再从最新重置点机械向前切分固定自然日周期。",
      "历史窗口的起止边界日按时间占比折算；daily-workspace-usage-counts 只有日粒度，因此结果仍是估计值。",
      "当前窗口比例使用当前窗口日用量 ÷ 多个可靠历史窗口的加权周限额；没有可靠历史窗口时回退到当前 cohort。"
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
