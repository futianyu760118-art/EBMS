# M10 POMS 微系统对接方案（EBMS / M03 侧）

> 版本：2026-10-31  
> 契约版本：`M10-POMS.V1`  
> 契约文件：`contracts/m10-poms-v1.schema.json`、`contracts/m10-poms-v1.examples.json`  
> 适用范围：EBMS 生产仓库 `D:\EBMS企业经营管理系统`

## 1. 定位与边界

AEOS V7.2 的系统注册表把 M10 定义为 **POMS 岗位个人操作微系统**，面向执行者的 Todo / Action / Evidence 提交与反馈；M03 EBMS 则是管理者 RESULT / EXCEPTION / DECISION / ACTION / EVIDENCE 的主工作面。

因此本次对接的边界是：

| 能力 | Owner | 说明 |
|---|---|---|
| SOP 协调会行动、AI 经营行动、会话行动项 | M03 EBMS | EBMS 管理行动的唯一起点与状态 Owner |
| 工作台 manifest、未来待办、历史结果引用 | M10 POMS | M10 只做工作面、装配与执行反馈，不复制事实 |
| 执行状态、证据引用、备注 | M10 提交，EBMS 落账 | 回写原 `sop_actions` / `ai_actions` / `chat_action_items` |
| 个人 Agent / 企业 Memory / Skills | AEOS Hub / M01 | EBMS 不重复建设，仅在 manifest 中标记不可用 |

红线：

1. 不在 EBMS 新建第二套待办表或第二套行动事实源；工作项由原业务表实时派生。
2. M10 反馈只更新 EBMS 所属管理行动，不跨域写专业表。
3. 未完成、未留证或未经管理侧确认的完成动作不会被伪造成“已验证”；`verification` 只有在原单据存在 `verified_by` / `verified_at` 时才为 `verified`，否则一律 `pending`，结果验证仍由 EBMS 管理侧留痕。
4. 机器通道未配置令牌时 fail-closed，返回 503，不写任何业务表。

## 2. 集成模式

采用 **拉取工作台 + 回写执行反馈** 的双向模式，不引入消息中间件：

```text
M10 POMS BFF / 页面
      │  1) GET workspace / work-items / results（Bearer M10_PARTNER_TOKEN）
      ▼
EBMS /api/m10/partner/*  ── 实时读取 ──►  sop_actions / ai_actions / chat_action_items
      ▲
      │  2) POST feedback（完成 / 进行中 / 阻塞 + 证据 + 备注）
      │
EBMS /api/m10/partner/feedback  ── 幂等落账 ──►  原行动状态 + m10_feedback
```

同时提供 EBMS 人员侧工作面 `/api/m10/me/*` 和可见的「微系统」页面 `frontend/m10.html`（我的待办 / 执行结果 / 我的岗位 / 个人 Agent / 对接自检）。正式个人操作入口仍为 M10 POMS；EBMS 页面用于未接入 M10 时的个人工作面与对接自检。

## 3. 契约对象

| 对象 | 方向 | 关键字段 |
|---|---|---|
| Workspace | EBMS → M10 | `person_id`、`widgets`、`actions`、`portal_url`、`source=ebms` |
| WorkItem | EBMS → M10 | `work_item_id`、`source_object_type`、`source_object_id`、`display_status`、`deep_link`、`allowed_action_refs` |
| Result | EBMS → M10 | `result_id`、`verification`、`evidence_refs`、`verified_at` |
| Feedback | M10 → EBMS | `feedback_id`、`idempotency_key`、`items[].status/evidence_refs/remark` |
| FeedbackResult | EBMS → M10 | `result`、`applied`、`skipped`、`conflicts`、逐项 `changes` |

状态口径：

| M10 display_status | EBMS `sop_actions.status` | 说明 |
|---|---|---|
| `pending` | `PENDING` | 待处理 |
| `in_progress` | `IN_PROGRESS` | 进行中 |
| `blocked` | `IN_PROGRESS` | 阻塞仍保留进行中，备注说明原因 |
| `awaiting_acceptance` | `VERIFYING` | 待验收（预留） |
| `done` | `CLOSED` | 完成，写入 `closed_at` |
| `cancelled` | `CANCELLED` | 取消（预留） |

`ai_actions` / `chat_action_items` 使用 `pending / in_progress / done / cancelled`，完成时写入 `result` 或保持原字段。

