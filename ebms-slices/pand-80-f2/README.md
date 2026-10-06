# EBMS M03 —— 偏差归因穿透（PAND-80）与反向链路查询（PAND-84）

F2：从任一结果指标的偏差穿透到原因项，显示影响方向与贡献占比（PAND-80）。
反向：从 Source 或 Evidence 反向查到其影响的原因项与最终结果指标（PAND-84）。

## 契约口径（2026-09-26 P0 边界重核后统一）

两条链路共用同一套契约链，与 PAND-83 的正向导航段一一对应：

```
Result  ←→  Exception（归因）  ←→  Evidence  ←→  source_system
 第1段           第2段               第3段            第4段
```

- 正向四层 `Result → Reason → Evidence → Source` **仅作 M03 视图导航**，不是跨域契约层级。
- 两条链路都**不新增契约对象或层级**：只有 `Result` / `Exception` / `Evidence` 三类契约对象。
- 「来源」以 `evidences.source_system` **字段**承载，不引入独立来源实体、不建独立来源表。
- 原因项口径（返工后）：或为 `Exception`（含 `reason_code` / `severity`），或显式标记为
  **M03 自有归因分析**。

### F2 归因口径的四条边界

| 口径 | 落地方式 |
|---|---|
| Exception 承载原因项 | 原因项挂 `exception_id`，`reason_code` / `severity` 取自被消费的 Exception 契约 |
| 影响方向 / 贡献占比属 M03 归因元数据 | 落 `attributions.direction` / `contribution_pct` / `impact_value`，基于消费到的专业 Result 判断得出 |
| 兜底：人工判断型原因 | 判不出 Exception 的原因显式落 `kind='m03_analysis'` 并标注原因（`NO_EXCEPTION_REF` / `EXCEPTION_NOT_FOUND` / `MISSING_REASON_CODE` / `MISSING_SEVERITY`），不留无归属字段的原因项 |
| 消费边界 | 归因依据一律取 `result_metrics`（专业模块 Owner 的 Result 契约，带 `source_system` + `calculation_version`）；EBMS **不重算专业指标、不建专业事实源** |

## 结构即口径

判定标准不是靠运行时检查兜住的，而是由数据结构保证：

| 判定标准 | 结构性保证 |
|---|---|
| 反向结果与正向导航一致（抽样 ≥ 10 条无差异） | 正反两向共用同一组关联表，反向只有一条关联路径 |
| 100% 归因项符合口径（映射 Exception 或显式 M03 自有归因分析） | `attributions` 的 `CHECK` 约束拒绝「既挂 Exception 又标 M03」及无归属行 |
| 对象清点 = Result/Exception/Evidence + `source_system`，无额外对象 | 库中只有这三个契约对象表，无独立来源表 |
| 不存在 EBMS 自建专业事实源 | 库中只有 6 张表；归因写路径只写 M03 归因元数据 + 留痕 |
| 影响方向仅限 正向/负向/中性 | `CHECK (direction IN (...))` |
| 每条原因项有「影响量或贡献占比」至少一项 | `CHECK` 约束 `contribution_pct` 与 `impact_value` 不得同时为空 |
| 归因层只读 | `chainRepository` 只实现 SELECT；写路径单独走 `attributionRepository`，仅登记元数据 + `audit_log` |
| 展开深度由归因关系决定 | 树按 `parent_id` 递归构建，深度默认无上限（`max_depth` 仅供显式收窄） |

## 目录

```
ebms/
├── backend/                      Node.js 22 + Express（routes → services → repositories → domain）
│   ├── src/db/schema.sql         契约数据底座（node:sqlite，本地可运行/自检）
│   ├── src/db/postgres.sql       等价 PostgreSQL 15 生产 DDL
│   ├── src/db/seed.js            种子数据（全库唯一写入口）
│   ├── src/domain/chain.js       层级与契约对象口径的唯一真源（已冻结）
│   ├── src/domain/reverseQuery.js  反向查询（纯函数）
│   ├── src/domain/forwardQuery.js  正向导航 + 一致性双向比对（纯函数）
│   ├── src/domain/attribution.js   归因领域逻辑（纯函数：状态/合计/多级树/兜底分类/类型判定）
│   ├── src/services/traceService.js         反向应用层编排
│   ├── src/services/attributionService.js   F2 应用层编排
│   ├── src/repositories/attributionRepository.js  F2 写路径（仅 M03 归因元数据 + 留痕）
│   └── test/                     99 项 AC 用例（PAND-84 47 项 + PAND-80 52 项）
└── frontend/                     Vue 3 + Vite
    ├── src/stores/reverseNavigation.js  反向视图状态（空态保留当前位置、正向跳转解析）
    ├── src/stores/reasonDrilldown.js    F2 视图状态（五字段展示、多级展开、类型判定、兜底标注）
    ├── src/views/ReasonDrilldown.vue    F2 主视图（页面切换由 src/App.vue 承载）
    └── test/                     49 项口径单测（PAND-84 19 项 + PAND-80 30 项）
```

