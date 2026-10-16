/**
 * AEOS 契约实现（EBMS 侧）—— 阶段 2 架构方案（PAND-248）§4「契约冻结」的代码化。
 *
 * 本文件是 EBMS 侧唯一的契约事实来源：
 *   - 事件类型 / 对象类型 / 取值域枚举（§4.2）
 *   - 对象 payload 字段表（§4.3，字段名 = EBMS 侧字段集，标注 Owner 与线格式类型）
 *   - 主键/业务键 → object_id 编码（§2）
 *   - canonical 跨语言序列化 + 指纹 + 幂等键（§4.1）
 *   - 信封构造与契约校验（校验失败 → 字段级 errors，供入站返回 422）
 *
 * 契约不得私改；如需变更回 PAND-248 返工。
 */
const crypto = require('crypto');

const SCHEMA_PATH = 'contracts/aeos-contracts-v1.schema.json';
const CONTRACT_VERSION = 'aeos-contracts-v1';

// ============================ 枚举（§4.2 冻结取值域）============================
const ENUMS = {
  source_system: ['M05', 'EBMS'],
  object_type: ['Customer', 'Inquiry', 'QuoteLibrary', 'Order', 'Sample', 'Feedback', 'Dictionary'],
  operation: ['UPSERT', 'DELETE'],
  event_type: [
    'customer.upserted', 'customer.deleted',
    'inquiry.upserted', 'inquiry.deleted',
    'quote_library.upserted', 'quote_library.deleted',
    'order.upserted', 'order.deleted',
    'sample.upserted', 'sample.deleted',
    'feedback.upserted', 'feedback.deleted',
    'dictionary.upserted'
  ],
  customer_level: ['A级（核心大客户）', 'B级（普通大客户）', 'C级（中小客户）', 'D级（新客/休眠客）'],
  sales_mode: ['外销', '内销', '外贸公司'],
  customer_status: ['大货合作客户', '样品单客户', '潜在客户', '未合作休眠客户'],
  inquiry_status: ['new', 'cert_configured', 'config_generated', 'pending_pricing', 'pending_quote',
    'quoted', 'negotiating', 'sample', 'project', 'lost', 'closed'],
  inquiry_certificate_compliant: ['是', '否'],
  inquiry_certificate_level: ['国标', '行标', '企标', '无证书'],
  quote_library_certificate_level: ['CE', 'ROHS', 'CCC', 'UL', 'ETL'],
  order_status: ['open', 'confirmed', 'procurement_ready', 'material_ready', 'packaging_done',
    'shipped', 'completed', 'closed', 'cancelled'],
  // 待签批 13：现状双轨（表单 low/medium/high，列表过滤 blue/yellow/red），冻结默认 blue + 保留两组值
  order_risk_level: ['blue', 'yellow', 'red', 'low', 'medium', 'high'],
  sample_status: ['pending', 'confirmed', 'producing', 'sent', 'customer_confirmed', 'completed'],
  feedback_type: ['bug', 'feature', 'improvement', 'question'],
  feedback_priority: ['low', 'medium', 'high', 'urgent'],
  feedback_status: ['open', 'processing', 'resolved', 'closed'],
  feedback_followup_action: ['submit', 'comment', 'status', 'assign', 'resolve', 'close'],
  sync_status: ['PENDING', 'SYNCING', 'SYNCED', 'CONFLICT'],
  result_status: ['VERIFIED'],
  exception_status: ['OPEN'],
  exception_severity: ['low', 'medium', 'high', 'critical']
};

// ============================ 对象规格（§2 主键映射 + §4.3 字段表）============================
// wire 线格式类型：str | str-dec（金额/数量/比率，十进制字符串）| int | bool
// owner：字段归属方。EBMS 入站只应用 owner=CRM 的字段；owner=EBMS 的字段被入站携带时
//        不覆盖、写冲突留痕（§6.1）。§4.3 明确「CRM 侧不反向覆盖」的成本块归 EBMS。
const O = (name, wire, owner, extra) => Object.assign({ name, wire, owner }, extra || {});

