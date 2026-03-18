const USER_AGENT = "paper-harvest-webui/1.1 (+local-tool)";
const FETCH_TIMEOUT_MS = 20000;
const MAX_LIMIT = 500;
const ARXIV_PAGE_SIZE = 100;
const ARXIV_MAX_PAGES = 50;
const ARXIV_PAGE_BUFFER = 4;
const DETAIL_CONCURRENCY = 6;

function makeError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Fetch timeout for ${url}`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x27;/g, "'");
}

function stripTags(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, " "));
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeXml(value) {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

function extractTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? normalizeWhitespace(stripTags(match[1])) : "";
}

function extractAllMatches(text, regex) {
  return Array.from(text.matchAll(regex), (match) => match);
}

function extractMetaContent(html, metaName) {
  const escaped = metaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\s+name="${escaped}"\\s+content="([^"]+)"`, "i"),
    new RegExp(`<meta\\s+content="([^"]+)"\\s+name="${escaped}"`, "i"),
    new RegExp(`<meta\\s+property="${escaped}"\\s+content="([^"]+)"`, "i"),
    new RegExp(`<meta\\s+content="([^"]+)"\\s+property="${escaped}"`, "i")
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return normalizeWhitespace(decodeHtml(match[1]));
    }
  }

  return "";
}

function splitKeywords(input) {
  return String(input || "")
    .split(/[\n,;，；]+/)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean);
}

function validateParams(payload) {
  const keywords = splitKeywords(payload.keywords);
  const startDate = payload.startDate ? new Date(`${payload.startDate}T00:00:00Z`) : null;
  const endDate = payload.endDate ? new Date(`${payload.endDate}T23:59:59Z`) : null;
  const sources = Array.isArray(payload.sources) && payload.sources.length
    ? payload.sources.filter(Boolean)
    : ["arxiv", "neurips", "aaai", "acl", "icml"];
  const limit = Math.min(Math.max(Number(payload.limit) || 50, 1), MAX_LIMIT);

  if (!keywords.length) {
    throw makeError("请至少填写一个关键词。");
  }

  if (!startDate || Number.isNaN(startDate.getTime())) {
    throw makeError("请提供有效的开始日期。");
  }

  if (!endDate || Number.isNaN(endDate.getTime())) {
    throw makeError("请提供有效的结束日期。");
  }

  if (startDate > endDate) {
    throw makeError("开始日期不能晚于结束日期。");
  }

  return { keywords, startDate, endDate, sources, limit };
}

function matchesKeywords(text, keywords) {
  const lower = text.toLowerCase();
  const matchedKeywords = keywords.filter((keyword) => lower.includes(keyword.toLowerCase()));
  return { matched: matchedKeywords.length > 0, matchedKeywords };
}

function withinDateRange(dateValue, startDate, endDate) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return date >= startDate && date <= endDate;
}

function yearInRange(year, startDate, endDate) {
  return year >= startDate.getUTCFullYear() && year <= endDate.getUTCFullYear();
}

