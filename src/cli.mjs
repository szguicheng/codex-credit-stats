#!/usr/bin/env node

import {
  estimateWeeklyCredits,
  expandHome,
  fetchDailyUsageWithBrowser,
  formatReport,
  readDailyJson,
  readSessionSnapshots,
  todayIso
} from "./index.mjs";

function parseArgs(argv) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const args = {
    from: null,
    to: todayIso(timeZone),
    timeZone,
    sessionsDir: expandHome("~/.codex/sessions"),
    profileDir: expandHome("~/.codex-credit-stats/browser-profile"),
    dailyJson: null,
    json: false,
    headless: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--from") args.from = argv[++index];
    else if (value === "--to") args.to = argv[++index];
    else if (value === "--timezone") args.timeZone = argv[++index];
    else if (value === "--sessions-dir") args.sessionsDir = expandHome(argv[++index]);
    else if (value === "--profile-dir") args.profileDir = expandHome(argv[++index]);
    else if (value === "--daily-json") args.dailyJson = expandHome(argv[++index]);
    else if (value === "--json") args.json = true;
    else if (value === "--headless") args.headless = true;
    else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }

  if (!args.from) {
    const today = new Date(`${args.to}T12:00:00Z`);
    today.setUTCDate(today.getUTCDate() - 30);
    args.from = today.toISOString().slice(0, 10);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  codex-credit-stats [options]

Options:
  --from YYYY-MM-DD       First daily date to include
  --to YYYY-MM-DD         Last daily date to include (default: today)
  --timezone IANA_NAME    Timezone used to map reset timestamps to API dates
  --daily-json FILE       Use a saved analytics JSON response instead of opening a browser
  --sessions-dir DIR      Codex sessions directory (default: ~/.codex/sessions)
  --profile-dir DIR       Dedicated persistent browser profile for ChatGPT login
  --headless              Do not show a browser; fails if login is required
  --json                  Print the machine-readable report
  --help                  Show this help
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const payload = options.dailyJson
    ? await readDailyJson(options.dailyJson)
    : await fetchDailyUsageWithBrowser({
        profileDir: options.profileDir,
        headed: !options.headless
      });
  const { snapshots } = await readSessionSnapshots(options.sessionsDir);
  const report = estimateWeeklyCredits({
    dailyRows: payload,
    snapshots,
    fromDate: options.from,
    toDate: options.to,
    timeZone: options.timeZone
  });

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
