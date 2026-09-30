# EBMS 经营管理系统

EBMS 是**跨域结论汇聚 + 经营判断 + 追溯**层，面向决策者与管理责任人，支持 Result → Reason → Evidence → Source 四层穿透。EBMS **不重算、不复制**任何专业中心（销售/生产·交付/财务/供应链）的内部算法与业务明细，只存「结论 / 归因 / 证据 / 来源 / 判断 / 视图」及其留痕。

本目录是 EBMS 的代码库，按架构方案（PAND-77）落地：后端 Node.js + Express（router → service → repository 分层）+ PostgreSQL；前端 Vue 3 + Vite。

> 交付位置说明：EBMS 是独立系统，`sales.git` 是其要汇聚的四个专业中心之一。当前平台仅提供 `sales.git` 作为仓库，因此 EBMS 代码以**新增顶层目录 `ebms/`** 的形式提交，**未修改任何既有 sales 文件**。若团队希望拆分为独立仓库，可整体迁移本目录。

## 当前实现范围

本次交付 **F1 经营结果指标集（PAND-79）**、**F3 证据关联（PAND-81）**、**F8 TODO 视图（PAND-86）** 与 **F11 四视图交叉跳转（PAND-89）** 四个完整切片，并包含其运行所需的**最小数据底座**（工程骨架、鉴权/RBAC 中的操作人识别、Result/Reason 锚点、通用留痕）。

| 功能 | 状态 |
|---|---|
| F1 结果指标集：目标值 / 实际值 / 偏差值 + 来源与口径可追溯（PAND-79） | ✅ 已实现 |
| F3 原因项挂载并查看支撑证据（PAND-81） | ✅ 已实现 |
| F8 TODO 视图：待办聚合 + 两种来源 + 认领 / 指派 / 状态流转（PAND-86） | ✅ 已实现 |
| F11 REPORT/TODO/Decision/Evidence 四视图互相跳转（PAND-89） | ✅ 已实现 |
| F2 归因穿透（PAND-80） | 锚点表 `result_reasons` + 只读清单已建，归因算法未实现 |
| F7 REPORT 视图（PAND-85）、F9 Decision 视图（PAND-87）、F10 Evidence 检索（PAND-88）、F4 来源标注（PAND-82）、F5 四层下钻（PAND-83）等 | 未实现（后续 issue） |

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

### F11 四视图交叉跳转（PAND-89）说明

四视图口径：**REPORT = Result**、**TODO = Action**、**Decision**、**Evidence**。

- **关联模型**：`object_links` 一行 = 一条关联，**天然双向可达**。因此 Report↔TODO 一条记录即同时满足 `report→todo` 与 `todo→report`，6 组类型对即可覆盖 AC 要求的全部 12 个有向组合。
- **幂等**：写入时把两端规范化为 `pair_a`/`pair_b`（`"<type>:<id>"` 字典序），配合 `UNIQUE (pair_a, pair_b)`，同一对对象无论从哪端、方向如何建立都只留一行。
- **置灰边界**：无关联时入口**置灰**且提示「**无关联**」；判定按**入口**（目标类型）粒度，因此部分关联的对象只置灰没有关联的那几个入口。
- **视图对象锚点**：本切片只建「能被链接、能被解析出落点」的对象身份（`reports`/`todos`/`decisions`，`evidences` 见 001）。各视图的**完整业务字段由归属 issue 以 `ALTER TABLE` 追加**（PAND-85/86/87/88），本切片不臆造其业务列。
- **跳转落点**：前端 hash 路由 `#/report/<id>`、`#/todo/<id>`、`#/decision/<id>`、`#/evidence/<id>`，可直接作为直达链接，支持浏览器前进/后退。
- **不涵盖**：关联的新增/解除目前只有后端接口与留痕，前端未提供编辑入口（导航为本 issue 的 AC 范围）。

### F8 TODO 视图（PAND-86）说明

TODO 视图聚合**待决策者 / 管理责任人处理**的事项，一屏可认领、指派并推进状态。