## 接口

### F2 偏差归因穿透（PAND-80）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/results/:metricRef/reasons` | 场景 1/2/3/4：指标 → 原因列表（含状态、合计、多级树、类型判定） |
| POST | `/api/v1/results/:metricRef/reasons` | 边界：关联原因（唯一写端点，兜底判为 M03 自有归因分析） |
| GET | `/api/v1/reasons/:attributionId/children` | 场景 3：某一级继续多级展开 |
| GET | `/api/v1/reasons/:attributionId/type-verdict` | 场景 4：类型判定（映射至 Exception / M03 自有归因分析） |
| GET | `/api/v1/attribution/directions` | 影响方向与严重度取值域 |
| GET | `/api/v1/attribution/professional-fact-trace?sample=10` | 自证：抽查 ≥ 10 条归因引用的专业事实可溯源、无 EBMS 自建事实源 |
| GET | `/api/v1/attribution/health` | 健康检查 |

`?max_depth=N` 仅供显式收窄展示层数；默认按归因关系展开，不受导航层级限制。

### PAND-84 反向链路查询（全部只读 GET）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/trace/reverse/by-evidence/:evidenceId` | 场景 1：Evidence → 归因项 + 最终结果指标 |
| GET | `/api/v1/trace/reverse/by-source-system/:sourceSystem` | 场景 2：来源系统 → 全部 Evidence / 归因项 / 结果指标 |
| GET | `/api/v1/trace/forward/by-result/:metricId` | 正向导航读模型（一致性基准） |
| GET | `/api/v1/trace/reverse/consistency?sample=10` | 自证：反向与正向逐对一致 |
| GET | `/api/v1/trace/reverse/attribution-compliance` | 自证：归因口径 100% 合规 |
| GET | `/api/v1/trace/contract-objects` | 自证：契约对象清点 |
| GET | `/api/v1/trace/source-systems` | 可用来源系统取值 |
| GET | `/api/v1/trace/read-only-check` | 自证：各表行数与留痕水位 |

## 运行

```bash
cd backend  && npm install && npm test        # 99 项 AC 用例
cd frontend && npm install && npm test        # 49 项口径单测
cd frontend && npm run build                  # 前端构建

# 联调（后端 4100，前端 5100，前端已配置 /api 代理）
cd backend  && npm start
cd frontend && npm run dev
```

### 自检样本

F2 可直接用种子数据验证三条路径：`M-REV`（完全归因，顶层合计 100%，含 3 级展开）、
`M-PROFIT`（部分归因，顶层合计 45%，含只给影响量的原因项）、
`M-BACKLOG`（未归因，走关联入口后转为完全归因）。

## 边界与口径落地

- **空态保留当前位置**：Evidence 或 `source_system` 未关联归因项时返回 `state: "EMPTY"`、
  `keepPosition: true`，并回传该锚点的 `position`（含面包屑）。界面据此原样保留当前位置，
  输入内容不清空。
- **不回落专业原始表**：响应固定携带 `fallbackQueried: false` / `fallbackPolicy: "none"`；
  仓储层对专业原始表没有访问路径。
- **来源未标注**：Evidence 缺失 `source_system` 时展示「来源未标注」并给出提示，不回落原始表。
- **只读**：反向查询前后全库内容指纹不变（`test/read-only.test.js` 比对整库哈希而非仅行数）。

## 与专业中心的边界

- Result 由专业中心 Owner 供给，记录其 `source_system` 与 `calculation_version`；EBMS 只消费不重算。
- 影响方向与贡献占比属 M03 归因元数据，基于消费到的专业 Result 判断得出，不自建专业事实源。
- 身份、角色与可见范围消费 M01 Kernel，本模块**不建**第二套身份/权限体系。
- F2 的写路径只登记 M03 归因元数据（`attributions`）与操作留痕（`audit_log`），
  **不创建 Exception**、不写任何专业原始表。

## 已知待收敛项（交给后续任务）

- 本分支基于 PAND-84 的 `ebms/` 数据底座（`agent/ebms/48a2404d62c9`）。PAND-79 返工分支
  （`96b0832e3c38`）自带另一套 `ebms/` 数据模型（`owner_results` 收件箱式），尚未与本底座合流，
  合流前两套 `ebms/` 不能同时存在于同一仓库路径。
- 种子中 `M-INV` 的 Owner 由 `M11` 改为 `M06`（Data Ownership：Connector 不是指标 Owner），
  `calculation_version` 相应改为 `M06-INV-V1`，用于支撑判定标准 5 的可溯源要求。
- `postgres.sql` 为等价生产 DDL，本次未在真实 PostgreSQL 实例上执行验证。
