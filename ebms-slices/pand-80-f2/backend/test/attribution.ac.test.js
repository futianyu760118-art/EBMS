/**
 * PAND-80 F2 结果偏差归因穿透 —— 逐条覆盖 AC（前置 / 口径 / 场景 / 边界 / 判定标准）。
 *
 * 领域规则用纯函数直测；服务层用内存库直测；接口层用真实 HTTP 打同一套应用。
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { createChainRepository } from '../src/repositories/chainRepository.js';
import { createAttributionRepository } from '../src/repositories/attributionRepository.js';
import { createAttributionService } from '../src/services/attributionService.js';
import {
  ALLOWED_DIRECTIONS,
  CONTRIBUTION_TOLERANCE_PCT,
  classifyReasonInput,
  summarizeAttribution,
  unsupportedDirections,
} from '../src/domain/attribution.js';

const NOW = '2026-09-30T12:00:00+08:00';

function buildService() {
  const db = openDatabase({ file: ':memory:' });
  return {
    db,
    chainRepository: createChainRepository(db),
    service: createAttributionService({
      chainRepository: createChainRepository(db),
      attributionRepository: createAttributionRepository(db),
    }),
  };
}

const { db, service } = buildService();

let server;
let baseUrl;

before(async () => {
  const app = createApp({ db, config: { corsOrigin: '*', port: 0 } });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const get = async (path) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
};

const post = async (path, payload, headers = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
};

// ---------------------------------------------------------------------------
// 前置条件
// ---------------------------------------------------------------------------
describe('前置条件：结果指标存在偏差，且已关联至少 1 条原因项', () => {
  test('指标存在偏差上下文（实际值来自 Owner Result，目标值来自 M03）', () => {
    const payload = service.reasonsForMetric('revenue');
    assert.equal(payload.state, 'OK');
    assert.equal(payload.deviation.target, 1000);
    assert.equal(payload.deviation.actual, 880);
    assert.equal(payload.deviation.deviation, -120);
    assert.equal(payload.deviation.deviationPct, -12);
    assert.equal(payload.deviation.hasDeviation, true);
  });

  test('原因项按本轮口径归位（Exception 型 / M03 自有归因分析型）', () => {
    const payload = service.reasonsForMetric('M-REV');
    assert.ok(payload.count >= 1, '原因项至少 1 条');
    const kinds = new Set(payload.reasonList.map((item) => item.kind));
    assert.ok(kinds.has('exception'), '应含映射至 Exception 的原因项');
    assert.ok(kinds.has('m03_analysis'), '应含 M03 自有归因分析的原因项');
  });
});

// ---------------------------------------------------------------------------
// 归因口径（本轮返工新增 · 统一口径）
// ---------------------------------------------------------------------------
describe('归因口径：Exception 承载 + 影响方向/贡献占比归 M03 归因元数据', () => {
  test('原因项以 Exception 契约承载，含 reason_code 与 severity', () => {
    const payload = service.reasonsForMetric('M-REV');
    const backed = payload.reasonList.filter((item) => item.kind === 'exception');
    assert.ok(backed.length >= 1);
    for (const item of backed) {
      assert.ok(item.reasonCode, '映射至 Exception 的原因项必须有 reason_code');
      assert.ok(item.severity, '映射至 Exception 的原因项必须有 severity');
      assert.equal(item.name, item.reasonCode, '原因名称取 reason_code');
    }
  });

  test('未映射 Exception 的原因显式标记为 M03 自有归因分析', () => {
    const payload = service.reasonsForMetric('M-REV');
    const own = payload.reasonList.filter((item) => item.kind === 'm03_analysis');
    assert.ok(own.length >= 1);
    for (const item of own) {
      assert.equal(item.kindLabel, 'M03 自有归因分析');
      assert.equal(item.reasonCode, null, 'M03 自有归因分析不挂专业 reason_code');
      assert.equal(item.severity, null, 'M03 自有归因分析不挂专业 severity');
      assert.ok(item.name, '必须有分析名');
    }
  });

  test('影响方向与贡献占比是 M03 归因元数据，不在 EBMS 内重算专业指标', () => {
    const payload = service.reasonsForMetric('M-REV');
    for (const item of payload.reasonList) {
      assert.ok(ALLOWED_DIRECTIONS.includes(item.direction));
      assert.ok(item.impactDisplay, '每条原因须含「影响量或贡献占比」至少一项');
    }
    assert.equal(payload.consumption.contract, 'AEOS.Result.V1');
    assert.ok(payload.consumption.calculationVersion, '消费的 Result 必须带 Owner 的 calculation_version');
    assert.equal(payload.consumption.ownedByEbms, false, 'EBMS 不得是专业指标的 Owner');
  });

  test('消费边界：归因依据的专业事实来自 result_metrics，不读专业原始表', () => {
    const trace = service.professionalFactTrace(10);
    assert.equal(trace.readsProfessionalRawTables, false);
    assert.deepEqual(trace.ebmsFactTables, [], 'EBMS 内不得存在自建专业事实表');
    for (const item of trace.items) {
      assert.equal(item.sourceOwnedByEbms, false);
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 1
// ---------------------------------------------------------------------------
describe('场景 1：从指标可打开原因列表', () => {
  test('列表每条含 原因名称 / 严重度 / 影响方向 / 影响量或贡献占比 / 责任方', () => {
    const payload = service.reasonsForMetric('M-REV');
    assert.equal(payload.state, 'OK');
    for (const item of payload.reasonList) {
      assert.ok(item.name, '原因名称');
      assert.ok(item.direction && item.directionLabel, '影响方向');
      assert.ok(item.impactDisplay?.text, '影响量或贡献占比');
      assert.ok(item.owner, '责任方');
    }
    const high = payload.reasonList.find((item) => item.reasonCode === 'LOW_PRICE_ORDER');
    assert.equal(high.severity, 'high');
    assert.equal(high.severityLabel, '高');
    assert.equal(high.directionLabel, '负向');
    assert.equal(high.contributionPct, 50);
    assert.equal(high.owner, '销售中心');
  });

  test('影响方向以文字表达（不依赖颜色单独区分）', () => {
    const payload = service.reasonsForMetric('M-REV');
    const labels = new Set(payload.reasonList.map((item) => item.directionLabel));
    assert.ok([...labels].every((label) => ['正向', '负向', '中性'].includes(label)));
  });

  test('接口层可打开原因列表', async () => {
    const { status, body } = await get('/results/revenue/reasons');
    assert.equal(status, 200);
    assert.equal(body.state, 'OK');
    assert.ok(body.reasonList.length >= 1);
    assert.equal(body.chain.current, 'reason');
    assert.equal(body.chain.reasonContract, 'Exception');
  });

  test('未知指标返回 404', async () => {
    const { status, body } = await get('/results/not-a-metric/reasons');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'METRIC_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// 场景 2
// ---------------------------------------------------------------------------
describe('场景 2：偏差被完全归因时各原因贡献占比合计为 100%', () => {
  test('顶层合计 = 100%，判定为完全归因', () => {
    const payload = service.reasonsForMetric('M-REV');
    assert.equal(payload.summary.rootContributionPct, 100);
    assert.equal(payload.summary.sumsTo100WithinTolerance, true);
    assert.equal(payload.attributionStatus, 'FULLY_ATTRIBUTED');
    assert.equal(payload.statusLabel, '完全归因');
  });

  test('子项不重复计入顶层合计', () => {
    const payload = service.reasonsForMetric('M-REV');
    const allPct = payload.reasonList.reduce((sum, item) => sum + (item.contributionPct ?? 0), 0);
    assert.ok(allPct > 100, '全量合计应大于 100（含子项），证明合计口径是顶层');
    assert.equal(payload.summary.rootCount, 3);
    assert.equal(payload.summary.childCount, 2);
  });

  test('部分归因时显式标注且合计不足 100%', () => {
    const payload = service.reasonsForMetric('M-PROFIT');
    assert.equal(payload.attributionStatus, 'PARTIALLY_ATTRIBUTED');
    assert.equal(payload.summary.rootContributionPct, 45);
    assert.equal(payload.summary.sumsTo100WithinTolerance, false);
    assert.equal(payload.notices[0].code, 'PARTIALLY_ATTRIBUTED');
  });

  test('容差边界：|合计 − 100| ≤ 1 判为完全归因（含端点）', () => {
    const make = (pct) => [{ id: 'a', parentId: null, contributionPct: pct }];
    assert.equal(summarizeAttribution(make(99)).sumsTo100WithinTolerance, true);
    assert.equal(summarizeAttribution(make(101)).sumsTo100WithinTolerance, true);
    assert.equal(summarizeAttribution(make(98.9)).sumsTo100WithinTolerance, false);
    assert.equal(summarizeAttribution(make(101.1)).sumsTo100WithinTolerance, false);
    assert.equal(CONTRIBUTION_TOLERANCE_PCT, 1);
  });

  test('合计未满 100% 时不判定为完全归因', () => {
    const result = summarizeAttribution([
      { id: 'a', parentId: null, contributionPct: 60 },
      { id: 'b', parentId: null, contributionPct: 35 },
    ]);
    assert.equal(result.rootContributionPct, 95);
    assert.equal(result.status, 'PARTIALLY_ATTRIBUTED');
  });
});

// ---------------------------------------------------------------------------
// 场景 3
// ---------------------------------------------------------------------------
describe('场景 3：归因层允许多级展开，深度由归因关系决定', () => {
  test('三级展开完整返回，不因导航层级截断', () => {
    const payload = service.reasonsForMetric('M-REV');
    assert.equal(payload.maxDepthReached, 3);
    assert.equal(payload.unfolding.unbounded, true);
    const l3 = payload.reasonList.find((item) => item.attributionId === 'A-REV1-1-1');
    assert.ok(l3, '第三级原因项应被返回');
    assert.equal(l3.depth, 2);
    assert.equal(l3.name, '大客户转投竞品');
  });

  test('多级展开接口返回子项与「已细分 / 未细分」比例', () => {
    const payload = service.childrenOf('A-REV1');
    assert.equal(payload.childCount, 1);
    assert.equal(payload.children[0].attributionId, 'A-REV1-1');
    assert.equal(payload.breakdown.parentContributionPct, 50);
    assert.equal(payload.breakdown.subdivided, true);
    assert.ok(payload.breakdown.childrenWithContributionPct >= 1);
  });

  test('叶子节点展开为空且不影响其余层级', () => {
    const payload = service.childrenOf('A-REV1-1-1');
    assert.equal(payload.childCount, 0);
    assert.equal(payload.breakdown.subdivided, false);
  });

  test('max_depth 仅在显式收窄时生效（默认不受导航层级限制）', () => {
    const narrowed = service.reasonsForMetric('M-REV', { maxDepth: 2 });
    assert.equal(narrowed.unfolding.unbounded, false);
    assert.equal(narrowed.unfolding.truncated, true);
    assert.equal(narrowed.reasonList.find((i) => i.attributionId === 'A-REV1-1-1'), undefined);
    assert.equal(narrowed.reasonList.find((i) => i.attributionId === 'A-REV1-1').children.length, 0);
    assert.equal(narrowed.reasonList.find((i) => i.attributionId === 'A-REV1-1').truncated, true);
  });

  test('接口层可继续展开', async () => {
    const { status, body } = await get('/reasons/A-REV1/children');
    assert.equal(status, 200);
    assert.equal(body.childCount, 1);
    assert.equal(body.unfolding.policy, 'by-relation');
  });

  test('未知原因项返回 404', async () => {
    const { status, body } = await get('/reasons/A-NOT-EXIST/children');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'ATTRIBUTION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// 场景 4
// ---------------------------------------------------------------------------
describe('场景 4：每条原因项可查看类型判定结果', () => {
  test('映射至 Exception 的判定带 reason_code 与 severity', () => {
    const verdict = service.typeVerdict('A-REV1');
    assert.equal(verdict.verdict, 'MAPPED_TO_EXCEPTION');
    assert.equal(verdict.verdictLabel, '映射至 Exception');
    assert.equal(verdict.reasonCode, 'LOW_PRICE_ORDER');
    assert.equal(verdict.severity, 'high');
    assert.equal(verdict.belongsToProfessionalDimension, true);
    assert.equal(verdict.professionalFactSource, 'M05');
  });

  test('M03 自有归因分析的判定显式标注不属于任何专业维度', () => {
    const verdict = service.typeVerdict('A-REV2');
    assert.equal(verdict.verdict, 'M03_OWN_ANALYSIS');
    assert.equal(verdict.verdictLabel, 'M03 自有归因分析');
    assert.equal(verdict.belongsToProfessionalDimension, false);
    assert.ok(verdict.notBelongingNote.includes('不属于任何专业维度'));
    assert.ok(verdict.basis);
  });

  test('每一条原因项都可判定归属，无未归类项', () => {
    const compliance = service.reasonsForMetric('M-REV');
    for (const item of compliance.reasonList) {
      const verdict = service.typeVerdict(item.attributionId);
      assert.ok(['MAPPED_TO_EXCEPTION', 'M03_OWN_ANALYSIS'].includes(verdict.verdict));
    }
    const all = service.professionalFactTrace(999).items;
    assert.ok(all.length >= 1);
  });

  test('接口层可查看类型判定', async () => {
    const { status, body } = await get('/reasons/A-REV2/type-verdict');
    assert.equal(status, 200);
    assert.equal(body.verdict, 'M03_OWN_ANALYSIS');
  });
});

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------
describe('边界：指标无关联原因时显示「未归因」并提供关联入口', () => {
  test('未归因指标返回未归因状态而非空列表', () => {
    const payload = service.reasonsForMetric('M-BACKLOG');
    assert.equal(payload.state, 'UNATTRIBUTED');
    assert.equal(payload.statusLabel, '未归因');
    assert.equal(payload.empty.code, 'UNATTRIBUTED');
    assert.equal(payload.empty.title, '未归因');
    assert.deepEqual(payload.reasons, []);
  });

  test('提供可操作的关联入口（不是死链）', () => {
    const payload = service.reasonsForMetric('M-BACKLOG');
    assert.equal(payload.linkEntry.method, 'POST');
    assert.equal(payload.linkEntry.path, '/api/v1/results/M-BACKLOG/reasons');
    assert.ok(payload.linkEntry.accepts.includes('exceptionRef'));
  });

  test('未归因查询不回落到专业原始表', () => {
    const payload = service.reasonsForMetric('M-BACKLOG');
    assert.equal(payload.fallbackPolicy, 'none');
    assert.equal(payload.consumption.ownedByEbms, false);
  });

  test('接口层返回未归因状态', async () => {
    const { status, body } = await get('/results/M-BACKLOG/reasons');
    assert.equal(status, 200);
    assert.equal(body.state, 'UNATTRIBUTED');
    assert.ok(body.linkEntry.path);
  });
});

describe('边界：原因项缺少 reason_code 或 severity 时按 M03 自有归因分析处理并标注', () => {
  test('缺少 reason_code 的输入被判为 M03 自有归因分析并标注原因', () => {
    const result = classifyReasonInput(
      { name: '人工判断：产线临时停机', direction: 'negative' },
      { findException: () => null },
    );
    assert.equal(result.kind, 'm03_analysis');
    assert.equal(result.exceptionId, null);
    assert.equal(result.analysisName, '人工判断：产线临时停机');
    assert.equal(result.fallback.code, 'NO_EXCEPTION_REF');
    assert.ok(result.fallback.message.includes('M03 自有归因分析'));
  });

  test('引用的 Exception 缺少 severity 时降级为 M03 自有归因分析', () => {
    const noSeverity = classifyReasonInput(
      { name: 'X', exceptionRef: 'EXC-X', direction: 'negative' },
      { findException: () => ({ id: 'X1', reasonCode: 'SOME_CODE', severity: null }) },
    );
    assert.equal(noSeverity.kind, 'm03_analysis');
    assert.equal(noSeverity.fallback.code, 'MISSING_SEVERITY');

    const noReasonCode = classifyReasonInput(
      { name: 'X', exceptionRef: 'EXC-X', direction: 'negative' },
      { findException: () => ({ id: 'X1', reasonCode: null, severity: 'high' }) },
    );
    assert.equal(noReasonCode.kind, 'm03_analysis');
    assert.equal(noReasonCode.fallback.code, 'MISSING_REASON_CODE');
  });

  test('引用不到已消费 Exception 时降级并标注', () => {
    const result = classifyReasonInput(
      { name: 'X', exceptionRef: 'EXC-NOPE', direction: 'negative' },
      { findException: () => null },
    );
    assert.equal(result.kind, 'm03_analysis');
    assert.equal(result.fallback.code, 'EXCEPTION_NOT_FOUND');
  });

  test('字段齐备的 Exception 正常映射，不带兜底标注', () => {
    const result = classifyReasonInput(
      { exceptionRef: 'EXC-SALES-001', direction: 'negative' },
      { findException: () => ({ id: 'X-SALES1', reasonCode: 'LOW_PRICE_ORDER', severity: 'high' }) },
    );
    assert.equal(result.kind, 'exception');
    assert.equal(result.exceptionId, 'X-SALES1');
    assert.equal(result.fallback, null);
  });

  test('库层 CHECK 兜底：不存在无归属字段的归因项', () => {
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO attributions
               (id, metric_id, parent_id, kind, exception_id, analysis_name,
                direction, contribution_pct, owner, order_no, created_at)
             VALUES ('A-UNOWNED', 'M-REV', NULL, 'm03_analysis', NULL, NULL,
                     'negative', 10, 'M03', 99, ?)`,
          )
          .run(NOW),
      /CHECK|constraint/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 判定标准
// ---------------------------------------------------------------------------
describe('判定标准 1：列表非空（原因项 ≥ 1）', () => {
  test('有归因的指标返回非空列表', () => {
    for (const ref of ['M-REV', 'M-PROFIT', 'gross_margin']) {
      const payload = service.reasonsForMetric(ref);
      assert.ok(payload.count >= 1, `${ref} 应至少 1 条原因项`);
      assert.ok(payload.reasonList.length >= 1);
    }
  });
});

describe('判定标准 2：影响方向取值仅限 正向 / 负向 / 中性', () => {
  test('现有归因方向全部合规', () => {
    const payload = service.reasonsForMetric('M-REV');
    assert.equal(payload.integrity.directionCompliant, true);
    assert.deepEqual(payload.integrity.directionViolations, []);
    assert.deepEqual(payload.integrity.allowedDirections.map((d) => d.value), [
      'positive',
      'negative',
      'neutral',
    ]);
  });

  test('超出取值域的方向被识别', () => {
    assert.deepEqual(unsupportedDirections(['up', 'negative']), ['up']);
    assert.deepEqual(unsupportedDirections(['正向']), ['正向']);
  });

  test('库层 CHECK 拒绝非法方向', () => {
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO attributions
               (id, metric_id, parent_id, kind, exception_id, analysis_name,
                direction, contribution_pct, owner, order_no, created_at)
             VALUES ('A-BADDIR', 'M-REV', NULL, 'exception', 'X-SALES1', NULL,
                     'up', 10, 'M03', 98, ?)`,
          )
          .run(NOW),
      /CHECK|constraint/i,
    );
  });

  test('接口层拒绝非法方向并回传取值域', async () => {
    const { status, body } = await post('/results/M-PROFIT/reasons', {
      name: '方向非法',
      direction: 'up',
      contributionPct: 5,
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_DIRECTION');
    assert.deepEqual(body.error.detail.allowedDirections, ['positive', 'negative', 'neutral']);
  });
});

describe('判定标准 3：完全归因时贡献占比合计 = 100%（误差 ≤ 1%）', () => {
  test('完全归因指标的合计落在容差内', () => {
    for (const ref of ['M-REV', 'gross_margin', 'on_time_delivery_rate', 'inventory_turnover_days']) {
      const payload = service.reasonsForMetric(ref);
      assert.equal(payload.attributionStatus, 'FULLY_ATTRIBUTED', `${ref} 应为完全归因`);
      assert.ok(
        Math.abs(payload.summary.rootContributionPct - 100) <= CONTRIBUTION_TOLERANCE_PCT,
        `${ref} 合计 ${payload.summary.rootContributionPct} 应在容差内`,
      );
    }
  });

  test('接口层可直接读到合计与容差', async () => {
    const { body } = await get('/results/M-REV/reasons');
    assert.equal(body.summary.rootContributionPct, 100);
    assert.equal(body.summary.tolerancePct, 1);
    assert.equal(body.summary.sumsTo100WithinTolerance, true);
  });
});

describe('判定标准 4：100% 的原因项可判定归属，无未归类项', () => {
  test('全部归因项均可判为 Exception 型或 M03 自有归因分析型', () => {
    const compliance = service.professionalFactTrace(999);
    const all = service
      .professionalFactTrace(999)
      .items.map((item) => item.attributionId);
    assert.ok(all.length >= 10, `归因项总数 ${all.length} 应不少于 10`);

    let checked = 0;
    for (const attributionId of all) {
      const verdict = service.typeVerdict(attributionId);
      assert.ok(
        ['MAPPED_TO_EXCEPTION', 'M03_OWN_ANALYSIS'].includes(verdict.verdict),
        `${attributionId} 未归类`,
      );
      if (verdict.verdict === 'MAPPED_TO_EXCEPTION') {
        assert.ok(verdict.reasonCode && verdict.severity);
      } else {
        assert.equal(verdict.belongsToProfessionalDimension, false);
      }
      checked += 1;
    }
    assert.equal(checked, all.length);
    assert.ok(compliance.items.length >= 10);
  });
});

describe('判定标准 5：抽查 ≥ 10 条归因所引用的专业事实可溯源，且无 EBMS 自建事实源', () => {
  test('抽样不少于 10 条且全部可溯源到专业模块 Result', () => {
    const trace = service.professionalFactTrace(10);
    assert.ok(trace.compared >= 10, `实际抽查 ${trace.compared} 条，应不少于 10 条`);
    assert.equal(trace.meetsRequiredSample, true);
    assert.equal(trace.allTraceable, true);
    assert.deepEqual(trace.untraceable, []);
  });

  test('不存在 EBMS 自建专业事实源', () => {
    const trace = service.professionalFactTrace(10);
    assert.deepEqual(trace.ebmsOwnedFactSources, []);
    assert.deepEqual(trace.ebmsFactTables, []);
    assert.equal(trace.readsProfessionalRawTables, false);
    for (const item of trace.items) {
      assert.ok(item.resultId, '须能指回 Owner 的 Result 标识');
      assert.ok(item.calculationVersion, '须带 Owner 的口径版本');
      assert.ok(item.sourceSystem, '须标注来源模块');
    }
  });

  test('接口层可自证溯源', async () => {
    const { status, body } = await get('/attribution/professional-fact-trace?sample=10');
    assert.equal(status, 200);
    assert.equal(body.allTraceable, true);
    assert.ok(body.compared >= 10);
  });
});

// ---------------------------------------------------------------------------
// 关联入口（写路径）与只读边界
// ---------------------------------------------------------------------------
describe('关联入口：登记原因项并留痕', () => {
  test('登记 M03 自有归因分析并即时反映到状态', async () => {
    const { status, body } = await post(
      '/results/M-BACKLOG/reasons',
      { name: '手工判断：产能瓶颈', direction: 'negative', contributionPct: 100, owner: '运营部' },
      { 'x-actor-id': 'u-tester' },
    );
    assert.equal(status, 201);
    assert.equal(body.createdCount, 1);
    assert.equal(body.created[0].kind, 'm03_analysis');
    assert.equal(body.created[0].fallback.code, 'NO_EXCEPTION_REF');
    // 中文名称须经真实 HTTP 往返后无损（UTF-8）
    assert.equal(body.created[0].name, '手工判断：产能瓶颈');
    assert.equal(body.created[0].owner, '运营部');
    assert.equal(body.summary.status, 'FULLY_ATTRIBUTED');

    const after = await get('/results/M-BACKLOG/reasons');
    assert.equal(after.body.state, 'OK');
    assert.equal(after.body.count, 1);
  });

  test('留痕写入 audit_log（操作人 + 动作）', () => {
    const rows = db
      .prepare("SELECT actor, action, entity_type FROM audit_log WHERE action = 'attribution.create'")
      .all();
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].entity_type, 'attribution');
    assert.ok(rows.some((row) => row.actor === 'u-tester'));
  });

  test('重复登记同一原因项幂等，不产生第二条留痕', async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'attribution.create'").get().n;
    const { body } = await post('/results/M-BACKLOG/reasons', {
      name: '手工判断：产能瓶颈',
      direction: 'negative',
      contributionPct: 100,
      owner: '运营部',
    });
    assert.equal(body.createdCount, 0);
    assert.equal(body.reusedCount, 1);
    const after_ = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'attribution.create'").get().n;
    assert.equal(after_, before);
  });

  test('引用已消费 Exception 时按 Exception 型登记', async () => {
    const { body } = await post('/results/M-PROFIT/reasons', {
      exceptionRef: 'EXC-SALES-001',
      direction: 'negative',
      impactValue: -7,
      owner: '销售中心',
    });
    assert.equal(body.createdCount, 1);
    assert.equal(body.created[0].kind, 'exception');
    assert.equal(body.created[0].reasonCode, 'LOW_PRICE_ORDER');
    assert.equal(body.created[0].severity, 'high');
  });

  test('缺少「影响量或贡献占比」被拒绝', async () => {
    const { status, body } = await post('/results/M-PROFIT/reasons', {
      name: '无影响依据',
      direction: 'negative',
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'IMPACT_BASIS_REQUIRED');
  });

  test('父原因项不属于该指标时被拒绝', async () => {
    const { status, body } = await post('/results/M-PROFIT/reasons', {
      name: '挂错父项',
      direction: 'negative',
      impactValue: -1,
      parentId: 'A-REV1',
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'PARENT_NOT_IN_METRIC');
  });

  test('F2 读路径不写库（指纹不变）', () => {
    const fresh = buildService();
    const fingerprint = () =>
      fresh.db
        .prepare('SELECT * FROM attributions ORDER BY rowid')
        .all()
        .map((row) => JSON.stringify(row))
        .join('|');
    const before = fingerprint();
    fresh.service.reasonsForMetric('M-REV');
    fresh.service.childrenOf('A-REV1');
    fresh.service.typeVerdict('A-REV1');
    fresh.service.professionalFactTrace(10);
    fresh.service.reasonsForMetric('M-BACKLOG');
    assert.equal(fingerprint(), before);
  });
});
