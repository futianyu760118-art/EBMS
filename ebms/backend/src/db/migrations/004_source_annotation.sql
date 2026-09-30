-- EBMS 数据底座 · 迁移 004
-- 范围：F4 每条证据标注来源（PAND-82），含 PAND-96 重核 / PAND-97 返工的 P0 边界口径。
--
-- 口径（PAND-97 §三.2）：Source 不是独立的跨域契约对象，而是 **Evidence 上的字段**。
--   PAND-83 第 4 导航段、PAND-84 反查入口取的均为 `evidences.source_system`。
--   因此本迁移在既有 evidences 上以 ALTER TABLE 追加来源标注列，**不新建 sources 表**——
--   早期「新建 EBMS」草案里的 sources 表已废弃，避免出现第二套来源口径。
--
-- 来源类别（source_type）：
--   internal 内部系统 / external 外部数据 / manual 人工录入（业务方 2026-09-23 确认口径）
--   source_type 为空 = 尚未标注来源 → 判定「来源缺失」，进入待补清单（不阻断既有证据）。
--
-- 更新周期（source_update_cycle）：口径明确「数据为周期更新（日/周/月），非实时」，
--   故连同数据截止时间（source_data_time）一并记录并展示。

ALTER TABLE evidences
  ADD COLUMN IF NOT EXISTS source_type         TEXT,
  -- 场景 1 字段：来源系统
  ADD COLUMN IF NOT EXISTS source_system       TEXT,
  -- 场景 1 字段：来源单据编号（非判定项，缺失时作「待补」提示，不阻断写入）
  ADD COLUMN IF NOT EXISTS source_document_no  TEXT,
  -- 场景 1 字段：来源数据时间，同时用作「数据截止时间」展示
  ADD COLUMN IF NOT EXISTS source_data_time    TIMESTAMPTZ,
  -- 口径字段：更新周期（日/周/月），说明数据非实时
  ADD COLUMN IF NOT EXISTS source_update_cycle TEXT,
  -- 场景 1 / 场景 3 字段：提供方（外部数据必备）
  ADD COLUMN IF NOT EXISTS source_provider     TEXT,
  -- 场景 2 字段：录入人 / 录入时间（人工录入必备）
  ADD COLUMN IF NOT EXISTS source_entered_by   TEXT,
  ADD COLUMN IF NOT EXISTS source_entered_at   TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidences_source_type_check') THEN
    ALTER TABLE evidences ADD CONSTRAINT evidences_source_type_check
      CHECK (source_type IS NULL OR source_type IN ('internal', 'external', 'manual'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidences_source_update_cycle_check') THEN
    ALTER TABLE evidences ADD CONSTRAINT evidences_source_update_cycle_check
      CHECK (source_update_cycle IS NULL OR source_update_cycle IN ('day', 'week', 'month'));
  END IF;

  -- 来源要么整体缺省（判定「来源缺失」），要么给出类别与来源系统。
  -- 不允许「半个来源」：半截来源会被读成已标注，使缺失率失真。
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidences_source_presence_check') THEN
    ALTER TABLE evidences ADD CONSTRAINT evidences_source_presence_check
      CHECK (
        (source_type IS NULL
          AND source_system IS NULL
          AND source_document_no IS NULL
          AND source_data_time IS NULL
          AND source_update_cycle IS NULL
          AND source_provider IS NULL
          AND source_entered_by IS NULL
          AND source_entered_at IS NULL)
        OR
        (source_type IS NOT NULL
          AND source_system IS NOT NULL
          AND length(btrim(source_system)) > 0)
      );
  END IF;

  -- 判定标准 2：外部来源记录的「提供方」字段非空（空串等同未标注）。
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidences_external_provider_required') THEN
    ALTER TABLE evidences ADD CONSTRAINT evidences_external_provider_required
      CHECK (source_type IS DISTINCT FROM 'external'
             OR (source_provider IS NOT NULL AND length(btrim(source_provider)) > 0));
  END IF;

  -- 判定标准 3：人工录入来源的「录入人」「录入时间」均非空。
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidences_manual_trace_required') THEN
    ALTER TABLE evidences ADD CONSTRAINT evidences_manual_trace_required
      CHECK (source_type IS DISTINCT FROM 'manual'
             OR (source_entered_by IS NOT NULL AND length(btrim(source_entered_by)) > 0
                 AND source_entered_at IS NOT NULL));
  END IF;
END
$$;

-- 待补清单与缺失率统计的取数入口
CREATE INDEX IF NOT EXISTS idx_evidences_source_type ON evidences (source_type);
CREATE INDEX IF NOT EXISTS idx_evidences_source_system ON evidences (source_system);

-- ---------------------------------------------------------------- 留痕口径扩展
-- 架构方案 §3.2.2「所有写操作过审计留痕」：来源标注/变更同样进入既有 audit_log。
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('evidence.create', 'evidence.link', 'evidence.unlink',
                    'view_link.create', 'view_link.delete',
                    'owner_result.receive',
                    'evidence.source.annotate', 'evidence.source.update'));
