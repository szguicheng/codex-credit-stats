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
