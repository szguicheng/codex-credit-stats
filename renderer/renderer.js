const state = { busy: false, report: null };

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

function number(value, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

function percent(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`;
}

function setStatus(message, mode = "idle") {
  const banner = $("statusBanner");
  banner.className = `status-banner ${mode}`;
  banner.textContent = message;
  const pill = $("connectionPill");
  pill.className = `connection-pill ${mode === "ready" ? "ready" : mode === "busy" ? "busy" : "idle"}`;
  pill.textContent = mode === "ready" ? "已连接" : mode === "busy" ? "处理中" : "未连接";
}

function setBusy(busy) {
  state.busy = busy;
  $("refreshButton").disabled = busy;
}

function localDateTime(epoch, timeZone) {
  if (!epoch) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(Number(epoch) * 1000));
}

function shortDate(iso) {
  return iso ? iso.slice(5) : "—";
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function renderDailyChart(rows) {
  const chart = $("dailyChart");
  chart.textContent = "";
  if (!rows?.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "当前没有服务端日用量记录。";
    chart.append(empty);
    return;
  }

  const max = Math.max(...rows.map((row) => Number(row.credits) || 0), 1);
  for (const row of rows) {
    const wrapper = document.createElement("div");
    wrapper.className = "bar-row";
    const date = document.createElement("span");
    date.className = "bar-date";
    date.textContent = shortDate(row.date);
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max(2, ((Number(row.credits) || 0) / max) * 100)}%`;
    track.append(fill);
    const value = document.createElement("span");
    value.className = "bar-value";
    value.textContent = number(row.credits, 0);
    wrapper.append(date, track, value);
    chart.append(wrapper);
  }
}

