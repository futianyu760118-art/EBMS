# EBMS · SOP 产销协调会 数据来源盘点

> 对象：EBMS 产销协调会（`/sop.html`，M03A 产销协同）
> 数据源：M02 EDP 数据服务（`http://150.158.13.110:9090/api/v1/data-api`）
> 盘点日期：2026-11-19
> 方法：EDP `_catalog`/`schema` 核对 + 本地落库 `edp_dataset_row` 抽样 + SOP 各表实测计数

## 一、结论摘要

- **业务实际数据（订单 / 生产 / 库存 / 采购 / 会议）已接入 EDP**：驾驶舱订单、PSI 生产/库存实际、供应评审、会议均来自 EDP。
- **规划/考核数据（PSI 计划、KPI 目标与实绩、需求预测、产能、MRP）仍为本地维护**：EDP 当前无对应数据集，且这些属"规划/考核"口径，不是业务事实。
- **关键阻塞**：EDP `meeting-assistant-actions` 数据集字段被错配成 **BOM 物料模板**，导致行动项的责任人/时间/主题在 EDP 源头丢失。SOP 待办的责任人与时间因此无法从 EDP 带入，需 **EDP 侧修正数据集定义**。

## 二、SOP 各模块数据来源盘点

| 模块 | 数据表 | 当前来源 | 判定 |
|---|---|---|---|
| 驾驶舱·本月订单 | `orders`（合并 EDP） | EDP `ads-order-list` + 本地 | ✅ 来自 EDP |
| PSI·销售/生产/库存实际 | `psi_lines.sales_actual / production_actual / inventory_actual` | EDP `ads-order-list` / `ads-production-task-view` / `ads-inventory-view` | ✅ 来自 EDP |
| 供应评审·采购/库存 | EDP 落库 | EDP `ads-purchase-order-view` / `ads-inventory-view` | ✅ 来自 EDP |
| 会议管理 | `sop_meetings` | EDP `meeting-assistant-meetings`（76 场） | ✅ 来自 EDP |
| 行动项（待办） | `sop_actions` | EDP `meeting-assistant-actions` | ❌ EDP 数据集字段错配 |
| PSI·计划量 | `psi_lines.sales_plan / production_plan / safety_stock` | 本地维护 | — 规划数据 |
| KPI 目标 / 实绩 | `kpi_standards` / `kpi_actuals` | 本地 seed | ⚠ EDP 无对应数据集 |
| 需求预测 | `demand_forecasts` | 本地 seed | ⚠ EDP 无对应数据集 |
| 产能 | `supply_capacities` | 本地 seed | ⚠ EDP 无（可从生产任务推算） |
| MRP 物料 | `supply_mrps` | 本地 seed | ⚠ EDP 无对应数据集 |
| 预警 | `alert_logs` | 本地规则引擎计算 | — 本地计算 |

## 三、来自 EDP 的模块（详情）

EDP 已授权数据集（10 个）：`meeting-assistant-meetings`(v3)、`meeting-assistant-action-progress`(v3)、`meeting-assistant-actions`(v5，字段错配)、`ads-order-list`(v14)、`ads-order-detail`(v4)、`ads-purchase-order-view`(v4)、`ads-inventory-view`(v4)、`ads-production-task-view`(v5)、`master-material`(v4)、`master-customer`(v4)。

- **驾驶舱订单**：`periodPipeline` 合并 `ads-order-list` 落库，按 S&OP 时间窗口（上月16日~当月15日）过滤。实测本月订单 3 → 38。
- **PSI 实际值**：`sop-edp-sync.syncPsiFromEdp` 按产品编码（忽略 ERP 层级前缀）聚合订单/生产任务/库存，回填 `*_actual` 并重算红黄绿；计划值不被覆盖。
- **会议**：`sop-edp-sync.syncMeetingsFromEdp` 取 `meeting-assistant-meetings`（`attributes` 嵌套），导入 `meeting_code/meeting_type/meeting_date/title/organizer/participants/department`。实测 76 场。