const OBJECT_SPECS = {
  Customer: {
    eventBase: 'customer',
    table: 'customers',
    tableName: '客户',
    keyFields: ['name'],
    // 业务键 → object_id 分量
    keyPartsOf: (rec) => [rec.name],
    fields: [
      O('name', 'str', 'CRM', { required: true }),
      O('customer_code', 'str', 'CRM'),
      O('former_name', 'str', 'CRM'),
      O('parent_code', 'str', 'CRM'),
      O('customer_level', 'str', 'CRM', { enum: 'customer_level' }),
      O('sales_mode', 'str', 'CRM', { enum: 'sales_mode' }),
      O('customer_status', 'str', 'CRM', { enum: 'customer_status' }),
      O('sales_person', 'str', 'CRM'),
      O('decision_maker', 'str', 'CRM'),
      O('decision_maker_position', 'str', 'CRM'),
      O('decision_core_need', 'str', 'CRM'),
      O('contact_person', 'str', 'CRM'),
      O('contact_position', 'str', 'CRM'),
      O('phone', 'str', 'CRM'),
      O('email', 'str', 'CRM'),
      O('website', 'str', 'CRM'),
      O('wechat', 'str', 'CRM'),
      O('whatsapp', 'str', 'CRM'),
      O('skype', 'str', 'CRM'),
      O('other_im', 'str', 'CRM'),
      O('last_trade_year', 'str', 'CRM'),
      O('invoice_title', 'str', 'CRM'),
      O('tax_id', 'str', 'CRM'),
      O('bank_name', 'str', 'CRM'),
      O('bank_account', 'str', 'CRM'),
      O('address', 'str', 'CRM'),
      O('country_region', 'str', 'CRM'),
      O('customer_source', 'str', 'CRM'),
      O('remarks', 'str', 'CRM'),
      O('created_at', 'str', 'CRM', { meta: true }),
      O('updated_at', 'str', 'CRM', { meta: true })
    ]
  },

  Inquiry: {
    eventBase: 'inquiry',
    table: 'inquiries',
    tableName: '询价',
    keyFields: ['serial_number'],
    keyPartsOf: (rec) => [rec.serial_number],
    // header 字段（items[] 之外的平铺部分）
    fields: [
      O('serial_number', 'str', 'CRM', { required: true }),
      O('customer_name', 'str', 'CRM'),
      O('customer_code', 'str', 'CRM'),
      O('country_region', 'str', 'CRM'),
      O('sales_person', 'str', 'CRM'),
      O('contact_person', 'str', 'CRM'),
      O('contact_phone', 'str', 'CRM'),
      O('contact_email', 'str', 'CRM'),
      O('inquiry_time', 'str', 'CRM'),
      O('delivery_date', 'str', 'CRM'),
      O('customer_source', 'str', 'CRM'),
      O('quote_validity', 'str', 'CRM'),
      O('status', 'str', 'CRM', { enum: 'inquiry_status' }),
      O('lost_reason', 'str', 'CRM'),
      O('created_at', 'str', 'CRM', { meta: true }),
      O('updated_at', 'str', 'CRM', { meta: true }),
      // 成本/报价块：待签批 4，冻结「各自保留、CRM 侧不反向覆盖」→ owner=EBMS
      O('material_cost', 'str-dec', 'EBMS'),
      O('process_cost', 'str-dec', 'EBMS'),
      O('accessory_cost', 'str-dec', 'EBMS'),
      O('estimated_loss', 'str-dec', 'EBMS'),
      O('base_cost', 'str-dec', 'EBMS'),
      O('profit_rate', 'str-dec', 'EBMS'),
      O('discount_rate', 'str-dec', 'EBMS'),
      O('final_price', 'str-dec', 'EBMS')
    ],
    itemFields: [
      O('external_model', 'str', 'CRM'),
      O('internal_model', 'str', 'CRM'),
      O('product_name', 'str', 'CRM'),
      O('product_category', 'str', 'CRM'),
      O('power', 'str', 'CRM'),
      O('configuration', 'str', 'CRM'),
      O('quantity', 'str-dec', 'CRM'),
      O('target_price', 'str-dec', 'CRM'),
      O('certificate_compliant', 'str', 'CRM', { enum: 'inquiry_certificate_compliant' }),
      O('certificate_level', 'str', 'CRM', { enum: 'inquiry_certificate_level' }),
      O('input_voltage', 'str', 'CRM'),
      O('battery', 'str', 'CRM'),
      O('color_temp', 'str', 'CRM'),
      O('luminous_flux', 'str', 'CRM'),
      O('light_source', 'str', 'CRM'),
      O('main_body', 'str', 'CRM'),
      O('lampshade', 'str', 'CRM'),
      O('reflector', 'str', 'CRM'),
      O('cable', 'str', 'CRM'),
      O('switch_type', 'str', 'CRM'),
      O('usb', 'str', 'CRM'),
      O('waterproof', 'str', 'CRM'),
      O('sensor', 'str', 'CRM'),
      O('quote_time_needed', 'str', 'CRM'),
      O('custom_requirements', 'str', 'CRM')
      // image：base64 → File，P2，本期不实现（schema 已登记）
    ]
  },

  QuoteLibrary: {
    eventBase: 'quote_library',
    table: 'quote_library',
    tableName: '报价库',
    keyFields: ['external_model', 'certificate_level'],
    keyPartsOf: (rec) => [rec.external_model, rec.certificate_level],
    fields: [
      O('external_model', 'str', 'CRM', { required: true }),
      // 复合业务键半边：EBMS 现状允许空证书等级（object_id 形如 "MODEL#"），故键允许为空值
      O('certificate_level', 'str', 'CRM', { required: true, allowEmpty: true, enum: 'quote_library_certificate_level' }),
      O('internal_model', 'str', 'CRM'),
      O('product_name', 'str', 'CRM'),
      O('category', 'str', 'CRM'),
      O('power', 'str', 'CRM'),
      O('configuration', 'str', 'CRM'),
      O('specs', 'str', 'CRM'),
      O('price_rmb', 'str-dec', 'CRM'),
      O('price_usd', 'str-dec', 'CRM'),
      O('unit_price', 'str-dec', 'CRM'),
      O('min_price', 'str-dec', 'CRM'),
      O('validity_days', 'int', 'CRM'),
      O('usage_count', 'int', 'CRM'),
      O('source_inquiry_no', 'str', 'CRM'),
      O('source_pricing_id', 'str', 'CRM'),
      O('creator', 'str', 'CRM'),
      O('created_at', 'str', 'CRM', { meta: true }),
      O('updated_at', 'str', 'CRM', { meta: true })
    ]
  },

  Order: {
    eventBase: 'order',
    table: 'orders',
    tableName: '订单',
    keyFields: ['order_no', 'line_no'],
    keyPartsOf: (rec) => [rec.order_no, rec.line_no],
    fields: [
      O('order_no', 'str', 'CRM', { required: true }),
      // 复合业务键半边：EBMS 现状允许空行号（object_id 形如 "HJ2001#"），故键允许为空值
      O('line_no', 'str', 'CRM', { required: true, allowEmpty: true }),
      O('customer_name', 'str', 'CRM'),
      O('customer_code', 'str', 'CRM'),
      O('product_code', 'str', 'CRM'),
      O('product_name', 'str', 'CRM'),
      O('project_no', 'str', 'CRM'),
      O('quantity', 'str-dec', 'CRM'),
      O('completed_qty', 'str-dec', 'CRM'),
      O('order_amount', 'str-dec', 'CRM'),
      O('status', 'str', 'CRM', { enum: 'order_status', lockField: true }),
      O('risk_level', 'str', 'CRM', { enum: 'order_risk_level' }),
      O('promised_date', 'str', 'CRM'),
      O('plan_date', 'str', 'CRM'),
      O('online_date', 'str', 'CRM'),
      O('user_status_locked', 'bool', 'CRM'),
      O('user_status_modified_at', 'str', 'CRM'),
      O('user_status_modified_by', 'str', 'CRM'),
      O('sales_id', 'int', 'CRM'),
      O('department_id', 'int', 'CRM'),
      O('create_by', 'int', 'CRM'),
      O('created_at', 'str', 'CRM', { meta: true }),
      O('updated_at', 'str', 'CRM', { meta: true })
    ]
  },

  Sample: {
    eventBase: 'sample',
    table: 'samples',
    tableName: '样品',
    keyFields: ['sample_no'],
    keyPartsOf: (rec) => [rec.sample_no],
    fields: [
      O('sample_no', 'str', 'CRM', { required: true }),
      O('customer_name', 'str', 'CRM'),
      O('inquiry_no', 'str', 'CRM'),
      O('product_name', 'str', 'CRM'),
      O('product_code', 'str', 'CRM'),
      O('quantity', 'str-dec', 'CRM'),
      O('sample_type', 'str', 'CRM'),
      O('status', 'str', 'CRM', { enum: 'sample_status' }),
      O('remarks', 'str', 'CRM'),
      O('send_date', 'str', 'CRM'),
      O('confirm_date', 'str', 'CRM'),
      O('created_at', 'str', 'CRM', { meta: true }),
      O('updated_at', 'str', 'CRM', { meta: true })
    ]
  },

  Feedback: {
    eventBase: 'feedback',
    table: 'feedback',
    tableName: '反馈',
    keyFields: ['feedback_no'],
    keyPartsOf: (rec) => [rec.feedback_no],
    fields: [
      O('feedback_no', 'str', 'CRM', { required: true }),
      O('title', 'str', 'CRM', { required: true }),
      O('description', 'str', 'CRM'),
      O('type', 'str', 'CRM', { enum: 'feedback_type' }),
      O('priority', 'str', 'CRM', { enum: 'feedback_priority' }),
      O('module', 'str', 'CRM'),
      O('submitter', 'str', 'CRM'),
      O('submitter_id', 'int', 'CRM'),
      O('assignee', 'str', 'CRM'),
      O('assignee_id', 'int', 'CRM'),
      O('screenshots', 'str', 'CRM'),
      O('source', 'str', 'CRM'),
      O('status', 'str', 'CRM', { enum: 'feedback_status' }),
      O('resolution', 'str', 'CRM'),
      O('resolved_at', 'str', 'CRM'),
      O('created_at', 'str', 'CRM', { meta: true }),
      O('updated_at', 'str', 'CRM', { meta: true })
    ],
    // 跟进内嵌，全量快照，不做独立事件
    embedded: [{
      key: 'followups',
      table: 'feedback_followups',
      parentField: 'feedback_id',
      fields: [
        O('action', 'str', 'CRM', { required: true, enum: 'feedback_followup_action' }),
        O('content', 'str', 'CRM'),
        O('status_from', 'str', 'CRM'),
        O('status_to', 'str', 'CRM'),
        O('assignee', 'str', 'CRM'),
        O('operator', 'str', 'CRM'),
        O('operator_id', 'int', 'CRM'),
        O('created_at', 'str', 'CRM', { meta: true })
      ]
    }]
  },

  Dictionary: {
    eventBase: 'dictionary',
    table: null, // sidecar 表 aeos_dictionary，不动业务表
    tableName: '字典组',
    keyFields: ['dict_type'],
    keyPartsOf: (rec) => [rec.dict_type],
    fields: [
      O('dict_type', 'str', 'EBMS', { required: true })
      // entries[] 单独处理（见 embedded）
    ],
    embedded: [{
      key: 'entries',
      table: 'aeos_dictionary_entry',
      parentField: 'dict_type',
      parentKeyField: 'dict_type',
      fields: [
        O('label', 'str', 'EBMS'),
        O('value', 'str', 'EBMS', { required: true }),
        O('sort', 'int', 'EBMS'),
        O('enabled', 'bool', 'EBMS')
      ]
    }]
  }
};

