# EBMS 经营管理系统

EBMS 是**跨域结论汇聚 + 经营判断 + 追溯**层，面向决策者与管理责任人，支持 Result → Reason → Evidence → Source 四层穿透。EBMS **不重算、不复制**任何专业中心（销售/生产·交付/财务/供应链）的内部算法与业务明细，只存「结论 / 归因 / 证据 / 来源 / 判断 / 视图」及其留痕。

本目录是 EBMS 的代码库，按架构方案（PAND-77）落地：后端 Node.js + Express（router → service → repository 分层）+ PostgreSQL；前端 Vue 3 + Vite。

> 交付位置说明：EBMS 是独立系统，`sales.git` 是其要汇聚的四个专业中心之一。当前平台仅提供 `sales.git` 作为仓库，因此 EBMS 代码以**新增顶层目录 `ebms/`** 的形式提交，**未修改任何既有 sales 文件**。若团队希望拆分为独立仓库，可整体迁移本目录。

## 当前实现范围

本次交付 **F1 经营结果指标集（PAND-79）**、**F3 证据关联（PAND-81）**、**F4 证据来源标注（PAND-82）** 与 **F11 四视图交叉跳转（PAND-89）** 四个完整切片，并包含其运行所需的**最小数据底座**（工程骨架、鉴权/RBAC 中的操作人识别、Result/Reason 锚点、通用留痕）。

| 功能 | 状态 |
|---|---|
| F1 结果指标集：目标值 / 实际值 / 偏差值 + 来源与口径可追溯（PAND-79） | ✅ 已实现 |
| F3 原因项挂载并查看支撑证据（PAND-81） | ✅ 已实现 |
| F4 每条证据标注来源：来源系统 / 来源单据 / 数据时间 / 提供方 + 缺失率（PAND-82） | ✅ 已实现 |
| F11 REPORT/TODO/Decision/Evidence 四视图互相跳转（PAND-89） | ✅ 已实现 |
| F2 归因穿透（PAND-80） | 锚点表 `result_reasons` + 只读清单已建，归因算法未实现 |
| F7 REPORT 视图（PAND-85）、F8 TODO 视图（PAND-86）、F9 Decision 视图（PAND-87）、F10 Evidence 检索（PAND-88）、F5 四层下钻（PAND-83）等 | 未实现（后续 issue） |

### F1 经营结果指标集（PAND-79）说明

决策者登录后默认落在本视图，一屏看到本周期全部配置指标的**目标值 / 实际值 / 偏差值**及其来源与口径。

- **红线（结构性封死，非仅靠约定）**：`result_metrics` 只有**配置**字段（归属模块、目标值、方向、阈值、数据截止时间），**没有实际值/偏差列**。实际值只存在于 `owner_results`（专业 Owner 模块 Result 的消费收件箱），经 `(metric_code, owner_module, period, status='VERIFIED')` 的最新一条 `LATERAL JOIN` 进入视图——EBMS 没有任何路径能从 orders / materials 等专业原始表算出指标值。自动化断言：`result_metrics` 上无 `actual*` / `deviation*` 列（读 `information_schema`），且 results 域内不出现针对专业原始表的 SQL（源码静态扫描）。
- **数据来源口径**：实际值 → M05 销售 / M06 交付 / M09 财经 的 Result；目标值 → M03 管理目标（EBMS 自有）；偏差值 = 实际值 − 目标值（后端算，前端只展示）。口径自述在**界面顶部常显**。
- **唯一写入路径**：`POST /owner-results` 接收 Owner 模块 Result，校验来源模块白名单（`M05|M06|M09`）、必填 `calculationVersion`、非空 `evidenceIds` 与 `AEOS.Result.V1` 契约字段；按 `result_id` 幂等（重复接收返回 200 且 `changed=false`，不留第二条留痕）。
- **无数据不兜底**：Owner 未供给时接口给 `hasData=false`，实际值与偏差一律渲染「**无数据**」，并区分两种原因——`来源模块未供给`（该模块从未供给过）与`来源模块未同步本期数据`（供给过其它周期）——**绝不由 EBMS 计算或填 0**。
- **超阈值提示**：`|偏差率| > threshold_pct`（默认 5%）时该指标带「超阈值」提示，并给出达标/未达标判定（按 `direction` 判）。
- **可追溯**：每条指标可查看实际值的 `calculation_version`、Owner Result 标识与 `evidence_ids`；证据引用直接链到 `#/evidence/<id>` 四视图落点；来源证据未在本系统登记时显式标注「来源证据未在本系统登记」，不生成死链。
- **归属声明可配置**：指标 → 归属模块是**逐条数据**（`result_metrics.owner_module`）而非硬编码分支。AEOS 归属文档未逐指标枚举「产能 / 库存」的 Owner（只列到「交付 → M06」），故按 issue AC 声明为 M06 并保持可改。
- **不涵盖**：指标集/目标的维护界面（配置写入由后续 issue 提供），本期只读展示 + Owner Result 接收接口。