- **七列齐备（场景 1）**：每条待办渲染 事项 / 来源 / 关联结果或原因 / 责任人 / 截止时间 / 状态 / 可执行动作。三处「空值」不留白——未关联渲染「未关联结果或原因」、未指派渲染「未指派」、无截止时间渲染「无截止时间」。
- **两种来源并存（场景 2）**：`source` 取 `rule`（规则自动产生）与 `manual`（人工派发），**两条产生路径都真实存在**——规则引擎 `POST /todos/rule-scan` 扫描 F1 指标偏差与 F2 原因项产生待办；人工派发走 `POST /todos`。列表顶部常显「规则自动产生 N 条 / 人工派发 M 条」及**并存成立**判定，避免「名为聚合、实则只有一条来源」。
- **规则幂等**：`rule_key = "<rule_code>:<ref_id>"` + 部分唯一索引，同一规则对同一锚点重复扫描只留一行（重复扫描返回 `created=[]`，不留第二条待办也不留第二条留痕）。
- **状态三类齐备（场景 3）**：`pending 待处理 → in_progress 处理中 → done 已完成`，枚举由后端下发（前端不硬编码）。状态机只放行合法边：`pending→in_progress`、`in_progress→pending|done`，`done` 为**终态**（`allowedTransitions=[]`）；非法流转返回 400 `TODO_TRANSITION_INVALID` 并回带 `allowed` 空数组。列表与详情**只渲染状态机允许的动作按钮**，不出现注定被拒的入口。
- **留痕（场景 3 判定标准）**：`todo.create` / `todo.rule_generate` / `todo.claim` / `todo.assign` / `todo.transition` 五类写入全部进 `audit_log`，含**操作人（id + 可读名）、时间、before/after**。详情页把 `before/after` 还原成「责任人：未指派 → 李责任（…）」「状态：待处理 → 处理中」的变更文案；状态码用后端下发的枚举翻译。
- **筛选与逾期（场景 4）**：可按 责任人 / 状态 / 来源 / 截止时间（`due_before`，按本地当天结束解释）/ 是否逾期 过滤；逾期项带醒目「逾期 N 天」标记并进统计条。**逾期判定完全由后端按「截止时间 vs 当前时间」比较得出**，已完成项即使过期也不计入逾期。筛选生效时界面显式提示「上方计数为全部待办」，统计条不被筛选结果污染。
- **边界（结构性封死）**：来源为 `rule` 的行**必须**带触发依据（规则编码 + 可读摘要 + 锚定的结果指标或原因项），库层 `CHECK todos_rule_trigger_required` 与业务层校验**双重保障**，缺一即拒收——不存在「来源是规则却查不到依据」的行。触发依据在详情页展开（期间 / 检出时间 / 锚定），责任人可据此核对「为什么派给我」。界面另设自检文案与缺失告警：正常时显示「规则自动产生的 N 条待办均含触发依据」，异常时改为「有 N 条自动产生的待办缺少触发依据」并在行内标记，**不静默**。
- **认领与指派**：未指派且未完成的待办可**认领**（`POST /todos/:id/claim`，写入人即认领人，重复认领返回 409 `TODO_ALREADY_CLAIMED`）；也可由决策者**指派**给他人（`POST /todos/:id/assign`）。人工派发必须指明责任人（库层 `CHECK todos_manual_owner_required`）。
- **展示口径（红线）**：前端**不自行判定逾期、不自行维护状态/来源枚举**，逾期标记、可流转动作、来源标签、关联对象可读名全部由接口下发，避免与后端状态机、逾期比较口径漂移。截止时间按**本地日历**渲染——接口返回 UTC 时刻，业务时区（UTC+8）的零点在 UTC 上是前一天 16:00，直接切 ISO 字符串会把「9-30 到期」显示成「9-29」。
- **不涵盖**：TODO 的删除/归档；批量操作；责任人候选的组织架构下拉（当前为自由输入 `部门 / 姓名`）。

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
        migrations/004_todos.sql   TODO 业务列 + 触发依据/责任人约束 + 规则幂等索引（F8）
      domain/
        evidence/                 证据域：类型枚举 / 仓储 / 服务（校验+用例）
        results/                  F1 指标域：来源口径 / Owner Result 仓储 / 指标仓储 / 服务
        todos/                    F8 待办域：状态机 / 仓储 / 服务（认领·指派·流转）/ 规则引擎
        views/                    四视图对象注册表（唯一类型口径）+ 对象仓储（F11）
        links/                    交叉跳转关联：规范化配对 / 仓储 / 导航服务（F11）
        reason/                   原因项锚点（只读）
        audit/                    通用留痕仓储
      http/
        routes/                   证据路由、四视图对象路由、指标集路由、TODO 路由、开发登录路由
        middleware/               操作人识别、错误处理
      lib/token.js                HMAC-SHA256 签名 token
    test/evidence-ac.test.js      AC 逐条自动化验证（node:test）
    test/view-links-ac.test.js    F11 AC 逐条验证（可达性 / 落点 / 置灰 / 幂等 / 留痕）
    test/results-ac.test.js       F1 AC 逐条验证（口径红线 / 偏差 / 无数据 / 可追溯 / 幂等）
    test/todos-ac.test.js         F8 AC 逐条验证（七列 / 两来源 / 三状态与流转 / 筛选逾期 / 触发依据）
  frontend/
    src/
      App.vue                     登录 + 模块切换（经营结果 / 原因项证据 / 四视图导航 / TODO 待办），默认落地 F1
      views/ResultOverviewView.vue F1 指标集视图（取数 + 状态）
      views/ReasonEvidenceView.vue 证据列表 / 无证据支撑提示 / 留痕
      views/ViewExplorer.vue      F11 四视图外壳：类型切换、对象清单、hash 路由
      views/ViewObjectDetail.vue  F11 对象落地页 + 交叉跳转入口
      views/TodoListView.vue      F8 待办视图：筛选栏 + 列表/详情分栏 + 人工派发 + 规则扫描
      components/ResultMetricTable.vue F1 指标集纯展示组件（SSR 可测）
      components/TodoTable.vue    F8 待办列表纯展示组件（七列 / 统计 / 逾期标记）
      components/TodoDetailPanel.vue F8 详情面板（触发依据 + 流转留痕时间线 + 认领/指派/流转）
      components/TodoCreateDialog.vue F8 人工派发表单
      components/                 详情面板、新增弹层、关联弹层、四视图导航栏
      result-overview.js          F1 展示模型纯逻辑（无数据文案 / 偏差 / 口径版本与证据）
      todo-view.js                F8 展示模型纯逻辑（七列 / 逾期与筛选 / 留痕变更文案 / 本地日历日期）
      view-nav.js                 F11 导航纯逻辑（置灰判定 / 落点地址 / hash 解析）
      api/client.js               API 客户端
    test/                         F1 / F8 / F11 前端单测（模型 + SSR 渲染断言）
