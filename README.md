# Paper Harvest WebUI

一个零依赖的本地 Node.js Web 界面，用来按关键词和时间范围抓取论文，并把结果流式显示在表格里。

当前支持：

- arXiv
- NeurIPS
- AAAI
- ACL
- ICML

## 启动

```bash
cd e:\codex\project2\paper-harvest-webui
npm start
```

打开 `http://localhost:3005`。

## 这次优化的重点

- `arXiv` 单次检索上限放宽到 500，默认可直接拉取 300 篇
- `arXiv` 分页改为每页 100 条，并按需要自动继续翻页
- 新增 `/api/search/stream`，前端会边收到结果边渲染
- 默认场景切到 `symbolic regression + arXiv + 300 + 2026-03-18`

## 功能

- 输入多个关键词
- 指定开始日期和结束日期
- 选择来源
- 表格展示标题、摘要、链接、匹配关键词
- 一键导出 CSV
- 检索时流式输出中间结果

## 说明

- `arXiv` 使用公开 API，并按真实日期过滤
- `NeurIPS`、`AAAI`、`ACL` 和 `ICML` 主要基于 proceedings 页面抓取，通常以年份为主
- 项目没有第三方依赖，页面结构如果未来变化，抓取规则可能需要再调整
