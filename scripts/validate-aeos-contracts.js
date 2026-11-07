/**
 * AEOS Phase 1 契约包校验（node 版，等价 AEOS scripts/validate_contracts.py）。
 *
 * 校验 contracts/aeos-v1/ 下 8 套 schema 与 manifest.json 的 SHA-256 指纹，
 * 确保 EBMS 消费的是未经篡改的 AEOS 生成契约包（禁止手改生成副本）。
 *
 * 运行：node scripts/validate-aeos-contracts.js
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_DIR = path.join(__dirname, '..', 'contracts', 'aeos-v1');

// 每个 schema 必须包含的关键 required 字段（与 AEOS validate_contracts.py 一致）
const EXPECTED_SCHEMAS = {
  'audit-event-v1.schema.json': ['tenant_id', 'event_id', 'event_type', 'source_system', 'object_id', 'revision', 'trace_id', 'idempotency_key'],
  'business-event-v1.schema.json': ['tenant_id', 'event_id', 'event_type', 'source_system', 'object_id', 'revision', 'trace_id', 'idempotency_key'],
  'finance-result-v1.schema.json': ['tenant_id', 'result_id', 'source_system', 'object_id', 'revision', 'status', 'evidence_refs'],
  'lead-intake-v1.schema.json': ['contract_version', 'intake_id', 'source_system', 'submitted_at', 'contact', 'consent', 'idempotency_key'],
  'person-lifecycle-event-v1.schema.json': ['tenant_id', 'event_id', 'event_type', 'event_version', 'source_system', 'object_type', 'object_id', 'revision', 'occurred_at', 'effective_at', 'correlation_id', 'trace_id', 'idempotency_key', 'person', 'status'],
  'person-lifecycle-result-v1.schema.json': ['event_id', 'target_system', 'status', 'changed', 'received_at'],
  'principal-context-v1.schema.json': ['tenant_id', 'source_system', 'person_id', 'trace_id', 'idempotency_key'],
  'system-manifest-v1.schema.json': ['system_code', 'module_id', 'display_name', 'base_url', 'health_url', 'version']
};

const SCHEMA_VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEY_RE = /^(password|secret|api[_-]?key)$/i;

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error('无法解析 ' + file + ': ' + e.message);
  }
}

// SHA-256 使用 LF 规范化字节，避免 Windows CRLF checkout 导致指纹漂移
function lfNormalize(buf) {
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function sha256Lf(file) {
  return crypto.createHash('sha256').update(lfNormalize(fs.readFileSync(file))).digest('hex');
}

function containsForbiddenKey(value) {
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return value.some(containsForbiddenKey);
    return Object.keys(value).some(k => FORBIDDEN_KEY_RE.test(k) || containsForbiddenKey(value[k]));
  }
  return false;
}

function main() {
  const errors = [];
  const files = fs.readdirSync(CONTRACT_DIR).filter(f => f.endsWith('.schema.json')).sort();
  const expectedNames = Object.keys(EXPECTED_SCHEMAS).sort();

  const missing = expectedNames.filter(n => !files.includes(n));
  const extra = files.filter(n => !expectedNames.includes(n));
  if (missing.length) errors.push('缺少 schema: ' + missing.join(', '));
  if (extra.length) errors.push('多余 schema: ' + extra.join(', '));

  const schemas = {};
  const ids = new Set();
  const versions = new Set();
  for (const name of files) {
    const schema = loadJson(path.join(CONTRACT_DIR, name));
    schemas[name] = schema;

    const required = schema.required;
    if (!Array.isArray(required)) errors.push(name + ' required 必须是数组');
    else {
      const miss = (EXPECTED_SCHEMAS[name] || []).filter(f => !required.includes(f));
      if (miss.length) errors.push(name + ' 缺少 required 字段: ' + miss.join(', '));
    }
    if (!schema.$id || !String(schema.$id).trim()) errors.push(name + ' 必须声明稳定 $id');
    else if (ids.has(schema.$id)) errors.push(name + ' $id 重复: ' + schema.$id);
    else ids.add(schema.$id);

    if (!SCHEMA_VERSION_RE.test(schema.schema_version || '')) errors.push(name + ' 必须声明 schema_version MAJOR.MINOR.PATCH');
    else if (versions.has(schema.schema_version)) errors.push(name + ' schema_version 重复: ' + schema.schema_version);
    else versions.add(schema.schema_version);

    if (!schema.title || !String(schema.title).trim()) errors.push(name + ' 缺少 title');
    if (schema.type !== 'object') errors.push(name + ' type 必须为 object');
    if (schema.additionalProperties !== false) errors.push(name + ' envelope 必须 additionalProperties=false');
    if (containsForbiddenKey(schema)) errors.push(name + ' 包含凭据字段');
  }

  const manifest = loadJson(path.join(CONTRACT_DIR, 'manifest.json'));
  const entries = manifest.schemas;
  if (!Array.isArray(entries)) return fail('manifest.json schemas 必须是数组');
  if (!manifest.compatibility_policy) errors.push('manifest 缺少 compatibility_policy');
  if (!manifest.generator) errors.push('manifest 缺少 generator');

  const registered = new Set();
  for (const entry of entries) {
    const name = entry.name;
    if (registered.has(name)) errors.push('manifest schema 重复: ' + name);
    registered.add(name);
    if (!EXPECTED_SCHEMAS[name]) { errors.push('manifest 引用未知 schema: ' + name); continue; }
    if (entry.version !== schemas[name].schema_version) errors.push(name + ' 版本不匹配');
    if (!SHA256_RE.test(entry.sha256 || '')) errors.push(name + ' 指纹非法');
    else {
      const actual = sha256Lf(path.join(CONTRACT_DIR, name));
      if (entry.sha256 !== actual) errors.push(name + ' 指纹不匹配（期望 ' + entry.sha256 + '，实际 ' + actual + '）');
    }
  }
  if (registered.size !== expectedNames.length) errors.push('manifest 未恰好注册 Phase 1 的 ' + expectedNames.length + ' 个 schema');

  if (errors.length) {
    console.error('契约包校验失败：');
    errors.forEach(e => console.error('  ERROR: ' + e));
    process.exit(1);
  }
  console.log('AEOS contract validation passed (' + expectedNames.length + ' schemas)');
}

function fail(msg) {
  console.error('契约包校验失败：' + msg);
  process.exit(1);
}

main();