```

## 数据模型（本切片）

- `evidences` —— 证据：`type`（枚举）、`title`、`formed_at`、`owner`、`content`、`attachment_refs`。
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

**F8 TODO 视图（PAND-86，迁移 004）**

- `todos` —— 由 F11 建锚点（`code` 唯一 + 最小展示字段），004 **追加业务列**：
  `related_refs`（JSONB 数组，非空；服务端回源 `result_metrics`/`result_reasons` 解析 label 后落库，
  前端只提交 `refId` 不提交 label，避免展示文案被伪造）、
  `trigger_basis`（JSONB，仅 `source='rule'` 必填）、
  `rule_key`（`"<rule_code>:<ref_id>"` 幂等键）、`updated_at`。
  状态列 `status` 由 002 建（`pending|in_progress|done`），来源列 `source` 取 `rule|manual`。
- **约束（数据相关，`NOT VALID`）**——存量行由 seed 按新口径重灌，对约束生效后写入的每一行强制；
  `todos-ac.test.js` 在灌入夹具后执行 `VALIDATE CONSTRAINT`，证明库内数据全部合规：
  - `todos_rule_trigger_required` —— **边界红线**：`source='rule'` 的行必须有
    `trigger_basis.ruleCode` + `summary` 非空，且**必须锚定**到 `resultMetricId` 或 `reasonId`
    （杜绝「只有规则名、查不到出处」的自动待办）。
  - `todos_manual_owner_required` —— 人工派发必须有责任人（自动产生的可为空，等待被认领）。
  - `todos_related_refs_array` —— `related_refs` 必须是 JSON 数组。
- **索引**：`uq_todos_rule_key`（部分唯一，仅 `rule_key IS NOT NULL`）保证规则幂等；
  `owner` / `status` / `due_at` / `source` 各一索引，支撑场景 4 的筛选与逾期扫描。
- `audit_log.action` 扩展 `todo.create` / `todo.rule_generate` / `todo.claim` / `todo.assign` / `todo.transition`。

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
| GET | `/view-object-types` | **F11** 四视图类型枚举（REPORT/TODO/Decision/Evidence） |
| GET | `/objects/{type}` | **F11** 某视图的对象清单（导航用，`?limit=`） |
| GET | `/objects/{type}/{id}` | **F11** 对象落地页数据（跳转落点） |
| GET | `/objects/{type}/{id}/links` | **F11 交叉跳转入口**：不带 `target_type` 返回三类入口（含 `disabled` / `hint`「无关联」）；带 `target_type` 返回该类型的关联对象平铺清单 |
| POST | `/objects/{type}/{id}/links` | **F11** 建立关联（幂等；重复建立返回 200 且 `created=false`） |
| DELETE | `/objects/{type}/{id}/links/{targetType}/{targetId}` | **F11** 解除关联（与建立方向无关） |
| GET | `/todo-meta` | **F8** 状态 / 来源 / 规则 / 关联引用类型枚举（前端筛选栏唯一取值来源） |
| GET | `/todos?owner=&status=&source=&due_before=&overdue=&limit=` | **F8 待办列表（场景 1/4）**：七列 + 逾期标记 + 筛选 + 汇总统计（`summary` 含 `bothSourcesPresent`） |
| POST | `/todos/rule-scan` | **F8 规则自动产生（场景 2 来源之一）**：扫描 F1 指标偏差与 F2 原因项产生待办（幂等；`dryRun` 只返回候选不写库） |
| GET | `/todos/{id}` | **F8 详情（场景 3）**：七列 + 触发依据 + 流转留痕时间线（含操作人 / 时间 / change） |
| POST | `/todos` | **F8 人工派发（场景 2 来源之二）**：必须指明责任人 |
| POST | `/todos/{id}/claim` | **F8 认领**：写入人即认领人；重复认领 409 `TODO_ALREADY_CLAIMED` |
| POST | `/todos/{id}/assign` | **F8 指派**：指派给他人 |
| POST | `/todos/{id}/transitions` | **F8 状态流转**：只放行状态机合法边，非法流转 400 `TODO_TRANSITION_INVALID` |
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
cd ebms/backend && npm test        # 71 项：F3 + F11 + F1 + F8 的 AC 场景/边界/判定标准逐条断言
cd ebms/frontend && npm test       # 51 项：F11 导航 / F1 指标集 / F8 待办模型 + SSR 渲染断言
cd ebms/frontend && npm run build  # 前端构建
```

