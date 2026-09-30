// F5（PAND-83）四层面包屑与断点提示：SSR 渲染断言。
// 用 Vite 的 SSR 模块加载器编译真实 SFC，再渲染成 HTML 断言，
// 避免「只测模型不测展示」——AC 要求的东西必须真的出现在页面上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

import { createNav, drill, buildBreadcrumb, SEGMENT_COUNT } from '../src/trace-nav.js';

let vite;
let TraceBreadcrumb;
let BreakpointNotice;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  TraceBreadcrumb = (await vite.ssrLoadModule('/src/components/TraceBreadcrumb.vue')).default;
  BreakpointNotice = (await vite.ssrLoadModule('/src/components/BreakpointNotice.vue')).default;
});

test.after(async () => {
  await vite?.close();
});

const M1 = '11111111-1111-4111-8111-111111111111';
const R1 = '22222222-2222-4222-8222-222222222222';

const SEGMENTS = [
  { key: 'result', index: 1, label: '结果', contractRef: 'Result', contractVersion: 'AEOS.Result.V1', kind: 'object', status: 'OK', breakpoint: null },
  { key: 'reason', index: 2, label: '原因（归因）', contractRef: 'Exception', contractVersion: 'AEOS.Exception.V1', kind: 'object', status: 'OK', breakpoint: null },
  { key: 'evidence', index: 3, label: '证据', contractRef: 'Evidence', contractVersion: 'AEOS.Evidence.V1', kind: 'object', status: 'OK', breakpoint: null },
  { key: 'source', index: 4, label: '来源信息', contractRef: 'Evidence.source_system', contractVersion: null, kind: 'field', status: 'OK', breakpoint: null },
];

function renderBreadcrumb(nav, segments = SEGMENTS) {
  return renderToString(createSSRApp(TraceBreadcrumb, { items: buildBreadcrumb(nav, segments) }));
}

function renderBreakpoint(layer) {
  return renderToString(createSSRApp(BreakpointNotice, { layer }));
}

function countTestId(html, testid) {
  return (html.match(new RegExp(`data-testid="${testid}"`, 'g')) || []).length;
}