### F4 证据来源标注（PAND-82）说明

每条证据在详情中展示一份**来源（Source）**：来源系统、来源单据编号、来源数据时间、提供方。

- **Source 不是独立实体**：按 AEOS V7.2 P0 口径，Source 是 `evidences` 上的**字段**（`source_system` 等），不建 `sources` 表——否则会出现第二套来源口径，且与 F5 下钻（PAND-83）、F10 反查（PAND-84，按 `evidences.source_system` 检索）不一致。旧草案中的 `sources` 表**已废弃**。
- **场景 1（明细展示）**：`display` 数组给出四项字段的取值与顺序；空值渲染为占位符，不把「没值」显示成「有值」。
- **场景 2（人工录入）**：`source_type = manual` 时额外标注**录入人**与**录入时间**（`entered_by` / `entered_at`）；非人工录入的来源**不展示**这两项，避免展示无意义的「录入人=系统」。
- **场景 3（内部 / 外部）**：`source_type` ∈ `internal`（内部系统）/ `external`（外部数据）/ `manual`（人工录入）。**外部数据必须标注提供方**，接口层拒绝 + 迁移 004 的 CHECK 约束兜底，双保险。
- **周期更新口径（业务方 2026-09-23 最终口径）**：数据为**周期更新（日/周/月）、非实时**，故 `update_cycle` 为独立字段，界面展示**更新周期**与**数据截止时间**（`data_cutoff_at`，与来源数据时间同源）——不把周期性数据表述成实时。
- **边界（来源缺失）**：未标注来源的证据标记「**来源缺失**」，计入**待补清单**（`GET /sources/missing`，带待补字段与所挂原因项）。来源**不在创建时强制**（否则既有 F3 流程与数据全部失败），而是可后补——缺失率因此可统计、可收敛。
- **判定标准**：
  1. 来源缺失率 = 缺失条数 ÷ 总条数，`GET /sources/stats` 返回 `missingRate` 与 `missingRateLabel`；**总条数为 0 时缺失率为 `null`**，不返回 0（0/0 不是「无缺失」）。
  2. 外部来源记录的「提供方」字段非空——`criteria.externalProviderNonEmpty` 直接给出 `providerNonEmptyCount / externalCount` 与是否满足。
  3. 人工录入来源的录入人、录入时间均非空——`criteria.manualTraceNonEmpty` 同上。
- **结构性保证**：除接口校验外，迁移 004 用 CHECK 约束封死「半截来源」（有 `source_type` 无 `source_system` 等）、缺提供方的外部来源、缺录入信息的人工来源；`source_type` / `update_cycle` 均为显式枚举约束。
- **写入留痕**：唯一写入入口 `PUT /evidences/{id}/source`，首次标注记 `evidence.source.annotate`、后续更正记 `evidence.source.update`（含 before/after 快照），与业务写入同事务。
- **不涵盖**：前端本切片只提供**展示**（详情内来源区块、列表来源列、来源待补视图）；来源的**表单式编辑入口**未做，写入走接口（已由 AC 测试覆盖）。

### F11 四视图交叉跳转（PAND-89）说明

四视图口径：**REPORT = Result**、**TODO = Action**、**Decision**、**Evidence**。

