-- EBMS 数据底座 · 迁移 005
-- 范围：F5 四层链路 Result → Reason → Evidence → Source 下钻与逐层返回（PAND-83）。
--
-- 口径（PAND-97 返工后统一，见 issue PAND-83「导航口径」）：
--   第 1 段 结果 → Result 契约         （已有：result_metrics + owner_results）
--   第 2 段 原因 → Exception（归因）契约（本迁移：result_reasons.reason_code / severity）
--   第 3 段 证据 → Evidence 契约        （已有：evidences + reason_evidences）
--   第 4 段 来源 → Evidence.source_system 字段（本迁移：evidences.source_system）
--
-- 结构性封死（不是约定，而是库里没有落点）：
--   · 第 4 段是 evidences 上的一个**字段**，不是独立层级：本迁移**不建任何来源实体表**
--     （无 sources / source_records 之类），因此「来源」在物理上无法被当成第 5 个契约对象。
--   · 该链路上除 Result / Exception / Evidence 三类契约 + source_system 字段外，
--     不引入任何其他跨域契约对象。
--   · 原因项归属由**生成列** attribution_kind 保证：缺 reason_code 或 severity 即自动落到
--     m03_analysis（M03 自有归因分析），结构上不存在「无归属」的原因项（PAND-80 边界）。

-- ---------------------------------------------------------------- 第 2 段：原因 → Exception（归因）
-- Exception 契约（AEOS.Exception.V1）要求 reason_code 与 severity。
-- 无法映射的纯人工判断型原因按 PAND-80 兜底口径登记为「M03 自有归因分析」并显式标注。
ALTER TABLE result_reasons
  ADD COLUMN IF NOT EXISTS reason_code TEXT,
  ADD COLUMN IF NOT EXISTS severity    TEXT;

-- 归属判定为生成列：口径写在库里，任何写入路径都无法绕过，也不会出现两个答案。
ALTER TABLE result_reasons
  ADD COLUMN IF NOT EXISTS attribution_kind TEXT
    GENERATED ALWAYS AS (
      CASE
        WHEN reason_code IS NOT NULL AND btrim(reason_code) <> ''
         AND severity    IS NOT NULL AND btrim(severity)    <> ''
        THEN 'exception'
        ELSE 'm03_analysis'
      END
    ) STORED;

DO $$
BEGIN
  -- severity 取值对齐 AEOS Exception 契约的严重度枚举
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'result_reasons_severity_check') THEN
    ALTER TABLE result_reasons ADD CONSTRAINT result_reasons_severity_check
      CHECK (severity IS NULL OR severity IN ('high', 'medium', 'low'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'result_reasons_attribution_kind_check') THEN
    ALTER TABLE result_reasons ADD CONSTRAINT result_reasons_attribution_kind_check
      CHECK (attribution_kind IN ('exception', 'm03_analysis'));
  END IF;
END
$$;

-- ---------------------------------------------------------------- 第 4 段：来源 → Evidence.source_system 字段
-- 来源系统标识（内部专业系统 M05/M06/M09 或外部数据提供方）。**可空**：
-- 未标注时来源段显示「来源未标注」，不得回落到专业原始表查询（PAND-83 边界）。
-- 完整的来源标注（来源单据 / 数据时间 / 提供方）由 F4（PAND-82）以 ALTER TABLE 追加，
-- 本迁移只建立四层导航所消费的那一个字段。
ALTER TABLE evidences
  ADD COLUMN IF NOT EXISTS source_system TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidences_source_system_check') THEN
    ALTER TABLE evidences ADD CONSTRAINT evidences_source_system_check
      CHECK (source_system IS NULL OR length(btrim(source_system)) > 0);
  END IF;
END
$$;

-- 来源段按来源系统筛选/清点用
CREATE INDEX IF NOT EXISTS idx_evidences_source_system ON evidences (source_system);
