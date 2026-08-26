const state = { busy: false, report: null };

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

function number(value, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

function percent(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `${Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}%`;
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

function renderCycleChart(cycles, references = [], dailyRows = []) {
  const svg = $("cycleChart");
  const empty = $("cycleChartEmpty");
  const points = (cycles || []).filter((cycle) => cycle.estimate?.impliedWeeklyCredits > 0);
  const daily = (dailyRows || []).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number(row.credits) >= 0);
  svg.textContent = "";
  if (!points.length && !daily.length) {
    svg.style.display = "none";
    empty.style.display = "block";
    $("cycleLegend").textContent = "";
    $("cycleDetails").textContent = "";
    return;
  }

  svg.style.display = "block";
  empty.style.display = "none";
  const width = Math.max(760, svg.parentElement.clientWidth || 960);
  const height = svg.clientHeight || 270;
  const margin = { top: 24, right: 88, bottom: 44, left: 88 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const values = points.map((point) => Number(point.estimate.impliedWeeklyCredits));
  const targetTickCount = 5;
  let minValue = values.length ? Math.min(...values) : 0;
  let maxValue = values.length ? Math.max(...values) : 1;
  if (minValue === maxValue) {
    minValue = Math.max(0, minValue * 0.8);
    maxValue *= 1.2;
  } else {
    const padding = (maxValue - minValue) * 0.12;
    minValue = Math.max(0, minValue - padding);
    maxValue += padding;
  }

  const roughStep = (maxValue - minValue) / targetTickCount;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(roughStep, Number.EPSILON)));
  const normalizedStep = roughStep / magnitude;
  const niceMultiplier = normalizedStep <= 1 ? 1 : normalizedStep <= 2 ? 2 : normalizedStep <= 5 ? 5 : 10;
  const niceStep = niceMultiplier * magnitude;
  minValue = Math.max(0, Math.floor(minValue / niceStep) * niceStep);
  maxValue = Math.ceil(maxValue / niceStep) * niceStep;
  const tickCount = Math.max(3, Math.min(7, Math.round((maxValue - minValue) / niceStep)));

  const dateEpoch = (iso) => Date.parse(`${iso}T12:00:00Z`);
  const dateEpochs = [
    ...daily.map((row) => dateEpoch(row.date)),
    ...points.map((point) => dateEpoch(point.toDate))
  ].filter(Number.isFinite);
  let minDate = Math.min(...dateEpochs);
  let maxDate = Math.max(...dateEpochs);
  if (minDate === maxDate) {
    minDate -= 43200000;
    maxDate += 43200000;
  }
  const x = (iso) => margin.left + ((dateEpoch(iso) - minDate) / (maxDate - minDate)) * plotWidth;
  const yLeft = (value) => margin.top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  const dailyMaxValue = Math.max(...daily.map((row) => Number(row.credits) || 0), 1);
  const dailyMagnitude = 10 ** Math.floor(Math.log10(dailyMaxValue));
  const dailyMax = Math.ceil((dailyMaxValue * 1.1) / dailyMagnitude) * dailyMagnitude;
  const yRight = (value) => margin.top + (1 - value / dailyMax) * plotHeight;
  const grid = svgElement("g", { class: "cycle-grid" });
  for (let index = 0; index <= tickCount; index += 1) {
    const value = minValue + ((maxValue - minValue) * index) / tickCount;
    const yPosition = yLeft(value);
    const dailyValue = dailyMax * (index / tickCount);
    grid.append(
      svgElement("line", { x1: margin.left, y1: yPosition, x2: width - margin.right, y2: yPosition }),
      svgElement("text", { x: margin.left - 10, y: yPosition + 4, "text-anchor": "end" }),
      svgElement("text", { x: width - margin.right + 10, y: yPosition + 4, class: "daily-axis-text", "text-anchor": "start" })
    );
    grid.children[grid.children.length - 2].textContent = number(value, 0);
    grid.lastChild.textContent = number(dailyValue, 0);
  }

  const xTickSource = daily.length ? daily : points.map((point) => ({ date: point.toDate }));
  const xTickIndexes = [...new Set(Array.from({ length: Math.min(6, xTickSource.length) }, (_, index) => (
    Math.round((index * (xTickSource.length - 1)) / Math.max(1, Math.min(6, xTickSource.length) - 1))
  )))];
  for (const index of xTickIndexes) {
    const date = xTickSource[index].date;
    const xPosition = x(date);
    grid.append(svgElement("line", { x1: xPosition, y1: margin.top + plotHeight, x2: xPosition, y2: margin.top + plotHeight + 5, class: "x-tick" }));
    const label = svgElement("text", { x: xPosition, y: height - 13, class: "point-date", "text-anchor": "middle" });
    label.textContent = shortDate(date);
    grid.append(label);
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
  const yTitle = svgElement("text", {
    x: 18,
    y: margin.top + plotHeight / 2,
    class: "axis-title",
    "data-axis": "y",
    "text-anchor": "middle",
    "dominant-baseline": "middle",
    transform: `rotate(-90 18 ${margin.top + plotHeight / 2})`
  });
  yTitle.textContent = "预估周限额（credits/week）";
  const rightTitle = svgElement("text", {
    x: width - 18,
    y: margin.top + plotHeight / 2,
    class: "axis-title daily-axis-title",
    "text-anchor": "middle",
    "dominant-baseline": "middle",
    transform: `rotate(90 ${width - 18} ${margin.top + plotHeight / 2})`
  });
  rightTitle.textContent = "每日使用量（credits/day）";
  axisTitles.append(yTitle, rightTitle);
  svg.append(axisTitles);

  const referenceLayer = svgElement("g", { class: "reference-layer" });
  for (const reference of references) {
    const value = Number(reference.credits);
    if (!(value >= minValue && value <= maxValue)) continue;
    const yPosition = yLeft(value);
    referenceLayer.append(svgElement("line", { x1: margin.left, y1: yPosition, x2: width - margin.right, y2: yPosition, class: "reference-line" }));
    const label = svgElement("text", { x: width - margin.right - 7, y: yPosition - 5, class: "reference-label", "text-anchor": "end" });
    label.textContent = reference.label;
    referenceLayer.append(label);
  }
  svg.append(referenceLayer);

  if (daily.length) {
    const baseline = margin.top + plotHeight;
    const dailyLinePath = daily.map((row, index) => `${index === 0 ? "M" : "L"} ${x(row.date)} ${yRight(row.credits)}`).join(" ");
    const dailyAreaPath = `${dailyLinePath} L ${x(daily.at(-1).date)} ${baseline} L ${x(daily[0].date)} ${baseline} Z`;
    svg.append(svgElement("path", { d: dailyAreaPath, class: "daily-area" }));
    svg.append(svgElement("path", { d: dailyLinePath, class: "daily-line" }));
    const dailyPointLayer = svgElement("g", { class: "daily-point-layer" });
    for (const row of daily) {
      const point = svgElement("circle", { cx: x(row.date), cy: yRight(row.credits), r: 2.5, class: "daily-point" });
      const title = svgElement("title");
      title.textContent = `${row.date}：${number(row.credits, 0)} credits`;
      point.append(title);
      dailyPointLayer.append(point);
    }
    svg.append(dailyPointLayer);
  }

  if (points.length) {
    const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${x(point.toDate)} ${yLeft(point.estimate.impliedWeeklyCredits)}`).join(" ");
    svg.append(svgElement("path", { d: linePath, class: "cycle-line" }));
  }

  const pointLayer = svgElement("g", { class: "point-layer" });
  points.forEach((point) => {
    const pointX = x(point.toDate);
    const pointY = yLeft(point.estimate.impliedWeeklyCredits);
    const range = point.estimate.roundingRange;
    if (range?.lower > 0 && range?.upper > 0) {
      const lowY = yLeft(Math.min(maxValue, range.upper));
      const highY = yLeft(Math.max(minValue, range.lower));
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
    pointLayer.append(group);
  });
  svg.append(pointLayer);

  const legend = $("cycleLegend");
  legend.textContent = "";
  const legendItems = [
    ["cycle-estimate", "周期估计"],
    ["cycle-range", "±0.5 个百分点取整范围"],
    ["cycle-reference", "套餐参考线"],
    ["daily-credits", "每日 credits（右轴）"]
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

function renderReport(report) {
  state.report = report;
  const cycles = report.cycles || report.estimates?.cycles || [];
  const latestCycle = cycles.at(-1);
  const latestEstimate = report.estimates?.reference || report.estimates?.latest || latestCycle?.estimate;
  const current = report.local?.currentWindowLatest;
  const currentWindow = report.estimates?.currentWindow;
  const timeZone = report.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const range = latestEstimate?.roundingRange;
  const fallbackUsedPercent = current?.usedPercent;
  const usedPercent = currentWindow?.usedPercent ?? fallbackUsedPercent;
  const remaining = currentWindow?.remainingPercent
    ?? (usedPercent == null ? null : Math.max(0, 100 - Number(usedPercent)));
  const currentEstimate = report.estimates?.currentWindowApprox || latestEstimate;
  const remainingCredits = currentWindow?.remainingCredits
    ?? (remaining == null || !currentEstimate?.impliedWeeklyCredits
      ? null
      : currentEstimate.impliedWeeklyCredits * (remaining / 100));

  $("weeklyLimit").textContent = number(latestEstimate?.impliedWeeklyCredits, 0);
  $("estimateCaption").textContent = report.estimates?.referenceWindowCount
    ? `基于 ${report.estimates.referenceWindowCount} 个已对齐历史窗口`
    : latestCycle
      ? `${latestCycle.fromDate} → ${latestCycle.toDate}${latestCycle.kind === "current" ? " · 当前周期" : ""}`
      : "尚未形成可估算周期";
  $("confidenceRange").textContent = range ? `${number(range.lower, 0)} – ${number(range.upper, 0)}` : "—";
  $("currentRemaining").textContent = percent(remaining, 3);
  $("usageProgress").style.width = `${Math.min(100, Math.max(0, Number(usedPercent) || 0))}%`;
  $("currentUsedLabel").textContent = usedPercent == null ? "已使用 —" : `已使用 ${percent(usedPercent, 3)}`;
  $("currentRemainingCredits").textContent = remainingCredits == null ? "估算剩余 — credits" : `估算剩余 ${number(remainingCredits, 0)} credits`;
  $("currentReferenceLabel").textContent = currentWindow?.referenceQuota == null
    ? "参考预估 — credits/week"
    : `参考预估 ${number(currentWindow.referenceQuota, 0)} credits/week`;
  $("resetDate").textContent = report.local?.boundaryResetDate || "—";
  $("nextResetDate").textContent = localDateTime(report.local?.currentReset, timeZone);
  const fiveHourWindow = report.local?.fiveHourWindow;
  $("fiveHourWindow").hidden = !fiveHourWindow;
  if (fiveHourWindow) {
    $("fiveHourRemaining").textContent = `${percent(fiveHourWindow.remainingPercent, 3)} 剩余`;
    $("fiveHourReset").textContent = `${localDateTime(fiveHourWindow.currentReset, timeZone)} 重置`;
  }
  $("dailyCredits").textContent = number(report.daily?.creditsInAvailableRange ?? report.daily?.creditsInRequestedRange);
  $("dailyCoverage").textContent = `${report.daily?.availableFrom || "—"} → ${report.daily?.availableTo || "—"}`;
  $("sourceLabel").textContent = report.source === "authenticated-browser" ? "页面已认证" : "未读取";
  $("cycleSummary").textContent = `${cycles.filter((cycle) => cycle.estimate).length} 个额度窗口 · ${number(report.daily?.creditsInAvailableRange ?? report.daily?.creditsInRequestedRange)} credits`;
  $("lastUpdated").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  renderCycleChart(cycles, report.planReferences, report.daily?.rows);
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
  if (state.report) renderCycleChart(state.report.cycles, state.report.planReferences, state.report.daily?.rows);
});

setStatus("正在连接 localhost 服务…", "busy");
connectToServer().catch((error) => setStatus(error.message, "error"));
