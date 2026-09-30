-- EBMS 数据底座 · 迁移 004
-- 范围：F7 REPORT 视图（PAND-85）。
--
-- 口径：REPORT 视图以「报告 / 结论」为单位组织信息，替代菜单逐级点击。
--   · 报告身份与筛选维度（period_type / period_value / domain / owner / conclusion）
--     已由 002（F11 四视图对象锚点）建立，本迁移不重复定义。
--   · 本迁移只补「报告 → 关键结果指标」的显式清单，使「每份 Report 含关键结果指标与偏差」
--     是**可编辑、可断言的数据**，而不是靠周期/维度隐式推导。
--   · 关联的 TODO / Decision / Evidence 入口复用 002 的 object_links（天然双向可达），不新建关联表。

-- ---------------------------------------------------------------- 报告的关键结果指标
-- 一行 = 某份报告把某个指标配置列为「关键结果指标」。
-- 指标的实际值仍只来自 owner_results（F1 红线），本表只存「引用」，不存任何指标数值。
CREATE TABLE IF NOT EXISTS report_metrics (
  report_id  UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  metric_id  UUID NOT NULL REFERENCES result_metrics(id) ON DELETE CASCADE,
  order_no   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一份报告不会重复引用同一指标
  PRIMARY KEY (report_id, metric_id)
);

CREATE INDEX IF NOT EXISTS idx_report_metrics_metric ON report_metrics (metric_id);

-- ---------------------------------------------------------------- 筛选入口索引
-- 场景 3「按周期与责任域筛选」：过滤条件即这三列的组合。
CREATE INDEX IF NOT EXISTS idx_reports_filter ON reports (period_type, period_value, domain);

-- ---------------------------------------------------------------- 留痕口径扩展
-- 架构方案 §3.2.2「所有写操作过审计留痕」：创建报告同样进入既有 audit_log。
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('evidence.create', 'evidence.link', 'evidence.unlink',
                    'view_link.create', 'view_link.delete',
                    'owner_result.receive',
                    'report.create'));
