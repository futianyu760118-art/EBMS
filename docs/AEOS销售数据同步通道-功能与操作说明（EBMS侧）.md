# AEOS 销售数据同步通道 — 功能与操作说明（EBMS 侧）

> 交付件：PAND-250「开发B·EBMS 侧：销售数据双向同步端点 + 通道扩展」
> 契约依据：PAND-248《架构方案·契约冻结版》（唯一权威）；数据所有权取「读法 A」
> 代码位置：`backend/lib/aeos-*.js`、`backend/routes/aeos.js`、`backend/routes/index.js`、各业务路由出站点
> 自检脚本：`backend/test-aeos-sync.js`

本说明分两部分：**功能说明**（通道做了什么、口径是什么）与**操作说明**（日常怎么看、出事怎么办）。

---

## 一、功能说明

### 1.1 范围与红线

| 项 | 说明 |
| --- | --- |
| 做什么 | ① EBMS→CRM 出站：销售 6 模块主数据/变更事件经 Outbox 投递；② CRM→EBMS 入站：落本地库（键映射 + 冲突规则）；③ 通道扩展：按冻结契约新增入站端点与出站队列；④ 幂等/重试/死信/对账/迁移导出 |
| 不做什么 | 不直写 CRM 库（只走契约 HTTP 通道）；不重算、不复制任何专业中心内部算法；不改 EBMS 现有业务规则，只在本地 CRUD 提交点做「数据同步点」 |
| 不改表结构 | 所有同步表均为 sidecar（`aeos_*`），不参与业务计算 |
| 不写密钥 | token 只从环境变量读取，配置项落库前显式剔除 `token` |

### 1.2 通道拓扑

```
EBMS ──POST /api/v1/integrations/ebms/ingest──▶ CRM      出站（Bearer EBMS_INBOUND_TOKEN）
EBMS ◀─POST /api/aeos/ingest─────────────────  CRM      入站（Bearer EBMS_INGEST_TOKEN）
```

- 出站报文头：`Authorization: Bearer <EBMS_INBOUND_TOKEN>`、`X-Idempotency-Key`、`X-Contract-Version`、`X-Event-Type`。
- 入站端点：`POST /api/aeos/ingest`；管理面（队列/对账/日志/配置）在 `/api/aeos/*`，权限码沿用 `system:config`，不新增权限码。
- 入站鉴权 fail-closed：**通道未配置**（服务端无 `EBMS_INGEST_TOKEN`）→ `503`；**缺凭据** → `401`；**凭据错** → `401`。以上三种情况都不落库。

### 1.3 事件信封（AEOS.Event.V1）

`event_id`、`trace_id`、`event_type`、`object_type`、`object_id`、`operation`、`source_system`、`occurred_at`、`idempotency_key`、`contract_version`、`payload`。

- `event_id = EVT-{source}-{object_type}-{object_id}-{8hex}`；`trace_id = TRACE-{event_id}`。
- `idempotency_key = "{target_system}:{event_type}:{object_id}:{fingerprint}"`。
- `fingerprint = sha1(canonical(event 去掉 occurred_at 等派生字段))[:16]`——**内容幂等**以「业务内容」为准，不因每次生成的新 `event_id` 而变化。
- `occurred_at = 源行 updated_at`（对侧 LWW 排序依据，不用发送时刻）。

### 1.4 事件 / 契约对照表

| # | event_type | 契约对象 | 本地表 | object_id（§2 业务键） | 字段归属 | 出站触发点 | 覆盖 AC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `customer.upserted` | Customer | `customers` | `name` | 全字段 Owner=CRM | `routes/customer.js` 新增/修改/批量修改 | S1 S2 S3 S6 |
| 2 | `customer.deleted` | Customer | `customers` | `name` | — | `routes/customer.js` 删除/批量删除 | S1 S6 |
| 3 | `inquiry.upserted` | Inquiry | `inquiries` | `serial_number`（基号） | 成本类字段 Owner=EBMS：`material_cost`/`process_cost`/`accessory_cost`/`estimated_loss`/`base_cost`/`profit_rate`/`discount_rate`/`final_price`；其余 Owner=CRM | `routes/inquiry.js` 创建/模板导入/批量创建/更新/状态/核价/折扣审批 | S1 S2 S3 S6 S7 |
| 4 | `inquiry.deleted` | Inquiry | `inquiries` | `serial_number`（基号） | — | `routes/inquiry.js` 删除（基号下已无并五行才出 DELETE） | S1 S6 |
| 5 | `quote_library.upserted` | QuoteLibrary | `quote_library` | `{external_model}#{certificate_level}` | 全字段 Owner=CRM | `routes/quote.js` 新增/更新/核价同步 | S1 S9 |
| 6 | `quote_library.deleted` | QuoteLibrary | `quote_library` | 同上 | — | `routes/quote.js` 删除/去重 | S1 |
| 7 | `order.upserted` | Order | `orders` | `{order_no}#{line_no}` | 全字段 Owner=CRM（含 `user_status_locked` 人工锁标记） | `routes/order.js` 创建/更新/状态/按业务键批量 | S1 S7 |
| 8 | `order.deleted` | Order | `orders` | `{order_no}#{line_no}` | — | `routes/order.js` 删除/批量删除 | S1 |
| 9 | `sample.upserted` | Sample | `samples` | `sample_no` | 全字段 Owner=CRM | `routes/sample.js` 新增/更新 | S1 |
| 10 | `sample.deleted` | Sample | `samples` | `sample_no` | — | `routes/sample.js` 删除 | S1 |
| 11 | `feedback.upserted` | Feedback | `feedback` | `feedback_no`，缺失时 `fb:{sha1(submitter‖title‖created_at)[:16]}` | 全字段 Owner=CRM | `routes/feedback.js` 新增/更新 | S1 |
| 12 | `feedback.deleted` | Feedback | `feedback` | 同上 | — | `routes/feedback.js` 删除 | S1 |
| 13 | `dictionary.upserted` | Dictionary | （sidecar `aeos_dictionary*`） | `dict_type` | Owner=EBMS（P1，本期注册未实现） | — | S1 |