function dedupeResults(items) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = `${item.source}::${item.link}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(item);
  }

  return output;
}

function toCsvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;

  async function runWorker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return results;
}

function parseLinks(html, matcher) {
  const anchors = extractAllMatches(html, /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  const items = [];

  for (const anchor of anchors) {
    const href = anchor[1];
    const text = normalizeWhitespace(stripTags(anchor[2]));

    if (matcher(href, text)) {
      items.push({ href, text });
    }
  }

  return items;
}

function absoluteUrl(base, href) {
  return new URL(href, base).toString();
}

async function maybeEmit(callback, payload) {
  if (typeof callback === "function") {
    await callback(payload);
  }
}

async function searchArxiv({ keywords, startDate, endDate, limit, emitItems, emitProgress }) {
  const results = [];
  const query = keywords.map((keyword) => `all:"${escapeXml(keyword)}"`).join(" OR ");
  const maxPages = Math.min(ARXIV_MAX_PAGES, Math.max(1, Math.ceil(limit / ARXIV_PAGE_SIZE) + ARXIV_PAGE_BUFFER));

  for (let page = 0; page < maxPages && results.length < limit; page += 1) {
    const start = page * ARXIV_PAGE_SIZE;
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=${start}&max_results=${ARXIV_PAGE_SIZE}&sortBy=submittedDate&sortOrder=descending`;
    const xml = await fetchText(url);
    const entries = extractAllMatches(xml, /<entry>([\s\S]*?)<\/entry>/gi);

    if (!entries.length) {
      break;
    }

    let sawOlderPaper = false;
    const pageItems = [];

    for (const entry of entries) {
      const block = entry[1];
      const title = extractTag(block, "title");
      const abstract = extractTag(block, "summary");
      const link = extractTag(block, "id");
      const published = extractTag(block, "published");
      const updated = extractTag(block, "updated");
      const dateValue = published || updated;

      if (!dateValue) {
        continue;
      }

      const entryDate = new Date(dateValue);
      if (entryDate < startDate) {
        sawOlderPaper = true;
      }

      if (!withinDateRange(dateValue, startDate, endDate)) {
        continue;
      }

      const { matched, matchedKeywords } = matchesKeywords(`${title} ${abstract}`, keywords);
      if (!matched) {
        continue;
      }

      const item = {
        source: "arXiv",
        year: entryDate.getUTCFullYear(),
        title,
        abstract,
        link,
        matchedKeywords,
        publishedAt: dateValue
      };

      results.push(item);
      pageItems.push(item);

      if (results.length >= limit) {
        break;
      }
    }

    if (pageItems.length) {
      await maybeEmit(emitItems, {
        source: "arXiv",
        page: page + 1,
        scanned: start + entries.length,
        collected: results.length,
        limit,
        items: pageItems
      });
    }

    await maybeEmit(emitProgress, {
      source: "arXiv",
      page: page + 1,
      scanned: start + entries.length,
      collected: results.length,
      limit
    });

    if (sawOlderPaper) {
      break;
    }
  }

  return results;
}

