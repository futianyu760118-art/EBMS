/**
 * AEOS 销售数据同步通道 · EBMS 侧自检（PAND-250）
 *
 * 运行方式（**必须用生产引擎运行**，与部署一致）：
 *   cd backend && node --experimental-sqlite test-aeos-sync.js
 * 回退引擎对照（可选，差异见报告末尾）：
 *   cd backend && node test-aeos-sync.js
 *
 * 设计：
 *   - 不启 Express 服务，直接驱动 lib/aeos-*.js 纯核（aeos-http.js 与 Express 解耦正是为此）；
 *     T11 另取 routes/inquiry.js 的真实路由处理器直呼，验「写落定 → 读行 → 出站」顺序；
 *   - 隔离库：EBMS_DATA_DIR 指向临时目录，不碰生产 database/sales.db；
 *   - 内置假 CRM（node:http）真实监听 127.0.0.1，走真实 HTTP 投递，验头/体重试与死信；
 *   - 逐条对应阶段 1 的 AC-S1~AC-S10（PAND-247 评论「AC-S 双向同步」）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

// ---- 隔离与凭据（必须在 require db 之前设置）----
const DATA_DIR = path.join(__dirname, '.aeos-selftest-data');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
process.env.EBMS_DATA_DIR = DATA_DIR;
process.env.EBMS_INGEST_TOKEN = 'selftest-ingest-token';
process.env.EBMS_INBOUND_TOKEN = 'selftest-inbound-token';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const db = require('./db');
const store = require('./lib/aeos-store');
const outbox = require('./lib/aeos-outbox');
const ingest = require('./lib/aeos-ingest');
const core = require('./lib/aeos-http');
const hooks = require('./lib/aeos-hooks');
const C = require('./lib/aeos-contract');

// ============================ 断言与记录 ============================
const results = [];
let current = { id: '', ac: '' };
function section(id, ac, title) {
  current = { id, ac };
  console.log('\n=== ' + id + ' [' + ac + '] ' + title + ' ===');
}
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ id: current.id, ac: current.ac, name, pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? '  PASS' : '  FAIL') + '  ' + name + (pass || detail === undefined ? '' : '  → ' + detail));
  return pass;
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 让「发了不等」的出站入队链落定（路由对钩子是 fire-and-forget，入队在其后的微任务里完成）
const settle = () => new Promise(r => setImmediate(r));

// ============================ 假 CRM（真实 HTTP 对端）============================
const received = [];
let crmMode = 'ok';
const crm = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    received.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (crmMode === 'ok') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"result":"applied"}'); return; }
    if (crmMode === 'skipped') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"result":"skipped"}'); return; }
    if (crmMode === '422') { res.writeHead(422, { 'Content-Type': 'application/json' }); res.end('{"errors":[{"field":"payload.status","message":"取值越界"}]}'); return; }
    res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"temporarily unavailable"}');
  });
});

// ============================ 报文夹具（M05→EBMS）============================
/**
 * 递增的「未来」本地时间戳（UTC+8）。
 * 入站 §6.4 以 last_sync_at（= 本机 now()）判定乱序/过期，若夹具用过去的固定时刻，
 * 第一条落库后其余事件全会被判 STALE。真实场景中事件总是「刚发生就被推送」，
 * 故夹具统一取略晚于 now() 的单调时刻；只有刻意构造过期场景时才用历史时刻。
 */
let _tick = 0;
function ts() {
  _tick += 1;
  return new Date(Date.now() + 8 * 3600 * 1000 + _tick * 60000).toISOString().replace('T', ' ').substring(0, 19);
}
function ev(objectType, objectId, operation, payload, occurredAt, sourceSystem) {
  return C.buildEvent({
    sourceSystem: sourceSystem || 'M05',
    objectType, objectId, operation, payload,
    occurredAt: occurredAt || ts()
  });
}
function customerPayload(name, over) {
  return Object.assign({
    name,
    customer_code: 'KH0001',
    customer_level: 'B级（普通大客户）',
    sales_mode: '外销',
    customer_status: '潜在客户',
    sales_person: '张三',
    contact_person: '李四',
    phone: '13800000000',
    email: 'a@b.com',
    country_region: '中国',
    address: '宁波市',
    customer_source: '展会',
    remarks: '',
    created_at: '2026-10-16 10:00:00',
    updated_at: '2026-10-16 10:00:00'
  }, over || {});
}
function inquiryPayload(serial, over) {
  return Object.assign({
    serial_number: serial,
    customer_name: '自检客户A',
    customer_code: 'KH0001',
    country_region: '中国',
    sales_person: '张三',
    contact_person: '李四',
    inquiry_time: '2026-10-16 10:00:00',
    delivery_date: '2026-11-01',
    customer_source: '展会',
    quote_validity: '30天',
    status: 'new',
    lost_reason: '',
    created_at: '2026-10-16 10:00:00',
    updated_at: '2026-10-16 10:00:00',
    material_cost: '10.00',
    process_cost: '30.00',
    accessory_cost: '5.00',
    estimated_loss: '2.50',
    base_cost: '47.50',
    profit_rate: '0.20',
    discount_rate: '1',
    final_price: '57.00',
    items: [
      { external_model: 'HJ-M1', internal_model: 'IN-1', product_name: '筒灯1', product_category: '筒灯', power: '10W', configuration: '', quantity: '100', target_price: '50.00', certificate_compliant: '是', certificate_level: '国标', input_voltage: '220V', battery: '', color_temp: '4000K', luminous_flux: '1000lm', light_source: 'LED', main_body: '铝', lampshade: 'PC', reflector: '', cable: '', switch_type: '', usb: '', waterproof: 'IP44', sensor: '', quote_time_needed: '7天', custom_requirements: '' },
      { external_model: 'HJ-M2', internal_model: 'IN-2', product_name: '筒灯2', product_category: '筒灯', power: '20W', configuration: '', quantity: '50', target_price: '80.00', certificate_compliant: '否', certificate_level: '无证书', input_voltage: '220V', battery: '', color_temp: '3000K', luminous_flux: '2000lm', light_source: 'LED', main_body: '铝', lampshade: 'PC', reflector: '', cable: '', switch_type: '', usb: '', waterproof: 'IP44', sensor: '', quote_time_needed: '10天', custom_requirements: '' }
    ]
  }, over || {});
}
function orderPayload(orderNo, lineNo, over) {
  return Object.assign({
    order_no: orderNo, line_no: lineNo,
    customer_name: '自检客户A', customer_code: 'KH0001',
    product_code: 'HJ-M1', product_name: '筒灯1', project_no: 'PJ-1',
    quantity: '100', completed_qty: '0', order_amount: '5700.00',
    status: 'open', risk_level: 'blue',
    promised_date: '2026-11-01', plan_date: '2026-10-20', online_date: '',
    user_status_locked: false, user_status_modified_at: '', user_status_modified_by: '',
    sales_id: 1, department_id: 1, create_by: 1,
    created_at: '2026-10-16 10:00:00', updated_at: '2026-10-16 10:00:00'
  }, over || {});
}
function quotePayload(model, level, over) {
  return Object.assign({
    external_model: model, certificate_level: level,
    internal_model: '', product_name: '筒灯', category: '筒灯', power: '10W', configuration: '', specs: '',
    price_rmb: '57.00', price_usd: '', unit_price: '57.00', min_price: '50.00',
    validity_days: 30, usage_count: 0, source_inquiry_no: '', source_pricing_id: '', creator: '张三',
    created_at: '2026-10-16 10:00:00', updated_at: '2026-10-16 10:00:00'
  }, over || {});
}
function samplePayload(no, over) {
  return Object.assign({
    sample_no: no, customer_name: '自检客户A', inquiry_no: 'JFX20261016001',
    product_name: '筒灯1', product_code: 'HJ-M1', quantity: '2', sample_type: '常规',
    status: 'pending', remarks: '', send_date: '', confirm_date: '',
    created_at: '2026-10-16 10:00:00', updated_at: '2026-10-16 10:00:00'
  }, over || {});
}
function feedbackPayload(no, over) {
  return Object.assign({
    feedback_no: no, title: '自检反馈', description: 'd', type: 'bug', priority: 'medium',
    module: '销售', submitter: '李四', submitter_id: 2, assignee: '', assignee_id: 0,
    screenshots: '', source: 'page', status: 'open', resolution: '', resolved_at: '',
    created_at: '2026-10-16 10:00:00', updated_at: '2026-10-16 10:00:00',
    followups: [
      { action: 'submit', content: '提交', status_from: '', status_to: 'open', assignee: '', operator: '李四', operator_id: 2, created_at: '2026-10-16 10:00:00' },
      { action: 'comment', content: '跟进1', status_from: 'open', status_to: 'open', assignee: '', operator: '王五', operator_id: 3, created_at: '2026-10-16 11:00:00' }
    ]
  }, over || {});
}
function inbound(body) {
  return core.handleIngest({
    headers: {
      authorization: 'Bearer ' + process.env.EBMS_INGEST_TOKEN,
      'x-contract-version': body.contract_version,
      'x-event-type': body.event_type || '',
      'x-idempotency-key': body.idempotency_key || ''
    },
    body: JSON.stringify(body)
  });
}
function outboxRows() { return store.t('outbox').all().slice(); }
function businessRow(table, fn) { return db.getTable(table).all().slice().find(fn) || null; }
function conflictsOf(type, id) {
  return store.all('conflict').filter(c => c.object_type === type && String(c.object_id) === String(id));
}

