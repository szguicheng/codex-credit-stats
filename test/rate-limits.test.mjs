import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { estimateWeeklyCredits, readSessionSnapshots } from "../src/index.mjs";

test("reads old weekly-primary and new five-hour-primary plus weekly-secondary snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-credit-stats-"));
  const sessionsDir = path.join(root, "sessions");
  await mkdir(sessionsDir);

  const records = [
    {
      timestamp: "2026-08-25T11:46:48.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          plan_type: "plus",
          primary: { used_percent: 5, window_minutes: 10080, resets_at: 1788143514 },
          secondary: null
        }
      }
    },
    {
      timestamp: "2026-08-25T14:22:42.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          plan_type: "plus",
          primary: { used_percent: 4, window_minutes: 300, resets_at: 1787685764 },
          secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1788272564 }
        }
      }
    }
  ];
  await writeFile(path.join(sessionsDir, "plus.jsonl"), `${records.map(JSON.stringify).join("\n")}\n`);

  const { snapshots } = await readSessionSnapshots(sessionsDir);
  assert.equal(snapshots.length, 3);
  assert.deepEqual(snapshots.map(({ slot, windowMinutes }) => [slot, windowMinutes]), [
    ["primary", 10080],
    ["primary", 300],
    ["secondary", 10080]
  ]);

  const report = estimateWeeklyCredits({
    dailyRows: [
      { date: "2026-08-24", totals: { credits: 200 } },
      { date: "2026-08-25", totals: { credits: 100 } }
    ],
    snapshots,
    timeZone: "Asia/Shanghai"
  });

  assert.equal(report.local.currentReset, 1788272564);
  assert.equal(report.local.boundaryResetDate, "2026-08-25");
  assert.equal(report.local.currentWindowLatest.slot, "secondary");
  assert.equal(report.local.weeklySnapshotCount, 2);
  assert.equal(report.local.fiveHourSnapshotCount, 1);
  assert.equal(report.local.fiveHourWindow.usedPercent, 4);
  assert.equal(report.local.fiveHourWindow.remainingPercent, 96);
  assert.equal(report.local.fiveHourWindow.currentReset, 1787685764);
});

test("aligns historical credits with their actual reset cohort", () => {
  const historicalReset = Date.parse("2026-08-08T00:00:00+08:00") / 1000;
  const currentReset = Date.parse("2026-08-16T00:00:00+08:00") / 1000;
  const snapshots = [
    {
      file: "historical.jsonl",
      timestamp: "2026-08-07T15:59:00.000Z",
      slot: "primary",
      planType: "pro",
      usedPercent: 20,
      windowMinutes: 10080,
      resetsAt: historicalReset
    },
    {
      file: "current.jsonl",
      timestamp: "2026-08-09T15:00:00.000Z",
      slot: "primary",
      planType: "pro",
      usedPercent: 2,
      windowMinutes: 10080,
      resetsAt: currentReset
    }
  ];
  const dailyRows = [
    ...Array.from({ length: 7 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      totals: { credits: 1000 }
    })),
    { date: "2026-08-09", totals: { credits: 700 } }
  ];

  const report = estimateWeeklyCredits({ dailyRows, snapshots, timeZone: "Asia/Shanghai" });

  assert.equal(report.method, "aligned-rate-limit-cohorts");
  assert.equal(report.estimates.referenceWindowCount, 1);
  assert.ok(Math.abs(report.estimates.reference.impliedWeeklyCredits - 35000) < 10);
  assert.equal(report.estimates.currentWindow.usedCredits, 700);
  assert.ok(Math.abs(report.estimates.currentWindow.usedPercent - 2) < 0.01);
  assert.equal(report.cycles[0].fromDate, "2026-08-01");
  assert.equal(report.cycles[0].toDate, "2026-08-07");
});
