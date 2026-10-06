-- EBMS 数据模型（SQLite 驱动，PostgreSQL 版的等价翻译）
-- 仅用于本地运行/自检；生产按架构方案走 PostgreSQL（schema.pg.sql）。
-- 差异：jsonb → text（application/json 字符串），double precision → real。

CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  created_at    text NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id   text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id text NOT NULL,
  role_id text NOT NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS role_scope (
  id          text PRIMARY KEY,
  role_id     text NOT NULL,
  scope_type  text NOT NULL,
  scope_value text NOT NULL
);

-- 经营结果指标（F1/PAND-79 域）：本切片作为决策「背景」可关联的 Result 层，只读取不重算
CREATE TABLE IF NOT EXISTS result_metrics (
  id             text PRIMARY KEY,
  code           text NOT NULL,
  name           text NOT NULL,
  dimension      text NOT NULL,
  domain         text NOT NULL,
  period_type    text NOT NULL,
  period_value   text NOT NULL,
  target         real,
  actual         real,
  unit           text,
  deviation_abs  real,
  deviation_pct  real,
  data_status    text NOT NULL DEFAULT 'ok',
  missing_reason text,
  threshold      real,
  as_of          text,
  updated_at     text NOT NULL,
  UNIQUE (code, period_type, period_value)
);

-- 原因项（F2/PAND-80 域）：本切片作为决策「背景」可关联的 Reason 层，只读取不重算
CREATE TABLE IF NOT EXISTS result_reasons (
  id               text PRIMARY KEY,
  metric_id        text NOT NULL,
  parent_id        text,
  name             text NOT NULL,
  direction        text NOT NULL,
  contribution_pct real,
  owner            text,
  order_no         integer NOT NULL DEFAULT 0,
  created_at       text NOT NULL,
  CHECK (direction IN ('positive', 'negative', 'neutral'))
);
CREATE INDEX IF NOT EXISTS idx_reasons_metric ON result_reasons (metric_id);

-- 证据（F3/PAND-81 域）：本切片只读取标题等摘要，供「所需 Evidence」引用
CREATE TABLE IF NOT EXISTS evidences (
  id         text PRIMARY KEY,
  type       text NOT NULL,
  title      text NOT NULL,
  formed_at  text NOT NULL,
  owner      text,
  created_at text NOT NULL,
  CHECK (type IN ('document', 'contract', 'system_record', 'manual'))
);

-- TODO（F8/PAND-86 域）：本切片作为决策「执行产生的 TODO」，读取执行结果 + 由决策派发新 TODO
CREATE TABLE IF NOT EXISTS todos (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  source        text NOT NULL,
  trigger_basis text,
  related_refs  text NOT NULL,
  owner         text,
  due_at        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  rule_key      text,
  created_by    text,
  created_at    text NOT NULL,
  updated_at    text NOT NULL,
  CHECK (source IN ('rule', 'manual')),
  CHECK (status IN ('pending', 'in_progress', 'done')),
  -- 边界（F8）：自动产生的 TODO 必须记录非空触发依据（DB 层兜底）
  CHECK (source = 'manual' OR (trigger_basis IS NOT NULL AND length(trigger_basis) > 2))
);
CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos (owner);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_todos_rule_key
  ON todos (rule_key) WHERE rule_key IS NOT NULL;

-- 决策（F9/PAND-87）
--   background          决策背景（文字说明，必填）
--   related_refs        背景关联的 Result / Reason，jsonb 数组 [{type,id,label}]
--   options             候选方案，jsonb 数组，≥ 1 条（[{name,summary,pros?,cons?}]）
--   required_evidence_ids 所需 Evidence 的 id 列表（jsonb 数组，可为空表示无需证据）
--   conclusion/decider/decided_at  仅「已决策」非空
--   status              pending=待决策（不计入已决策数量）| decided=已决策
CREATE TABLE IF NOT EXISTS decisions (
  id                   text PRIMARY KEY,
  title                text NOT NULL,
  domain               text NOT NULL,
  background           text NOT NULL,
  related_refs         text NOT NULL,
  options              text NOT NULL,
  required_evidence_ids text NOT NULL DEFAULT '[]',
  conclusion           text,
  status               text NOT NULL DEFAULT 'pending',
  decider              text,
  decider_id           text,
  decided_at           text,
  created_by           text,
  created_at           text NOT NULL,
  updated_at           text NOT NULL,
  CHECK (status IN ('pending', 'decided')),
  -- 已决策不变量（DB 层兜底）：
  --   待决策 ⇒ 结论/决策人/决策时间 必须为空（不得静默形成结论）
  --   已决策 ⇒ 结论/决策人/决策时间 必须非空（判定标准逐条对应）
  CHECK (
    (
      status = 'pending'
      AND (conclusion IS NULL OR length(trim(conclusion)) = 0)
      AND (decider IS NULL OR length(trim(decider)) = 0)
      AND (decided_at IS NULL OR length(trim(decided_at)) = 0)
    )
    OR
    (
      status = 'decided'
      AND conclusion IS NOT NULL AND length(trim(conclusion)) > 0
      AND decider IS NOT NULL AND length(trim(decider)) > 0
      AND decided_at IS NOT NULL AND length(trim(decided_at)) > 0
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status);
CREATE INDEX IF NOT EXISTS idx_decisions_domain ON decisions (domain);

-- 决策变更留痕（F9/PAND-87 场景 2）
--   每次结论形成/修改、执行 TODO 关联/解除 各落一行；
--   before/after 为变更前后值快照（jsonb）→ 支撑「变更记录条数 ≥ 实际修改次数」。
-- 决策变更留痕（追加写，只增不改）。seq 为决策内的写入序号，用于稳定排序：
-- changed_at 由时钟给出，同一毫秒内的多条变更无法区分先后，变更历史须按写入次序展示。
CREATE TABLE IF NOT EXISTS decision_changes (
  id             text PRIMARY KEY,
  decision_id    text NOT NULL,
  seq            integer NOT NULL,
  action         text NOT NULL,
  reason         text,
  before         text,
  after          text,
  changed_by     text,
  changed_by_name text NOT NULL,
  changed_at     text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_changes ON decision_changes (decision_id, seq);

-- 四视图对象互相跳转（F11/PAND-89 口径）：本切片写入 decision ↔ todo 执行关联
CREATE TABLE IF NOT EXISTS object_links (
  id         text PRIMARY KEY,
  from_type  text NOT NULL,
  from_id    text NOT NULL,
  to_type    text NOT NULL,
  to_id      text NOT NULL,
  created_at text NOT NULL,
  UNIQUE (from_type, from_id, to_type, to_id)
);
CREATE INDEX IF NOT EXISTS idx_object_links_from ON object_links (from_type, from_id, to_type);

-- 通用留痕：决策域之外的写操作（登录等）
CREATE TABLE IF NOT EXISTS audit_log (
  id          text PRIMARY KEY,
  actor_id    text,
  actor_name  text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  detail      text,
  at          text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);
