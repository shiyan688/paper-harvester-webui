const form = document.getElementById("search-form");
const submitButton = document.getElementById("submit-button");
const exportButton = document.getElementById("export-button");
const summary = document.getElementById("summary");
const resultsBody = document.getElementById("results-body");
const warningBox = document.getElementById("warning-box");
const statusPill = document.getElementById("status-pill");

let latestCsv = "";
let currentItems = [];
let warningMessages = [];

function setStatus(label, kind) {
  statusPill.textContent = label;
  statusPill.className = `status-pill ${kind}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function collectFormData() {
  const formData = new FormData(form);
  const sources = formData.getAll("sources");

  return {
    keywords: formData.get("keywords"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
    limit: Number(formData.get("limit")),
    sources
  };
}

function renderWarnings(warnings) {
  if (!warnings || !warnings.length) {
    warningBox.classList.add("hidden");
    warningBox.textContent = "";
    return;
  }

  warningBox.classList.remove("hidden");
  warningBox.innerHTML = warnings.map((item) => `<div>${escapeHtml(item)}</div>`).join("");
}

function renderRows(items) {
  if (!items.length) {
    resultsBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">还没有结果，开始搜索后会在这里持续追加。</td>
      </tr>
    `;
    return;
  }

  resultsBody.innerHTML = items.map((item) => `
    <tr>
      <td>${escapeHtml(item.source)}</td>
      <td>${escapeHtml(item.year)}</td>
      <td class="title-cell">${escapeHtml(item.title)}</td>
      <td class="abstract-cell">${escapeHtml(item.abstract)}</td>
      <td>${escapeHtml(item.matchedKeywords.join(", "))}</td>
      <td><a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">打开</a></td>
    </tr>
  `).join("");
}

function downloadCsv() {
  if (!latestCsv) {
    return;
  }

  const blob = new Blob([latestCsv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `papers-${Date.now()}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function resetUiForSearch() {
  latestCsv = "";
  currentItems = [];
  warningMessages = [];
  exportButton.disabled = true;
  renderRows([]);
  renderWarnings([]);
  summary.textContent = "正在建立检索请求，结果会流式追加到表格中。";
  setStatus("抓取中", "loading");
}

function addWarnings(messages) {
  warningMessages = [...new Set([...warningMessages, ...messages.filter(Boolean)])];
  renderWarnings(warningMessages);
}

async function runStandardSearch(payload) {
  const response = await fetch("/api/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "搜索失败。");
  }

  latestCsv = data.csv || "";
  currentItems = data.items || [];
  addWarnings(data.warnings || []);
  renderRows(currentItems);
  summary.textContent = `共找到 ${data.total} 条结果，来源：${(data.query.sources || []).join(", ")}。`;
  exportButton.disabled = !latestCsv;
  setStatus("完成", "success");
}

function handleStreamEvent(event) {
  if (event.type === "meta" && event.query) {
    summary.textContent = `开始搜索：${event.query.keywords.join(", ")}，目标上限 ${event.query.limit} 条。`;
    return;
  }

  if (event.type === "items") {
    currentItems = currentItems.concat(event.items || []);
    renderRows(currentItems);
    const source = event.source || "当前来源";
    summary.textContent = `已流式收到 ${currentItems.length} 条结果，最新来自 ${source}，当前扫描到第 ${event.page || "?"} 页。`;
    return;
  }

  if (event.type === "progress") {
    const source = event.source || "当前来源";
    const pageText = event.page ? `第 ${event.page} 页` : `${event.year} 年`;
    summary.textContent = `${source} 正在抓取中，已累计 ${event.collected || currentItems.length} / ${event.limit || "?"} 条，进度：${pageText}。`;
    return;
  }

  if (event.type === "warning") {
    addWarnings([event.message]);
    return;
  }

  if (event.type === "done" && event.data) {
    latestCsv = event.data.csv || "";
    currentItems = event.data.items || currentItems;
    renderRows(currentItems);
    addWarnings(event.data.warnings || []);
    summary.textContent = `共找到 ${event.data.total} 条结果，来源：${(event.data.query.sources || []).join(", ")}。`;
    exportButton.disabled = !latestCsv;
    setStatus("完成", "success");
    return;
  }

  if (event.type === "error") {
    throw new Error(event.error || "流式搜索失败。");
  }
}

async function runStreamSearch(payload) {
  const response = await fetch("/api/search/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "搜索失败。");
  }

  if (!response.body) {
    await runStandardSearch(payload);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      handleStreamEvent(JSON.parse(line));
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    handleStreamEvent(JSON.parse(buffer));
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  resetUiForSearch();

  try {
    const payload = collectFormData();
    await runStreamSearch(payload);
  } catch (error) {
    latestCsv = "";
    currentItems = [];
    renderRows([]);
    addWarnings([error.message || "搜索失败。"]);
    summary.textContent = "请求失败，请检查参数、网络或目标站点可用性。";
    setStatus("失败", "error");
  } finally {
    submitButton.disabled = false;
  }
});

exportButton.addEventListener("click", downloadCsv);
