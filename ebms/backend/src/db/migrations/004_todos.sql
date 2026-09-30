-- EBMS 数据底座 · 迁移 004
-- 范围：F8 TODO 视图（PAND-86）—— 待办事项聚合、两种来源、认领 / 指派 / 状态流转与留痕。
--
-- 约定（见 002 文件头）：todos 表的锚点身份由 F11（PAND-89）建立，
-- 「完整业务字段」由归属 issue 以 ALTER TABLE 追加，本迁移即 F8 的追加部分。
--
-- 红线：EBMS 只汇聚结论与派发事项，不重算任何专业中心内部算法。
-- 自动产生的 TODO 必须可回溯到「关联结果 / 原因 / 规则」——触发依据非空由
-- 库层约束 + 业务层校验双重保障，缺一即拒收，不存在「来源是规则但查不到依据」的行。

-- ---------------------------------------------------------------- todos 业务列（F8 追加）
ALTER TABLE todos
  -- 关联结果或原因：服务端回源 result_metrics / result_reasons 解析 label 后落库，
  -- 前端只提交 refId，不提交 label，避免展示文案被伪造。
  ADD COLUMN IF NOT EXISTS related_refs  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 触发依据（仅 source='rule' 必填）：规则编码 + 可读摘要 + 锚定的结果指标或原因项
  ADD COLUMN IF NOT EXISTS trigger_basis JSONB,
  -- 规则幂等键 `"<rule_code>:<ref_id>"`：同一规则对同一锚点重复扫描只留一行
  ADD COLUMN IF NOT EXISTS rule_key      TEXT,
  ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---------------------------------------------------------------- 结构性约束
-- 说明：以下两条为「数据相关」约束，迁移时**不校验存量行**（NOT VALID）。
-- 理由：trigger_basis / related_refs 是本迁移新增的列，此前产生的行不可能带着它们，
-- 而本系统里 todos 的唯一写入方就是 F8 的用例与规则引擎（见 todo-service / todo-rule-engine），
-- 因此对「约束生效后写入的每一行」都是强制的；存量行由 seed 夹具按新口径重灌。
-- 测试 todos-ac.test.js 会在灌入夹具后执行 VALIDATE CONSTRAINT，证明库内数据全部合规。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'todos_related_refs_array') THEN
    ALTER TABLE todos ADD CONSTRAINT todos_related_refs_array
      CHECK (jsonb_typeof(related_refs) = 'array');
  END IF;

  -- 判定标准：来源为自动产生的 TODO 均含非空触发依据（关联结果 / 原因 + 规则）。
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'todos_rule_trigger_required') THEN
    ALTER TABLE todos ADD CONSTRAINT todos_rule_trigger_required CHECK (
      source <> 'rule' OR (
        trigger_basis IS NOT NULL
        AND jsonb_typeof(trigger_basis) = 'object'
        AND length(btrim(coalesce(trigger_basis ->> 'ruleCode', ''))) > 0
        AND length(btrim(coalesce(trigger_basis ->> 'summary', ''))) > 0
        -- 必须锚定到具体结论或原因，杜绝「只有规则名、查不到出处」的自动待办
        AND (
          length(btrim(coalesce(trigger_basis ->> 'resultMetricId', ''))) > 0
          OR length(btrim(coalesce(trigger_basis ->> 'reasonId', ''))) > 0
        )
      )
    ) NOT VALID;
  END IF;

  -- 人工派发必须指明责任人（自动产生的可为空，等待被认领）。
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'todos_manual_owner_required') THEN
    ALTER TABLE todos ADD CONSTRAINT todos_manual_owner_required
      CHECK (source <> 'manual' OR length(btrim(coalesce(owner, ''))) > 0) NOT VALID;
  END IF;
END
$$;

-- ---------------------------------------------------------------- 索引
-- 规则幂等：同一规则对同一锚点重复扫描不产生第二条待办。
CREATE UNIQUE INDEX IF NOT EXISTS uq_todos_rule_key ON todos (rule_key) WHERE rule_key IS NOT NULL;

-- 场景 4 的筛选（责任人 / 状态 / 截止时间）与逾期扫描各自走索引。
CREATE INDEX IF NOT EXISTS idx_todos_owner  ON todos (owner);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos (status);
CREATE INDEX IF NOT EXISTS idx_todos_due_at ON todos (due_at);
CREATE INDEX IF NOT EXISTS idx_todos_source ON todos (source);

-- ---------------------------------------------------------------- 留痕口径扩展
-- 架构方案 §3.2.2「所有写操作过审计留痕」：新增 / 认领 / 指派 / 状态流转 / 规则产生
-- 五类操作全部进入既有 audit_log（操作人 + 时间 + before/after）。
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('evidence.create', 'evidence.link', 'evidence.unlink',
                    'view_link.create', 'view_link.delete',
                    'owner_result.receive',
                    'todo.create', 'todo.rule_generate', 'todo.claim',
                    'todo.assign', 'todo.transition'));
