-- EBMS 数据底座 · 迁移 003
-- 范围：F1 经营结果指标集（PAND-79，含 PAND-96 返工口径）。
--
-- 红线（数据来源口径）：
--   · 目标值：由 M03（EBMS 自有的 Management Goal）提供 → 存于 result_metrics。
--   · 实际值：100% 来自专业 Owner 模块（M05 销售 / M06 交付 / M09 财经）的 Result
--             → 存于 owner_results（消费收件箱），EBMS 只登记，不重算。
--
-- 结构性保证：result_metrics **刻意不设任何 actual_* 列**。EBMS 因此没有「兜底计算实际值」
-- 的落点——没有 Owner Result 就没有实际值，只能是「无数据」，永不退化为 0 或空白。
-- 同理，本切片不读取 orders / materials 等专业原始表（CROSS_DOMAIN_READS P1 高危项封死）。

-- ---------------------------------------------------------------- Owner Result 消费收件箱
-- 一行 = 一条收到的 AEOS.Result.V1（BusinessMetric）。权威事实仍在 Owner 模块，
-- 本表只是按契约登记的只读取数，字段原样保存（含 result_id / calculation_version /
-- evidence_ids / trace_id），用于把「实际值」追溯到它的来源声明。
CREATE TABLE IF NOT EXISTS owner_results (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Owner Result 标识（契约 id）。同一 result_id 重复投递视为同一事实 → 幂等。
  result_id           TEXT NOT NULL UNIQUE,
  contract_version    TEXT NOT NULL DEFAULT 'AEOS.Result.V1',
  -- 来源模块：仅限三个专业 Owner 模块（红线：非 Owner 模块的投递一律拒绝）
  source_system       TEXT NOT NULL,
  object_type         TEXT NOT NULL DEFAULT 'BusinessMetric',
  object_id           TEXT NOT NULL,
  -- 与 result_metrics.code 对齐的行业指标编码（契约 metric.code）
  metric_code         TEXT NOT NULL,
  metric_name         TEXT,
  -- 原样记录 Owner 计算结果，EBMS 不做任何换算/加总/推导
  value               NUMERIC NOT NULL,
  unit                TEXT,
  period_type         TEXT NOT NULL CHECK (period_type IN ('day', 'week', 'month')),
  period_value        TEXT NOT NULL,
  -- 口径版本：专业指标的算法版本，用于「避免多个系统出现多个答案」
  calculation_version TEXT NOT NULL CHECK (length(btrim(calculation_version)) > 0),
  -- 证据引用：可据此定位到证据（来源证据未在本系统登记时显式标注，不静默丢弃）
  evidence_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
  status              TEXT NOT NULL CHECK (status IN ('VERIFIED', 'DRAFT', 'REJECTED')),
  -- 口径截止时间（Owner 模块给出的数据截止时间）
  occurred_at         TIMESTAMPTZ NOT NULL,
  trace_id            TEXT,
  received_by         TEXT NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT owner_results_source_system_check CHECK (source_system IN ('M05', 'M06', 'M09')),
  CONSTRAINT owner_results_evidence_ids_array CHECK (jsonb_typeof(evidence_ids) = 'array')
);

-- 取数入口：按「指标编码 + 周期」取最新一条已核验结果
CREATE INDEX IF NOT EXISTS idx_owner_results_lookup
  ON owner_results (metric_code, period_type, period_value, status, occurred_at DESC);

-- ---------------------------------------------------------------- 指标集配置（F1 追加列）
-- 约定与 001/002 一致：result_metrics 的业务列由归属 issue 以 ALTER TABLE 追加。
-- 本切片追加「指标集配置」与「目标值（M03）」；实际值不落此表（见文件头红线）。
ALTER TABLE result_metrics
  ADD COLUMN IF NOT EXISTS unit                 TEXT,
  -- 归属声明：该指标的实际值由哪个 Owner 模块供给（M05 / M06 / M09）
  ADD COLUMN IF NOT EXISTS owner_module         TEXT,
  -- 目标方向：越高越好 / 越低越好（影响达标判定；文档未定义，本切片显式配置）
  ADD COLUMN IF NOT EXISTS direction            TEXT NOT NULL DEFAULT 'higher_better',
  -- 目标值：来自 M03 Management Goal（EBMS 自有）
  ADD COLUMN IF NOT EXISTS target_value         NUMERIC,
  ADD COLUMN IF NOT EXISTS target_source_module TEXT NOT NULL DEFAULT 'M03',
  -- M03 侧 Management Goal 的标识，使目标值同样可追溯
  ADD COLUMN IF NOT EXISTS target_source_ref    TEXT,
  -- 偏差阈值（%）：|偏差率| 超过该值即在总览中醒目提示
  ADD COLUMN IF NOT EXISTS threshold_pct        NUMERIC(6, 2) NOT NULL DEFAULT 5.00,
  -- 指标集配置：仅 is_active 的条目计入「配置的指标集条目数」
  ADD COLUMN IF NOT EXISTS is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS order_no             INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'result_metrics_owner_module_check') THEN
    ALTER TABLE result_metrics ADD CONSTRAINT result_metrics_owner_module_check
      CHECK (owner_module IS NULL OR owner_module IN ('M05', 'M06', 'M09'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'result_metrics_direction_check') THEN
    ALTER TABLE result_metrics ADD CONSTRAINT result_metrics_direction_check
      CHECK (direction IN ('higher_better', 'lower_better'));
  END IF;

  -- 目标值只能来自 M03（EBMS 自有的 Management Goal），不得声明为专业模块
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'result_metrics_target_source_check') THEN
    ALTER TABLE result_metrics ADD CONSTRAINT result_metrics_target_source_check
      CHECK (target_source_module = 'M03');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'result_metrics_threshold_check') THEN
    ALTER TABLE result_metrics ADD CONSTRAINT result_metrics_threshold_check
      CHECK (threshold_pct >= 0);
  END IF;
END
$$;

-- ---------------------------------------------------------------- 留痕口径扩展
-- 架构方案 §3.2.2「所有写操作过审计留痕」：登记 Owner Result 同样进入既有 audit_log。
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('evidence.create', 'evidence.link', 'evidence.unlink',
                    'view_link.create', 'view_link.delete',
                    'owner_result.receive'));