> 业务键中的 `#` 在编码时转义为 `~`（`quote_library`/`order` 复合键、`serial_number` 含 `#` 的场景）。

### 1.5 幂等、重试与对账

- **幂等（出站）**：同内容重复保存被指纹幂等吸收（队列内不重复入队）；**同 `object_id` 内容变化视为新投递**；同一对象已有未投递记录时**合并为最新内容**（避免抖动刷屏）。同对象出现 DELETE 时，丢弃该对象尚未发出的增/改记录，只留一条 `deleted`。
- **幂等（入站）**：`idempotency_key` 命中已处理记录 → `200 {"result":"skipped"}`（不新增/改动业务行），并回 `ref_inbound_id` 便于反查。
- **重试与死信**：失败退避 `min(2^n × 30, 3600)` 秒，`max_retry=5`；SUCCESS 的单子再点重投 → 直接回「无需重试」；确定性错误（契约校验类）终局，不占用重试额度；超限转死信（`dead_letter`），人工 `requeue` 复位或 `dismiss` 丢弃。
- **对账**：按 `event_type` 统计 `produced / delivered / pending / failed` + 全局 `dead_letter`；`GET /api/aeos/reconcile?remote={"pending":0,"failed":0}` 可并入对侧数字，`consistent` ⟺ 两侧 `pending=0` 且 `failed=0`。
- **同步日志**：对象类型、业务 ID 与 `object_id`、幂等键、状态、重试次数、最后错误、**开始/结束时间**，并保留原始报文可反查（`GET /api/aeos/logs/:id`）。

### 1.6 冲突规则（字段级）

| 场景 | 处理 | 留痕 |
| --- | --- | --- |
| Owner=CRM 字段入库 | 覆盖本地镜像值 | — |
| Owner=EBMS 字段入库 | **不写入**（等 EBMS 本地计算），冲突时 `OWNER_KEPT` | `aeos_sync_conflict` |
| 本地人工锁（如订单 `user_status_locked=1`） | 保留本地值 | `MANUAL_LOCKED` |
| 同窗口双方都改（本地新一轮改动未发出） | 保留本地值 | `STALE` |
| 乱序（`occurred_at` 早于上次同步时间） | 跳过 | `STALE` |
| 对侧发 DELETE 但本地有新未发出的改动 | 保留本地对象 | `DELETE_PROTECTED` / `OWNER_KEPT` |
| 对侧发 DELETE 且本地无新改动 | 删除本地镜像行 | `DELETED` |

`created_at` 镜像源值；`updated_at` 取本地落库时刻（meta 字段不参与冲突比对）。

### 1.7 配置项（均从环境变量读取，不落明文）

| 变量 | 用途 | 必填 |
| --- | --- | --- |
| `EBMS_INGEST_TOKEN` | 入站 Bearer 校验凭据；未配置 → 入站 503（fail-closed） | 入站必填 |
| `EBMS_INBOUND_TOKEN` | 出站投递凭据；未配置 → 队列只暂存、不消耗重试 | 出站必填 |
| `EBMS_CRM_INGEST_URL` | CRM 入站地址；未配置 → `configured=false` | 出站必填 |
| `EBMS_AEOS_SPOOL_DIR` | `mode=spool` 时的落盘目录 | 可选 |
| `EBMS_DATA_DIR` | 数据目录（自检用隔离目录） | 可选 |

非机密项（`enabled` / `mode` / `url` / `spoolDir` / `batchSize` / `owner`）可通过 `GET|PUT /api/aeos/config` 维护，写入时自动剔除 `token`。

---

## 二、操作说明

### 2.1 上线前检查（5 分钟）

