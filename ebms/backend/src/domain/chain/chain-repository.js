'use strict';

const { query } = require('../../db/pool');

/**
 * F5（PAND-83）四层链路的只读数据访问。
 *
 * 只读是本模块的结构性约束：这里只实现 SELECT，没有任何写方法。
 * 数据来源也固定为三类契约对象所在表 —— result_metrics / owner_results（Result）、
 * result_reasons（Exception 归因）、evidences / reason_evidences（Evidence）。
 * 不存在读取 orders / materials 等专业原始表的语句（CROSS_DOMAIN_READS 红线）。
 */

/**
 * 第 2 段：某结果指标下的原因项（含 Exception 归因口径 + 证据计数）。
 * attribution_kind 为库内生成列，无法由写入路径绕过。
 */
async function listReasons(metricId) {
  const { rows } = await query(
    `SELECT r.id, r.parent_id, r.name, r.direction, r.contribution_pct, r.owner, r.order_no,
            r.reason_code, r.severity, r.attribution_kind,
            count(re.evidence_id)::int AS evidence_count
       FROM result_reasons r
       LEFT JOIN reason_evidences re ON re.reason_id = r.id
      WHERE r.metric_id = $1
      GROUP BY r.id
      ORDER BY r.order_no, r.created_at`,
    [metricId]
  );
  return rows;
}

/**
 * 第 3 段：给定原因项集合下的证据（含第 4 段所需的 source_system 字段）。
 * source_system 可能为 NULL —— 那正是「来源未标注」的判定依据，不做任何回填或兜底。
 */
async function listEvidencesByReason(reasonIds) {
  if (!Array.isArray(reasonIds) || reasonIds.length === 0) return [];
  const { rows } = await query(
    `SELECT re.reason_id, e.id, e.type, e.title, e.formed_at, e.owner, e.content,
            e.source_system
       FROM reason_evidences re
       JOIN evidences e ON e.id = re.evidence_id
      WHERE re.reason_id = ANY($1::uuid[])
      ORDER BY e.formed_at DESC, e.created_at DESC`,
    [reasonIds]
  );
  return rows;
}

module.exports = { listReasons, listEvidencesByReason };