// ============================ 幂等键 / 指纹（§4.1 冻结）============================
/** target_system = 事件目的地：CRM→EBMS 为 EBMS，EBMS→CRM 为 M05。 */
const TARGET_SYSTEM = { inbound: 'EBMS', outbound: 'M05' };

/**
 * canonical 序列化（跨语言冻结，防 Python/JS 指纹漂移）：
 * UTF-8、键排序、无空格、分隔符 (":", ",")、非 ASCII 原样；金额/数量/比率一律十进制字符串。
 */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical: 非有限数值不可指纹化');
    if (!Number.isInteger(value)) {
      throw new Error('canonical: 出现非整数数值 ' + value +
        '（契约要求金额/数量/比率以十进制字符串传输，整数字段以 JSON 整数传输）');
    }
    return String(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new Error('canonical: 不支持的类型 ' + t);
}

/**
 * fingerprint = sha1( canonical(事件内容) )[:16]
 *
 * 「事件内容」= 契约 §4 的「event 去掉 occurred_at」，并进一步去掉全部**派生的、非内容的**
 * 信封字段：idempotency_key（本函数的结果）、event_id（EVT-...-<8位随机十六进制>）、
 * trace_id（= TRACE-{event_id}）。
 *
 * 为什么必须去掉 event_id：§4 的 event_id 含 4 字节随机数，若参与指纹，则「同一对象、
 * 同一内容」每次构造都会得到不同指纹 → 不同幂等键，§5.3 的「同内容重复保存被指纹幂等吸收」
 * 与 AC-S3 的「同 ID 且数值未变 = 不是新投递」都将永远不成立。去掉随机派生字段后，
 * 指纹只随业务内容变化 —— 这正是幂等键要表达的东西；键的**格式与语义**（
 * `{target}:{event_type}:{object_id}:{fingerprint}`、occurred_at 不参与）保持不变。
 */
