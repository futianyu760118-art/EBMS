/**
 * EBMS 消费 M09 FAC 的 FinanceResult（财经结果）落库与读取。
 *
 * 契约依据：contracts/aeos-v1/finance-result-v1.schema.json + mappings/fac-ebms-result.yaml。
 * 语义（GR-13）：EBMS 只消费 FAC 发布的 VERIFIED 结果，不重算成本/毛利；
 * 落库的是「引用 + 管理投影」，不可编辑财经事实；SUPERSEDED/RESTATED 追加新 revision 保留历史。
 *
 * sidecar 表：aeos_finance_result（不参与业务计算）
 */
const { getTable, now } = require('../db');

function table() { return getTable('aeos_finance_result'); }

/**
 * 落库（幂等：按 result_id + revision 判重；同 result_id 新 revision 追加不覆盖）。
 * @param {object} r FinanceResult 记录（字段对齐 finance-result-v1 + fac-ebms-result）
 */
async function saveFinanceResult(r) {
  const t = table();
  const existing = t.all().find(
    (x) => String(x.result_id) === String(r.result_id) && Number(x.revision) === Number(r.revision)
  );
  if (existing) return { ok: true, idempotent: true, existing_id: existing.id };

  const rec = {
    result_id: r.result_id,
    source_system: r.source_system || 'M09_FAC',
    object_type: r.object_type || 'FinanceResult',
    object_id: r.object_id || r.result_id,
    revision: Number(r.revision) || 1,
    result_type: r.result_type || '',
    status: r.status || 'VERIFIED',
    calculation_run_id: r.calculation_run_id || '',
    accounting_period: r.accounting_period || '',
    rule_version: r.rule_version || '',
    currency: r.currency || 'CNY',
    total_revenue: r.total_revenue,
    total_cost: r.total_cost,
    gross_margin: r.gross_margin,
    margin_rate: r.margin_rate,
    exception_flags: r.exception_flags || [],
    evidence_refs: r.evidence_refs || [],
    verified_at: r.verified_at || '',
    verified_by: r.verified_by || '',
    trace_id: r.trace_id || '',
    idempotency_key: r.idempotency_key || '',
    created_at: now(),
    updated_at: now()
  };
  const inserted = await t.insert(rec);
  return { ok: true, idempotent: false, id: inserted.lastID };
}

/**
 * 读取 VERIFIED 结果（SUPERSEDED/RESTATED 的历史版本通过 getHistory 取）。
 * @param {string} period accounting_period（如 2026-10）；空则全部
 */
function getVerifiedFinanceResults(period) {
  const rows = table().all().filter(
    (x) => x.status === 'VERIFIED' && (!period || String(x.accounting_period) === String(period))
  );
  return rows.sort((a, b) => (b.verified_at || '').localeCompare(a.verified_at || ''));
}

/** 同一 result_id 的历史版本（含 SUPERSEDED/RESTATED，按 revision 升序，保留溯源）。 */
function getHistory(resultId) {
  return table()
    .all()
    .filter((x) => String(x.result_id) === String(resultId))
    .sort((a, b) => Number(a.revision) - Number(b.revision));
}

module.exports = { saveFinanceResult, getVerifiedFinanceResults, getHistory };
