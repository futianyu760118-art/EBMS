/**
 * AEOS 出站钩子 —— 销售 6 模块「本地 CRUD 提交点」调用，把变更写入出站队列（§5.3）。
 *
 * 三条纪律：
 *   1. 只在本地 CRUD 路由调用。外部同步落库（lib/aeos-ingest.js、routes/external-sync.js、
 *      routes/external-api.js、server.js 启动期客户同步）一律**不得**调用，避免回环。
 *   2. 任何异常都只记日志并返回 {queued:false}——同步故障绝不阻断业务（AC-S10）。
 *   3. 只读取业务记录做「出站剪裁」，不改任何业务字段（红线：只做数据同步点）。
 */
const logger = require('./logger');
const db = require('../db');
const store = require('./aeos-store');
const outbox = require('./aeos-outbox');

async function guard(label, fn) {
  try {
    store.init();
    return await fn();
  } catch (e) {
    logger.error('[aeos-hook] ' + label + ' 出站入队异常（已忽略，不影响业务）: ' + e.message);
    return { queued: false, reason: e.message };
  }
}

/**
 * 本地新增/修改 → 出站事件（自动按对象业务键编码 object_id）。
 * Inquiry 特殊：EBMS 一行 = 一个产品行，必须按基号聚合出站，故一律转发到 fireInquiryUpsert，
 * 避免「子行 serial_number 被当成独立 object_id」把一张询价拆成多条对象。
 *
 * 返回 Promise：路由调用点须 await，否则出站记录会滞后到下一个微任务才落队列，
 * 紧随其后的读操作（如迁移导出、对账）会看不到它。
 */
function fireUpsert(objectType, record, opts) {
  if (!record) return { queued: false, reason: '空记录' };
  if (objectType === 'Inquiry') {
    return fireInquiryUpsert(typeof record === 'string' ? record : record.serial_number, opts);
  }
  return guard(objectType + '.upsert', () =>
    outbox.enqueueEntity(objectType, record, Object.assign({ operation: 'UPSERT' }, opts || {})));
}

/** 本地删除 → 出站事件（DELETE 只携带业务键）。 */
function fireDelete(objectType, record, opts) {
  if (!record) return { queued: false, reason: '空记录' };
  if (objectType === 'Inquiry') {
    return fireInquiryRemoved(typeof record === 'string' ? record : record.serial_number);
  }
  return guard(objectType + '.delete', () =>
    outbox.enqueueEntity(objectType, record, Object.assign({ operation: 'DELETE' }, opts || {})));
}

/** 本地按业务键删除（record 已不存在，用键构造）。 */
function fireDeleteByKey(objectType, keyRecord) {
  return guard(objectType + '.delete', () =>
    outbox.enqueueEntity(objectType, keyRecord, { operation: 'DELETE' }));
}

function baseOf(serial) { return String(serial || '').replace(/-\d{2,}$/, ''); }

/** 取基号下的全部并列行（含母行）。EBMS 母行 serial = 基号，子行 = 基号 + '-NN'。 */
function inquiryRowsOf(base) {
  return db.getTable('inquiries').all().filter(r => {
    const sn = String(r.serial_number || '');
    return sn === base || sn.startsWith(base + '-');
  });
}

/**
 * 询价：EBMS 一行 = 一个产品行，出站按基号聚合成一条 inquiry.upserted。
 * @param {string} serial 任一行的 serial_number（自动收敛到基号）
 */
function fireInquiryUpsert(serial) {
  return guard('Inquiry.upsert', () => {
    const base = baseOf(serial);
    if (!base) return { queued: false, reason: '空业务键' };
    const rows = inquiryRowsOf(base);
    if (!rows.length) return { queued: false, reason: '无匹配行' };
    return outbox.enqueueEntity('Inquiry', rows, { operation: 'UPSERT', objectId: base });
  });
}

/**
 * 询价行被删除后收敛出站语义：基号下仍有并列行 → 出快照 UPSERT（对象仍存在，只是少了一行）；
 * 基号下已无任何行 → 才是真正的对象删除，出 DELETE。
 * 单行删除路由（DELETE /:id）必须走这里，否则会把「删一行」误报成「删整张询价」。
 */
function fireInquiryRemoved(serial) {
  return guard('Inquiry.remove', () => {
    const base = baseOf(serial);
    if (!base) return { queued: false, reason: '空业务键' };
    const rows = inquiryRowsOf(base);
    if (rows.length) return outbox.enqueueEntity('Inquiry', rows, { operation: 'UPSERT', objectId: base });
    return outbox.enqueueEntity('Inquiry', { serial_number: base }, { operation: 'DELETE', objectId: base });
  });
}

/** 强制整对象删除（批量清理等明确知道对象已整体消失的场景）。 */
function fireInquiryDelete(serial) {
  return guard('Inquiry.delete', () => {
    const base = baseOf(serial);
    if (!base) return { queued: false, reason: '空业务键' };
    return outbox.enqueueEntity('Inquiry', { serial_number: base }, { operation: 'DELETE', objectId: base });
  });
}

module.exports = {
  guard, baseOf,
  fireUpsert, fireDelete, fireDeleteByKey,
  fireInquiryUpsert, fireInquiryDelete, fireInquiryRemoved
};
