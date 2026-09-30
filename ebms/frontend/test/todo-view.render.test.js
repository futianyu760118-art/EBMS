// F8（PAND-86）TODO 待办视图：SSR 渲染断言。
// 用 Vite 的 SSR 模块加载器编译真实 SFC，再渲染成 HTML 断言，避免「只测模型不测展示」。
// 断言的是 AC 要求「看得见」的东西：七列、两种来源、三类状态与动作、
// 逾期区分标记、触发依据、认领/指派/流转入口、留痕时间线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

import { buildTodoDetailModel, buildTodoModel, dueDateTimeText, dueText } from '../src/todo-view.js';
import { AUTO_ITEM, DETAIL, ITEMS, OVERVIEW } from './fixtures/todo-payload.js';

let vite;
let TodoTable;
let TodoDetailPanel;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  TodoTable = (await vite.ssrLoadModule('/src/components/TodoTable.vue')).default;
  TodoDetailPanel = (await vite.ssrLoadModule('/src/components/TodoDetailPanel.vue')).default;
});

test.after(async () => {
  await vite?.close();
});

function renderTable(payload = OVERVIEW) {
  return renderToString(createSSRApp(TodoTable, { model: buildTodoModel(payload) }));
}

function renderDetail(detail = DETAIL) {
  return renderToString(createSSRApp(TodoDetailPanel, { model: buildTodoDetailModel(detail) }));
}

/** 每条待办占一行；按行切分，避免跨行误判。 */
function rowsOf(html) {
  return html.split('<tr data-testid="todo-row"').slice(1).map((chunk) => chunk.split('</tr>')[0]);
}

function countTestId(html, testid) {
  return (html.match(new RegExp(`data-testid="${testid}"`, 'g')) || []).length;
}

/** 取某行内某个 data-testid 单元格的内容（到该 </td> 为止）。 */
function cellAfter(rowHtml, testid) {
  const idx = rowHtml.indexOf(`data-testid="${testid}"`);
  if (idx === -1) return null;
  return rowHtml.slice(idx).split('</td>')[0];
}

test('场景 1：每条待办渲染成一行，七列齐备（事项/来源/关联结果或原因/责任人/截止时间/状态/操作）', async () => {
  const html = await renderTable();
  const rows = rowsOf(html);

  assert.equal(rows.length, ITEMS.length);
  for (const testid of ['todo-title', 'todo-source', 'todo-relation', 'todo-owner', 'todo-due', 'todo-status']) {
    assert.equal(countTestId(html, testid), ITEMS.length, `每行都应渲染 ${testid}`);
  }
  assert.ok(html.includes('每条待办含：事项、来源、关联结果或原因、责任人、截止时间、状态'), '列口径应可见');
  assert.ok(html.includes('2号线排产调整以补产能缺口'), '事项标题应可见');
  assert.ok(html.includes('TODO-2026-0901'), '待办编号应可见');
  // 截止时间按本地日历渲染（具体日期由 dueText 的时区语义决定，此处核对列表确实取用它）
  const first = rows.find((r) => r.includes('TODO-2026-0901'));
  assert.ok(cellAfter(first, 'todo-due').includes(dueText(ITEMS[0].dueAt)), '截止时间应可见');
});

test('场景 1：无关联 / 未指派 / 无截止时间三类空心值都渲染显式文案，不留空白', async () => {
  const html = await renderTable();

  assert.ok(html.includes('未关联结果或原因'), '无关联时显式写明');
  assert.ok(html.includes('无截止时间'), '无截止时间时显式写明');
  assert.equal(countTestId(html, 'todo-unassigned'), 1, '未指派只有一条');
  // 未指派那条同时是可认领的（规则产生 + 未指派）
  const unassignedRow = rowsOf(html).find((r) => r.includes('todo-unassigned'));
  assert.equal(countTestId(unassignedRow, 'todo-claim'), 1, '未指派的未完成项提供认领入口');
  assert.ok(unassignedRow.includes('TODO-2026-0904'));
});

