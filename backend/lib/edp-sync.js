/**
 * EDP 数据服务同步（参考 M05 CRM 的 EDP 对接：data-api 取数 → 本地落库幂等覆盖）。
 *
 * 落库表：
 *   edp_dataset_row —— { dataset_code, row_pk, payload(JSON), dataset_version, synced_at }
 *   edp_sync_run     —— { dataset_code, status, pages, rows_read, rows_stored, error, created_at }
 *
 * 依赖：EDP_READ_KEY（data:read，绑定消费方）+ EDP_BASE_URL。
 */
const { getTable, now } = require('../db');
const edp = require('./data-provider/edp-provider');

function rowTable() { return getTable('edp_dataset_row'); }
function runTable() { return getTable('edp_sync_run'); }

// 从 _catalog / schema 取数据集主键字段名（分页游标字段）
async function datasetPk(code) {
  const cat = await edp.catalog();
  const item = (cat || []).find((d) => d.dataset_code === code);
  if (item && item.pk) return item.pk;
  return 'object_id';
}

// 分页拉取全部行（keyset：末行主键 + truncated）
async function fetchAll(code, params, opts) {
  const o = opts || {};
  const pk = o.pk || (await datasetPk(code));
  const rows = [];
  let cursor = null;
  let pages = 0;
  const maxPages = o.maxPages || 200;
  while (true) {
    const res = await edp.queryDataset(code, params, { limit: o.limit || 500, cursor });
    const batch = res.rows || [];
    rows.push(...batch);
    if (!res.truncated || batch.length === 0) break;
    cursor = String(batch[batch.length - 1][pk]);
    pages++;
    if (pages >= maxPages) break;
  }
  return { rows, pk, pages: pages + 1 };
}

async function upsertRow(datasetCode, rowPk, payload, version) {
  const t = rowTable();
  const existing = t.all().find((r) => String(r.dataset_code) === String(datasetCode) && String(r.row_pk) === String(rowPk));
  const ts = now();
  if (existing) {
    await t.update(existing.id, { payload: JSON.stringify(payload), dataset_version: version, synced_at: ts });
  } else {
    await t.insert({ dataset_code: datasetCode, row_pk: String(rowPk), payload: JSON.stringify(payload), dataset_version: version, synced_at: ts });
  }
}

async function syncDataset(code, opts) {
  const o = opts || {};
  const started = now();
  let status = 'success';
  let pages = 0, rowsRead = 0, rowsStored = 0, error = '';
  try {
    const { rows, pages: p } = await fetchAll(code, o.params, o);
    pages = p;
    rowsRead = rows.length;
    const pk = o.pk || (await datasetPk(code));
    for (const row of rows) {
      const rowPk = row[pk] !== undefined ? row[pk] : row.object_id;
      if (rowPk === undefined || rowPk === null) continue;
      await upsertRow(code, rowPk, row, row.dataset_version || o.version || null);
      rowsStored++;
    }
  } catch (e) {
    status = 'failed';
    error = e.message || String(e);
  }
  const inserted = await runTable().insert({
    dataset_code: code, status, pages, rows_read: rowsRead, rows_stored: rowsStored,
    error, created_at: started, finished_at: now()
  });
  return { code, status, pages, rows_read: rowsRead, rows_stored: rowsStored, error, sync_run_id: inserted.lastID };
}

module.exports = {
  rowTable,
  runTable,
  datasetPk,
  fetchAll,
  syncDataset
};
