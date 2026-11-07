/**
 * M10 POMS 微系统对接契约（EBMS / M03 侧）。
 *
 * 设计依据：
 *   - AEOS V7.2：M10 POMS 是岗位与个人操作微系统，负责执行者 Todo / Action / Evidence 提交与反馈回传。
 *   - M03 EBMS 是管理者 RESULT / EXCEPTION / DECISION / ACTION / EVIDENCE 主工作面。
 *   - M10 只做工作面与引用，不写专业域事实；专业事实仍由 EBMS（管理行动）等 Owner 维护。
 *
 * 本文件只做契约常量、标识生成与入站反馈校验，不读写任何业务表。
 */

const CONTRACT_VERSION = 'M10-POMS.V1';
const SOURCE_SYSTEM = 'M03';

const SOURCE_OBJECT_TYPES = Object.freeze({
  SOP_ACTION: 'SopAction',
  AI_ACTION: 'AiAction',
  CHAT_ACTION_ITEM: 'ChatActionItem'
});

const SOURCE_TYPE_BY_SLUG = Object.freeze({
  sop_action: SOURCE_OBJECT_TYPES.SOP_ACTION,
  ai_action: SOURCE_OBJECT_TYPES.AI_ACTION,
  chat_action_item: SOURCE_OBJECT_TYPES.CHAT_ACTION_ITEM
});

const STATUSES = Object.freeze(['pending', 'in_progress', 'awaiting_acceptance', 'blocked', 'done', 'cancelled']);

const SOP_TO_DISPLAY = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  VERIFYING: 'awaiting_acceptance',
  VERIFY_PENDING: 'awaiting_acceptance',
  AWAITING_ACCEPTANCE: 'awaiting_acceptance',
  CLOSED: 'done',
  CANCELLED: 'cancelled'
});

const DISPLAY_TO_SOP = Object.freeze({
  pending: 'PENDING',
  in_progress: 'IN_PROGRESS',
  blocked: 'IN_PROGRESS',
  awaiting_acceptance: 'VERIFYING',
  done: 'CLOSED',
  cancelled: 'CANCELLED'
});

/** 稳定的跨系统工作项标识：ebms:<source_type_slug>:<source_id>。 */
function workItemId(sourceTypeSlug, sourceId) {
  return 'ebms:' + String(sourceTypeSlug) + ':' + String(sourceId);
}

function parseWorkItemId(value) {
  const m = /^ebms:([a-z_]+):(.+)$/.exec(String(value || ''));
  if (!m) return null;
  const sourceObjectType = SOURCE_TYPE_BY_SLUG[m[1]];
  if (!sourceObjectType) return null;
  return { slug: m[1], sourceObjectType, sourceObjectId: m[2] };
}