F1 夹具覆盖：12 条指标（M09 6 条 / M05 2 条 / M06 4 条）、11 条 Owner Result；其中 2 条**无数据**
（`new_customer_count` 只供给过 2026-08 → 「来源模块未同步本期数据」；`on_time_delivery` 从未供给 →
「来源模块未供给」），供无数据边界与「偏差一并无法计算」的断言使用。

F11 夹具覆盖：6 组类型对（→ 12 个有向组合）各 1 条关联；`report`/`todo`/`decision`/`evidence` 各 1 个**无关联**对象（入口置灰边界）；1 个**部分关联** TODO（逐入口置灰）。

F8 夹具覆盖：**两种来源并存**（规则自动产生 + 人工派发）、**三类状态齐备**（待处理 / 处理中 / 已完成）、
指派与未指派、逾期 / 未逾期 / 无截止时间、触发依据的两种锚点（结果指标 / 原因项）、
以及一条 `done` 终态项（验证「已完成不可回流、不再提供认领」）。
后端 AC 用例额外覆盖：库层 `VALIDATE CONSTRAINT`（证明无「来源为规则却无触发依据」的行）、
原始 `INSERT` 绕过服务层被拒、401 `AUTH_REQUIRED`、规则幂等（重复扫描不产生第二条）、
`due_at = as_of + 7d` 与 F1 偏差集一致、「无数据不产生待办」。

截止时间按**本地日历**渲染（接口返回 UTC 时刻），前端单测用 `localDate`/`localTime` 辅助断言，
不绑定运行时区，并保留「非 UTC 时区下不得等于切字符串结果」的回归防线。

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
- **附件不暴露存储路径**：附件经后端流式返回，路径以 `basename` 收敛，避免目录穿越。
- **自动产生的 TODO 必须可回溯**：`source='rule'` 的行必须带触发依据（规则编码 + 摘要 + 锚定的
  结果指标或原因项），**库层约束 + 业务层校验双重保障**；触发依据在详情页对责任人可见，
  回答「为什么派给我」。缺失时界面显式告警，不静默。
- **状态机是唯一流转口径**：`pending → in_progress → done`，`done` 为终态；非法流转一律拒绝，
  前端只渲染状态机允许的动作。状态 / 来源枚举由后端下发，前端不硬编码。
- **逾期与日期口径**：逾期由后端按「截止时间 vs 当前时间」比较得出（已完成项不计入）；
  日期筛选按本地当天结束解释；展示按**本地日历**渲染 UTC 时刻，避免跨时区偏移一天。
- **不写入密钥**：`EBMS_AUTH_SECRET` 等由部署环境注入，`.env` 不入库。
