/**
 * F2 归因写入仓储（PAND-80 关联入口）。
 *
 * 与 `chainRepository` 刻意分开：链路读模型仓储**只实现 SELECT**（反向查询的
 * 结构性只读保证不受影响），归因登记所需的写入集中在本文档，并且：
 *   - 只写 M03 归因元数据（`attributions`）与留痕（`audit_log`）；
 *   - **不新建 Exception**：原因项只能引用本系统已消费的 Exception（专业模块供给），
 *     否则按 M03 自有归因分析登记；
 *   - 不写任何专业原始表，不存在 EBMS 自建专业事实源。
 *
 * 业务行与其留痕在同一事务内提交，避免「操作生效但无留痕」。
 */

export function createAttributionRepository(db) {
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const one = (sql, ...params) => db.prepare(sql).get(...params) ?? null;

  function inTransaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    /** 按内部主键或 Exception 契约 id 取已消费的 Exception。 */
    findException(ref) {
      if (!ref) return null;
      const row = one(
        `SELECT e.id, e.exception_id, e.source_system, e.object_type, e.object_id,
                e.reason_code, e.severity, e.status
           FROM exceptions e
          WHERE e.id = ? OR e.exception_id = ?
          LIMIT 1`,
        ref,
        ref,
      );
      if (!row) return null;
      return {
        id: row.id,
        exceptionCode: row.exception_id,
        exceptionId: row.exception_id,
        sourceSystem: row.source_system,
        objectType: row.object_type,
        objectId: row.object_id,
        reasonCode: row.reason_code,
        severity: row.severity,
        status: row.status,
      };
    },

    /** 同一父项下的下一个排序号。 */
    nextOrderNo(metricId, parentId) {
      const row = parentId
        ? one(
            'SELECT COALESCE(MAX(order_no), 0) AS n FROM attributions WHERE metric_id = ? AND parent_id = ?',
            metricId,
            parentId,
          )
        : one(
            'SELECT COALESCE(MAX(order_no), 0) AS n FROM attributions WHERE metric_id = ? AND parent_id IS NULL',
            metricId,
          );
      return row.n + 1;
    },

    /**
     * 登记一条归因项 + 留痕（同一事务）。
     * 主键冲突时按幂等处理：不重复写入、不重复留痕。
     */
    createAttribution(row, { actor, action, detail, at }) {
      return inTransaction(() => {
        const exists = one('SELECT * FROM attributions WHERE id = ?', row.id);
        if (exists) return { created: false, row: exists };

        db.prepare(
          `INSERT INTO attributions
             (id, metric_id, parent_id, kind, exception_id, analysis_name,
              direction, contribution_pct, impact_value, owner, order_no, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.metricId,
          row.parentId,
          row.kind,
          row.exceptionId,
          row.analysisName,
          row.direction,
          row.contributionPct,
          row.impactValue,
          row.owner,
          row.orderNo,
          at,
        );

        db.prepare(
          `INSERT INTO audit_log (actor, action, entity_type, entity_id, detail, at)
           VALUES (?, ?, 'attribution', ?, ?, ?)`,
        ).run(actor, action, row.id, detail, at);

        return { created: true, row: one('SELECT * FROM attributions WHERE id = ?', row.id) };
      });
    },

    listAuditFor(entityId, limit = 20) {
      return all(
        `SELECT id, actor, action, entity_type, entity_id, detail, at
           FROM audit_log WHERE entity_type = 'attribution' AND entity_id = ?
          ORDER BY id DESC LIMIT ?`,
        entityId,
        limit,
      );
    },
  };
}