- **关联模型**：`object_links` 一行 = 一条关联，**天然双向可达**。因此 Report↔TODO 一条记录即同时满足 `report→todo` 与 `todo→report`，6 组类型对即可覆盖 AC 要求的全部 12 个有向组合。
- **幂等**：写入时把两端规范化为 `pair_a`/`pair_b`（`"<type>:<id>"` 字典序），配合 `UNIQUE (pair_a, pair_b)`，同一对对象无论从哪端、方向如何建立都只留一行。
- **置灰边界**：无关联时入口**置灰**且提示「**无关联**」；判定按**入口**（目标类型）粒度，因此部分关联的对象只置灰没有关联的那几个入口。
- **视图对象锚点**：本切片只建「能被链接、能被解析出落点」的对象身份（`reports`/`todos`/`decisions`，`evidences` 见 001）。各视图的**完整业务字段由归属 issue 以 `ALTER TABLE` 追加**（PAND-85/86/87/88），本切片不臆造其业务列。
- **跳转落点**：前端 hash 路由 `#/report/<id>`、`#/todo/<id>`、`#/decision/<id>`、`#/evidence/<id>`，可直接作为直达链接，支持浏览器前进/后退。
- **不涵盖**：关联的新增/解除目前只有后端接口与留痕，前端未提供编辑入口（导航为本 issue 的 AC 范围）。

## 目录结构

```
ebms/
  backend/
    src/
      app.js                      Express 装配（CORS、路由、错误处理）
      server.js                   启动入口（自动执行迁移）
      config/env.js               环境变量（.env 不入库）
      db/
        pool.js                   连接池 + withTransaction（写数据与留痕同事务）
        migrate.js                迁移执行器
        seed.js                   自检/联调夹具（含「无证据支撑」原因项、四视图关联/无关联对象）
        migrations/001_init.sql   数据模型（证据 / 原因项 / 留痕）
        migrations/002_view_links.sql  四视图对象锚点 + object_links（F11）
        migrations/003_result_metrics.sql  Owner Result 收件箱 + 指标配置列（F1）
        migrations/004_source_annotation.sql  证据来源标注列 + 结构性 CHECK 约束（F4）
      domain/
        evidence/                 证据域：类型枚举 / 仓储 / 服务（校验+用例）
        source/                   F4 来源域：口径常量 / 仓储 / 服务（校验+明细+缺失率）
        results/                  F1 指标域：来源口径 / Owner Result 仓储 / 指标仓储 / 服务
        views/                    四视图对象注册表（唯一类型口径）+ 对象仓储（F11）
        links/                    交叉跳转关联：规范化配对 / 仓储 / 导航服务（F11）
        reason/                   原因项锚点（只读）
        audit/                    通用留痕仓储
      http/
        routes/                   证据路由、来源路由（F4）、四视图对象路由、指标集路由、开发登录路由
        middleware/               操作人识别、错误处理
      lib/token.js                HMAC-SHA256 签名 token
    test/evidence-ac.test.js      AC 逐条自动化验证（node:test）
    test/view-links-ac.test.js    F11 AC 逐条验证（可达性 / 落点 / 置灰 / 幂等 / 留痕）
    test/results-ac.test.js       F1 AC 逐条验证（口径红线 / 偏差 / 无数据 / 可追溯 / 幂等）
    test/source-ac.test.js        F4 AC 逐条验证（明细 / 人工录入 / 外部提供方 / 缺失标记与缺失率 / 约束兜底 / 留痕）
  frontend/
    src/
      App.vue                     登录 + 模块切换（经营结果 / 原因项证据 / 来源待补 / 四视图导航），默认落地 F1
      views/ResultOverviewView.vue F1 指标集视图（取数 + 状态）
      views/ReasonEvidenceView.vue 证据列表 / 无证据支撑提示 / 来源列 / 留痕
      views/SourceMissingView.vue F4 来源待补视图（缺失率 + 待补清单 + 来源明细）
      views/ViewExplorer.vue      F11 四视图外壳：类型切换、对象清单、hash 路由
      views/ViewObjectDetail.vue  F11 对象落地页 + 交叉跳转入口
      components/ResultMetricTable.vue F1 指标集纯展示组件（SSR 可测）
      components/SourceDetailPanel.vue F4 来源区块（场景 1/2/3 + 来源缺失标记）
      components/SourceMissingPanel.vue F4 缺失率 / 覆盖分布 / 判定核对 / 待补清单
      components/                 详情面板、新增弹层、关联弹层、四视图导航栏
      result-overview.js          F1 展示模型纯逻辑（无数据文案 / 偏差 / 口径版本与证据）
      source-view.js              F4 来源展示模型纯逻辑（明细 / 人工录入 / 缺失标记 / 缺失率）
      view-nav.js                 F11 导航纯逻辑（置灰判定 / 落点地址 / hash 解析）
      api/client.js               API 客户端
    test/                         F1 / F4 / F11 前端单测（模型 + SSR 渲染断言）
```

## 数据模型（本切片）