/** 面包屑段数：按 data-nav 计（每个段恰好一个；断点标记不带 data-nav）。 */
function segmentCount(html) {
  return (html.match(/data-nav="/g) || []).length;
}

test('场景 3：面包屑渲染出固定四段，且第 2 段标注为「原因（归因）」', async () => {
  const html = await renderBreadcrumb(createNav(M1));

  assert.equal(countTestId(html, 'trace-breadcrumb'), 1);
  assert.equal(segmentCount(html), SEGMENT_COUNT, '面包屑段数必须与导航段数一致（固定四段）');
  assert.equal(countTestId(html, 'crumb-result'), 1);
  assert.equal(countTestId(html, 'crumb-source'), 1);
  assert.ok(html.includes('原因（归因）'), '第 2 段必须标注为「原因（归因）」');
  assert.ok(html.includes('来源信息'));
});

test('场景 3：数据缺段时面包屑仍渲染四段（不增减段数）', async () => {
  const html = await renderBreadcrumb(createNav(M1), [{ key: 'result', index: 1, label: '结果', contractRef: 'Result', status: 'OK', breakpoint: null }]);

  assert.equal(segmentCount(html), 4);
  assert.ok(html.includes('原因（归因）'), '缺段也不得少渲染第 2 段');
  assert.ok(html.includes('来源信息'));
});

test('导航态：当前位置标注为 active，仅紧邻下一段标注为 reachable，更深的段不可达', async () => {
  const html = await renderBreadcrumb(createNav(M1));

  assert.equal((html.match(/data-nav="active"/g) || []).length, 1);
  assert.equal((html.match(/data-nav="reachable"/g) || []).length, 1);
  assert.equal((html.match(/data-nav="ahead"/g) || []).length, 2);
  // 结果段为当前段，下一段（原因）为唯一可进入段
  const resultSeg = html.slice(html.indexOf('data-testid="crumb-result"')).split('</span>')[0];
  const reasonSeg = html.slice(html.indexOf('data-testid="crumb-reason"')).split('</span>')[0];
  assert.ok(resultSeg.includes('data-nav="active"'));
  assert.ok(reasonSeg.includes('data-nav="reachable"'));

  const drilled = await renderBreadcrumb(drill(createNav(M1), R1));
  assert.equal((drilled.match(/data-nav="visited"/g) || []).length, 1, '已过的段标注为 visited');
  assert.equal((drilled.match(/data-nav="active"/g) || []).length, 1);
});

test('判定标准：段↔契约映射在面包屑上可见（结果/归因/证据/来源字段）', async () => {
  const html = await renderBreadcrumb(createNav(M1));

  assert.ok(html.includes('data-contract="Result"'));
  assert.ok(html.includes('data-contract="Exception"'));
  assert.ok(html.includes('data-contract="Evidence"'));
  assert.ok(html.includes('data-contract="Evidence.source_system"'));
  assert.ok(html.includes('对应契约：Evidence.source_system'), '契约对应关系可见');
});

test('边界：断点段在面包屑上标出「断点」，且不减少段数', async () => {
  const broken = SEGMENTS.map((s) =>
    s.key === 'evidence' ? { ...s, status: 'MISSING', breakpoint: { code: 'NO_EVIDENCE', label: '无证据支撑' } } : s
  );
  const html = await renderBreadcrumb(createNav(M1), broken);

  assert.equal(segmentCount(html), 4, '断点不改变段数');
  assert.equal((html.match(/data-status="MISSING"/g) || []).length, 1);
  assert.equal(countTestId(html, 'crumb-breakpoint'), 1);
  assert.ok(html.includes('断点'));
  // 断点标记本身不得被当成第 5 段：只有 4 个段容器
  assert.equal(countTestId(html, 'crumb-evidence'), 1);
  assert.equal(countTestId(html, 'crumb-source'), 1);
});

test('边界：断点提示渲染出断点说明与补录入口（含落点模块），不阻断其余段', async () => {
  const html = await renderBreakpoint({
    key: 'reason',
    index: 2,
    label: '原因（归因）',
    status: 'MISSING',
    breakpoint: {
      code: 'NO_ATTRIBUTION',
      layer: 'reason',
      label: '未归因',
      message: '该结果指标尚未关联任何原因项，原因段为断点。',
      refill: { action: 'ATTR', label: '登记原因项', targetLayer: 'reason' },
    },
  });

  assert.equal(countTestId(html, 'breakpoint'), 1);
  assert.ok(html.includes('未归因'), '断点类型应可见');
  assert.ok(html.includes('该结果指标尚未关联任何原因项'), '断点说明应可见');
  assert.ok(html.includes('不影响其余段查看'), '须写明不阻断其余段');
  assert.equal(countTestId(html, 'breakpoint-refill'), 1, '必须有补录入口');
  assert.ok(html.includes('登记原因项'), '补录入口按钮文案应可见');
  assert.ok(html.includes('F2 原因项登记'), '补录落点模块应可见');
  assert.ok(html.includes('data-refill-action="ATTR"'));
});

test('边界：来源段断点的补录入口落在来源标注，不提供「查原始表」入口', async () => {
  const html = await renderBreakpoint({
    key: 'source',
    index: 4,
    label: '来源信息',
    status: 'MISSING',
    breakpoint: {
      code: 'SOURCE_UNMARKED',
      layer: 'source',
      label: '来源未标注',
      message: '该证据未标注来源系统（source_system），来源段为断点。',
      refill: { action: 'SOURCE', label: '补录来源', targetLayer: 'source' },
    },
  });

  assert.ok(html.includes('来源未标注'));
  assert.ok(html.includes('补录来源'));
  assert.ok(html.includes('F4 来源标注'));
  assert.equal(/原始表|raw_table|rawTable/i.test(html), false, '不得出现原始表回落入口');
});

test('边界：段状态正常时不渲染任何断点提示', async () => {
  const html = await renderBreakpoint({ key: 'result', index: 1, label: '结果', status: 'OK', breakpoint: null });
  assert.equal(countTestId(html, 'breakpoint'), 0, '正常段不应渲染断点提示');
  assert.equal(countTestId(html, 'breakpoint-refill'), 0, '正常段不应渲染补录入口');
});
