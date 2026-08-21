# Codex Credit Stats

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

![Codex Credit Stats dashboard preview](docs/dashboard-preview.jpg)

Codex Credit Stats is a local web tool for estimating your Codex weekly credit limit from your actual usage. It shows the estimated limit for each usage cycle, daily credit usage, current-window remaining credits, and reference amounts for common plans.

## Install

Requirements: Node.js 20 or later.

```bash
git clone https://github.com/szguicheng/codex-credit-stats.git
cd codex-credit-stats
npm install
npm start
```

The tool opens a local page in your browser. Click **Connect ChatGPT and refresh**, then sign in to ChatGPT in the browser window if needed.

## Purpose

The tool helps you understand how many Codex credits your current usage pattern implies for a weekly limit. It provides:

- an estimated weekly limit for each seven-day usage cycle;
- a horizontal connected-dot chart for comparing cycles;
- total credits used and a daily breakdown;
- the remaining percentage and estimated remaining credits in the current window;
- reference amounts for Pro 20x, Pro 5x, and Plus plans.

## How it works

1. Start the local web tool and connect it to ChatGPT through the browser.
2. After ChatGPT is authenticated, the tool obtains the daily usage totals from the analytics page.
3. It combines those totals with the local Codex session usage records.
4. It treats each earlier quota update as a boundary, groups history into seven-day cycles, and treats the latest update-to-date period as the current cycle.
5. It estimates the weekly limit for each cycle and presents the result in the dashboard.

## Information it reads

The tool reads two categories of personal information:

1. **ChatGPT analytics usage** — the daily Codex credits reported by your ChatGPT analytics page. If the analytics page provides a plan label, it is used only for an optional reference comparison.
2. **Local Codex session usage** — the usage percentage and reset time recorded in your local Codex session files, normally under `~/.codex/sessions`.

These two sources are used to calculate the estimated weekly limit and current remaining credits.