- `evidences` —— 证据：`type`（枚举）、`title`、`formed_at`、`owner`、`content`、`attachment_refs`，
  以及 **F4 来源字段**（见下方迁移 004）。
  约束：`title` / `formed_at` / `owner` 非空；`type` 为 `evidence_type` 枚举。
- `evidence_type_dict` —— 证据类型中文口径的唯一权威映射。
- `reason_evidences` —— Reason ↔ Evidence 关联，主键 `(reason_id, evidence_id)` 保证关联幂等。
- `audit_log` —— 通用留痕：`actor`（id）+ `actor_name`（可读名）+ `action` + `entity` + `at`。
- `result_metrics` / `result_reasons` —— Evidence 的挂载锚点（F1/F2 的完整字段由各自 issue 交付）。
- `ebms_users` —— 本切片最小操作人身份。

**F1 经营结果指标集（PAND-79，迁移 003）**

- `result_metrics` —— 指标**配置**（`code`、`name`、`dimension`、`period_type`、`period_value`、`as_of`
  已由 001 建；003 追加 `unit`、`owner_module`（`M05|M06|M09`）、`direction`（`higher_better|lower_better`）、
  `target_value`、`target_source_module`（固定 `M03`）、`target_source_ref`、`threshold_pct`、
  `is_active`、`order_no`、`updated_at`）。
  **刻意不含实际值/偏差列**：实际值不落在这里。
- `owner_results` —— Owner 模块 Result 的**消费收件箱**（`AEOS.Result.V1`）：
  `result_id`（唯一，幂等键）、`contract_version`、`source_system`（`M05|M06|M09`）、`object_type`、`object_id`、
  `metric_code`、`value`、`unit`、`period_type`、`period_value`、`calculation_version`（非空）、
  `evidence_ids`（JSONB 数组）、`status`（`VERIFIED|DRAFT|REJECTED`）、`occurred_at`、`trace_id`、
  `received_by`、`received_at`。
  实际值进视图的唯一路径：按 `(metric_code, owner_module, period, status='VERIFIED')` 取**最新一条**。
- `audit_log.action` 扩展 `owner_result.receive`。

**F4 证据来源标注（PAND-82，迁移 004）**

- `evidences` 追加来源字段（**不建 `sources` 表**，Source 是证据上的字段）：
  `source_type`（`internal | external | manual`）、`source_system`、`source_document_no`、
  `source_data_time`、`source_update_cycle`（`day | week | month`）、`source_provider`、
  `source_entered_by`、`source_entered_at`。
- CHECK 约束（把 AC 变成结构性保证，而非仅靠接口约定）：
  - `evidences_source_presence_check` —— 来源要么**整体为空**（=来源缺失），要么 `source_type` 与 `source_system` 均非空，**不允许「半截来源」**；
  - `evidences_external_provider_required` —— `external` 必须有 `source_provider`（判定标准 2）；
  - `evidences_manual_trace_required` —— `manual` 必须有 `source_entered_by` 与 `source_entered_at`（判定标准 3）；
  - `evidences_source_type_check` / `evidences_source_update_cycle_check` —— 枚举取值约束。
- 索引：`idx_evidences_source_type`、`idx_evidences_source_system`（供缺失率统计与 F10 按来源反查）。
- `audit_log.action` 扩展 `evidence.source.annotate` / `evidence.source.update`。

**F11 四视图（PAND-89，迁移 002）**

- `view_object_type` —— 枚举 `report | todo | decision | evidence`，交叉跳转的类型唯一取值来源。
- `reports` / `todos` / `decisions` —— 视图对象**锚点表**（含 `code` 唯一与最小展示字段）。
  约定与 `result_metrics`/`result_reasons` 一致：**各视图的完整业务字段由归属 issue 以 `ALTER TABLE` 追加**（PAND-85/86/87），本切片只保证「可被链接、可被解析出落点」。
- `object_links` —— 四视图对象之间的关联：`from_type/from_id`、`to_type/to_id`、`relation_type`
  （`related | derived_from | evidences | executes`）、`created_by`。
  约束：`pair_a`/`pair_b`（规范化的 `"<type>:<id>"` 字典序两端）+ `UNIQUE (pair_a, pair_b)` 保证
  **同一对对象只留一行**（关联幂等 + 双向可达）；`CHECK (pair_a <= pair_b)` 杜绝正反两行；
  `CHECK (NOT (from_type = to_type AND from_id = to_id))` 禁止自关联。