function renderCycleChart(cycles, references = []) {
  const svg = $("cycleChart");
  const empty = $("cycleChartEmpty");
  const points = (cycles || []).filter((cycle) => cycle.estimate?.impliedWeeklyCredits > 0);
  svg.textContent = "";
  if (!points.length) {
    svg.style.display = "none";
    empty.style.display = "block";
    $("cycleLegend").textContent = "";
    $("cycleDetails").textContent = "";
    return;
  }

  svg.style.display = "block";
  empty.style.display = "none";
  const width = Math.max(760, svg.parentElement.clientWidth || 960);
  const height = 360;
  const margin = { top: 28, right: 116, bottom: 78, left: 76 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const referenceValues = references.map((reference) => Number(reference.credits)).filter((value) => value > 0);
  const values = points.map((point) => Number(point.estimate.impliedWeeklyCredits));
  const allValues = [...values, ...referenceValues];
  let minValue = Math.min(...allValues);
  let maxValue = Math.max(...allValues);
  if (minValue === maxValue) {
    minValue = Math.max(0, minValue * 0.8);
    maxValue *= 1.2;
  } else {
    const padding = (maxValue - minValue) * 0.12;
    minValue = Math.max(0, minValue - padding);
    maxValue += padding;
  }

  const x = (index) => points.length === 1
    ? margin.left + plotWidth / 2
    : margin.left + (index / (points.length - 1)) * plotWidth;
  const y = (value) => margin.top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  const tickCount = 5;
  const grid = svgElement("g", { class: "cycle-grid" });
  for (let index = 0; index <= tickCount; index += 1) {
    const value = minValue + ((maxValue - minValue) * index) / tickCount;
    const yPosition = y(value);
    grid.append(
      svgElement("line", { x1: margin.left, y1: yPosition, x2: width - margin.right, y2: yPosition }),
      svgElement("text", { x: margin.left - 12, y: yPosition + 4, "text-anchor": "end" })
    );
    grid.lastChild.textContent = number(value, 0);
  }
  svg.append(grid);

  const frame = svgElement("rect", {
    x: margin.left,
    y: margin.top,
    width: plotWidth,
    height: plotHeight,
    class: "cycle-frame"
  });
  svg.append(frame);

  const axisTitles = svgElement("g", { class: "axis-titles" });
  const yTitle = svgElement("text", { x: 16, y: margin.top + plotHeight / 2, class: "axis-title", "data-axis": "y", transform: `rotate(-90 16 ${margin.top + plotHeight / 2})` });
  yTitle.textContent = "预估周限额（credits/week）";
  const xTitle = svgElement("text", { x: margin.left + plotWidth / 2, y: height - 8, class: "axis-title", "data-axis": "x", "text-anchor": "middle" });
  xTitle.textContent = "周期（从旧到新）";
  axisTitles.append(yTitle, xTitle);
  svg.append(axisTitles);

  const referenceLayer = svgElement("g", { class: "reference-layer" });
  for (const reference of references) {
    const value = Number(reference.credits);
    if (!(value >= minValue && value <= maxValue)) continue;
    const yPosition = y(value);
    referenceLayer.append(svgElement("line", { x1: margin.left, y1: yPosition, x2: width - margin.right, y2: yPosition, class: "reference-line" }));
    const label = svgElement("text", { x: width - margin.right + 10, y: yPosition + 4, class: "reference-label" });
    label.textContent = reference.label;
    referenceLayer.append(label);
  }
  svg.append(referenceLayer);

  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(point.estimate.impliedWeeklyCredits)}`).join(" ");
  svg.append(svgElement("path", { d: linePath, class: "cycle-line" }));

  const pointLayer = svgElement("g", { class: "point-layer" });
  points.forEach((point, index) => {
    const pointX = x(index);
    const pointY = y(point.estimate.impliedWeeklyCredits);
    const range = point.estimate.roundingRange;
    if (range?.lower > 0 && range?.upper > 0) {
      const lowY = y(Math.min(maxValue, range.upper));
      const highY = y(Math.max(minValue, range.lower));
      pointLayer.append(
        svgElement("line", { x1: pointX, y1: lowY, x2: pointX, y2: highY, class: "range-line" }),
        svgElement("line", { x1: pointX - 5, y1: lowY, x2: pointX + 5, y2: lowY, class: "range-cap" }),
        svgElement("line", { x1: pointX - 5, y1: highY, x2: pointX + 5, y2: highY, class: "range-cap" })
      );
    }
    const group = svgElement("g", { class: point.kind === "current" ? "cycle-point current" : "cycle-point" });
    const title = svgElement("title");
    title.textContent = `${point.label}：${number(point.estimate.impliedWeeklyCredits, 0)} credits/week，${point.usedPercent ?? "—"}% used`;
    group.append(
      svgElement("circle", { cx: pointX, cy: pointY, r: 11, class: "point-halo" }),
      svgElement("circle", { cx: pointX, cy: pointY, r: 6, class: "point-mark" }),
      title
    );
    const valueLabel = svgElement("text", { x: pointX, y: pointY - 15, class: "point-value", "text-anchor": "middle" });
    valueLabel.textContent = number(point.estimate.impliedWeeklyCredits, 0);
    group.append(valueLabel);
    const dateLabel = svgElement("text", { x: pointX, y: height - margin.bottom + 23, class: "point-date", "text-anchor": "middle" });
    dateLabel.textContent = point.kind === "current" ? `${shortDate(point.fromDate)}–今` : `${shortDate(point.fromDate)}–${shortDate(point.toDate)}`;
    group.append(dateLabel);
    pointLayer.append(group);
  });
  svg.append(pointLayer);

  const legend = $("cycleLegend");
  legend.textContent = "";
  const legendItems = [
    ["cycle-estimate", "周期估计"],
    ["cycle-range", "±0.5 个百分点取整范围"],
    ["cycle-reference", "套餐参考线"]
  ];
  for (const [className, label] of legendItems) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("i");
    swatch.className = `legend-swatch ${className}`;
    item.append(swatch, document.createTextNode(label));
    legend.append(item);
  }

  const details = $("cycleDetails");
  details.textContent = "";
  for (const point of points) {
    const detail = document.createElement("div");
    detail.className = `cycle-detail ${point.kind === "current" ? "current" : ""}`;
    detail.innerHTML = `<span class="cycle-detail-date">${point.label}</span><strong>${number(point.estimate.impliedWeeklyCredits, 0)}</strong><small>${point.durationDays} 天 · ${point.usedPercent ?? "—"}% used</small>`;
    details.append(detail);
  }
}

function renderPlanReferences(report, latestEstimate) {
  const references = report.planReferences || [];
  const detected = report.plan;
  const rows = $("planRows");
  rows.textContent = "";
  if (!references.length) return;

  if (detected?.id) {
    const ratio = latestEstimate?.impliedWeeklyCredits && detected.credits
      ? (latestEstimate.impliedWeeklyCredits / detected.credits) * 100
      : null;
    $("planStatus").textContent = `analytics 识别到 ${detected.label} · 最近周期估计约为参考额度的 ${percent(ratio)}`;
  } else if (detected?.label) {
    $("planStatus").textContent = `analytics 识别到 ${detected.label}，但没有匹配具体倍率；以下为静态参考值。`;
  } else {
    $("planStatus").textContent = "未从 analytics 识别具体套餐，以下为静态参考值。";
  }

  for (const reference of references) {
    const row = document.createElement("div");
    row.className = `plan-row ${detected?.id === reference.id ? "selected" : ""}`;
    const ratio = detected?.id === reference.id && latestEstimate?.impliedWeeklyCredits
      ? `${percent((latestEstimate.impliedWeeklyCredits / reference.credits) * 100)} · 最近周期估计`
      : "对比待定";
    row.innerHTML = `<div><strong>${reference.label}</strong><span>参考 ${reference.displayCredits} credits/week</span></div><b>${ratio}</b>`;
    rows.append(row);
  }
}

function renderReport(report) {
  state.report = report;
  const cycles = report.cycles || report.estimates?.cycles || [];
  const latestCycle = cycles.at(-1);
  const latestEstimate = report.estimates?.latest || latestCycle?.estimate;
  const current = report.local?.currentWindowLatest;
  const timeZone = report.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const range = latestEstimate?.roundingRange;
  const usedPercent = current?.usedPercent;
  const remaining = usedPercent == null ? null : Math.max(0, 100 - Number(usedPercent));
  const currentEstimate = report.estimates?.currentWindowApprox || latestEstimate;
  const remainingCredits = remaining == null || !currentEstimate?.impliedWeeklyCredits
    ? null
    : currentEstimate.impliedWeeklyCredits * (remaining / 100);

  $("weeklyLimit").textContent = number(latestEstimate?.impliedWeeklyCredits, 0);
  $("estimateCaption").textContent = latestCycle
    ? `${latestCycle.fromDate} → ${latestCycle.toDate}${latestCycle.kind === "current" ? " · 当前周期" : ""}`
    : "尚未形成可估算周期";
  $("confidenceRange").textContent = range ? `${number(range.lower, 0)} – ${number(range.upper, 0)}` : "—";
  $("currentRemaining").textContent = percent(remaining);
  $("usageProgress").style.width = `${Math.min(100, Math.max(0, Number(usedPercent) || 0))}%`;
  $("currentUsedLabel").textContent = usedPercent == null ? "已使用 —" : `已使用 ${percent(usedPercent)}`;
  $("currentRemainingCredits").textContent = remainingCredits == null ? "估算剩余 — credits" : `估算剩余 ${number(remainingCredits, 3)} credits`;
  $("resetDate").textContent = report.local?.boundaryResetDate || "—";
  $("nextResetDate").textContent = localDateTime(report.local?.currentReset, timeZone);
  $("dailyCredits").textContent = number(report.daily?.creditsInAvailableRange ?? report.daily?.creditsInRequestedRange);
  $("dailyCoverage").textContent = `${report.daily?.availableFrom || "—"} → ${report.daily?.availableTo || "—"}`;
  $("sourceLabel").textContent = report.source === "authenticated-browser" ? "页面已认证" : "未读取";
  $("chartTotal").textContent = `${number(report.daily?.creditsInAvailableRange ?? report.daily?.creditsInRequestedRange)} credits`;
  $("cycleSummary").textContent = `${cycles.filter((cycle) => cycle.estimate).length} 个可估算周期`;
  $("lastUpdated").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  renderCycleChart(cycles, report.planReferences);
  renderDailyChart(report.daily?.rows);
  renderPlanReferences(report, latestEstimate);
  setStatus("统计完成。周期估计已更新。", "ready");
}

async function run() {
  if (state.busy) return;
  setBusy(true);
  setStatus("正在打开外部浏览器并连接 ChatGPT analytics…", "busy");
  try {
    const response = await fetch("/api/sync", { method: "POST" });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || "无法启动统计刷新。");
    }
  } catch (error) {
    setStatus(error?.message || "统计失败，请重试。", "error");
    setBusy(false);
  } finally {
    // The server-sent state event releases the button when the job finishes.
  }
}

function applyServerState(snapshot) {
  setBusy(Boolean(snapshot.busy));
  if (snapshot.report) renderReport(snapshot.report);
  if (snapshot.status?.message && !(snapshot.report && snapshot.status.mode === "ready")) {
    setStatus(snapshot.status.message, snapshot.status.mode || "idle");
  }
}

async function connectToServer() {
  const response = await fetch("/api/state", { cache: "no-store" });
  if (!response.ok) throw new Error("请从 npm start 自动打开的 localhost 页面访问此工具。");
  applyServerState(await response.json());
  const events = new EventSource("/api/events");
  events.addEventListener("state", (event) => applyServerState(JSON.parse(event.data)));
  events.onerror = () => {
    if (!state.busy) setStatus("localhost 服务连接中断，请检查启动终端。", "error");
  };
}

$("refreshButton").addEventListener("click", run);
window.addEventListener("resize", () => {
  if (state.report) renderCycleChart(state.report.cycles, state.report.planReferences);
});

setStatus("正在连接 localhost 服务…", "busy");
connectToServer().catch((error) => setStatus(error.message, "error"));