1. 配好上表环境变量后重启后端。
2. `GET /api/aeos/status` → 看 `ready`、`mode`、`reason`（`reason` 直接写明缺哪项）与队列计数。
3. 用一条测试对象（客户/询价）在本地新增，`GET /api/aeos/outbox` 应出现 1 条 `pending`。
4. 在 CRM 侧确认收到；随后 `GET /api/aeos/reconcile`，两侧 `pending`/`failed` 均为 0 即对平。

### 2.2 日常核对

| 想知道 | 看哪里 |
| --- | --- |
| 通道是否就绪、积压多少 | `GET /api/aeos/status` |
| 某条是否发出、重试几次、最后错误 | `GET /api/aeos/outbox?object_type=&status=` |
| 收到过什么、原始报文长什么样 | `GET /api/aeos/logs`、`GET /api/aeos/logs/:id` |
| 两侧是否对平 | `GET /api/aeos/reconcile`（可带 `?remote=` 并入对侧数字） |
| 有哪些冲突被拦下 | `GET /api/aeos/conflicts` |

### 2.3 故障处置

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `/api/aeos/status` 报 `configured=false` | 未配 `EBMS_CRM_INGEST_URL` 或 `EBMS_INBOUND_TOKEN` | 补齐环境变量后重启；队列期间只暂存，**不丢**且不消耗重试 |
| CRM 短暂不可达 | 网络/对端重启 | 等退避自动重投（30s/60s/…最长 1h，共 5 次）；急用可 `POST /api/aeos/outbox/flush` |
| 单条卡死、要立刻重试 | — | `POST /api/aeos/outbox/:id/retry` |
| 已进死信 | 超过 5 次 | 先修根因，再 `POST /api/aeos/outbox/:id/requeue` 复位 |
| 该条不该发 | 误操作 | `DELETE /api/aeos/outbox/:id` 丢弃（写冲突留痕） |
| 入站 422 | 契约校验失败 | 响应体 `errors[{field,message}]` 直接指出字段；修好后重发（同键会正常通过） |
| 入站 503 | 服务端未配 `EBMS_INGEST_TOKEN` | 配置后重启；期间入站完全拒绝（fail-closed） |

**断链表现**：CRM 侧故障时，EBMS 本地业务照常提交、无报错、无阻塞；事件留在本地队列等待，数据不丢（自检 AC-S10 覆盖）。

### 2.4 存量迁移一次性导出

`POST /api/aeos/export`（或设置 `deliver:true` 直接投递）：

- 按依赖序导出：`customers → inquiries → quote_library → orders → samples → feedback`；
- 逐对象「EBMS 源条数 = 导出条数」；询价按基号聚合成对象数；
- **可重复执行**：重复跑全部按幂等键跳过，不产生重复数据；
- 不改变任何业务值；`occurred_at` 取源行 `updated_at`；
- 每批写 `aeos_export_log`（含 `batch_id`）。

### 2.5 自检与验收

```bash
cd backend
node --experimental-sqlite test-aeos-sync.js   # 生产引擎（SQLite）
USE_JSON_DB=1 node test-aeos-sync.js           # 回退引擎（JSON）
```

- 覆盖 AC-S1~AC-S10，共 **117 条用例，两引擎各 117/117 通过**；
- 报告输出到 `backend/.aeos-selftest-report.md`（已 gitignore），自检数据写在隔离目录 `backend/.aeos-selftest-data/`，**不碰生产库**；
- T11 直接调用 `routes/inquiry.js` 的真实路由处理器，验证「写落定 → 读行 → 出站」顺序。

### 2.6 跨侧约定与遗留事项

1. **出站头需 RFC 3986 百分比编码**：`idempotency_key` 内嵌 `object_id`，而业务键可能是中文（客户名、询价基号）。HTTP 头只能放 ASCII，故发送前对头值做百分比编码，接收方需**解码后再比对**（键格式与语义不变；`X-Event-Type` 同为 ASCII 无需处理）。→ 需与开发A 对齐。
2. **指纹口径澄清**：冻结 §4 的 `fingerprint = sha1(canonical(event 去掉 occurred_at))` 若按字面把随机生成的 `event_id`/`trace_id` 计入，则同内容两次投递指纹必然不同，「内容幂等」无法成立。EBMS 侧实现取**业务内容**（再排除 `occurred_at`/`idempotency_key`/`event_id`/`trace_id` 等派生字段），键格式与语义不变，且不额外校验指纹值（只校验键结构一致性）。→ 需与开发A 对齐。
3. 本期 **只有 EBMS 侧落点**；CRM 侧入站实现与两端联调在开发A 范围。
4. `dictionary.upserted` 已注册取值域，本期未实现（P1）。

---

## 三、不改动清单（便于回归定位）

- 未改任何业务字段的含义、计算公式与状态机；
- 未改任何权限码；
- 未改任何业务表结构（同步表均为新增 sidecar）；
- 出站钩子异常一律吞掉并记日志，绝不阻断业务请求。