- `audit_log.action` 扩展 `view_link.create` / `view_link.delete`。

**证据类型枚举**（业务方 2026-09-23 确认口径，唯一取值来源）：

| code | label |
|---|---|
| `document` | 单据 |
| `contract` | 合同 |
| `system_record` | 系统记录 |
| `manual_note` | 人工说明 |

## 接口（内部 BFF，前缀 `/api/v1`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/result-sources` | **F1** 实际值 Owner 模块口径清单（M05/M06/M09 + 职责范围） |
| GET | `/results?period_type=&period_value=` | **F1 指标集**：目标值 / 实际值 / 偏差值 + 来源声明 + 口径版本 + 证据引用（缺省取最近周期） |
| GET | `/results/{metricId}` | **F1** 单指标详情（含 Owner Result 原样载荷与目标值溯源） |
| GET | `/owner-results?metric_code=&source_system=&limit=` | **F1** 已接收的 Owner Result 清单（对账用） |
| POST | `/owner-results` | **F1** 接收专业模块 Result 写入（需鉴权；按 `result_id` 幂等） |
| GET | `/evidence-types` | 证据类型枚举 |
| GET | `/reasons` | 原因项清单（含证据计数，导航锚点） |
| GET | `/reasons/{reasonId}/evidences` | **F3 证据列表** + `无证据支撑` 状态 + 操作留痕 |
| POST | `/reasons/{reasonId}/evidences` | **关联**已有证据（幂等） |
| DELETE | `/reasons/{reasonId}/evidences/{evidenceId}` | **解除关联**（不删除证据实体） |
| GET | `/evidences/{id}` | 证据详情（文本说明 + 附件） |
| GET | `/evidences/{id}/attachments/{index}` | 附件预览（`?download=1` 为下载） |
| POST | `/evidences` | **新增**证据（带 `reasonId` 时同时关联） |
| GET | `/evidences?unlinkedToReason=&q=` | 关联候选清单（完整检索由 F10/PAND-88 交付） |
| GET | `/source-catalog` | **F4** 来源类别（内部系统 / 外部数据 / 人工录入）与更新周期（日/周/月）枚举 |
| GET | `/evidences/{id}/source` | **F4 来源明细**：四项字段 + `sourceMissing` / 缺失标记 + 人工录入追加字段 + 更新周期与数据截止时间 + 待补字段 |
| PUT | `/evidences/{id}/source` | **F4 标注 / 更正来源**（需鉴权；首次记 `evidence.source.annotate`，更正记 `evidence.source.update`） |
| GET | `/sources/stats?q=&evidence_type=` | **F4 判定标准**：来源缺失率（缺失 ÷ 总数）+ 内部/外部/人工/缺失覆盖分布 + 两项判定核对 |
| GET | `/sources/missing?q=&evidence_type=&limit=&offset=` | **F4 边界**：来源缺失的证据待补清单（含待补字段与所挂原因项） |
| GET | `/view-object-types` | **F11** 四视图类型枚举（REPORT/TODO/Decision/Evidence） |
| GET | `/objects/{type}` | **F11** 某视图的对象清单（导航用，`?limit=`） |
| GET | `/objects/{type}/{id}` | **F11** 对象落地页数据（跳转落点） |
| GET | `/objects/{type}/{id}/links` | **F11 交叉跳转入口**：不带 `target_type` 返回三类入口（含 `disabled` / `hint`「无关联」）；带 `target_type` 返回该类型的关联对象平铺清单 |
| POST | `/objects/{type}/{id}/links` | **F11** 建立关联（幂等；重复建立返回 200 且 `created=false`） |
| DELETE | `/objects/{type}/{id}/links/{targetType}/{targetId}` | **F11** 解除关联（与建立方向无关） |
| POST | `/auth/dev-login` | 开发环境签发操作人 token |

写操作均需 `Authorization: Bearer <token>`，并写入留痕（操作人 + 时间）。

响应统一为 `{ ok: true, data }` / `{ ok: false, error: { code, message, details } }`。
新增校验失败时 `error.details.fields` 给出**全部**字段错误，`error.code` 给出首个错误的专属码。

## 本地运行