**同步入口**：`POST /api/v1/edp/sop/sync`（先同步源数据集，再更新 PSI 实际值、行动项、会议；支持 `period_month` / `months_back` / `cutoff_date`）。

## 四、本地规划数据（为何保留本地）

KPI 目标、需求预测、产能、MRP、PSI 计划量属于**规划与考核口径**，不是业务发生的既成事实，EDP 作为"事实与证据平台"当前未提供此类数据集。建议：

- 短期：保留本地维护（表单录入/导入）。
- 若要求「全部来自 EDP」：需 EDP 侧新增对应数据集（如 KPI 实绩、需求预测、产能规划），EBMS 再切换到 data-api 取数。

## 五、关键阻塞：EDP 行动项数据集字段错配

**现象**：`meeting-assistant-actions`(v5) 的 `schema` 字段为 BOM 物料模板：

```
attributes.aux_attr_id / aux_qty / back_flush / bom_id / material_id / material_size /
material_type / oper_sn / process_id / standard_qty / unit_id / warehouse_id …
```

实测样本：这些字段全为 `null`，仅 `object_id`、`object_type=ACTION`、`source_id` 有值。**行动项的 `owner`/`due_date`/`theme`/`status` 字段在 EDP 源头未落**。

**影响**：SOP 待办（2449 条，其中会议助手导入 2440 条）→ 无责任人 2444、无截止日 2440、有效待办仅 4 条。EBMS 侧映射逻辑已能取 `owner`/`due_date`，但源数据为空，无从带入。

**处置**：需 **EDP 管理员修正 `meeting-assistant-actions` 数据集定义**，恢复行动项字段（owner / due_date / theme / status / dept 等）。修正后，EBMS 执行 `POST /api/v1/edp/sop/sync` 即可自动带入责任人与时间。

> 对照：`meeting-assistant-action-progress`(v3) 为行动进展（含 `action_id`/`progress`/`cycle_date`），无 owner/时间；`meeting-assistant-meetings`(v3) 数据正常。

## 六、待办完整性现状与整改

| 项 | 数值 |
|---|---|
| 待办总数 | 2449 |
| 会议助手导入 | 2440 |
| 无责任人 | 2444 |
| 无截止日 | 2440 |
| 有效待办（有责任人+有截止日+未关闭）| 4 |

**已落地整改**：
- 新建 Action **强制责任人 + 截止日**（后端 `400 OWNER_REQUIRED` / `DUE_DATE_REQUIRED`，前端表单校验）。
- 待办页**分区显示**「SOP 决议项」与「会议助手导入项」，缺责任人/截止日打标且不计入有效待办。

**待推动**：
- EDP 修正行动项数据集后重新同步，历史导入项的责任人/时间随之补齐。

## 七、本次已落地改动

| 文件 | 改动 |
|---|---|
| `backend/routes/sop.js` | `periodPipeline` 合并 EDP 订单按时间窗口统计；`review.alerts` 接入预警统计；新建 Action 强制责任人/截止日；`/sop/supply-balance` 供需平衡表 |
| `backend/lib/sop-edp-sync.js` | `syncPsiFromEdp`（PSI 实际值）、`syncActionsFromEdp`（限近 N 个月）、`syncMeetingsFromEdp`（会议） |
| `backend/routes/edp.js` | `POST /api/v1/edp/sop/sync`（透传 period_month/months_back/cutoff_date） |
| `frontend/sop.html` | PSI 显示 EDP 实际 + M+1 预测；KPI 仅看异常；驾驶舱对账区/预警；行动项分区 |

## 八、待推动事项（EDP 侧）

1. **修正 `meeting-assistant-actions` 数据集字段定义**（恢复 owner/due_date/theme/status）——待办责任人/时间的根本前提。
2. （可选）新增 KPI 实绩 / 需求预测 / 产能数据集，以实现「SOP 规划数据也来自 EDP」。
3. （可选）确认订单统计口径：按 `order_date` 还是 `promised_date` 落入 S&OP 时间窗口。