function fingerprint(event) {
  const stripped = Object.assign({}, event);
  delete stripped.occurred_at;      // §4 显式排除（同一内容的时间不同仍算同一次投递）
  delete stripped.idempotency_key;  // 本函数的派生结果
  delete stripped.event_id;         // 含随机数，非内容
  delete stripped.trace_id;         // = TRACE-{event_id}，同上
  return crypto.createHash('sha1').update(canonical(stripped), 'utf8').digest('hex').slice(0, 16);
}

function idempotencyKey(event, targetSystem) {
  const present = event.idempotency_key;
  if (present) return present;
  return buildIdempotencyKey(targetSystem, event.event_type, event.object_id, fingerprint(event));
}

function buildIdempotencyKey(targetSystem, eventType, objectId, fp) {
  return [targetSystem, eventType, objectId, fp].join(':');
}

// ============================ object_id 编码（§2）============================
/** 保留字符 `#`：两侧写入 order_no/external_model/certificate_level 等分量时不得包含 `#`；
 *  含 `#` 的值在编码前由发送侧替换为 `~`。 */
const KEY_SEP = '#';
const KEY_ESC = '~';

function encodeObjectId(objectType, parts) {
  const spec = OBJECT_SPECS[objectType];
  if (!spec) throw new Error('未知 object_type: ' + objectType);
  const arr = Array.isArray(parts) ? parts : [parts];
  return spec.keyFields.map((_, i) => sanitizeKeyPart(arr[i])).join(KEY_SEP);
}

