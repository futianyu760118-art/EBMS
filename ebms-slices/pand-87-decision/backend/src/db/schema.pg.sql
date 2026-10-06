-- EBMS 数据模型（PostgreSQL，架构方案 3.3 的目标形态）
-- 时间列沿用 text（ISO-8601 字符串）以与 SQLite 驱动保持完全一致的行为，
-- JSON 列使用 jsonb（架构方案要求「结论/候选方案/变更前后值原样落库」）。

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

CREATE TABLE IF NOT EXISTS result_metrics (
  id             text PRIMARY KEY,
  code           text NOT NULL,
  name           text NOT NULL,
  dimension      text NOT NULL,
  domain         text NOT NULL,
  period_type    text NOT NULL,
  period_value   text NOT NULL,
  target         double precision,
  actual         double precision,
  unit           text,
  deviation_abs  double precision,
  deviation_pct  double precision,
  data_status    text NOT NULL DEFAULT 'ok',
  missing_reason text,
  threshold      double precision,
  as_of          text,
  updated_at     text NOT NULL,
  UNIQUE (code, period_type, period_value)
);

CREATE TABLE IF NOT EXISTS result_reasons (
  id               text PRIMARY KEY,
  metric_id        text NOT NULL REFERENCES result_metrics (id) ON DELETE CASCADE,
  parent_id        text REFERENCES result_reasons (id) ON DELETE CASCADE,
  name             text NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('positive', 'negative', 'neutral')),
  contribution_pct double precision,
  owner            text,
  order_no         integer NOT NULL DEFAULT 0,
  created_at       text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reasons_metric ON result_reasons (metric_id);

CREATE TABLE IF NOT EXISTS evidences (
  id         text PRIMARY KEY,
  type       text NOT NULL
             CHECK (type IN ('document', 'contract', 'system_record', 'manual')),
  title      text NOT NULL,
  formed_at  text NOT NULL,
  owner      text,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS todos (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  source        text NOT NULL CHECK (source IN ('rule', 'manual')),
  trigger_basis jsonb,
  related_refs  jsonb NOT NULL,
  owner         text,
  due_at        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'done')),
  rule_key      text,
  created_by    text,
  created_at    text NOT NULL,
  updated_at    text NOT NULL,
  CONSTRAINT todos_rule_trigger_basis_chk
    CHECK (source = 'manual' OR (trigger_basis IS NOT NULL AND trigger_basis::text <> 'null'))
);
CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos (owner);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_todos_rule_key
  ON todos (rule_key) WHERE rule_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS decisions (
  id                    text PRIMARY KEY,
  title                 text NOT NULL,
  domain                text NOT NULL,
  background            text NOT NULL,
  related_refs          jsonb NOT NULL,
  options               jsonb NOT NULL,
  required_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  conclusion            text,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'decided')),
  decider               text,
  decider_id            text,
  decided_at            text,
  created_by            text,
  created_at            text NOT NULL,
  updated_at            text NOT NULL,
  -- 已决策不变量（DB 层兜底）：待决策 ⇒ 三字段为空；已决策 ⇒ 三字段非空
  CONSTRAINT decisions_decided_invariant_chk
    CHECK (
      (
        status = 'pending'
        AND (conclusion IS NULL OR length(btrim(conclusion)) = 0)
        AND (decider IS NULL OR length(btrim(decider)) = 0)
        AND (decided_at IS NULL OR length(btrim(decided_at)) = 0)
      )
      OR
      (
        status = 'decided'
        AND conclusion IS NOT NULL AND length(btrim(conclusion)) > 0
        AND decider IS NOT NULL AND length(btrim(decider)) > 0
        AND decided_at IS NOT NULL AND length(btrim(decided_at)) > 0
      )
    )
);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status);
CREATE INDEX IF NOT EXISTS idx_decisions_domain ON decisions (domain);

-- 决策变更留痕（追加写，只增不改）。seq 为决策内的写入序号，用于稳定排序：
-- changed_at 由时钟给出，同一毫秒内的多条变更无法区分先后，变更历史须按写入次序展示。
CREATE TABLE IF NOT EXISTS decision_changes (
  id              text PRIMARY KEY,
  decision_id     text NOT NULL REFERENCES decisions (id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  action          text NOT NULL,
  reason          text,
  before          jsonb,
  after           jsonb,
  changed_by      text,
  changed_by_name text NOT NULL,
  changed_at      text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_changes ON decision_changes (decision_id, seq);

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

CREATE TABLE IF NOT EXISTS audit_log (
  id          text PRIMARY KEY,
  actor_id    text,
  actor_name  text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  detail      jsonb,
  at          text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);
