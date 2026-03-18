# Paper Harvest WebUI

A zero-dependency local Node.js web app for searching papers by keyword and date range, with streaming results in the browser.

## Supported Paper Sources

- arXiv
- NeurIPS
- AAAI
- ACL
- ICML

## Supported Platforms

- Windows
- macOS
- Linux
- Any modern browser that supports `fetch` streaming
- Node.js 18+ recommended

## Quick Start

```bash
git clone https://github.com/shiyan688/paper-harvester-webui.git
cd paper-harvest-webui
node server.js
```

Then open `http://localhost:3005`.

## Highlights

- Optimized arXiv paging for large-result searches
- Supports up to 500 results per search
- Default example is `symbolic regression + arXiv + 300 + 2026-03-18`
- Streaming endpoint at `/api/search/stream`
- Export results as CSV

## Features

- Multiple keywords
- Date range filtering
- Selectable sources
- Table view for title, abstract, matched keywords, and link
- CSV export
- Streaming incremental updates during search

## Notes

- arXiv uses the public API and is filtered by actual paper dates
- NeurIPS, AAAI, ACL, and ICML are collected from proceedings pages, so filtering is mainly year-based there
- The project has no third-party runtime dependencies
- If source site structures change in the future, selectors may need to be updated