test('场景 2：两种来源在列表上可区分（规则自动产生 / 人工派发各带来源标签）', async () => {
  const html = await renderTable();

  assert.ok(html.includes('规则自动产生'), '规则来源标签应可见');
  assert.ok(html.includes('人工派发'), '人工来源标签应可见');
  assert.equal(countTestId(html, 'todo-trigger'), 2, '两条自动产生的待办各展示其规则');
  assert.ok(html.includes('R-REASON-NEGATIVE'), '规则编码应可见');
  assert.ok(html.includes('R-RESULT-DEVIATION'));
  assert.ok(html.includes('两种来源并存：规则自动产生 2 条 / 人工派发 3 条（并存成立）'));

  // 规则自动产生的待办：每一条都有规则标签，人工派发的没有
  const rows = rowsOf(html);
  for (const row of rows) {
    const auto = row.includes('规则自动产生');
    assert.equal(countTestId(row, 'todo-trigger'), auto ? 1 : 0, '规则标签只出现在自动产生的行');
  }
});

test('场景 3：三类状态齐备（含已完成行），并只渲染状态机允许的动作', async () => {
  const html = await renderTable();
  const rows = rowsOf(html);

  for (const label of ['待处理', '处理中', '已完成']) {
    assert.ok(html.includes(label), `状态「${label}」应可见`);
  }
  assert.equal(countTestId(html, 'todo-status'), ITEMS.length, '每行都有状态列');

  const pending = rows.find((r) => r.includes('TODO-2026-0902'));
  const inProgress = rows.find((r) => r.includes('TODO-2026-0901'));
  const done = rows.find((r) => r.includes('TODO-2026-0905'));

  assert.ok(pending.includes('开始处理'));
  assert.equal(pending.includes('标记完成'), false, '待处理不得直接提供「标记完成」');

  assert.ok(inProgress.includes('标记完成'));
  assert.ok(inProgress.includes('退回待处理'));

  assert.equal(countTestId(done, 'todo-transition'), 0, '已完成是终态，不提供后续流转按钮');
  assert.equal(countTestId(done, 'todo-claim'), 0, '已完成的待办不可认领');
});

test('场景 4：逾期项带区分标记并单独计数，已完成项即使过期也不打标记', async () => {
  const html = await renderTable();
  const rows = rowsOf(html);

  assert.equal(countTestId(html, 'todo-overdue'), 1, '只有一条逾期标记');
  const overdueRow = rows.find((r) => r.includes('todo-overdue'));
  assert.ok(overdueRow.includes('TODO-2026-0904'));
  assert.ok(overdueRow.includes('逾期 10 天'));

  const doneRow = rows.find((r) => r.includes('TODO-2026-0905'));
  assert.equal(countTestId(doneRow, 'todo-overdue'), 0, '已完成项不得打逾期标记');

  // 逾期汇总与「截止时间 vs 当前时间」的口径都写在界面上
  assert.ok(html.includes('有 1 条已过截止时间且未完成（逾期判定 = 截止时间早于当前时间）'));
  // 逾期计数进入统计条
  assert.ok(cellAfter(html, 'todo-stat-overdue').includes('>1<'));
});

test('场景 4：筛选生效时在界面上说明「上方计数为全部待办」', async () => {
  const filtered = buildTodoModel({
    ...OVERVIEW,
    items: [AUTO_ITEM],
    filters: { owner: null, status: 'pending', source: null, dueBefore: null, overdue: null },
  });
  const html = await renderToString(createSSRApp(TodoTable, { model: filtered }));

  assert.ok(html.includes('已按筛选条件过滤，命中 1 条；上方计数为全部待办。'));
  // 统计条仍报全部口径，不被筛选结果污染
  assert.ok(cellAfter(html, 'todo-stat-total').includes('>5<'));
});

