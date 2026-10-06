# EBMS — F9 Decision 决策视图（PAND-87）

EBMS（企业经营管理系统）的 Decision 场景化视图：记录决策背景、候选方案、所需证据与决策结论，
保证决策结论不可静默修改，并可关联其执行产生的 TODO 与回看执行结果。

本切片是 PAND-77 架构方案下 PAND-87 的**自有完整可运行切片**：后端 + 前端 + 数据库脚本 + 自检，
按架构方案分层（接入层 router → 应用层 service → 领域层 lib/repository），PostgreSQL 为主库、
SQLite 为本地自检驱动。**不重算、不复制任何专业中心内部算法**，只读取 F1/F2/F3/F8 已产出的结论。

## 目录结构

```
backend/
  src/config/           运行配置（DB_DRIVER / 分页 / 时钟）
  src/db/               pg 与 sqlite 双方言 schema、驱动抽象、迁移、演示数据
  src/lib/              领域层：decision-status（F9 规则）、todo-status（F8 只读镜像）、
                        domain（责任域/证据类型）、auth-token（HMAC-SHA256）、errors、password
  src/repositories/     数据访问：decision / decision_changes / todo / evidence / ref / link /
                        audit / user
  src/services/         应用层：decision-service（F9 用例）、auth、landing
  src/routers/          接入层：decisions（F9）、auth、me、health
  test/                 decision.ac.test.js（AC 逐条验证）、smoke-server.js（启动链路验证）
frontend/
  src/api/client.js     接口封装（token 存 localStorage）
  src/lib/              decision-view（状态/变更类型表现层映射）、format
  src/components/       StatusBadge / BackgroundRefs / OptionList / RequiredEvidence /
                        ChangeHistory / ExecutionTodos / ConclusionForm / CreateDecisionForm /
                        DecisionCard / EmptyState
  src/views/            LoginView / DecisionListView / DecisionDetailView
  test/                 decision-view.test.js（AC 的界面侧验证）
```

## 运行

后端（本地无 PostgreSQL 实例时用 SQLite 驱动，等价走同一套分层与 SQL）：

```bash
cd backend
npm install
npm run migrate:sqlite        # 建表
npm run seed:sqlite           # 写入演示数据
npm run start:sqlite          # http://127.0.0.1:4600
```

接入 PostgreSQL：复制 `.env.example` 为 `.env`，置 `DB_DRIVER=pg` 并填写 PGHOST/PGUSER/PGDATABASE，
然后 `npm run migrate && npm run seed && npm start`。两方言建表脚本分别为 `src/db/schema.pg.sql`
与 `src/db/schema.sqlite.sql`，SQL 统一以 `?` 占位符书写，pg 驱动内部翻译为 `$n`。

前端：

```bash
cd frontend
npm install
npm run dev                   # http://127.0.0.1:4700，/api 代理到 4600
npm run build                 # 产物 dist/
```

演示账号（口令统一 `ebms@2026`，可用 `EBMS_SEED_PASSWORD` 覆盖）：

| 账号 | 角色 | 数据范围 |
| --- | --- | --- |
| `dm` | 决策者（张决策） | 全企业 |
| `owner_sales` | 管理责任人（赵销售） | 仅销售域 |
| `no_role` | 未配置角色 | 不可进入主体功能 |