async function searchNeurips({ keywords, startDate, endDate, limit, emitItems, emitProgress }) {
  const years = [];
  for (let year = endDate.getUTCFullYear(); year >= startDate.getUTCFullYear(); year -= 1) {
    years.push(year);
  }

  const results = [];

  for (const year of years) {
    if (!yearInRange(year, startDate, endDate) || results.length >= limit) {
      continue;
    }

    const listUrl = `https://proceedings.neurips.cc/paper_files/paper/${year}`;
    let listHtml;

    try {
      listHtml = await fetchText(listUrl);
    } catch (error) {
      continue;
    }

    const paperLinks = parseLinks(listHtml, (href) => /Abstract/i.test(href) && /paper_files/i.test(href))
      .map((item) => absoluteUrl(listUrl, item.href));
    const uniqueLinks = [...new Set(paperLinks)];

    const detailResults = await mapLimit(uniqueLinks, DETAIL_CONCURRENCY, async (paperUrl) => {
      try {
        const html = await fetchText(paperUrl);
        const title = normalizeWhitespace(stripTags((html.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i) || [])[1] || ""));
        const abstract = normalizeWhitespace(stripTags((html.match(/<h4[^>]*>\s*Abstract\s*<\/h4>\s*<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || ""));
        const { matched, matchedKeywords } = matchesKeywords(`${title} ${abstract}`, keywords);

        if (!matched) {
          return null;
        }

        return {
          source: "NeurIPS",
          year,
          title,
          abstract,
          link: paperUrl,
          matchedKeywords,
          publishedAt: `${year}-01-01`
        };
      } catch (error) {
        return null;
      }
    });

    const batch = detailResults.filter(Boolean);

    if (batch.length) {
      results.push(...batch);
      await maybeEmit(emitItems, {
        source: "NeurIPS",
        year,
        collected: results.length,
        limit,
        items: batch.slice(0, Math.max(0, limit - (results.length - batch.length)))
      });
    }

    await maybeEmit(emitProgress, {
      source: "NeurIPS",
      year,
      collected: Math.min(results.length, limit),
      limit
    });

    if (results.length >= limit) {
      break;
    }
  }

  return results.slice(0, limit);
}

function parseAaaiIssueLinks(html, startDate, endDate) {
  const issueLinks = parseLinks(html, (href, text) => /issue\/view/i.test(href) && /\b20\d{2}\b/.test(text));

  return issueLinks
    .map((item) => {
      const yearMatch = item.text.match(/\b(20\d{2})\b/);
      return yearMatch ? { href: item.href, year: Number(yearMatch[1]) } : null;
    })
    .filter(Boolean)
    .filter((item) => yearInRange(item.year, startDate, endDate));
}

async function searchAaai({ keywords, startDate, endDate, limit, emitItems, emitProgress }) {
  const archiveUrl = "https://ojs.aaai.org/index.php/AAAI/issue/archive";
  let archiveHtml;

  try {
    archiveHtml = await fetchText(archiveUrl);
  } catch (error) {
    return [];
  }

  const issues = parseAaaiIssueLinks(archiveHtml, startDate, endDate).sort((a, b) => b.year - a.year);
  const results = [];

  for (const issue of issues) {
    if (results.length >= limit) {
      break;
    }

    const issueUrl = absoluteUrl(archiveUrl, issue.href);
    let issueHtml;

    try {
      issueHtml = await fetchText(issueUrl);
    } catch (error) {
      continue;
    }

    const articleLinks = parseLinks(issueHtml, (href) => /article\/view/i.test(href))
      .map((item) => absoluteUrl(issueUrl, item.href));
    const uniqueArticleLinks = [...new Set(articleLinks)];

    const detailResults = await mapLimit(uniqueArticleLinks, DETAIL_CONCURRENCY, async (articleUrl) => {
      try {
        const html = await fetchText(articleUrl);
        const title = extractMetaContent(html, "citation_title")
          || normalizeWhitespace(stripTags((html.match(/<h1[^>]*class="page_title"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || ""));
        const abstract = normalizeWhitespace(stripTags((html.match(/<section[^>]*class="item abstract"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || ""))
          || extractMetaContent(html, "description");
        const { matched, matchedKeywords } = matchesKeywords(`${title} ${abstract}`, keywords);

        if (!matched) {
          return null;
        }

        return {
          source: "AAAI",
          year: issue.year,
          title,
          abstract,
          link: articleUrl,
          matchedKeywords,
          publishedAt: `${issue.year}-01-01`
        };
      } catch (error) {
        return null;
      }
    });

    const batch = detailResults.filter(Boolean);

    if (batch.length) {
      results.push(...batch);
      await maybeEmit(emitItems, {
        source: "AAAI",
        year: issue.year,
        collected: results.length,
        limit,
        items: batch.slice(0, Math.max(0, limit - (results.length - batch.length)))
      });
    }

    await maybeEmit(emitProgress, {
      source: "AAAI",
      year: issue.year,
      collected: Math.min(results.length, limit),
      limit
    });
  }

  return results.slice(0, limit);
}

async function searchAcl({ keywords, startDate, endDate, limit, emitItems, emitProgress }) {
  const years = [];
  for (let year = endDate.getUTCFullYear(); year >= startDate.getUTCFullYear(); year -= 1) {
    years.push(year);
  }

  const results = [];

  for (const year of years) {
    if (!yearInRange(year, startDate, endDate) || results.length >= limit) {
      continue;
    }

    const eventUrl = `https://aclanthology.org/events/acl-${year}/`;
    let eventHtml;

    try {
      eventHtml = await fetchText(eventUrl);
    } catch (error) {
      continue;
    }

    const paperLinks = parseLinks(eventHtml, (href) => {
      const fullUrl = href.toLowerCase();
      return /^\/\d{4}\.acl[-./]/.test(fullUrl) || /^https:\/\/aclanthology\.org\/\d{4}\.acl[-./]/.test(fullUrl);
    }).map((item) => absoluteUrl(eventUrl, item.href));
    const uniquePaperLinks = [...new Set(paperLinks)];

    const detailResults = await mapLimit(uniquePaperLinks, DETAIL_CONCURRENCY, async (paperUrl) => {
      try {
        const html = await fetchText(paperUrl);
        const title = extractMetaContent(html, "citation_title")
          || normalizeWhitespace(stripTags((html.match(/<h2[^>]*id="title"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || ""));
        const abstract = normalizeWhitespace(stripTags((html.match(/<div[^>]*class="acl-abstract"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || ""))
          || extractMetaContent(html, "description")
          || extractMetaContent(html, "dc.Description");
        const { matched, matchedKeywords } = matchesKeywords(`${title} ${abstract}`, keywords);

        if (!matched) {
          return null;
        }

        return {
          source: "ACL",
          year,
          title,
          abstract,
          link: paperUrl,
          matchedKeywords,
          publishedAt: `${year}-01-01`
        };
      } catch (error) {
        return null;
      }
    });

    const batch = detailResults.filter(Boolean);

    if (batch.length) {
      results.push(...batch);
      await maybeEmit(emitItems, {
        source: "ACL",
        year,
        collected: results.length,
        limit,
        items: batch.slice(0, Math.max(0, limit - (results.length - batch.length)))
      });
    }

    await maybeEmit(emitProgress, {
      source: "ACL",
      year,
      collected: Math.min(results.length, limit),
      limit
    });
  }

  return results.slice(0, limit);
}

async function fetchIcmlVolumes() {
  const baseUrl = "https://proceedings.mlr.press/";
  const html = await fetchText(baseUrl);
  const volumeLinks = parseLinks(html, (href, text) => {
    const normalizedText = text.toLowerCase();
    return /\/v\d+\//i.test(href) && normalizedText.includes("international conference on machine learning");
  });

  return volumeLinks
    .map((item) => {
      const yearMatch = item.text.match(/\b(20\d{2})\b/);
      return yearMatch
        ? {
            year: Number(yearMatch[1]),
            url: absoluteUrl(baseUrl, item.href)
          }
        : null;
    })
    .filter(Boolean);
}

async function searchIcml({ keywords, startDate, endDate, limit, emitItems, emitProgress }) {
  let volumes;

  try {
    volumes = await fetchIcmlVolumes();
  } catch (error) {
    return [];
  }

  const results = [];
  const candidateVolumes = volumes
    .filter((item) => yearInRange(item.year, startDate, endDate))
    .sort((a, b) => b.year - a.year);

  for (const volume of candidateVolumes) {
    if (results.length >= limit) {
      break;
    }

    let volumeHtml;

    try {
      volumeHtml = await fetchText(volume.url);
    } catch (error) {
      continue;
    }

    const paperLinks = parseLinks(volumeHtml, (href) => /\/v\d+\/[^/]+\.html$/i.test(href))
      .map((item) => absoluteUrl(volume.url, item.href));
    const uniquePaperLinks = [...new Set(paperLinks)];

    const detailResults = await mapLimit(uniquePaperLinks, DETAIL_CONCURRENCY, async (paperUrl) => {
      try {
        const html = await fetchText(paperUrl);
        const title = extractMetaContent(html, "citation_title")
          || normalizeWhitespace(stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || ""));
        const abstract = normalizeWhitespace(stripTags((html.match(/<div[^>]*id="abstract"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || ""))
          || extractMetaContent(html, "description");
        const { matched, matchedKeywords } = matchesKeywords(`${title} ${abstract}`, keywords);

        if (!matched) {
          return null;
        }

        return {
          source: "ICML",
          year: volume.year,
          title,
          abstract,
          link: paperUrl,
          matchedKeywords,
          publishedAt: `${volume.year}-01-01`
        };
      } catch (error) {
        return null;
      }
    });

    const batch = detailResults.filter(Boolean);

    if (batch.length) {
      results.push(...batch);
      await maybeEmit(emitItems, {
        source: "ICML",
        year: volume.year,
        collected: results.length,
        limit,
        items: batch.slice(0, Math.max(0, limit - (results.length - batch.length)))
      });
    }

    await maybeEmit(emitProgress, {
      source: "ICML",
      year: volume.year,
      collected: Math.min(results.length, limit),
      limit
    });
  }

  return results.slice(0, limit);
}

function createStreamHelpers(onEvent) {
  const emittedKeys = new Set();

  return {
    emitMeta: async (payload) => {
      await maybeEmit(onEvent, { type: "meta", ...payload });
    },
    emitProgress: async (payload) => {
      await maybeEmit(onEvent, { type: "progress", ...payload });
    },
    emitWarning: async (message) => {
      await maybeEmit(onEvent, { type: "warning", message });
    },
    emitItems: async (payload) => {
      const uniqueItems = [];

      for (const item of payload.items || []) {
        const key = `${item.source}::${item.link}`;
        if (emittedKeys.has(key)) {
          continue;
        }

        emittedKeys.add(key);
        uniqueItems.push(item);
      }

      if (!uniqueItems.length) {
        return;
      }

      await maybeEmit(onEvent, {
        type: "items",
        ...payload,
        items: uniqueItems
      });
    }
  };
}

async function searchPapers(payload, options = {}) {
  const { keywords, startDate, endDate, sources, limit } = validateParams(payload);
  const { onEvent } = options;
  const stream = createStreamHelpers(onEvent);

  await stream.emitMeta({
    query: {
      keywords,
      startDate: payload.startDate,
      endDate: payload.endDate,
      sources,
      limit
    }
  });

  const tasks = [];

  if (sources.includes("arxiv")) {
    tasks.push(searchArxiv({
      keywords,
      startDate,
      endDate,
      limit,
      emitItems: stream.emitItems,
      emitProgress: stream.emitProgress
    }));
  }

  if (sources.includes("neurips")) {
    tasks.push(searchNeurips({
      keywords,
      startDate,
      endDate,
      limit,
      emitItems: stream.emitItems,
      emitProgress: stream.emitProgress
    }));
  }

  if (sources.includes("aaai")) {
    tasks.push(searchAaai({
      keywords,
      startDate,
      endDate,
      limit,
      emitItems: stream.emitItems,
      emitProgress: stream.emitProgress
    }));
  }

  if (sources.includes("acl")) {
    tasks.push(searchAcl({
      keywords,
      startDate,
      endDate,
      limit,
      emitItems: stream.emitItems,
      emitProgress: stream.emitProgress
    }));
  }

  if (sources.includes("icml")) {
    tasks.push(searchIcml({
      keywords,
      startDate,
      endDate,
      limit,
      emitItems: stream.emitItems,
      emitProgress: stream.emitProgress
    }));
  }

  const taskResults = await Promise.allSettled(tasks);
  const items = [];
  const warnings = [];

  for (const result of taskResults) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
      continue;
    }

    const message = result.reason?.message || "Unknown source error.";
    warnings.push(message);
    await stream.emitWarning(message);
  }

  const deduped = dedupeResults(items)
    .sort((a, b) => {
      const dateDiff = new Date(b.publishedAt) - new Date(a.publishedAt);
      if (dateDiff !== 0) {
        return dateDiff;
      }

      return a.source.localeCompare(b.source);
    })
    .slice(0, limit);

  const csvHeader = ["source", "year", "title", "abstract", "link", "matchedKeywords"];
  const csvRows = deduped.map((item) => [
    item.source,
    item.year,
    item.title,
    item.abstract,
    item.link,
    item.matchedKeywords.join(" | ")
  ]);
  const csv = [csvHeader, ...csvRows].map((row) => row.map(toCsvCell).join(",")).join("\n");

  return {
    query: {
      keywords,
      startDate: payload.startDate,
      endDate: payload.endDate,
      sources,
      limit
    },
    total: deduped.length,
    warnings,
    items: deduped,
    csv
  };
}

module.exports = {
  searchPapers
};