function normalizeStatus(value) {
  const s = String(value || '').trim().toLowerCase();
  const map = {
    open: 'pending',
    todo: 'pending',
    pending: 'pending',
    start: 'in_progress',
    started: 'in_progress',
    in_progress: 'in_progress',
    doing: 'in_progress',
    processing: 'in_progress',
    blocked: 'blocked',
    verify: 'awaiting_acceptance',
    verifying: 'awaiting_acceptance',
    awaiting_acceptance: 'awaiting_acceptance',
    done: 'done',
    complete: 'done',
    completed: 'done',
    closed: 'done',
    cancel: 'cancelled',
    cancelled: 'cancelled',
    canceled: 'cancelled'
  };
  return map[s] || '';
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function asStringArray(v, max) {
  if (!Array.isArray(v)) return [];
  return v.filter(isNonEmptyString).map(s => s.trim()).slice(0, max || 50);
}

/**
 * 校验 M10 -> EBMS 的执行反馈报文。
 * 只返回规范化结果与错误，不做权限判断（权限由 m10-http / m10-service 负责）。
 */
function validateFeedback(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: [{ field: '$', message: '报文必须是 JSON 对象' }] };
  }

  const feedbackId = isNonEmptyString(body.feedback_id) ? body.feedback_id.trim() : '';
  if (!feedbackId) errors.push({ field: 'feedback_id', message: 'feedback_id 必填' });
  else if (feedbackId.length > 128) errors.push({ field: 'feedback_id', message: 'feedback_id 不能超过 128 字符' });

  if (body.contract_version !== undefined && body.contract_version !== null && String(body.contract_version) !== CONTRACT_VERSION) {
    errors.push({ field: 'contract_version', message: '不支持的契约版本：' + body.contract_version + '（期望 ' + CONTRACT_VERSION + '）' });
  }

  const idempotencyKey = isNonEmptyString(body.idempotency_key) ? body.idempotency_key.trim() : feedbackId;
  if (idempotencyKey && idempotencyKey.length > 160) {
    errors.push({ field: 'idempotency_key', message: 'idempotency_key 不能超过 160 字符' });
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push({ field: 'items', message: 'items 必须是非空数组' });
  }
  if (Array.isArray(body.items) && body.items.length > 200) {
    errors.push({ field: 'items', message: 'items 单次最多 200 条' });
  }

  const items = [];
  const rawItems = Array.isArray(body.items) ? body.items : [];
  rawItems.slice(0, 200).forEach((raw, index) => {
    const prefix = 'items[' + index + ']';
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ field: prefix, message: '事项必须是 JSON 对象' });
      return;
    }
    const parsed = parseWorkItemId(raw.work_item_id);
    const explicitType = isNonEmptyString(raw.source_object_type) ? raw.source_object_type.trim() : '';
    const explicitId = raw.source_object_id !== undefined && raw.source_object_id !== null ? String(raw.source_object_id).trim() : '';

    let slug = parsed ? parsed.slug : '';
    let sourceObjectType = parsed ? parsed.sourceObjectType : explicitType;
    let sourceObjectId = parsed ? parsed.sourceObjectId : explicitId;

    if (!parsed && (!sourceObjectType || !sourceObjectId)) {
      errors.push({ field: prefix + '.work_item_id', message: 'work_item_id 非法，且未提供 source_object_type/source_object_id' });
      return;
    }
    if (explicitType && parsed && explicitType !== parsed.sourceObjectType) {
      errors.push({ field: prefix + '.source_object_type', message: 'source_object_type 与 work_item_id 不一致' });
      return;
    }
    if (explicitId && parsed && explicitId !== parsed.sourceObjectId) {
      errors.push({ field: prefix + '.source_object_id', message: 'source_object_id 与 work_item_id 不一致' });
      return;
    }
    if (!slug) {
      slug = Object.keys(SOURCE_TYPE_BY_SLUG).find(k => SOURCE_TYPE_BY_SLUG[k] === sourceObjectType) || '';
    }
    if (!slug) {
      errors.push({ field: prefix + '.source_object_type', message: '不支持的 source_object_type：' + sourceObjectType });
      return;
    }

    const status = normalizeStatus(raw.status);
    if (!status) {
      errors.push({ field: prefix + '.status', message: 'status 必须是 pending/in_progress/awaiting_acceptance/blocked/done/cancelled 之一' });
      return;
    }

    const remark = isNonEmptyString(raw.remark) ? raw.remark.trim() : '';
    if (remark.length > 4000) errors.push({ field: prefix + '.remark', message: 'remark 不能超过 4000 字符' });

    items.push({
      work_item_id: workItemId(slug, sourceObjectId),
      slug,
      source_object_type: sourceObjectType,
      source_object_id: sourceObjectId,
      status,
      evidence_refs: asStringArray(raw.evidence_refs, 50),
      remark,
      completed_at: isNonEmptyString(raw.completed_at) ? raw.completed_at.trim() : ''
    });
  });

  if (rawItems.length > 0 && items.length === 0 && errors.length === 0) {
    errors.push({ field: 'items', message: '没有可处理的事项' });
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      contract_version: isNonEmptyString(body.contract_version) ? body.contract_version.trim() : CONTRACT_VERSION,
      feedback_id: feedbackId,
      idempotency_key: idempotencyKey,
      person_id: isNonEmptyString(body.person_id) ? body.person_id.trim() : '',
      ebms_user_id: body.ebms_user_id !== undefined && body.ebms_user_id !== null ? String(body.ebms_user_id).trim() : '',
      items
    }
  };
}

module.exports = {
  CONTRACT_VERSION,
  SOURCE_SYSTEM,
  SOURCE_OBJECT_TYPES,
  SOURCE_TYPE_BY_SLUG,
  STATUSES,
  SOP_TO_DISPLAY,
  DISPLAY_TO_SOP,
  workItemId,
  parseWorkItemId,
  normalizeStatus,
  validateFeedback
};