function sanitizeKeyPart(v) {
  return String(v === undefined || v === null ? '' : v).replace(/#/g, KEY_ESC);
}

function decodeObjectId(objectType, objectId) {
  const spec = OBJECT_SPECS[objectType];
  if (!spec) throw new Error('未知 object_type: ' + objectType);
  const parts = String(objectId === undefined || objectId === null ? '' : objectId).split(KEY_SEP);
  const out = {};
  spec.keyFields.forEach((f, i) => { out[f] = parts[i] === undefined ? '' : parts[i]; });
  return out;
}

/** EBMS 表名 → object_type（出站入队与 sidecar 反查用）。 */
function objectTypeOfTable(table) {
  return Object.keys(OBJECT_SPECS).find(k => OBJECT_SPECS[k].table === table) || null;
}

// ============================ 线格式转换 ============================
function toWireValue(field, v) {
  if (v === undefined || v === null) {
    return field.wire === 'bool' ? null : (field.wire === 'int' || field.wire === 'str-dec' ? null : '');
  }
  switch (field.wire) {
    case 'str-dec': {
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
      if (!Number.isFinite(n)) return null;
      // 十进制字符串；按 Numeric(18,4) 精度收敛，避免浮点尾数污染指纹
      return String(Math.round(n * 10000) / 10000);
    }
    case 'int': {
      const n = typeof v === 'number' ? v : parseInt(v, 10);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 1 || v === '1' || v === 'true' || v === true) return true;
      if (v === 0 || v === '0' || v === 'false' || v === false) return false;
      return null;
    default:
      return String(v);
  }
}

function fromWireValue(field, v) {
  if (v === undefined || v === null) return null;
  switch (field.wire) {
    case 'str-dec': {
      const n = parseFloat(String(v));
      return Number.isFinite(n) ? n : null;
    }
    case 'int': {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'bool':
      return (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
    default:
      return String(v);
  }
}

// ============================ payload 规范化（出站）============================
/** 枚举字段越界时的处置：出站丢弃该值并记 warning（保证不把非法契约发出去、
 *  同时不因存量脏数据阻塞迁移）；入站则直接 422。 */
function normalizeEnum(field, raw, warnings, ctx) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (!field.enum) return raw;
  const domain = ENUMS[field.enum];
  if (!domain) return raw;
  if (domain.includes(raw)) return raw;
  warnings.push({
    object_type: ctx.objectType,
    object_id: ctx.objectId,
    field: field.name,
    value: raw,
    reason: '取值不在冻结取值域 ' + field.enum + ' 内，已丢弃该字段值'
  });
  return '';
}

/**
 * 按 §4.3 字段表把 EBMS 记录剪裁成线格式 payload。
 * 只输出契约声明的字段 —— 未声明的 EBMS 内部字段永不出现在报文里。
 */
function buildPayload(objectType, record, opts) {
  const spec = OBJECT_SPECS[objectType];
  const warnings = [];
  const ctx = { objectType, objectId: opts && opts.objectId };
  const payload = {};
  for (const f of spec.fields) {
    let raw = record[f.name];
    if (f.wire === 'bool') {
      payload[f.name] = toWireValue(f, raw);
      continue;
    }
    if (f.enum && f.wire === 'str') raw = normalizeEnum(f, raw, warnings, ctx);
    payload[f.name] = toWireValue(f, raw === undefined || raw === null ? '' : raw);
  }
  return { payload, warnings };
}

/** 记录的业务键 → object_id（Feedback 走 feedback_no 或三元组派生键）。 */
function objectIdOf(objectType, record) {
  if (objectType === 'Feedback') return feedbackObjectId(record);
  const spec = OBJECT_SPECS[objectType];
  return encodeObjectId(objectType, spec.keyPartsOf(record));
}

/**
 * §2 反馈业务键：EBMS 无稳定键 → 有 feedback_no 用之；
 * 否则用 `fb:{sha1(submitter‖title‖created_at)[:16]}`。
 */
function feedbackObjectId(record) {
  const no = String((record && record.feedback_no) || '').trim();
  if (no) return sanitizeKeyPart(no);
  return feedbackDerivedKey(record);
}

function feedbackDerivedKey(record) {
  const r = record || {};
  const basis = [r.submitter || '', r.title || '', r.created_at || ''].join('‖');
  return 'fb:' + crypto.createHash('sha1').update(basis, 'utf8').digest('hex').slice(0, 16);
}

// ============================ 信封构造 ============================
const OPERATION_SUFFIX = { UPSERT: 'upserted', DELETE: 'deleted' };

function eventTypeOf(objectType, operation) {
  const spec = OBJECT_SPECS[objectType];
  if (!spec) throw new Error('未知 object_type: ' + objectType);
  const suffix = OPERATION_SUFFIX[String(operation || '').toUpperCase()];
  if (!suffix) throw new Error('未知 operation: ' + operation);
  // Dictionary 仅 upserted（§4.1 event_type 取值域）
  if (objectType === 'Dictionary' && suffix !== 'upserted') {
    throw new Error('Dictionary 不支持 ' + operation + '（冻结取值域仅 dictionary.upserted）');
  }
  return spec.eventBase + '.' + suffix;
}

function makeEventId(sourceSystem, objectType, objectId) {
  const rnd = crypto.randomBytes(4).toString('hex');
  return ['EVT', sourceSystem, objectType, objectId, rnd].join('-');
}

/**
 * 构造 AEOS.Event.V1 信封。
 * @param {object} a {sourceSystem, objectType, objectId, operation, payload, occurredAt, targetSystem}
 */
function buildEvent(a) {
  const operation = String(a.operation || 'UPSERT').toUpperCase();
  const eventType = eventTypeOf(a.objectType, operation);
  const eventId = a.eventId || makeEventId(a.sourceSystem, a.objectType, a.objectId);
  const event = {
    contract_version: 'AEOS.Event.V1',
    event_id: eventId,
    event_type: eventType,
    source_system: a.sourceSystem,
    object_type: a.objectType,
    object_id: String(a.objectId),
    operation,
    occurred_at: toRfc3339(a.occurredAt),
    trace_id: a.traceId || ('TRACE-' + eventId),
    payload: a.payload || {}
  };
  event.idempotency_key = buildIdempotencyKey(
    a.targetSystem || (a.sourceSystem === 'EBMS' ? TARGET_SYSTEM.outbound : TARGET_SYSTEM.inbound),
    event.event_type, event.object_id, fingerprint(event)
  );
  return event;
}

/** EBMS 本地时间字符串（'YYYY-MM-DD HH:mm:ss'，UTC+8）→ RFC3339(+08:00)。 */
function toRfc3339(v) {
  if (!v) return nowRfc3339();
  const s = String(v).trim();
  if (/[+-]\d{2}:\d{2}$|Z$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : nowRfc3339();
}

function nowRfc3339() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('Z', '+08:00');
}

/** RFC3339 → 可比较的毫秒数（LWW / 乱序判定用）。 */
function parseTime(v) {
  if (!v) return NaN;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return Date.parse(s.replace(' ', 'T') + '+08:00');
  }
  return Date.parse(s);
}

// ============================ 契约校验（入站 422 口径）============================
function isNonEmptyString(v) { return typeof v === 'string' && v.trim() !== ''; }

/**
 * 校验 AEOS.Event.V1。
 * @returns {{ok:boolean, errors:Array<{field:string,message:string}>, warnings:Array}}
 */
function validateEvent(env) {
  const errors = [];
  const warnings = [];
  const E = (field, message) => errors.push({ field, message });
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, errors: [{ field: '', message: '报文必须是 JSON 对象' }], warnings };
  }

  // 信封必填
  for (const f of ['contract_version', 'event_id', 'event_type', 'source_system',
    'object_type', 'object_id', 'operation', 'occurred_at', 'trace_id']) {
    if (!isNonEmptyString(env[f])) E(f, '必填字段缺失或为空');
  }
  if (errors.length && !env.contract_version) {
    // 连契约版本都没有，后续按域校验无意义
    return { ok: false, errors, warnings };
  }

  if (env.contract_version !== 'AEOS.Event.V1') {
    E('contract_version', '必须恰为 AEOS.Event.V1，实际 ' + env.contract_version);
  }
  if (!ENUMS.source_system.includes(env.source_system)) {
    E('source_system', '取值必须为 ' + ENUMS.source_system.join('/') + '，实际 ' + env.source_system);
  }
  if (!ENUMS.object_type.includes(env.object_type)) {
    E('object_type', '取值必须为 ' + ENUMS.object_type.join('/') + '，实际 ' + env.object_type);
  }
  if (!ENUMS.operation.includes(env.operation)) {
    E('operation', '取值必须为 ' + ENUMS.operation.join('/') + '，实际 ' + env.operation);
  }
  if (!ENUMS.event_type.includes(env.event_type)) {
    E('event_type', '取值不在冻结的 13 个事件类型内，实际 ' + env.event_type);
  } else if (ENUMS.object_type.includes(env.object_type) && ENUMS.operation.includes(env.operation)) {
    const expect = eventTypeOf(env.object_type, env.operation);
    if (expect !== env.event_type) {
      E('event_type', '与 object_type/operation 不一致：期望 ' + expect + '，实际 ' + env.event_type);
    }
  }
  if (isNonEmptyString(env.occurred_at) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/.test(env.occurred_at)) {
    E('occurred_at', '必须为 RFC3339 时间戳，实际 ' + env.occurred_at);
  }
  if (isNonEmptyString(env.object_id) && String(env.object_id).includes(KEY_SEP) === false &&
    OBJECT_SPECS[env.object_type] && OBJECT_SPECS[env.object_type].keyFields.length > 1) {
    E('object_id', '复合业务键必须以 "' + KEY_SEP + '" 分隔（如 order_no' + KEY_SEP + 'line_no）');
  }

  // payload 字段级校验（UPSERT 必须带齐必填；DELETE 只校验键）
  const spec = OBJECT_SPECS[env.object_type];
  if (spec) {
    if (env.operation === 'UPSERT') {
      if (!env.payload || typeof env.payload !== 'object' || Array.isArray(env.payload)) {
        E('payload', 'UPSERT 必须携带对象 payload');
      } else {
        for (const f of spec.fields) {
          if (!f.required) continue;
          const v = env.payload[f.name];
          const missing = v === undefined || v === null;
          const empty = !missing && String(v).trim() === '';
          if (missing || (empty && !f.allowEmpty)) {
            E('payload.' + f.name, f.allowEmpty ? '必填字段缺失（复合业务键半边允许空值但必须出现）' : '必填字段缺失或为空');
          }
        }
        for (const f of spec.fields) {
          const v = env.payload[f.name];
          if (v === undefined || v === null || v === '') continue;
          if (f.enum) {
            const domain = ENUMS[f.enum] || [];
            if (!domain.includes(v)) {
              E('payload.' + f.name, '取值必须为 ' + domain.join(' / ') + ' 之一，实际 ' + v);
            }
          }
          if (f.wire === 'str-dec' && !/^-?\d+(\.\d+)?$/.test(String(v))) {
            E('payload.' + f.name, 'str-dec 必须为十进制字符串（如 "156.00"），实际 ' + v);
          }
          if (f.wire === 'int' && !Number.isInteger(v)) {
            E('payload.' + f.name, 'int 必须为 JSON 整数，实际 ' + JSON.stringify(v));
          }
          if (f.wire === 'bool' && typeof v !== 'boolean') {
            E('payload.' + f.name, 'bool 必须为 JSON 布尔，实际 ' + JSON.stringify(v));
          }
        }
      }
      // 嵌套组
      for (const emb of (spec.embedded || [])) {
        const arr = env.payload ? env.payload[emb.key] : undefined;
        if (arr === undefined) continue;
        if (!Array.isArray(arr)) { E('payload.' + emb.key, '必须为数组'); continue; }
        arr.forEach((row, i) => {
          if (!row || typeof row !== 'object') { E(`payload.${emb.key}[${i}]`, '必须为对象'); return; }
          for (const f of emb.fields) {
            const v = row[f.name];
            if (f.required && (v === undefined || v === null || String(v).trim() === '')) {
              E(`payload.${emb.key}[${i}].${f.name}`, '必填字段缺失或为空');
            }
            if (v !== undefined && v !== null && v !== '' && f.enum) {
              const domain = ENUMS[f.enum] || [];
              if (!domain.includes(v)) {
                E(`payload.${emb.key}[${i}].${f.name}`, '取值必须为 ' + domain.join(' / ') + ' 之一，实际 ' + v);
              }
            }
          }
        });
      }
    }
  } else if (env.object_type && !OBJECT_SPECS[env.object_type]) {
    // 已由 object_type 枚举拦下
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 校验 body 中的业务键与 object_id 是否自洽（防「键与 ID 不一致」的一物两 ID）。 */
function validateKeyConsistency(env) {
  const errors = [];
  const spec = OBJECT_SPECS[env.object_type];
  if (!spec || env.operation !== 'UPSERT' || !env.payload) return errors;
  const expected = encodeObjectId(env.object_type, spec.keyFields.map(f => env.payload[f]));
  if (expected !== String(env.object_id)) {
    errors.push({
      field: 'object_id',
      message: 'object_id 与 payload 业务键不一致：期望 ' + expected + '，实际 ' + env.object_id
    });
  }
  return errors;
}

// ============================ Result / Exception 校验（AC-S1）============================
function validateResult(env) {
  const errors = [];
  const E = (field, message) => errors.push({ field, message });
  if (!env || typeof env !== 'object') return { ok: false, errors: [{ field: '', message: '报文必须是 JSON 对象' }] };
  for (const f of ['contract_version', 'result_id', 'source_system', 'object_type', 'object_id',
    'period', 'metric', 'status', 'evidence_ids', 'trace_id', 'occurred_at']) {
    if (env[f] === undefined || env[f] === null || env[f] === '') E(f, '必填字段缺失或为空');
  }
  if (env.contract_version !== 'AEOS.Result.V1') E('contract_version', '必须恰为 AEOS.Result.V1');
  if (env.source_system !== 'M05') E('source_system', '必须恰为 M05');
  if (env.status !== undefined && !ENUMS.result_status.includes(env.status)) {
    E('status', '当前合法域恰为 ' + ENUMS.result_status.join('/') + '，实际 ' + env.status);
  }
  if (env.period) {
    if (!isNonEmptyString(env.period.start)) E('period.start', '必填字段缺失或为空');
    if (!isNonEmptyString(env.period.end)) E('period.end', '必填字段缺失或为空');
    const s = parseTime(env.period.start), e = parseTime(env.period.end);
    if (Number.isFinite(s) && Number.isFinite(e) && e < s) E('period.end', 'period.end 必须 ≥ period.start');
  }
  if (env.metric) {
    for (const k of ['code', 'unit', 'calculation_version']) {
      if (!isNonEmptyString(env.metric[k])) E('metric.' + k, '必填字段缺失或为空（禁止无口径版本的指标）');
    }
    if (typeof env.metric.value !== 'number' || !Number.isFinite(env.metric.value)) {
      E('metric.value', '必须为数值');
    }
  }
  if (!Array.isArray(env.evidence_ids) || env.evidence_ids.length === 0) {
    E('evidence_ids', '必须为非空数组（每条可回查到来源单据）');
  }
  return { ok: errors.length === 0, errors };
}

function validateException(env) {
  const errors = [];
  const E = (field, message) => errors.push({ field, message });
  if (!env || typeof env !== 'object') return { ok: false, errors: [{ field: '', message: '报文必须是 JSON 对象' }] };
  for (const f of ['contract_version', 'exception_id', 'source_system', 'object_type', 'object_id',
    'severity', 'reason_code', 'status', 'trace_id', 'occurred_at']) {
    if (env[f] === undefined || env[f] === null || env[f] === '') E(f, '必填字段缺失或为空');
  }
  if (env.contract_version !== 'AEOS.Exception.V1') E('contract_version', '必须恰为 AEOS.Exception.V1');
  if (env.severity !== undefined && !ENUMS.exception_severity.includes(env.severity)) {
    E('severity', '取值必须为 ' + ENUMS.exception_severity.join('/') + '，实际 ' + env.severity);
  }
  if (env.status !== undefined && !ENUMS.exception_status.includes(env.status)) {
    E('status', '当前合法域恰为 ' + ENUMS.exception_status.join('/') + '，实际 ' + env.status);
  }
  if (env.evidence_ids !== undefined && !Array.isArray(env.evidence_ids)) {
    E('evidence_ids', '必须为数组');
  }
  return { ok: errors.length === 0, errors };
}

/** 按 contract_version 分派校验。未知版本 → 400（无法判定契约）。 */
function validateAny(body) {
  if (!body || typeof body !== 'object') {
    return { kind: 'unknown', ok: false, status: 400, errors: [{ field: '', message: '报文必须是 JSON 对象' }] };
  }
  const v = body.contract_version;
  if (v === 'AEOS.Event.V1') {
    const r = validateEvent(body);
    const keyErrors = r.ok ? validateKeyConsistency(body) : [];
    return { kind: 'event', ok: r.ok && keyErrors.length === 0, status: 422, errors: r.errors.concat(keyErrors), warnings: r.warnings };
  }
  if (v === 'AEOS.Result.V1') {
    const r = validateResult(body);
    return { kind: 'result', ok: r.ok, status: 422, errors: r.errors };
  }
  if (v === 'AEOS.Exception.V1') {
    const r = validateException(body);
    return { kind: 'exception', ok: r.ok, status: 422, errors: r.errors };
  }
  return {
    kind: 'unknown', ok: false, status: 400,
    errors: [{ field: 'contract_version', message: '未知或不支持的契约版本：' + String(v) }]
  };
}

module.exports = {
  SCHEMA_PATH, CONTRACT_VERSION, ENUMS, OBJECT_SPECS, TARGET_SYSTEM,
  KEY_SEP, KEY_ESC,
  canonical, fingerprint, idempotencyKey, buildIdempotencyKey,
  encodeObjectId, decodeObjectId, sanitizeKeyPart, objectTypeOfTable,
  toWireValue, fromWireValue, buildPayload, objectIdOf,
  feedbackObjectId, feedbackDerivedKey,
  eventTypeOf, makeEventId, buildEvent, toRfc3339, nowRfc3339, parseTime,
  validateEvent, validateKeyConsistency, validateResult, validateException, validateAny
};
