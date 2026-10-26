# AEOS 切流后运维 SOP（PAND-309）

适用：CRM 主写、EBMS 同步/读侧（读法 A）。本文给出 R1/R3 的落地口径与值守责任。

## 1. 写路径边界

| 路径 | 切流后状态 | 说明 |
|---|---|---|
| CRM 6 模块新增/修改/删除 | 唯一业务写入口 | 产生 `AEOS_EVENT_V1`，由 `crm-worker` 每 60s 投递 EBMS |
| EBMS 6 模块写权限（非 admin） | 已收回（PAND-307） | 业务角色不可写；入口返回 403 |
| EBMS `inquiry:price`（核价） | 已收回（PAND-309 R3） | 核价迁至 CRM；admin 保留作应急/回滚 |
| EBMS「核价→报价库」自动同步 | 默认停用 | 代码门禁 `EBMS_QUOTE_AUTOSYNC=1` 才启用，仅回滚演练使用 |
| EBMS 出站（admin 应急修改） | 自动调度 + 手动兜底 | 每 5 分钟 flush，见下 |

收回核价权限的执行方式（幂等，生成回滚清单）：

```bash
node scripts/aeos-revoke-pricing.js --out database/backups/inquiry-price-rollback.json
# 回滚
node scripts/aeos-revoke-pricing.js --restore database/backups/inquiry-price-rollback.json
```

## 2. 出站自动调度

- 实现：`backend/server.js` 启动后 15s 首次执行，此后按 `EBMS_AEOS_FLUSH_INTERVAL_MS`（默认 300000ms）周期 `flush`。
- 关闭开关：`EBMS_AEOS_AUTOSYNC=0`。
- 与手动 flush 等价：`POST /api/aeos/outbox/flush`（需 admin/集成权限）。
- 判定健康：`GET /api/aeos/reconcile` 返回 `outbound.pending=0`、`outbound.failed=0`、`dead_letter=0`。

**责任人**：EBMS 系统管理员（应急写与出站队列）；CRM 集成负责人（入站落库与对账）。
**频率**：自动每 5 分钟；每日 09:00 由 CRM 侧 `POST /api/v1/integrations/ebms/reconcile` 出具对账结果；异常（dead_letter>0 或 pending 持续 >30 分钟）当日处理。

## 3. 证书等级取值域（R1）

报价库 `certificate_level` 取两侧并集：`CE / ROHS / CCC / UL / ETL / 国标 / 行标 / 企标 / 无证书`。
契约与本侧实现：`backend/lib/aeos-contract.js`、`contracts/aeos-contracts-v1.schema.json`。
存量「国标」24 条为真实定价维度，不置空、不清洗。

## 4. 观察窗口

切流后连续 ≥24h：`integration_outbox` 中 `AEOS_EVENT_V1` 的 pending/failed=0、无死信、双端 6 模块计数稳定。
CRM 对账接口已纳入实体事件通道（`event` 字段）与 6 模块计数（`modules` 字段），见 R5。
