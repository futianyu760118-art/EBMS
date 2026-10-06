# ebms-slices —— 独立交付切片（保持原样）

本目录原样保留与 `../ebms/` **数据模型不兼容**的独立实现，供逐项 AC 实测与后续原生移植参考。
每个切片自带 `backend/`、`frontend/`、`package.json` 与 `test/`，可独立安装运行。

| 切片 | issue | 原始分支 | commit |
|---|---|---|---|
| `pand-80-f2` | PAND-80（F2 归因穿透）+ PAND-84（反向链路查询） | `pand80-f2` | `7ebf110` |
| `pand-87-decision` | PAND-87（F9 Decision 视图） | `agent/ebms/pand-87-decision-view` | `28c6f23` |

## 为什么单独存放
这两个切片是完整的独立应用：后端为 ESM（`"type": "module"`）、数据层为 SQLite
（`db.prepare(...)`，`result_metrics` 内联 actual/target，另有 `attributions` / `exceptions` 表）。
而 `../ebms/` 为 CommonJS + PostgreSQL，`result_metrics` 只存配置、实际值经 `owner_results` 消费。
两者的契约承载与主键形态不同，直接合并/轻量移植会破坏各自 AC 夹具，故不并入内核，保持原样。

## 运行
见各切片内 `README.md`（`cd <slice>/backend && npm install && npm test`）。
