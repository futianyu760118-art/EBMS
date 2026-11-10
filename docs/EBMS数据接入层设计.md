# EBMS 数据接入层设计

> 版本：2026-11-07
> 定位：EBMS（M03）经营数据从「本地表」抽离为统一取数接口，隔离数据来源，实现「本地测试 → EDP 取数」平滑切换，并为每个系统（M01~M14）预留对接接口。

## 一、目标

1. **当前**：用本地表（`monthly_*`，由月度报告数据导入）测试经营数据链路。
2. **后续**：切换到 M02 EDP（企业数据与证据平台）取数，EBMS 不再自存自算专业事实。
3. **统一**：业务模块只依赖取数接口契约，不感知数据来源（本地表 / EDP）。
4. **预留**：每个系统一个 adapter 接口，覆盖 M01~M14 的对接。

## 二、架构

```
EBMS 业务模块（月度报告 / 驾驶舱 / ...）
        │  await provider.getXxx(period)   ← 统一接口契约
        ▼
  backend/lib/data-provider/index.js  ← Provider 工厂（EBMS_DATA_PROVIDER=local|edp）
        ├── local-provider.js  本地表读取（当前）
        └── edp-provider.js    EDP API 拉取（后续，骨架）
        │
        └── contracts.js       接口契约 + 各系统 adapter 注册表（M01~M14）
```

| 文件 | 职责 |
|---|---|
| `index.js` | Provider 工厂，按 `EBMS_DATA_PROVIDER` 切换 local/edp |
| `contracts.js` | 取数接口契约（方法签名 + owner + 契约版本）+ 系统 adapter 注册表 |
| `local-provider.js` | 本地数据源：读 `monthly_*` 表，映射为统一结果形状 |
| `edp-provider.js` | EDP 数据源骨架：预留 `EBMS_EDP_URL`/`EBMS_EDP_TOKEN`，未配置 fail-closed |

## 三、统一返回形状

所有取数方法返回：

```json
{
  "source": "local | edp",
  "owner": "M09_FAC",
  "contract": "finance-result-v1",
  "period": "2026-10",
  "data": [ ... ],
  "status": "available | not_connected"
}
```

- `status=available`：有数据（本地有 / EDP 拉取成功）。
- `status=not_connected`：该专业系统未接入（本地无真实结果，或 EDP 未配置）。
- 业务模块据此区分「真实数据」与「未接入」，不把缺失当 0%。

## 四、取数接口契约

| 方法 | 返回 | Owner | 契约 |
|---|---|---|---|
| `getFinanceResults(period)` | FinanceResultV1[] | M09_FAC | finance-result-v1 |
| `getSalesResults(period)` | SalesResult[] | M05_CRM | aeos-contracts-v1 |
| `getDeliveryResults(period)` | DeliveryResult[] | M06_SPC | business-event-v1 |
| `getRdResults(period)` | RdResult[] | M04_PLM | business-event-v1 |
| `getQualityResults(period)` | QualityResult[] | M08_QUALITY | business-event-v1 |
| `getIndicators(period)` | Indicator[] | M03_EBMS | —（M03 自有）|
| `getDeptSummary(period)` | DeptSummary[] | M03_EBMS | — |
| `getExceptions(period)` | Exception[] | M03_EBMS | aeos-contracts-v1 |
| `getDecisions(period)` | Decision[] | M03_EBMS | aeos-contracts-v1 |
| `getActions(period)` | Action[] | M03_EBMS | m10-poms-v1 |

## 五、各系统 adapter 注册表（M01~M14）

见 `contracts.js` 的 `SYSTEM_ADAPTERS`，覆盖：

| Module | system_id | 取数类型 | 契约 | 状态 |
|---|---|---|---|---|
| M01 | M01_KERNEL | person/organization/permission | principal-context-v1 | adapter |
| M02 | M02_EDP | event/evidence/audit/result | business-event-v1 | dispatcher |
| M04 | M04_PLM | rd_result/bom/eco/release | business-event-v1 | adapter |
| M05 | M05_CRM | sales_result/customer/inquiry/quote/order | aeos-contracts-v1 | adapter |
| M06 | M06_SPC | delivery_result/material/po/plan/shipment | business-event-v1 | adapter |
| M08 | M08_QUALITY | quality_result/nc/capa | business-event-v1 | not-deployed |
| M09 | M09_FAC | finance_result/revenue/cost/margin/cash | finance-result-v1 | adapter |
| M10 | M10_POMS | todo/action/feedback | m10-poms-v1 | adapter |
| M13 | M13_AEOS_HUB | agent_performance | business-event-v1 | adapter |
| M14 | M14_NOMI | dev_performance | business-event-v1 | adapter |

## 六、切换机制

```powershell
# 本地（默认，当前测试）
EBMS_DATA_PROVIDER=local

# 后续切 EDP
EBMS_DATA_PROVIDER=edp
EBMS_EDP_URL=http://host.docker.internal:8080
EBMS_EDP_TOKEN=<机机令牌>
```

- 未配置 `EBMS_EDP_URL` 时，EdpProvider 所有方法 fail-closed 返回 `not_connected`，不产生任何对外请求。
- 业务模块统一 `await provider.getXxx(period)`，local/edp 均兼容。

## 七、月度报告数据导入

月度报告数据（指标/部门红黄绿/决议/问题/决策）通过 `scripts/seed-monthly-report.js` 幂等导入本地表，作为当前阶段的测试数据源；切换 EDP 后，该数据改由专业系统经 EDP 供给，`get*Results` 方法自动切换来源，业务模块无需改动。

## 八、后续 EDP 接入步骤

1. EDP 部署并开放 Result 查询 API（对齐 `contracts/aeos-v1/` 契约）。
2. 配置 `EBMS_EDP_URL` + `EBMS_EDP_TOKEN`，`EBMS_DATA_PROVIDER=edp`。
3. EdpProvider 各 `get*Results` 方法替换为真实 EDP 端点（当前为占位路径）。
4. 回归测试 `scripts/data-provider-regression.test.js` 扩展 EDP 用例。
