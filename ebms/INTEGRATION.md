# EBMS 集成分支说明（integration/ebms-pand）

本分支用于把 PAND 系列的多个独立交付切片收敛到**同一代码基**，并明确「已统一」与「待原生统一」两部分。

## 一、统一内核：`ebms/`（chain-A 家族）

顶层 `ebms/` 是统一运行内核，技术栈 Node.js + Express + PostgreSQL + Vue 3（模块化单体：router → service → repository）。
已原生并入并共用同一套数据模型（`result_metrics` / `owner_results` / `result_reasons` / `evidences` /
`reason_evidences` / `reports` / `todos` / `decisions` / `object_links` / `audit_log`）：

| 功能 | issue | 迁移 | 说明 |
|---|---|---|---|
| F1 经营结果指标集 | PAND-79 | 003 | 目标/实际/偏差，实际值只来自 owner_results |
| F3 证据关联 | PAND-81 | 001 | 原因项挂载/查看证据 |
| F4 证据来源标注 | PAND-82 | 004 | 来源系统/单据/时间/提供方 + 缺失率 |
| F5 四层链路穿透 | PAND-83 | 005 | Result→Reason→Evidence→Source，连续下钻与逐层返回 |
| F7 REPORT 视图 | PAND-85 | 006 | 以报告/结论为单位组织信息 |
| F8 TODO 视图 | PAND-86 | 007 | 待办聚合、认领/指派/状态流转 |
| F11 四视图交叉跳转 | PAND-89 | 002 | REPORT/TODO/Decision/Evidence 两两可达 |

### 收敛决策（本分支相对各单点分支的改动）
1. **迁移重编号**：F5/F7/F8 原本各自使用 `004_*.sql`，与 F4 的 `004` 冲突；统一重编号为
   `005_trace_chain.sql` / `006_report_view.sql` / `007_todos.sql`，保证迁移顺序确定。
2. **audit_log 动作口径累积**：各切片都 `DROP + ADD` 同一 CHECK 约束，会互相回退；
   统一为**累积口径**（006 与 007 均包含此前全部 action）。
3. **source_system 单一口径**：F4 与 F5/PAND-84 共用 `evidences.source_system`；统一为
   契约口径（`M05/M06/M09`、外部 `SUPPLIER-A`），并只保留 F4 的 `document` 一条「来源未标注」边界，
   删除 F5 额外引入的重复未标注证据，使两套 AC 夹具同时成立。
4. **默认落地视图冲突**：F1 要求登录即见指标集，F7 要求登录即见报告清单，二者不可同时满足；
   本分支取 **F1** 为默认，F7 经「报告（F7）」入口一次点击可达（已在该处注明）。

### 验证
- 后端：`cd ebms/backend && npm test` → **139/139 通过**
- 前端：`cd ebms/frontend && npm test` → **132/132 通过**；`npm run build` 通过

## 二、独立切片：`ebms-slices/`（保持原样，待原生统一）
以下 issue 的原实现使用**另一套数据模型**（ESM + SQLite；`result_metrics` 内联实际值/目标值；
独立 `attributions` / `exceptions` 表），与 `ebms/`（CJS + PostgreSQL）不兼容，
无法直接合并或轻量移植而不破坏其 AC 夹具。故以**原样**保留为可独立运行/测试的切片，
并保留其原始分支以便逐项实测：

| issue | 切片目录 | 原始分支 | commit |
|---|---|---|---|
| PAND-80（F2 归因穿透）+ PAND-84（反向查询） | `ebms-slices/pand-80-f2` | `pand80-f2` | `7ebf110` |
| PAND-87（F9 Decision 视图） | `ebms-slices/pand-87-decision` | `agent/ebms/pand-87-decision-view` | `28c6f23` |

> 原生统一（把上述切片按 `ebms/` 契约重写）属于逐项返工，尚未完成。

## 三、其它 issue 的可检出分支（未并入本分支）
`agent/ebms/e0e35c05680d`（PAND-88 / F10 Evidence 检索，sales 内改架构）、
`agent/ebms/f7632c91640c`（PAND-92）、`agent/ebms/5ba76a098eb1`（PAND-91 / F13）、
`agent/ebms/d7b512c04619`（m03）、`agent/ebms/b0f7da469a05`（nav）、
`agent/agent/38558f62bbb1`（P0 收口）。

远端：
- Gitee：`https://gitee.com/ningbohengjianguangdian/EBMS.git`
- GitHub：`https://github.com/futianyu760118-art/EBMS.git`