test('边界：自动产生的待办在界面上自证「均含触发依据」，缺失时告警而非静默', async () => {
  const html = await renderTable();
  assert.ok(html.includes('规则自动产生的 2 条待办均含触发依据（规则 + 关联结果或原因）'));
  assert.equal(countTestId(html, 'todo-trigger-missing'), 0);

  const broken = await renderToString(
    createSSRApp(TodoTable, { model: buildTodoModel({ ...OVERVIEW, items: [{ ...AUTO_ITEM, triggerBasis: null }] }) })
  );
  assert.equal(countTestId(broken, 'todo-trigger-missing'), 1, '缺触发依据必须显式告警');
  assert.ok(broken.includes('自动产生的待办必须可回溯到关联结果或原因'));
  assert.ok(broken.includes('触发依据缺失'), '行内也标记出来，不只靠汇总条');
});

test('详情：七列 + 触发依据 + 留痕时间线（操作人 / 时间 / 变更）', async () => {
  const html = await renderDetail();

  assert.ok(html.includes('TODO-2026-0904'));
  assert.ok(cellAfter(html, 'detail-owner').includes('未指派'));
  // 详情写明截止时刻（逾期按时刻精确比较，避免「显示今天到期却已逾期」的矛盾观感）
  assert.ok(cellAfter(html, 'detail-due').includes(dueDateTimeText(AUTO_ITEM.dueAt)));
  assert.ok(cellAfter(html, 'detail-due').includes('逾期 10 天'));
  assert.ok(cellAfter(html, 'detail-status').includes('待处理'));

  // 触发依据：规则 + 摘要 + 锚定（边界：责任人可核对「为什么派给我」）
  assert.equal(countTestId(html, 'detail-trigger'), 1);
  assert.ok(html.includes('R-RESULT-DEVIATION · 结果指标偏差达阈值'));
  assert.ok(html.includes('超过阈值 5%'));
  assert.ok(html.includes('结果指标 order_delivery'));
  assert.ok(html.includes('month/2026-09'));

  // 留痕三条，含操作人与时间；变更文案由 before/after 还原
  assert.equal(countTestId(html, 'todo-audit-entry'), 3);
  assert.ok(html.includes('流转留痕（3）'));
  assert.ok(html.includes('责任人：未指派 → 张决策（决策者）'));
  assert.ok(html.includes('状态：待处理 → 处理中'));
  assert.ok(html.includes('李责任（管理责任人）'), '规则产生那条留痕的操作人应可见');
  assert.ok(html.includes('张决策（决策者）'));
  assert.equal(countTestId(html, 'todo-audit-at'), 3);

  // 未指派且未完成 → 认领入口；待处理 → 开始处理
  assert.equal(countTestId(html, 'detail-claim'), 1);
  assert.equal(countTestId(html, 'detail-transition'), 1);
  assert.equal(countTestId(html, 'detail-assign'), 1, '提供指派入口');
});

test('详情（已完成）：终态不提供任何流转或认领入口，并说明原因', async () => {
  const done = { ...ITEMS[4], owner: '生产中心 / 赵计划' };
  const html = await renderDetail({
    ...DETAIL,
    todo: done,
    audit: [
      { ...DETAIL.audit[0], action: 'todo.create', actionLabel: '人工派发', after: { owner: '生产中心 / 赵计划' } },
      { ...DETAIL.audit[2], before: { status: 'in_progress' }, after: { status: 'done' } },
    ],
    auditCount: 2,
  });

  assert.equal(countTestId(html, 'detail-claim'), 0);
  assert.equal(countTestId(html, 'detail-transition'), 0);
  assert.ok(html.includes('已完成（终态），无后续流转。'));
  assert.ok(html.includes('状态：处理中 → 已完成'));
  assert.equal(countTestId(html, 'detail-trigger'), 0, '人工派发不展示触发依据区块');
  assert.equal(countTestId(html, 'todo-audit-entry'), 2);
});

test('场景 3：留痕为空时给出显式占位，不留空白区域', async () => {
  const html = await renderDetail({ ...DETAIL, audit: [], auditCount: 0 });

  assert.ok(html.includes('流转留痕（0）'));
  assert.ok(html.includes('暂无操作记录。'));
  assert.equal(countTestId(html, 'todo-audit-entry'), 0);
});