```bash
# 1) 数据库（PostgreSQL）
docker run -d --name ebms-postgres \
  -e POSTGRES_USER=ebms -e POSTGRES_PASSWORD=<password> -e POSTGRES_DB=ebms \
  -p 5433:5432 postgres:15-alpine

# 2) 后端
cd ebms/backend
cp .env.example .env       # 填写 EBMS_DB_PASSWORD 与 EBMS_AUTH_SECRET
npm install
npm run migrate            # 建表
npm run seed               # 灌入自检夹具
npm start                  # http://127.0.0.1:3020

# 3) 前端
cd ../frontend
npm install
npm run dev                # http://127.0.0.1:5199（/api 已代理到后端）
```

开发环境账号：`decider`（决策者）、`owner`（管理责任人）。

## 自检

```bash
cd ebms/backend && npm test        # 82 项：F3 + F11 + F1 + F4 的 AC 场景/边界/判定标准逐条断言
cd ebms/frontend && npm test       # 57 项：F1 / F4 / F11 模型 + SSR 渲染断言
cd ebms/frontend && npm run build  # 前端构建
```

后端测试按 `--test-concurrency=1` 串行执行：各测试文件都会 `migrate()` + `seed()` 重置同一测试库，
并发跑会互相 TRUNCATE（曾观察到 41/53 误报失败）。

F4 另做了**端到端契约走查**（真实后端 + 前端展示模型对同一份响应，非夹具）：确认场景 1/2/3 与
来源缺失的四类覆盖、缺失率随标注收敛、外部数据缺提供方被拒。该走查曾发现一处单测未覆盖的缺陷——
写入侧字段名不一致导致「外部数据的提供方」在接口返回 200 的情况下被静默丢弃（详见 `source-ac.test.js`
中「写入：外部数据标注成功后提供方真正落库」等三条回归用例）。

F4 夹具覆盖：7 条证据中 6 条已标注来源、**1 条刻意不标注**（文档类），因此缺失率 = 1 ÷ 7 = 14.29%；
已标注的 6 条覆盖**内部系统 4 条 / 外部数据 1 条（提供方「A 供应商（外部）」）/ 人工录入 1 条（录入人「钱厂长」）**，
使场景 1/2/3、边界与三项判定标准在同一份夹具上都能被断言。

F1 夹具覆盖：12 条指标（M09 6 条 / M05 2 条 / M06 4 条）、11 条 Owner Result；其中 2 条**无数据**
（`new_customer_count` 只供给过 2026-08 → 「来源模块未同步本期数据」；`on_time_delivery` 从未供给 →
「来源模块未供给」），供无数据边界与「偏差一并无法计算」的断言使用。

F11 夹具覆盖：6 组类型对（→ 12 个有向组合）各 1 条关联；`report`/`todo`/`decision`/`evidence` 各 1 个**无关联**对象（入口置灰边界）；1 个**部分关联** TODO（逐入口置灰）。

浏览器端 AC 走查（真实浏览器 23 项检查）见 PAND-81 评论中的验证结果。

## 关键约定

- **留痕与业务同事务**：新增/关联/解除关联的写入与其留痕在同一事务内提交，避免「操作生效但无留痕」。
- **关联幂等**：重复关联不产生第二条留痕；解除未关联的关系返回 409 而非静默成功。
- **实际值只来自 Owner Result**：EBMS 不持有实际值，也不读专业原始表；指标值经 `owner_results`
  按「指标 + Owner 模块 + 周期 + VERIFIED」取最新一条，来源模块限 `M05|M06|M09`。
- **无数据不兜底**：Owner 未供给时实际值与偏差均为「无数据」并给出原因（未供给 / 未同步本期），
  不显示 0、不留空白、不由 EBMS 计算。
- **口径与证据随值同行**：每条实际值必须带 `calculation_version` 与 `evidence_ids`，缺任一项的 Result 拒收。
- **无证据支撑**：接口返回 `evidenceStatus: NO_EVIDENCE`，前端渲染醒目告警 + 列表内显式提示。
- **来源缺失可统计、可收敛**：来源不强制在创建时给出，未标注的证据统一标记「来源缺失」并进入待补清单；
  缺失率 = 缺失 ÷ 总数（**0/0 返回 `null` 而非 0**，避免被读成「无缺失」）。
- **口径单一**：来源类别 / 更新周期的中文标签由后端一处给出（`source-types.js`），前端只做展示整形，
  不在前后端各写一遍口径。
- **附件不暴露存储路径**：附件经后端流式返回，路径以 `basename` 收敛，避免目录穿越。
- **不写入密钥**：`EBMS_AUTH_SECRET` 等由部署环境注入，`.env` 不入库。