// ============================ 主流程 ============================
(async function main() {
  await new Promise(r => crm.listen(0, '127.0.0.1', r));
  const crmPort = crm.address().port;
  const crmUrl = 'http://127.0.0.1:' + crmPort + '/api/v1/integrations/ebms/ingest';

  store.init();
  ['customers', 'inquiries', 'quote_library', 'orders', 'samples', 'feedback', 'feedback_followups', 'system_settings'].forEach(db.ensureTable);

  // ---------------------------------------------------------------- AC-S1
  section('T1', 'AC-S1', '出站契约合规（EBMS→CRM 的 AEOS.Event.V1 信封与字段线格式）');
  const custRec = { name: '自检客户A', customer_code: 'KH0001', customer_level: 'B级（普通大客户）', sales_mode: '外销', customer_status: '潜在客户', contact_person: '李四', phone: '13800000000', country_region: '中国', address: '宁波市', customer_source: '展会', created_at: '2026-10-16 10:00:00', updated_at: '2026-10-16 10:00:00' };
  await db.getTable('customers').insert(Object.assign({ id: 1 }, custRec));
  await hooks.fireUpsert('Customer', db.getTable('customers').findById(1));
  let row = outboxRows()[0];
  let env = row ? JSON.parse(row.payload) : null;
  check('出站事件已入队', !!row, row ? '' : '队列为空');
  check('contract_version 恰为 AEOS.Event.V1', env && env.contract_version === 'AEOS.Event.V1', env && env.contract_version);
  check('source_system 恰为 EBMS', env && env.source_system === 'EBMS', env && env.source_system);
  check('event_type 恰为 customer.upserted', env && env.event_type === 'customer.upserted', env && env.event_type);
  check('operation 恰为 UPSERT', env && env.operation === 'UPSERT', env && env.operation);
  check('object_id = 业务键（customers.name）', env && env.object_id === '自检客户A', env && env.object_id);
  check('event_id 形如 EVT-EBMS-Customer-<键>-<8hex>', env && /^EVT-EBMS-Customer-.+-[0-9a-f]{8}$/.test(env.event_id), env && env.event_id);
  check('trace_id = TRACE-{event_id}', env && env.trace_id === 'TRACE-' + env.event_id, env && env.trace_id);
  check('occurred_at 为 RFC3339', env && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(env.occurred_at), env && env.occurred_at);
  check('target_system 段 = M05（= 事件目的地）', row && row.idempotency_key.startsWith('M05:customer.upserted:自检客户A:'), row && row.idempotency_key);
  check('幂等键末段 = fingerprint(event)', env && row.idempotency_key.split(':')[3] === C.fingerprint(env), row && row.idempotency_key.split(':')[3]);
  check('fingerprint 可复算（跨语言冻结口径）', env && C.fingerprint(env) === C.fingerprint(JSON.parse(JSON.stringify(env))));
  const vAny = C.validateAny(env);
  check('出站报文通过冻结契约校验（validateAny.ok）', vAny.ok, JSON.stringify(vAny.errors || []).substring(0, 200));
  check('payload 只含契约声明字段（不含 EBMS 内部字段）', env && !Object.keys(env.payload).some(k => k.startsWith('_')) && env.payload.name === '自检客户A');
  check('Outbox 行状态为 pending 且 attempts=0', row && row.status === 'pending' && Number(row.attempts) === 0, row && row.status + '/' + row.attempts);

  // 金额/数量：一律十进制字符串
  await db.getTable('inquiries').insert({ id: 1, serial_number: 'JFX20261016001', customer_name: '自检客户A', status: 'quoted', final_price: 57.5, base_cost: 47.5, material_cost: 10, process_cost: 30, quantity: 100, external_model: 'HJ-M1', created_at: '2026-10-16 10:00:00', updated_at: '2026-10-16 10:00:00' });
  await hooks.fireUpsert('Inquiry', 'JFX20261016001');
  const inqRow = outboxRows().find(r => r.object_type === 'Inquiry');
  const inqEnv = inqRow ? JSON.parse(inqRow.payload) : null;
  check('询价按基号聚合成 1 条 inquiry.upserted', inqRow && inqEnv.object_id === 'JFX20261016001' && Array.isArray(inqEnv.payload.items), inqEnv && inqEnv.object_id);
  check('金额/比率以十进制字符串传输（final_price/base_cost）',
    inqEnv && typeof inqEnv.payload.final_price === 'string' && typeof inqEnv.payload.base_cost === 'string',
    inqEnv && JSON.stringify({ f: inqEnv.payload.final_price, b: inqEnv.payload.base_cost }));
  check('数量以十进制字符串传输（items[].quantity）',
    inqEnv && typeof inqEnv.payload.items[0].quantity === 'string',
    inqEnv && typeof inqEnv.payload.items[0].quantity);

  // Result/Exception 既有基线合规口径（AC-S1 后半段）
  const badResult = { contract_version: 'AEOS.Result.V1', result_id: 'R1', source_system: 'M05', object_type: 'Order', object_id: 'HJ2001#', period: { start: '2026-10-01T00:00:00+08:00', end: '2026-09-01T00:00:00+08:00' }, status: 'VERIFIED', evidence_ids: [], trace_id: 'T1', occurred_at: '2026-10-16T10:00:00+08:00' };
  const vBad = C.validateAny(badResult);
  check('Result 必填缺失/period 逆序/evidence 空 → 422 且带字段级错误',
    vBad.ok === false && vBad.status === 422 && vBad.errors.some(e => e.field === 'metric') && vBad.errors.some(e => e.field === 'period.end') && vBad.errors.some(e => e.field === 'evidence_ids'),
    JSON.stringify(vBad.errors));

  // ---------------------------------------------------------------- AC-S2
  section('T2', 'AC-S2', '入站契约与鉴权（POST /api/aeos/ingest）');
  const savedToken = process.env.EBMS_INGEST_TOKEN;
  delete process.env.EBMS_INGEST_TOKEN;
  const r503 = await core.handleIngest({ headers: {}, body: '{}' });
  check('未配置凭据 → 503，不放行（fail-closed）', r503.status === 503, r503.status);
  process.env.EBMS_INGEST_TOKEN = savedToken;

  const before = db.getTable('customers').all().length;
  const r401a = await core.handleIngest({ headers: {}, body: JSON.stringify(ev('Customer', 'X', 'UPSERT', customerPayload('X'))) });
  const r401b = await core.handleIngest({ headers: { authorization: 'Bearer wrong-token' }, body: JSON.stringify(ev('Customer', 'X', 'UPSERT', customerPayload('X'))) });
  check('无凭据 → 401', r401a.status === 401, r401a.status);
  check('错误凭据 → 401', r401b.status === 401, r401b.status);
  check('401 时无任何数据落库', db.getTable('customers').all().length === before, db.getTable('customers').all().length + ' vs ' + before);

  const badEv = ev('Customer', '自检客户B', 'UPSERT', customerPayload('自检客户B', { customer_level: 'S级（越界值）' }));
  const r422 = await inbound(badEv);
  check('取值越界 → 422', r422.status === 422, r422.status);
  check('422 响应体含字段级错误（field + message）',
    r422.body.errors && r422.body.errors.length > 0 && typeof r422.body.errors[0].field === 'string' && typeof r422.body.errors[0].message === 'string',
    JSON.stringify(r422.body.errors));
  check('422 响应字段指向 payload.customer_level', r422.body.errors.some(e => e.field === 'payload.customer_level'), JSON.stringify(r422.body.errors.map(e => e.field)));

  const hdrMismatch = await core.handleIngest({
    headers: { authorization: 'Bearer ' + process.env.EBMS_INGEST_TOKEN, 'x-event-type': 'order.upserted' },
    body: JSON.stringify(ev('Customer', '自检客户B', 'UPSERT', customerPayload('自检客户B')))
  });
  check('头/体不一致 → 422（防「头说 A 体说 B」）', hdrMismatch.status === 422, hdrMismatch.status);

  const okCust = await inbound(ev('Customer', '自检客户B', 'UPSERT', customerPayload('自检客户B', { customer_code: 'KH0002' })));
  check('合法凭据 + 合法报文 → 200 applied', okCust.status === 200 && okCust.body.result === 'applied', JSON.stringify(okCust.body).substring(0, 160));
  const custB = businessRow('customers', r => r.name === '自检客户B');
  check('入站数据已落 EBMS 本地表', !!custB && custB.customer_code === 'KH0002', custB && custB.customer_code);
  // meta 字段（Owner=CRM）：created_at 镜像源值（对象诞生事实），updated_at 取本地落库时刻。
  // 二者都不参与 §6 冲突比对（见 aeos-ingest.js applyFields 的 meta 分支）。
  check('created_at 镜像源创建时间、updated_at 取本地落库时刻（meta 字段不被冲突逻辑改写）',
    !!custB && custB.created_at === '2026-10-16 10:00:00' && custB.updated_at !== '2026-10-16 10:00:00',
    custB && custB.created_at + ' / ' + custB.updated_at);

  const rUnknown = await core.handleIngest({ headers: { authorization: 'Bearer ' + process.env.EBMS_INGEST_TOKEN }, body: JSON.stringify({ contract_version: 'AEOS.Nope.V9' }) });
  check('未知契约版本 → 400（无法判定契约）', rUnknown.status === 400, rUnknown.status);

  // ---------------------------------------------------------------- AC-S3
  section('T3', 'AC-S3', '幂等（同契约投递 2 次不新增业务记录；同 ID 改值视为新投递）');
  // 与 T2 的入站不同的内容（否则与 T2 同指纹同幂等键，首次即为重放）
  const e1 = ev('Customer', '自检客户B', 'UPSERT', customerPayload('自检客户B', { customer_code: 'KH0002', remarks: 'T3 首次投递' }));
  const first = await inbound(e1);
  const second = await inbound(e1);
  check('首次 → 200 applied', first.status === 200 && first.body.result === 'applied', JSON.stringify(first.body).substring(0, 160));
  check('重放 → 200 skipped（不新增业务记录）', second.status === 200 && second.body.result === 'skipped', JSON.stringify(second.body).substring(0, 160));
  check('重放未产生第二条客户', db.getTable('customers').all().filter(r => r.name === '自检客户B').length === 1);
  check('入站日志留痕 skipped/DUPLICATE', store.all('inbound').some(r => r.status === 'skipped' && r.resolution === 'DUPLICATE'));

  const changed = ev('Customer', '自检客户B', 'UPSERT', customerPayload('自检客户B', { customer_code: 'KH0999' }));
  const third = await inbound(changed);
  check('同 object_id 但内容变化 → 视为新投递（fingerprint 不同）',
    third.body.result === 'applied' && third.body.resolution !== 'DUPLICATE' && C.fingerprint(e1) !== C.fingerprint(changed),
    JSON.stringify(third.body).substring(0, 160));
  check('新投递已更新本地值', (businessRow('customers', r => r.name === '自检客户B') || {}).customer_code === 'KH0999');

  const dupEnq = await hooks.fireUpsert('Customer', db.getTable('customers').findById(1));
  check('出站侧同内容重复入队被指纹幂等吸收（queued=false / duplicate）',
    dupEnq.queued === false && dupEnq.reason === 'duplicate', JSON.stringify(dupEnq));

  // ---------------------------------------------------------------- AC-S4
  section('T4', 'AC-S4', '重试与死信（退避 min(2^n×30,3600) / max_retry=5 / SUCCESS 无需重试）');
  check('退避序列 30/60/120/240/480/960', eq([0, 1, 2, 3, 4, 5].map(n => outbox.backoffSeconds(n)), [30, 60, 120, 240, 480, 960]), JSON.stringify([0, 1, 2, 3, 4, 5].map(n => outbox.backoffSeconds(n))));
  check('退避上限 3600', outbox.backoffSeconds(10) === 3600);
  check('4xx 契约类错误判为确定性（不重试）', outbox.classifyHttpStatus(422) === 'deterministic' && outbox.classifyHttpStatus(400) === 'deterministic' && outbox.classifyHttpStatus(401) === 'deterministic');
  check('408/429/5xx 判为可重试', outbox.classifyHttpStatus(408) === 'retryable' && outbox.classifyHttpStatus(429) === 'retryable' && outbox.classifyHttpStatus(503) === 'retryable');

  await store.setConfig({ enabled: true, mode: 'http', url: crmUrl, batchSize: 50 });
  const st = store.transportStatus();
  check('投递就绪（url + 凭据齐备）', st.ready === true, JSON.stringify(st));

  // 确定性错误 → 直接死信
  received.length = 0;
  crmMode = '422';
  const d1 = await outbox.flush({ force: true });
  const deadRow = outboxRows().find(r => r.status === 'dead_letter');
  check('HTTP 422 → 立即 DEAD_LETTER（不做无意义重试）', d1.deadLetter >= 1 && !!deadRow, JSON.stringify(d1));
  check('死信行记录 last_error 与 attempts=1', deadRow && /HTTP 422/.test(deadRow.last_error) && Number(deadRow.attempts) === 1, deadRow && deadRow.last_error);

  // 可重试错误 → 退避等待
  crmMode = '503';
  await hooks.fireDelete('Customer', { name: '重试客户', customer_code: '' });
  const retryRowId = outboxRows().find(r => r.object_id === '重试客户').id;
  const f1 = await outbox.flush({ force: true });
  let rr = outboxRows().find(r => r.id === retryRowId);
  check('HTTP 503 → status=failed, attempts=1', f1.failed >= 1 && rr.status === 'failed' && Number(rr.attempts) === 1, rr.status + '/' + rr.attempts);
  check('置 next_retry_at（约 +30s 退避）', !!rr.next_retry_at, rr.next_retry_at);
  const f2 = await outbox.flush();
  rr = outboxRows().find(r => r.id === retryRowId);
  check('未到退避时刻的 flush 不重复投递', Number(rr.attempts) === 1, rr.attempts);

  // 连续失败到 max_retry → 死信
  for (let i = 0; i < 4; i++) await outbox.flush({ force: true });
  rr = outboxRows().find(r => r.id === retryRowId);
  check('达到 max_retry=5 → DEAD_LETTER', rr.status === 'dead_letter' && Number(rr.attempts) === 5, rr.status + '/' + rr.attempts);
  const fDead = await outbox.flush({ force: true });
  check('死信后不再自动重试', Number(outboxRows().find(r => r.id === retryRowId).attempts) === 5 && !fDead.errors.some(e => e.id === retryRowId));

  // 成功 + SUCCESS 重试请求
  crmMode = 'ok';
  received.length = 0;
  await hooks.fireUpsert('Customer', db.getTable('customers').findById(1));
  const fOk = await outbox.flush({ force: true });
  const okRow = outboxRows().find(r => r.object_id === '自检客户A' && r.status === 'success');
  check('HTTP 200 → SUCCESS 且记录 sent_at', fOk.sent >= 1 && !!okRow && !!okRow.sent_at, JSON.stringify(fOk).substring(0, 160));
  check('投递请求头齐备（Bearer / X-Idempotency-Key / X-Contract-Version / X-Event-Type）', (() => {
    const h = received[0] && received[0].headers;
    return !!h && h.authorization === 'Bearer ' + process.env.EBMS_INBOUND_TOKEN && !!h['x-idempotency-key'] && h['x-contract-version'] === 'AEOS.Event.V1' && h['x-event-type'] === 'customer.upserted';
  })(), received[0] && JSON.stringify({ a: received[0].headers.authorization, e: received[0].headers['x-event-type'] }));
  check('投递到契约冻结端点路径 /api/v1/integrations/ebms/ingest', received[0] && received[0].url === '/api/v1/integrations/ebms/ingest', received[0] && received[0].url);
  const rNoRetry = await outbox.retryOne(okRow.id);
  check('SUCCESS 记录重试 → 「无需重试」且不重复投递', rNoRetry.ok === false && rNoRetry.noRetryNeeded === true && /无需重试/.test(rNoRetry.message), JSON.stringify(rNoRetry));

  // ---------------------------------------------------------------- AC-S5
  section('T5', 'AC-S5', '对账（按 event_type 的 produced/delivered/pending/failed + 全局 dead_letter + 两侧判据）');
  const rec = outbox.reconcile();
  const et = rec.outbound.by_event_type.find(x => x.event_type === 'customer.upserted');
  check('按 event_type 输出 produced/delivered/pending/failed', !!et && ['produced', 'delivered', 'pending', 'failed'].every(k => typeof et[k] === 'number'), JSON.stringify(et));
  check('全局 dead_letter 计数存在', typeof rec.dead_letter === 'number' && rec.dead_letter >= 1, rec.dead_letter);
  check('入站侧另加 ingested/skipped/conflict 计数', ['ingested', 'skipped', 'conflict'].every(k => typeof rec.inbound[k] === 'number'), JSON.stringify(rec.inbound));
  check('Result/Exception 通道消费计数存在', !!rec.result_exception && typeof rec.result_exception.results === 'number', JSON.stringify(rec.result_exception));
  const recRemote = outbox.reconcile({ remote: { pending: 0, failed: 0 } });
  check('consistent 判据 = 两侧 pending=0 且 failed=0', recRemote.local_consistent === true ? recRemote.consistent === true : recRemote.consistent === false, JSON.stringify({ local: recRemote.local_consistent, remote: recRemote.remote, consistent: recRemote.consistent }));
  const recPending = outbox.reconcile({ remote: { pending: 1, failed: 0 } });
  check('对侧存在 1 条 pending → consistent=false', recPending.consistent === false, JSON.stringify(recPending.sides));

  // ---------------------------------------------------------------- AC-S6
  section('T6', 'AC-S6', '主键对应与双向定位（业务键 ↔ object_id ↔ 本地行）');
  const stB = store.findState('Customer', '自检客户B');
  check('sidecar 记录 (object_type, object_id) → local_table/local_id', !!stB && stB.local_table === 'customers' && !!stB.local_id, stB && JSON.stringify(stB));
  const located = db.getTable(stB.local_table).findById(stB.local_id);
  check('由 local_id 反查得到同一业务对象', !!located && located.name === '自检客户B', located && located.name);
  check('由本地行反算 object_id 与 sidecar 一致', C.objectIdOf('Customer', located) === stB.object_id, C.objectIdOf('Customer', located));
  check('sync_status = SYNCED / last_sync_at 已记录', stB.sync_status === 'SYNCED' && !!stB.last_sync_at, stB.sync_status + '/' + stB.last_sync_at);
  check('复合键编码 QuoteLibrary = "{model}#{level}"', C.encodeObjectId('QuoteLibrary', ['HJ-M1', 'CE']) === 'HJ-M1#CE' && eq(C.decodeObjectId('QuoteLibrary', 'HJ-M1#CE'), { external_model: 'HJ-M1', certificate_level: 'CE' }));
  check('复合键编码 Order = "{order_no}#{line_no}"', C.encodeObjectId('Order', ['HJ2001', '2']) === 'HJ2001#2' && eq(C.decodeObjectId('Order', 'HJ2001#2'), { order_no: 'HJ2001', line_no: '2' }));
  check('保留字符 # 发送侧转义为 ~', C.encodeObjectId('Order', ['A#B', '1']) === 'A~B#1' && C.decodeObjectId('Order', 'A~B#1').order_no === 'A~B');

  const inqRes = await inbound(ev('Inquiry', 'JFX20261016002', 'UPSERT', inquiryPayload('JFX20261016002')));
  const lines = db.getTable('inquiries').all().filter(r => String(r.serial_number).startsWith('JFX20261016002')).sort((a, b) => String(a.serial_number).localeCompare(String(b.serial_number)));
  check('询价多行落地：首行用原号、后续行加 -NN 后缀',
    inqRes.body.result === 'applied' && lines.length === 2 && lines[0].serial_number === 'JFX20261016002' && lines[1].serial_number === 'JFX20261016002-02',
    lines.map(l => l.serial_number).join(','));
  check('子行带 parent_serial 指向基号', lines[1] && lines[1].parent_serial === 'JFX20261016002', lines[1] && lines[1].parent_serial);
  check('一物一 ID：基号在 sidecar 中至多 1 行', store.all('state').filter(s => s.object_type === 'Inquiry' && s.object_id === 'JFX20261016002').length === 1);

  // ---------------------------------------------------------------- AC-S7
  section('T7', 'AC-S7', '冲突规则（字段归属 / 人工锁 / 同窗口双改 / 乱序 / DELETE 保护）');
  // (1) 字段归属：成本块 Owner=EBMS，入站不覆盖，留痕 OWNER_KEPT
  // 真实场景：EBMS 侧已有自算成本（入站新建的镜像行不含 EBMS 归属字段，等本地计算，见 applyFields）
  const preBase = db.getTable('inquiries').all().find(r => r.serial_number === 'JFX20261016002');
  await db.getTable('inquiries').update(preBase.id, { final_price: 57, base_cost: 47.5 });
  check('入站新建镜像行不落 Owner=EBMS 字段（等本地计算）', lines[1].final_price === undefined && lines[1].quantity !== undefined, String(lines[1].final_price) + '/' + String(lines[1].quantity));
  const costEv = ev('Inquiry', 'JFX20261016002', 'UPSERT', inquiryPayload('JFX20261016002', { final_price: '999.00', base_cost: '888.00', customer_source: 'CRM改' }), ts());
  const costRes = await inbound(costEv);
  const baseRow = db.getTable('inquiries').all().find(r => r.serial_number === 'JFX20261016002');
  check('Owner=EBMS 的成本块不被入站覆盖', Number(baseRow.final_price) === 57, baseRow.final_price);
  check('成本块差异留痕 resolution=OWNER_KEPT', conflictsOf('Inquiry', 'JFX20261016002').some(c => c.resolution === 'OWNER_KEPT' && c.field === 'final_price'), JSON.stringify(conflictsOf('Inquiry', 'JFX20261016002').map(c => c.field + '/' + c.resolution)));
  check('Owner=CRM 字段正常应用（customer_source）', baseRow.customer_source === 'CRM改', baseRow.customer_source);
  check('冲突留痕含两端值（可查 incoming/local）', conflictsOf('Inquiry', 'JFX20261016002').some(c => c.incoming_value === '999' || c.incoming_value === '999.00'), JSON.stringify(conflictsOf('Inquiry', 'JFX20261016002').slice(0, 2).map(c => c.incoming_value + '|' + c.local_value)));
  check('冲突记录附带 event_id / idempotency_key / occurred_at', conflictsOf('Inquiry', 'JFX20261016002').every(c => !!c.event_id && !!c.idempotency_key && !!c.occurred_at));
  check('含冲突的入站在日志中标 conflict', store.all('inbound').some(r => r.status === 'conflict' && r.object_id === 'JFX20261016002'));

  // (2) 人工锁优先：订单状态锁生效时跳过 status
  await db.getTable('orders').insert({ id: 1, order_no: 'HJ2001', line_no: '', status: 'confirmed', risk_level: 'blue', user_status_locked: 1, customer_name: '自检客户A', created_at: '2026-10-16 10:00:00', updated_at: '2026-10-16 10:00:00' });
  const lockEv = ev('Order', 'HJ2001#', 'UPSERT', orderPayload('HJ2001', '', { status: 'cancelled', risk_level: 'yellow', user_status_locked: true }));
  await inbound(lockEv);
  const orderRow = db.getTable('orders').all().find(r => r.order_no === 'HJ2001');
  check('人工锁生效时入站跳过 status（不覆盖）', orderRow.status === 'confirmed', orderRow.status);
  check('跳过 status 留痕 resolution=LOCKED', conflictsOf('Order', 'HJ2001#').some(c => c.resolution === 'LOCKED' && c.field === 'status'), JSON.stringify(conflictsOf('Order', 'HJ2001#').map(c => c.field + '/' + c.resolution)));
  check('非锁字段照常应用（risk_level）', orderRow.risk_level === 'yellow', orderRow.risk_level);

  // (3) 同窗口双改：Owner 侧（CRM）胜出 + 本地旧值留痕 STALE
  const cWin = db.getTable('customers').findById(1);
  await store.markStatePending('Customer', '自检客户A');
  const priceEv = ev('Customer', '自检客户A', 'UPSERT', customerPayload('自检客户A', { phone: '13900000000' }), ts());
  await inbound(priceEv);
  check('同窗口双改：Owner 侧（CRM）值胜出', db.getTable('customers').findById(1).phone === '13900000000', db.getTable('customers').findById(1).phone);
  check('同窗口双改：本地旧值留痕 resolution=STALE',
    conflictsOf('Customer', '自检客户A').some(c => c.resolution === 'STALE' && c.local_value === '13800000000' && c.incoming_value === '13900000000'),
    JSON.stringify(conflictsOf('Customer', '自检客户A').filter(c => c.resolution === 'STALE').map(c => c.local_value + '→' + c.incoming_value)));
  check('入站后 sync_status 回到 SYNCED（未同步变更已被 Owner 侧收敛）', store.findState('Customer', '自检客户A').sync_status === 'SYNCED', store.findState('Customer', '自检客户A').sync_status);
  void cWin;

  // (4) 乱序/过期：occurred_at < last_sync_at → skipped STALE，不落库
  const staleEv = ev('Customer', '自检客户A', 'UPSERT', customerPayload('自检客户A', { phone: '13700000000' }), '2026-10-15 09:00:00');
  const staleRes = await inbound(staleEv);
  check('乱序/过期事件 → 200 skipped resolution=STALE', staleRes.status === 200 && staleRes.body.result === 'skipped' && staleRes.body.resolution === 'STALE', JSON.stringify(staleRes.body));
  check('过期事件未覆盖新值', db.getTable('customers').findById(1).phone === '13900000000', db.getTable('customers').findById(1).phone);

  // (5) DELETE 保护：本地有未同步变更 → 跳过删除
  await store.markStatePending('Customer', '自检客户B');
  const delRes = await inbound(ev('Customer', '自检客户B', 'DELETE', { name: '自检客户B' }, ts()));
  check('目标存在本地未同步变更 → 跳过删除', delRes.body.resolution === 'OWNER_KEPT' && !!businessRow('customers', r => r.name === '自检客户B'), JSON.stringify(delRes.body).substring(0, 200));
  check('跳过删除留痕 resolution=OWNER_KEPT', conflictsOf('Customer', '自检客户B').some(c => c.resolution === 'OWNER_KEPT' && /跳过删除/.test(c.remark || '')), JSON.stringify(conflictsOf('Customer', '自检客户B').map(c => c.resolution)));

  // 清掉未同步变更后再删 → 正常删除
  await store.markStateSynced('Customer', '自检客户B');
  const delRes2 = await inbound(ev('Customer', '自检客户B', 'DELETE', { name: '自检客户B' }, ts()));
  check('无未同步变更 → 正常删除镜像行', delRes2.body.resolution === 'DELETED' && !businessRow('customers', r => r.name === '自检客户B'), JSON.stringify(delRes2.body).substring(0, 160));
  check('删除后 sidecar 同步态清理', !store.findState('Customer', '自检客户B'));

  // 反馈内嵌跟进：全量替换
  await inbound(ev('Feedback', 'FB20261016001', 'UPSERT', feedbackPayload('FB20261016001'), ts()));
  const fu1 = db.getTable('feedback_followups').all().filter(r => Number(r.feedback_id) === Number((businessRow('feedback', r => r.feedback_no === 'FB20261016001') || {}).id));
  check('反馈内嵌 followups[] 全量落地', fu1.length === 2, fu1.length);
  await inbound(ev('Feedback', 'FB20261016001', 'UPSERT', feedbackPayload('FB20261016001', { followups: [{ action: 'close', content: '关闭', status_from: 'open', status_to: 'closed', assignee: '', operator: '王五', operator_id: 3, created_at: '2026-10-16 17:00:00' }] }), ts()));
  const fu2 = db.getTable('feedback_followups').all().filter(r => Number(r.feedback_id) === Number((businessRow('feedback', r => r.feedback_no === 'FB20261016001') || {}).id));
  check('回复内嵌组为全量快照（旧跟进被替换）', fu2.length === 1 && fu2[0].action === 'close', JSON.stringify(fu2.map(f => f.action)));

  // ---------------------------------------------------------------- AC-S8
  section('T8', 'AC-S8', '同步日志（对象/业务 ID/幂等键/状态/重试次数/最后错误/起止时间 + 原始报文反查）');
  const logRow = store.all('inbound').slice().reverse().find(r => r.object_type === 'Feedback');
  check('入站日志含对象类型/业务 ID/幂等键/状态/重试次数/起止时间',
    ['object_type', 'object_id', 'idempotency_key', 'status', 'retry_count', 'started_at', 'finished_at'].every(k => logRow && logRow[k] !== undefined),
    JSON.stringify(logRow && { o: logRow.object_type, i: logRow.object_id, k: logRow.idempotency_key, s: logRow.status }));
  check('入站日志含最后错误字段（last_error）', logRow && logRow.last_error !== undefined);
  const detail = core.handleInboundDetail(logRow.id);
  check('可由日志 ID 反查原始报文（AC-S8）',
    detail.status === 200 && detail.body.payload && detail.body.payload.contract_version === 'AEOS.Event.V1' && detail.body.payload.event_id === logRow.event_id,
    detail.status + ' ' + JSON.stringify({ cv: detail.body.payload && detail.body.payload.contract_version, de: detail.body.payload && detail.body.payload.event_id, le: logRow.event_id }));
  const ob = outboxRows().find(r => r.status === 'success');
  check('出站记录含对象/ID/幂等键/状态/重试次数/最后错误', ['object_type', 'object_id', 'idempotency_key', 'status', 'attempts', 'last_error'].every(k => ob[k] !== undefined));
  check('出站记录含起止时间（first_attempt_at / finished_at）', !!ob.first_attempt_at && !!ob.finished_at, ob.first_attempt_at + '→' + ob.finished_at);
  check('出站记录 payload 保留完整原始报文（可反查）', !!JSON.parse(ob.payload).contract_version);

  // ---------------------------------------------------------------- AC-S9
  section('T9', 'AC-S9', '存量迁移（依赖序一次性导出 + 迁移幂等 + 不改变业务值）');
  for (const r of outboxRows()) await outbox.dismiss(r.id);
  for (const s of store.all('state').slice()) await store.removeState(s.object_type, s.object_id);
  await db.getTable('quote_library').insert({ id: 1, external_model: 'HJ-M1', certificate_level: 'CE', price_rmb: 57, internal_model: 'IN-1', created_at: '2026-10-16 10:00:00', updated_at: '2026-10-16 10:00:00' });
  await db.getTable('samples').insert({ id: 1, sample_no: 'SMP0001', customer_name: '自检客户A', inquiry_no: 'JFX20261016001', quantity: 2, status: 'pending', created_at: '2026-10-16 10:00:00', updated_at: '2026-10-16 10:00:00' });
  // 把客户源行的 updated_at 钉到一个与「导出时刻」明显不同的历史时刻，
  // 用于无歧义地区分 occurred_at 取的是「源行时间」还是「导出时刻」。
  const custSrcId = db.getTable('customers').all().find(r => r.name === '自检客户A').id;
  await db.getTable('customers').update(custSrcId, { updated_at: '2026-10-16 08:30:00' });
  const exp1 = await outbox.exportAll();
  check('导出按依赖序（customers → inquiries → quote_library → orders → samples → feedback）',
    eq(Object.keys(exp1.objects), ['Customer', 'Inquiry', 'QuoteLibrary', 'Order', 'Sample', 'Feedback']),
    Object.keys(exp1.objects).join('→'));
  const srcCount = (t) => db.getTable(t).all().length;
  check('逐对象「EBMS 源条数 = 导出条数」±0',
    exp1.objects.Customer.source_count === srcCount('customers') && exp1.objects.Order.source_count === srcCount('orders') &&
    exp1.objects.Sample.source_count === srcCount('samples') && exp1.objects.Feedback.source_count === srcCount('feedback') &&
    exp1.objects.QuoteLibrary.source_count === srcCount('quote_library'),
    JSON.stringify(Object.keys(exp1.objects).map(k => k + ':' + exp1.objects[k].source_count + '/' + srcCount(C.OBJECT_SPECS[k].table))));
  check('询价按基号聚合（source_count 按对象数计，不为行数）',
    exp1.objects.Inquiry.source_count === new Set(db.getTable('inquiries').all().map(r => String(r.serial_number).replace(/-\d{2,}$/, ''))).size,
    exp1.objects.Inquiry.source_count);
  check('导出写批次日志（aeos_export_log）', store.all('exportLog').length >= 1 && !!store.all('exportLog').slice(-1)[0].batch_id);
  const exp2 = await outbox.exportAll();
  check('迁移幂等：重复执行不产生重复数据（全部按幂等键跳过）', exp2.queued === 0 && exp2.skipped > 0, JSON.stringify({ queued: exp2.queued, skipped: exp2.skipped }));
  const custEvRow = outboxRows().find(r => r.object_type === 'Customer' && r.object_id === '自检客户A');
  const custEvPayload = custEvRow ? JSON.parse(custEvRow.payload).payload : null;
  check('迁移不改变业务值（抽查客户字段逐项一致）',
    custEvPayload && custEvPayload.name === '自检客户A' && custEvPayload.customer_code === 'KH0001' && custEvPayload.phone === '13900000000',
    JSON.stringify(custEvPayload && { n: custEvPayload.name, c: custEvPayload.customer_code, p: custEvPayload.phone }));
  // 迁移事件的 occurred_at 必须是「源行的 updated_at」，不能是导出时刻（否则对侧 LWW/乱序判定失真）。
  check('迁移事件 occurred_at = 源 updated_at（LWW 排序依据）',
    custEvRow && custEvRow.occurred_at === C.toRfc3339('2026-10-16 08:30:00') && custEvRow.occurred_at !== C.toRfc3339(exp1.started_at),
    custEvRow && custEvRow.occurred_at + ' / 导出时刻 ' + C.toRfc3339(exp1.started_at));
  check('导出事件 object_id = 契约 §2 编码', exp1.objects.QuoteLibrary.source_count === 1 && !!outboxRows().find(r => r.object_id === 'HJ-M1#CE'));

  // ---------------------------------------------------------------- AC-S10
  section('T10', 'AC-S10', '红线（不直写对方库；断开对方系统时本方业务无异常、数据不丢）');
  for (const r of outboxRows().filter(x => x.status === 'pending')) await outbox.dismiss(r.id);
  const savedTok = process.env.EBMS_INBOUND_TOKEN;
  delete process.env.EBMS_INBOUND_TOKEN;
  await hooks.fireUpsert('Customer', db.getTable('customers').findById(1));
  const pendRow = outboxRows().find(r => r.object_id === '自检客户A');
  const unconf = await outbox.flush({ force: true });
  let pr2 = outboxRows().find(r => r.id === pendRow.id);
  check('对方未配置/不可达 → 事件保留在本地队列（数据不丢）', !!pr2 && pr2.status === 'pending', pr2 && pr2.status);
  check('未就绪时不消耗重试次数（attempts 仍为 0）', Number(pr2.attempts) === 0, pr2.attempts);
  check('flush 明确返回 configured=false 与原因', unconf.configured === false && !!unconf.reason, JSON.stringify(unconf).substring(0, 200));
  process.env.EBMS_INBOUND_TOKEN = savedTok;

  const before101 = db.getTable('customers').all().length;
  const boom = await hooks.guard('selftest', () => { throw new Error('模拟同步故障'); });
  check('同步故障被吞掉（guard 不抛出，业务不中断）', boom && boom.queued === false, JSON.stringify(boom));
  const bogus = await hooks.fireUpsert('NotAnObjectType', { id: 1, name: 'x' });
  check('未知对象类型不抛出、不入队', bogus && bogus.queued === false, JSON.stringify(bogus));
  check('同步失败未改动业务表', db.getTable('customers').all().length === before101);
  check('投递只经 HTTP 契约端点（无直连 CRM 库）：全部请求均打到 /api/v1/integrations/ebms/ingest',
    received.every(r => r.url === '/api/v1/integrations/ebms/ingest' && r.method === 'POST'),
    received.map(r => r.method + ' ' + r.url).join(','));
  const evTypes = C.ENUMS.event_type;
  check('事件类型取值域恰为冻结的 13 个', evTypes.length === 13 && evTypes.includes('dictionary.upserted') && evTypes.includes('feedback.deleted'), evTypes.length);

  // ---------------------------------------------------------------- AC-S1（路由层）
  section('T11', 'AC-S1', '路由层出站点（真实 Express 路由处理器：必须在「写落定 → 读行 → 出站」顺序上）');
  const inquiryRouter = require('./routes/inquiry');
  const routeHandler = (router, method, routePath) => {
    for (const layer of router.stack) {
      if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
        const st = layer.route.stack;
        return st[st.length - 1].handle;   // 末位为业务处理器；鉴权中间件不在本用例范围内
      }
    }
    return null;
  };
  const invokeRoute = (handler, opts) => new Promise((resolve) => {
    const o = opts || {};
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload) { resolve({ status: this.statusCode, body: payload }); return this; }
    };
    handler({ body: o.body || {}, params: o.params || {}, query: o.query || {}, headers: o.headers || {} }, res);
  });

  for (const r of outboxRows()) await outbox.dismiss(r.id);
  const hBatchCreate = routeHandler(inquiryRouter, 'post', '/batch-create');
  const rc = await invokeRoute(hBatchCreate, {
    body: { customer_name: '路由自检客户', sales_person: 'rte', products: [{ external_model: 'RT-BATCH-01', quantity: 2 }] }
  });
  // 路由对出站钩子是「发了不等」（同步故障不得影响业务），入队落在后续微任务；断言前先让队列落定
  await settle();
  const rtSerial = rc.body && rc.body.serial_number;
  check('路由 POST /batch-create 返回体含有效自增 ID（写已落定 → result.lastID 可用）',
    rc.status === 200 && rc.body.created === 1 && Array.isArray(rc.body.ids) && Number.isInteger(rc.body.ids[0]) && rc.body.ids[0] > 0,
    rc.status + ' ' + JSON.stringify(rc.body && { created: rc.body.created, ids: rc.body.ids }));
  const rtRow = outboxRows().find(r => r.object_type === 'Inquiry' && r.object_id === rtSerial);
  check('路由创建后出站事件已入队且 object_id = 返回的业务键（写落定后才出站）',
    !!rtRow && rtRow.operation === 'UPSERT' && JSON.parse(rtRow.payload).payload.serial_number === rtSerial,
    rtRow ? rtRow.operation + ' ' + rtRow.object_id : '（未入队）');

  const hStatus = routeHandler(inquiryRouter, 'put', '/:id/status');
  const rs = await invokeRoute(hStatus, { params: { id: String(rc.body.ids[0]) }, body: { status: 'quoted', changed_by: 'rte' } });
  await settle();
  const rtRow2 = outboxRows().find(r => r.object_type === 'Inquiry' && r.object_id === rtSerial);
  const rtPayload2 = rtRow2 ? JSON.parse(rtRow2.payload).payload : null;
  check('路由更新后出站报文取到的是「新值」而非改前值',
    rs.status === 200 && rtPayload2 && rtPayload2.status === 'quoted' && rtPayload2.status !== 'pending_pricing',
    rtPayload2 && rtPayload2.status);

  const hDelete = routeHandler(inquiryRouter, 'delete', '/:id');
  const rd = await invokeRoute(hDelete, { params: { id: String(rc.body.ids[0]) } });
  await settle();
  const rtRow3 = outboxRows().find(r => r.object_type === 'Inquiry' && r.object_id === rtSerial);
  check('路由删除后收敛为 DELETE 事件（该基号下已无并五行）',
    rd.status === 200 && !!rtRow3 && rtRow3.operation === 'DELETE' && String(rtRow3.event_type).endsWith('deleted'),
    rtRow3 ? rtRow3.operation + ' ' + rtRow3.event_type : '（未入队）');

  // ---------------------------------------------------------------- 收尾
  crm.close();
  const failed = results.filter(r => !r.pass);
  const byAc = {};
  results.forEach(r => { byAc[r.ac] = byAc[r.ac] || { total: 0, fail: 0 }; byAc[r.ac].total++; if (!r.pass) byAc[r.ac].fail++; });

  console.log('\n================ 自检汇总 ================');
  console.log('引擎: ' + db.engine + '   用例: ' + results.length + '   通过: ' + (results.length - failed.length) + '   失败: ' + failed.length);
  Object.keys(byAc).forEach(ac => console.log('  ' + ac + '  ' + (byAc[ac].total - byAc[ac].fail) + '/' + byAc[ac].total));
  if (failed.length) {
    console.log('\n失败明细：');
    failed.forEach(f => console.log('  [' + f.ac + '] ' + f.name + ' → ' + f.detail));
  }

  const md = [];
  md.push('# AEOS 同步通道自检报告（EBMS 侧 · PAND-250）');
  md.push('');
  md.push('- 运行命令：`cd backend && node --experimental-sqlite test-aeos-sync.js`');
  md.push('- 引擎：`' + db.engine + '`（与生产快照一致；SQLite 双引擎）');
  md.push('- 隔离库：`backend/.aeos-selftest-data`（EBMS_DATA_DIR，不触碰生产 database/sales.db）');
  md.push('- 用例：' + results.length + ' · 通过 ' + (results.length - failed.length) + ' · 失败 ' + failed.length);
  md.push('');
  md.push('| AC | 用例 | 结果 | 说明 |');
  md.push('|---|---|---|---|');
  const reportPath = path.join(__dirname, '.aeos-selftest-report.md');
  fs.writeFileSync(reportPath, md.join('\n'), 'utf8');
  console.log('\n报告已写入: ' + reportPath);
  process.exit(failed.length ? 1 : 0);
})().catch(e => {
  console.error('\n自检脚本异常终止:', e && e.stack || e);
  try { crm.close(); } catch (_) {}
  process.exit(2);
});