演示数据含 4 条决策：`d1` 已决策且结论被修改过一次（含前后值留痕）、关联 2 条执行 TODO（1 条已完成）；
`d2` 已决策且执行 TODO 逾期；`d3` 待决策（无结论、未关联 TODO）；`d4` 已决策且所需证据为空。

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/decisions` | 列表 + 已决策/待决策汇总（支持 `status`、`domain` 筛选） |
| POST | `/api/v1/decisions` | 创建决策（背景关联 + 候选方案 ≥1 + 所需证据），初始为待决策 |
| GET | `/api/v1/decisions/{id}` | 详情：背景、候选方案、所需证据、变更历史、执行情况 |
| PATCH | `/api/v1/decisions/{id}/conclusion` | 形成/修改结论（修改必须带 `reason`） |
| POST | `/api/v1/decisions/{id}/execution-todos` | 关联已有 TODO（`todo_ids`）或派发新 TODO（`todos`） |
| DELETE | `/api/v1/decisions/{id}/execution-todos/{todoId}` | 解除关联 |
| GET | `/api/v1/decisions/refs` | 创建表单候选（可关联的结果/原因/证据） |
| GET | `/api/v1/decisions/todo-candidates` | 可关联的执行 TODO 候选 |

`GET /decisions/refs` 与 `/decisions/todo-candidates` 必须注册在 `/:id` 之前，否则会被详情路由吞掉。

## AC 落点

**前置：存在 ≥1 条决策记录** — `backend/src/db/seed.js` 写入 4 条；`GET /decisions` 返回 `summary.total`。

**场景 1：每条决策含 背景（关联结果/原因）· 候选方案（≥1）· 所需 Evidence · 结论 · 决策人 · 决策时间**

- 背景关联在写入时校验存在性：`backend/src/services/decision-service.js:80` `resolveBackgroundRefs`，
  至少 1 条且 `type` 仅支持 `result`/`reason`；读取时重新解析并给出 `available` 标记，源对象消失也不隐藏引用。
- 候选方案 ≥1、每项须有名称：`normalizeOptions`（`decision-service.js:103`）。
- 所需 Evidence 为 id 列表，写入前校验存在；`GET` 详情返回 `requiredEvidence[].provided` 与
  `evidenceSummary`，字段存在但为空表示「本决策无需外部证据」，不视为缺失。
- 决策人/决策时间：`baseView`（`decision-service.js:249`）输出 `decider`/`decidedAt`。

**场景 2：决策结论不可静默修改，修改须留痕（变更人、时间、变更前后值）**

两层结构保证，互不依赖：

1. **数据库层**——`decisions` 表上的 CHECK 约束（`schema.pg.sql` / `schema.sqlite.sql`）强制「已决策不变量」：
   `status='decided'` ⇔ `conclusion`、`decider`、`decided_at` 三者同时非空；`status='pending'` 时三者必须全空。
   因此**不存在**「已决策却缺决策人/时间」或「待决策却带结论」的落库路径。
2. **仓储层**——`backend/src/repositories/decision-repo.js:133` `updateConclusion` 在同一事务内
   更新结论并向 `decision_changes` 追加一条记录；`decisions.conclusion` 只由该方法写入，
   故不存在「改了结论却没有变更记录」的路径。

服务层在修改路径上追加两道校验（`decision-service.js:404` `decideConclusion`）：
已形成结论后修改**必须**提供 `reason`，否则 400（`决策结论不可静默修改`）；结论值与现值相同则 422，
不产生无意义的变更记录。

变更历史按写入序号 `decision_changes.seq` 排序而非 `changed_at`——同一毫秒内的多条变更靠时钟无法区分先后，
而变更历史必须按实际发生次序展示。

**场景 3：决策可关联其执行产生的 TODO，并可回看执行结果**

`linkExecutionTodos`（`decision-service.js:499`）支持关联已有 TODO 与由决策派发新 TODO（写入 F8 表
`source='manual'`，并携带该决策的背景关联作为 `related_refs`）；两种操作都追加 `decision.todo_linked` 留痕，
解除关联追加 `decision.todo_unlinked`。执行结果由 `buildExecution`（`decision-service.js:181`）
**只读** F8 TODO 现状 + 流转留痕，输出 done/inProgress/pending/overdue 与完成度。

**边界：未形成结论的记录状态为「待决策」，不计入已决策数量**

`countsByStatus`（`decision-repo.js:230`）分别统计 pending 与 decided，`summary.decided` 只含已决策；
列表与卡片上待决策条目标注「不计入已决策数量」。

**边界：不做决策效果评价** — 决策在其执行 TODO 未全部完成时同样成立为已决策；响应中不引入任何
效果评价字段。`已确认口径（2026-09-23）：关联执行 TODO + 回看执行结果 required；效果评价 not required`。

**判定标准**

- 已决策条目 决策人、决策时间 非空 — `assertDecidedInvariant`（`lib/decision-status.js`）在详情返回前自检，
  前端 `decidedFieldsPresent` 为假时显式报数据异常。
- 变更记录条数 ≥ 实际修改次数 — `conclusionChangeCount` 统计 `decision.decided` / `decision.revised`
  两条动作，列表与详情均返回（列表侧由 `countChangesFor` 一次分组查询取回整页，避免 N+1）。
- 未形成结论的记录均标记「待决策」 — 状态取值只有 `pending`/`decided`，标签由 `DECISION_STATUS_LABELS` 统一给出，
  且数据库 CHECK 已排除其他组合。

## 自检结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 后端 AC 逐条验证（真实 HTTP + 真实数据库） | `cd backend && npm test` | 13/13 通过 |
| 服务端启动链路（migrate + listen + 主链路） | `cd backend && npm run smoke` | 通过 |
| 前端 AC 界面验证 | `cd frontend && npm test` | 17/17 通过 |
| 前端生产构建 | `cd frontend && npm run build` | 通过（43 modules，129 kB / gzip 47 kB） |

`npm test`（后端）覆盖：前置条件、场景 1（字段齐备 + 创建校验）、场景 2（静默修改被拒、留痕含前后值、
变更计数 ≥ 修改次数、无变化不产生记录）、场景 3（关联已有/派发新 TODO/解除关联 + 执行回看 + 逾期标记）、
边界（待决策不计入已决策、不强制效果评价、数据库 CHECK 兜底）、判定标准、数据范围（管理责任人仅见本责任域、
越权读/写返回 403）、未登录 401、筛选与分页、404。

`npm run smoke` 额外验证 `src/server.js` 的真实启动路径（迁移、监听、优雅退出）与
「登录 → 列表 → 详情 → 静默修改被拒 → 带理由修改留痕 → 待决策不计入 → 派发执行 TODO」主链路。

前端测试覆盖：列表/详情要素齐备、创建表单的必填拦截与请求体形状、修改结论时必须填写理由（未填时按钮禁用
且不发请求）、结论未变化不提交、首次形成结论不要求理由、变更历史的前后值/变更人/时间/理由展示、
执行 TODO 的状态与逾期展示、关联已有与派发新 TODO 的请求体、解除关联、待决策的展示与汇总口径、
空态与创建入口、筛选带参与 URL 同步、管理责任人的责任域下拉收敛。

## 与架构方案的对齐

- **分层**：router（HTTP 编排、参数取值）→ service（用例、权限、校验、留痕）→ repository（SQL）→ lib（领域规则）。
  错误码统一小写（`bad_request`/`unauthorized`/`forbidden`/`not_found`/`unprocessable`/`constraint_violation`），
  由 `middleware/error.js` 集中映射。
- **鉴权**：自签 HMAC-SHA256 token（`base64url(payload).sig`），契约与 sales.git 的 `auth-token.js` 一致，
  未引入 jsonwebtoken。RBAC 角色 `decision_maker`（全企业）/`domain_owner`（责任域），
  数据范围在 repository 的 `scopeClause` 上收敛，越权读 → 403、越权写 → 403。
- **数据模型**：`decisions` 与 `decision_changes` 字段与架构方案的 Decision 契约一致；`decision_changes`
  增加 `seq`（写入序号，见场景 2 说明）。跨视图跳转沿用 PAND-89 口径的 `object_links`
  （本切片只写 `decision → todo`），为 F11 交叉跳转预留。
- **写操作留痕**：结论形成/修改、TODO 关联/解除除写入 `decision_changes` 外，另记 `audit_log`。

### 本切片承接的既有约定（来自同架构下的并行切片，非本切片新增）

- `users`/`roles`/`user_roles`/`role_scope`、`audit_log`、`object_links`、`result_metrics`、
  `result_reasons`、`evidences` 的表结构与 PAND-85（REPORT 视图）保持一致；
- `todos` 表结构与状态口径取自 PAND-86（TODO 视图，F8），本切片只读写、不改其状态流转规则；
- `decisions` 表在 PAND-85 中仅为占位（骨架字段），本切片按 PAND-77 架构方案补齐
  `background`/`options`/`required_evidence_ids`/`decider_id` 等并新增 `decision_changes`。

### 已知偏差与待裁决事项

1. **登录落地视图**：F15（PAND-93）口径为「决策者 → REPORT」，但本切片只装载 Decision 视图，
   故 `landing-service.resolveLanding` 的 `view`/`route` 均指向本切片实际装载的 Decision 视图，
   同时保留 `reportRoute: '/reports'` 与 F15 的角色语义，落地裁决权归 PAND-93 切片。前端路由
   `'/'` 重定向到 `/decisions` 与此一致。
2. **TODO 候选无域过滤**：F8 `todos` 表不带责任域字段，故 `GET /decisions/todo-candidates` 不做域过滤，
   只标注每条 TODO 已关联到哪个决策（`linkedDecisionId`/`linkedHere`）以避免重复关联；
   决策本身的可见性校验不受影响。
3. **未纳入本切片**：REPORT/TODO/Evidence 视图、F11 四视图交叉跳转的读侧、决策效果评价（口径明确不要求）。
