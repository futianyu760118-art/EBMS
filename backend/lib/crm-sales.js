/**
 * M05 CRM 销售看板取数适配器（EBMS → M05 external API）。
 *
 * 接口（契约见 IMA「AEOS云服务」笔记 / M05 external）：
 *   GET /api/v1/external/indicators      销售经营指标（period=YYYY-MM）
 *   GET /api/v1/external/orders/list     订单列表（分页，支持 promised_date 推算下期预测）
 * 鉴权：X-App-Key + X-Timestamp + X-Signature = HMAC-SHA256(AppSecret, "{timestamp}.GET.{path}")，path 不含查询串。
 */
const crypto = require('crypto');

const HOST = () => (process.env.CRM_EXTERNAL_HOST || 'http://150.158.13.110:3001').replace(/\/$/, '');
const AK = () => process.env.CRM_EXTERNAL_APP_KEY || 'ak_7967c9a2211e0119';
const SECRET = () => process.env.CRM_EXTERNAL_APP_SECRET || '1912eab02b06638af769558227033836';

function configured() { return !!AK() && !!SECRET(); }

async function crmGet(pathOnly, query) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', SECRET()).update(ts + '.GET.' + pathOnly).digest('hex');
  const url = HOST() + pathOnly + (query ? ('?' + query) : '');
  const res = await fetch(url, { headers: { 'X-App-Key': AK(), 'X-Timestamp': ts, 'X-Signature': sig }, timeout: 20000 });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok || !json || json.code !== 0) {
    throw new Error('M05 请求失败 ' + res.status + ': ' + text.slice(0, 160));
  }
  return json.data;
}

function periodOffset(base, n) {
  let [y, m] = String(base).split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return y + '-' + String(m).padStart(2, '0');
}

// 分页拉全部订单（可选 promised_date 区间过滤）
async function listOrders(opts) {
  const o = opts || {};
  const pageSize = 200;
  let page = 1, all = [];
  for (;;) {
    const q = 'page=' + page + '&page_size=' + pageSize + (o.start ? '&updated_after=' + encodeURIComponent(o.start) : '');
    const data = await crmGet('/api/v1/external/orders/list', q);
    const items = (data && data.items) || [];
    all = all.concat(items);
    const pages = (data && data.pages) || 1;
    if (page >= pages || items.length === 0) break;
    page++;
    if (page > 200) break;
  }
  return all;
}

// 某周期的实际接单额（按订单的 order_date/promised_date 归入周期）
function sumAmount(orders, pick) {
  return Math.round(orders.reduce((s, x) => s + (Number(x.order_amount) || 0), 0) * 100) / 100;
}

/**
 * 销售看板：上期实际 vs 本期实际、下期预测（订单管线）。
 * 返回：
 *   current / previous / next 三个周期
 *   current_actual / previous_actual：本期/上期实际接单（orders/list 按 promised_date 落在对应月）
 *   next_forecast：下期预测（promised_date 落在下期、未完成订单金额）
 *   indicators：M05 /indicators 原始指标（period 当前）
 */
async function getSalesBoard(currentPeriod) {
  const cur = currentPeriod;
  const prev = periodOffset(cur, -1);
  const next = periodOffset(cur, 1);
  let orders = [];
  let ordersErr = null;
  try { orders = await listOrders({}); } catch (e) { ordersErr = e.message; }

  const byMonth = (ym, field) => orders.filter(o => {
    const d = String(o[field] || '').slice(0, 7);
    return d === ym;
  });
  const isOpen = (o) => !(o.status === 'closed' || o.status === 'cancelled' || o.status === 'shipped');

  let indicators = null, indErr = null;
  try { indicators = await crmGet('/api/v1/external/indicators', 'period=' + encodeURIComponent(cur)); } catch (e) { indErr = e.message; }

  // 实际接单按 order_date 归月；下期预测按 promised_date（交期）归月的未完成订单（订单管线）
  const prevOrders = byMonth(prev, 'order_date');
  const curOrders = byMonth(cur, 'order_date');
  const nextPipe = byMonth(next, 'promised_date').filter(isOpen);
  const prevPipe = byMonth(prev, 'promised_date').filter(isOpen);

  return {
    source: 'M05_CRM',
    base: HOST(),
    period: { previous: prev, current: cur, next },
    previous_actual: { count: prevOrders.length, amount: sumAmount(prevOrders) },
    current_actual: {
      count: (indicators && indicators.orders_count !== undefined) ? indicators.orders_count : curOrders.length,
      amount: (indicators && indicators.orders_amount !== undefined) ? indicators.orders_amount : sumAmount(curOrders)
    },
    next_forecast: { count: nextPipe.length, amount: sumAmount(nextPipe) },
    // 环比：本期实际 vs 上期实际
    mom_rate: sumAmount(prevOrders) > 0 ? Math.round((sumAmount(curOrders) - sumAmount(prevOrders)) / sumAmount(prevOrders) * 1000) / 10 : null,
    indicators: indicators || null,
    errors: { orders: ordersErr, indicators: indErr }
  };
}

module.exports = { configured, crmGet, listOrders, getSalesBoard, periodOffset };