## 4. EBMS 接口

### 4.1 机器通道（M10 BFF 调用）

统一鉴权：`Authorization: Bearer ${M10_PARTNER_TOKEN}`（也接受 `X-M10-Token`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/m10/partner/status` | 通道健康状态（M10 侧探活，不返回机密） |
| GET | `/api/m10/partner/workspace?person_id=` | 工作台 manifest + 待办计数 |
| GET | `/api/m10/partner/work-items?person_id=&status=&limit=&include_done=1` | 未完成工作项（默认排除已完成） |
| GET | `/api/m10/partner/results?person_id=&limit=` | 已完成结果与证据引用 |
| POST | `/api/m10/partner/feedback` | 执行反馈，按 `idempotency_key` 幂等 |

`person_id` 支持以下任一形态：

1. `m10_person_link` 中登记的 M10 人员 ID；
2. EBMS 用户 ID / 用户名（如 `2`、`zhangsan`）；
3. EBMS 组织人员工号（如 `E001`）；
4. EBMS 稳定标识 `ebms:user:<id>` / `ebms:person:<id>`。

未找到映射时返回 200 + `person_unmapped: true` + 空列表，并给出 `hint`，不泄露全量待办。反馈接口则返回 422 `M10_PERSON_UNMAPPED`。

### 4.2 人员映射管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/m10/person-links` | 查看映射 |
| POST | `/api/m10/person-links` | 新增/更新：`{m10_person_id, ebms_user_id, ebms_personnel_id, name, emp_code}` |
| DELETE | `/api/m10/person-links/:id` | 删除映射 |

### 4.3 个人工作面（EBMS 登录态）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/m10/me/workspace` | 当前登录人的 manifest |
| GET | `/api/m10/me/work-items` | 当前登录人的工作项 |
| GET | `/api/m10/me/results` | 当前登录人的结果 |
| POST | `/api/m10/me/work-items/:workItemId/feedback` | 当前登录人回写，仅限本人事项 |

`workItemId` 需 URL 编码，例如 `ebms%3Asop_action%3A6`。

EBMS 页面 `frontend/m10.html` 提供与 PLM 岗位工作台类似的分栏工作面：

- **我的待办**：待办/进行中/逾期指标、工作项列表、异常专区、快捷入口；
- **执行结果**：已闭环行动、证据引用、待验证提示；
- **我的岗位**：人员、部门、岗位、角色码与 M10 人员映射状态；
- **个人 Agent**：跳转 AI 经营助手，并链接 M10 门户；
- **对接自检**：机器通道状态、反馈日志、人员映射维护（仅管理员可读写）。

### 4.4 管理面（`system:config`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/m10/status` | 通道状态、配置、反馈计数、映射数量 |
| GET/PUT | `/api/m10/config` | 非机密配置（`enabled`、`portalUrl`、`allowFeedback`、`roleMap` 等） |
| GET | `/api/m10/logs` | 反馈日志（分页/筛选） |

## 5. 数据映射与角色

默认接入三类管理行动：

| 来源表 | `source_object_type` | 标题 | 负责人匹配 |
|---|---|---|---|
| `sop_actions` | `SopAction` | `description` | `owner_name` / `owner_role` |
| `ai_actions` | `AiAction` | `title || content` | `assignee || user` |
| `chat_action_items` | `ChatActionItem` | `content` | `assignee || created_by` |

人员匹配顺序：

1. 姓名/用户名/工号精确匹配；
2. `owner_name` 支持 `张三+李四`、`张三、李四` 等组合写法拆分匹配；
3. `owner_role` 通过 `m10_sync_config.roleMap` 映射到 EBMS 角色码；
4. `created_by` / `assignee` 与 EBMS 用户 ID 匹配。

默认 `roleMap`：

```json
{
  "PURCHASE_HEAD": ["purchase", "purchase_manager"],
  "QUALITY_HEAD": ["engineer", "rd_manager"],
  "DEPT_HEAD": ["project_manager", "rd_manager", "sales_manager"],
  "SALES_DIRECTOR": ["sales_director", "sales_manager"],
  "ENGINEER_HEAD": ["engineer", "rd_manager"],
  "IT_ADMIN": ["admin"]
}
```

> 角色映射是配置项，不是硬编码业务事实。各企业可在 `PUT /api/m10/config` 中调整，不需要改代码。

## 6. 安全与失败语义

