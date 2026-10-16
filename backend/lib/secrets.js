/**
 * 集中读取外部对接密钥。
 * 密钥一律通过环境变量注入，代码中不再硬编码任何密钥。
 *
 * 环境变量：
 *   EBMS_APP_KEY          —— 外部数据供给/ERP 接口的 App Key（随请求头 X-App-Key 发送，非机密）
 *   EBMS_APP_SECRET       —— 外部数据供给/ERP 接口的 HMAC-SHA256 签名密钥（机密，已轮换）
 *   EBMS_EXTERNAL_API_KEY —— 本系统对外接口 /api/external 的入站 API Key（X-API-Key，机密）
 *
 * AEOS 销售数据同步通道（可选，未启用时以下变量可不配）：
 *   EBMS_INGEST_TOKEN     —— 本系统 AEOS 入站端点 /api/aeos/ingest 的 Bearer 凭据（机密）
 *   EBMS_INBOUND_TOKEN   —— CRM 入站端点 /api/v1/integrations/ebms/ingest 要求的 Bearer 凭据（机密）
 *                            两处同名同值：CRM 侧校验的就是这个值，EBMS 侧出站携带它（契约 §5.1/§5.2）
 *   EBMS_CRM_INGEST_URL   —— CRM 入站端点地址（非机密）
 *   EBMS_AEOS_SPOOL_DIR   —— 落盘（spool）模式的目录（非机密）
 */
const APP_KEY = process.env.EBMS_APP_KEY || '';
const APP_SECRET = process.env.EBMS_APP_SECRET || '';
const EXTERNAL_API_KEY = process.env.EBMS_EXTERNAL_API_KEY || '';

// AEOS 通道凭据按「调用时刻」读取环境变量：便于轮换/热注入，且不落任何常量快照。
function aeosIngestToken() { return process.env.EBMS_INGEST_TOKEN || ''; }
function aeosOutboundToken() { return process.env.EBMS_INBOUND_TOKEN || ''; }
function aeosCrmIngestUrl() { return process.env.EBMS_CRM_INGEST_URL || ''; }
function aeosSpoolDir() { return process.env.EBMS_AEOS_SPOOL_DIR || ''; }

/** AEOS 通道缺失项清单（供 /api/aeos/status 与运维自检展示，不参与启动告警）。 */
function missingAeos(mode) {
  const need = [];
  const m = mode || 'http';
  if (m === 'http') {
    if (!aeosCrmIngestUrl()) need.push('EBMS_CRM_INGEST_URL');
    if (!aeosOutboundToken()) need.push('EBMS_INBOUND_TOKEN');
  }
  if (m === 'spool' && !aeosSpoolDir()) need.push('EBMS_AEOS_SPOOL_DIR');
  if (!aeosIngestToken()) need.push('EBMS_INGEST_TOKEN');
  return need;
}

// 启动时告警：缺失的密钥会导致相关外部对接能力不可用（请求侧会拒绝执行）。
// 该函数由 server.js 在启动阶段调用一次。
function warnMissing() {
  const missing = [];
  if (!APP_KEY) missing.push('EBMS_APP_KEY');
  if (!APP_SECRET) missing.push('EBMS_APP_SECRET');
  if (!EXTERNAL_API_KEY) missing.push('EBMS_EXTERNAL_API_KEY');

  if (!missing.length) {
    console.log('[secrets] 外部对接密钥已全部通过环境变量注入 ✓');
    return;
  }
  const line = '='.repeat(72);
  console.warn(line);
  console.warn('[secrets] ⚠️ 以下环境变量未设置，相关外部对接能力将不可用（对应请求会被拒绝）：');
  missing.forEach(name => console.warn('   - ' + name));
  console.warn('   设置方法（bash）:   export ' + missing[0] + '=<值>');
  console.warn('   设置方法（CMD）:    set ' + missing[0] + '=<值>');
  console.warn('   或参照 backend/.env.example 在部署环境中注入。');
  console.warn(line);
}

module.exports = {
  APP_KEY, APP_SECRET, EXTERNAL_API_KEY, warnMissing,
  aeosIngestToken, aeosOutboundToken, aeosCrmIngestUrl, aeosSpoolDir, missingAeos
};