| 场景 | 行为 |
|---|---|
| 未配置 `M10_PARTNER_TOKEN` | `/api/m10/partner/*` 返回 503，不读不写业务表 |
| 令牌缺失/错误 | 401 |
| `m10_sync_config.enabled=false` | 机器通道 503，个人工作面仍可用（便于回滚） |
| 未映射人员 | 列表 200 + 空列表 + `person_unmapped`；反馈 422 |
| 越权回写他人事项 | 该条结果 `forbidden`，整体 `conflict`，HTTP 409；原单据不变 |
| 原单据已关闭后再次完成 | 幂等跳过（`skipped`），不重复记账 |
| 原单据已关闭后回退状态 | `conflict`，不改原单据 |
| 重复 `feedback_id` / `idempotency_key` | 直接返回 `skipped` + `duplicate=true` |

管理面复用现有权限码 `system:config`，不新增权限数据，避免部署期需要补权限。

## 7. 部署配置

`.env` 或 Docker Compose 环境变量：

| 变量 | 机密 | 说明 |
|---|---|---|
| `M10_PARTNER_TOKEN` | 是 | M10 机器通道 Bearer 令牌，随机长串 |
| `M10_PORTAL_URL` | 否 | M10 门户地址，如 `http://m10.local:4173/` |

已同步到 `docker-compose.yml` 与 `.env.example`。代码改动后按生产约定重建：

```powershell
docker compose up -d --build
docker compose ps
docker compose logs --tail=100
```

配置项也可通过 `PUT /api/m10/config` 热更新（不含令牌）；令牌仍只从环境变量读取。

## 8. M10 侧接入步骤（下一阶段）

EBMS 侧已完成；M10 仓库只需新增适配器，不复制 EBMS 数据：

1. 在 `adapters/` 下新增 `ebms`，读取 `EBMS_API`（默认 `http://host.docker.internal:3010`）与 `EBMS_M10_TOKEN`。
2. 实现三个拉取方法，映射到 M10 现有 `poms/me/*` 形状：
   - `GET /api/m10/partner/workspace?person_id=...`
   - `GET /api/m10/partner/work-items?person_id=...`
   - `GET /api/m10/partner/results?person_id=...`
3. 执行动作调用 `POST /api/m10/partner/feedback`，把 M10 的 `done / in_progress / blocked` 与证据引用回传。
4. 在 M10 统一门户增加 EBMS 卡片，跳转 `M10_PORTAL_URL` 对应页面或 EBMS `m10.html`。
5. M10 的人员 ID 若不是 EBMS 用户名/工号，先在 EBMS `POST /api/m10/person-links` 建立映射。

建议 M10 适配器保留 `source: 'ebms'` 标识，网络不可达时显式降级为“EBMS 暂不可用”，不得伪造成功。

## 9. 验收与回归

```powershell
node --check backend/lib/m10-contract.js
node --check backend/lib/m10-store.js
node --check backend/lib/m10-service.js
node --check backend/lib/m10-http.js
node --check backend/routes/m10.js
node scripts/m10-integration-regression.test.js
node scripts/audit-icons.js
git diff --check
```

回归脚本使用隔离的临时数据目录，不触碰生产 `database/sales.db`，覆盖：

- 契约示例可解析、反馈报文校验；
- 人员解析（工号、`ebms:user:<id>`、角色映射）；
- 工作项过滤（本人 / 角色 / 他人不可见）；
- 结果仅返回已闭环且有证据引用的记录；
- 反馈回写原 SOP 行动、幂等重放、越权拒绝；
- 机器通道 401 / 503 fail-closed。

## 10. 运维与回滚

- 观察：`GET /api/m10/status` 的 `transport.ready`、`feedback` 计数、`person_links`。
- 反馈异常：`GET /api/m10/logs?status=conflict` 查看逐项冲突原因。
- 快速停用：`PUT /api/m10/config {"enabled": false}`（机器通道停止，个人工作面保留），或移除 `M10_PARTNER_TOKEN` 后重启容器。
- 回滚：删除 `backend/lib/m10-*.js`、`backend/routes/m10.js`、`frontend/m10.html` 与路由挂载即可；sidecar 表 `m10_feedback`、`m10_person_link` 可保留，不影响 EBMS 业务。
- 不修改任何既有业务表结构；`sop_actions` / `ai_actions` / `chat_action_items` 仅通过原有字段更新。
