<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api/client';
import { NO_DATA_LABEL, cutoffText, periodLabel } from '../result-overview';
import {
  MAX_DRILL_OPS,
  SOURCE_FIELD_REF,
  buildBreadcrumb,
  buildChainModel,
  canDrill,
  canReturn,
  createNav,
  drill,
  drillsRemainingToSource,
  evidencesOfReason,
  segmentOf,
  sourceSegmentView,
  nextSegmentKey,
  returnToPrev,
} from '../trace-nav';
import BreakpointNotice from '../components/BreakpointNotice.vue';
import TraceBreadcrumb from '../components/TraceBreadcrumb.vue';

const props = defineProps({
  metricId: { type: String, default: '' },
});

const anchors = ref([]);
const period = ref(null);
const model = ref(null);
const nav = ref(createNav(props.metricId || null));
const loading = ref(false);
const error = ref('');
// 补录入口是「入口」，不是本模块的写入：点击后在页内提示落点，不伪造跨模块表单。
const refillHint = ref('');

const breadcrumb = computed(() => buildBreadcrumb(nav.value, model.value?.segments || []));
const currentLayer = computed(() => segmentOf(model.value, nav.value.layerKey));
const currentReason = computed(
  () => model.value?.reasons.find((r) => r.id === nav.value.positions.reason) || null
);
const reasonEvidences = computed(() =>
  currentReason.value ? evidencesOfReason(model.value, currentReason.value.id) : []
);
const sourceView = computed(() => sourceSegmentView(model.value, nav.value));
const remaining = computed(() => drillsRemainingToSource(nav.value));

async function loadAnchors() {
  try {
    const data = await api.traceAnchors();
    anchors.value = data.items;
    period.value = data.period;
  } catch (err) {
    error.value = err.message;
  }
}

async function loadChain(metricId) {
  if (!metricId) return;
  loading.value = true;
  error.value = '';
  refillHint.value = '';
  try {
    model.value = buildChainModel(await api.traceChain(metricId));
    // 进入任一结果指标都从结果段开始；段数恒为四段
    nav.value = createNav(metricId);
  } catch (err) {
    error.value = err.message;
    model.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await loadAnchors();
  await loadChain(props.metricId);
});

watch(
  () => props.metricId,
  (next) => loadChain(next)
);

/** 逐层下钻：只进入紧邻的下一段，并预置该段的停留位置。 */
function drillNext() {
  if (!model.value) return;
  const next = nextSegmentKey(nav.value.layerKey);
  if (!next) return;
  refillHint.value = '';
  if (next === 'reason') {
    nav.value = drill(nav.value, model.value.reasons[0]?.id ?? null);
  } else if (next === 'evidence') {
    nav.value = drill(nav.value, reasonEvidences.value[0]?.id ?? null);
  } else {
    nav.value = drill(nav.value);
  }
}

/** 返回上一层：位置沿用该段原有停留位置（与操作前一致）。 */
function goBack() {
  refillHint.value = '';
  nav.value = returnToPrev(nav.value);
}

function focusReason(reasonId) {
  nav.value = { ...nav.value, positions: { ...nav.value.positions, reason: reasonId } };
}

function focusEvidence(evidenceId) {
  nav.value = { ...nav.value, positions: { ...nav.value.positions, evidence: evidenceId } };
}

function onRefill(refill) {
  refillHint.value = `${refill?.label || '补录'}：请在对应模块完成登记后返回本页刷新。`;
}

function money(value, unit) {
  if (value === null || value === undefined) return NO_DATA_LABEL;
  return unit ? `${value}${unit}` : String(value);
}
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h2>四层链路穿透（F5）</h2>
        <p class="muted">
          结果 → 原因（归因） → 证据 → 来源信息 · 固定四段
          <span v-if="period"> · 周期 <span class="strong">{{ periodLabel(period.periodType, period.periodValue) }}</span></span>
          <span v-if="model"> · 结果到来源需 {{ model.drillOpsToSource }} 次层间下钻（上限 {{ MAX_DRILL_OPS }} 次操作）</span>
        </p>
      </div>
      <div class="view-actions">
        <button
          class="btn btn-sm"
          type="button"
          data-testid="trace-back"
          :disabled="!canReturn(nav)"
          @click="goBack"
        >返回上一层</button>
        <button
          class="btn btn-sm btn-primary"
          type="button"
          data-testid="trace-drill"
          :disabled="!canDrill(nav)"
          @click="drillNext"
        >下钻一层</button>
      </div>
    </header>

    <TraceBreadcrumb :items="breadcrumb" />

    <p v-if="error" class="alert alert-error">{{ error }}</p>
    <p v-else-if="loading" class="muted">加载中…</p>

    <template v-else-if="model">
      <p v-if="refillHint" class="alert alert-info" data-testid="refill-hint">{{ refillHint }}</p>

      <!-- ============ 第 1 段：结果（Result 契约） ============ -->
      <article v-if="nav.layerKey === 'result'" class="card trace-card" data-testid="segment-result">
        <h3>第 1 段 · 结果（{{ currentLayer?.contractRef }}）</h3>
        <div class="detail-grid">
          <div><span class="muted">指标</span><div class="strong" data-testid="trace-result-name">{{ model.result.name }}</div></div>
          <div><span class="muted">代码</span><div>{{ model.result.code }} · {{ model.result.dimensionLabel }}</div></div>
          <div><span class="muted">目标值</span><div data-testid="trace-result-target">{{ money(model.result.targetValue, model.result.unit) }}</div></div>
          <div><span class="muted">实际值</span><div class="strong" data-testid="trace-result-actual">
            {{ model.result.hasData ? money(model.result.actualValue, model.result.unit) : NO_DATA_LABEL }}
          </div></div>
          <div><span class="muted">偏差</span><div data-testid="trace-result-deviation">
            {{ model.result.hasData && model.result.deviation?.computable ? money(model.result.deviation.value, model.result.unit) : NO_DATA_LABEL }}
          </div></div>
          <div><span class="muted">数据截止</span><div>{{ cutoffText(model.result.dataCutoffAt) || '—' }}</div></div>
          <div><span class="muted">口径版本</span><div data-testid="trace-result-version">{{ model.result.calculationVersion || NO_DATA_LABEL }}</div></div>
          <div><span class="muted">Result 标识</span><div data-testid="trace-result-id">{{ model.result.resultId || NO_DATA_LABEL }}</div></div>
          <div><span class="muted">结果来源系统</span><div>{{ model.result.sourceSystemLabel || NO_DATA_LABEL }}</div></div>
        </div>
        <p class="muted hint">实际值只来自专业 Owner 模块的 Result；EBMS 不重算专业指标。</p>
      </article>

      <!-- ============ 第 2 段：原因（归因，对齐 Exception 契约） ============ -->
      <article v-else-if="nav.layerKey === 'reason'" class="card trace-card" data-testid="segment-reason">
        <h3>第 2 段 · 原因（归因）（{{ currentLayer?.contractRef }}）</h3>
        <BreakpointNotice :layer="currentLayer" @refill="onRefill" />
        <ul v-if="model.reasons.length" class="trace-list">
          <li v-for="r in model.reasons" :key="r.id">
            <button
              type="button"
              class="trace-item"
              :class="{ active: r.id === nav.positions.reason }"
              data-testid="trace-reason"
              :data-reason-id="r.id"
              :data-attribution="r.attribution.kind"
              @click="focusReason(r.id)"
            >
              <span class="trace-item-name">{{ r.name }}</span>
              <span class="badge" :class="r.attribution.kind === 'exception' ? 'badge-warn' : ''" data-testid="trace-attribution">
                {{ r.attribution.kindLabel }}
              </span>
              <span class="muted">
                {{ r.directionLabel }} · 贡献 {{ r.contributionPct }}% · 证据 {{ r.evidenceCount }} 条
                <template v-if="r.attribution.reasonCode"> · {{ r.attribution.reasonCode }}</template>
                <template v-if="r.attribution.severityLabel"> · 严重度 {{ r.attribution.severityLabel }}</template>
              </span>
            </button>
          </li>
        </ul>
        <p class="muted hint">
          第 2 段对齐 Exception（归因）契约：含 reason_code + severity 的原因项映射至 Exception；
          其余显式标注为「M03 自有归因分析」，不冒充专业维度归因。
        </p>
      </article>

      <!-- ============ 第 3 段：证据（Evidence 契约） ============ -->
      <article v-else-if="nav.layerKey === 'evidence'" class="card trace-card" data-testid="segment-evidence">
        <h3>第 3 段 · 证据（{{ currentLayer?.contractRef }}）</h3>
        <p class="muted" data-testid="trace-evidence-scope">
          原因项：<span class="strong">{{ currentReason?.name || '未选中' }}</span>
        </p>
        <BreakpointNotice :layer="currentLayer" @refill="onRefill" />
        <ul v-if="reasonEvidences.length" class="trace-list">
          <li v-for="e in reasonEvidences" :key="e.id">
            <button
              type="button"
              class="trace-item"
              :class="{ active: e.id === nav.positions.evidence }"
              data-testid="trace-evidence"
              :data-evidence-id="e.id"
              @click="focusEvidence(e.id)"
            >
              <span class="trace-item-name">{{ e.title }}</span>
              <span class="tag">{{ e.typeLabel }}</span>
              <span class="muted">{{ e.owner }} · {{ cutoffText(e.formedAt) || '—' }}</span>
            </button>
          </li>
        </ul>
        <p class="muted hint">证据来自 EBMS 登记的证据台账（Evidence 契约），不直读专业原始表。</p>
      </article>

      <!-- ============ 第 4 段：来源信息（Evidence.source_system 字段） ============ -->
      <article v-else class="card trace-card" data-testid="segment-source">
        <h3>第 4 段 · 来源信息（{{ SOURCE_FIELD_REF }} 字段）</h3>
        <p class="muted">
          本段不是独立层级：取值只来自所挂载 Evidence 的 <code>source_system</code> 字段，不打开新的独立来源实体。
        </p>
        <BreakpointNotice :layer="currentLayer" @refill="onRefill" />
        <ul v-if="sourceView.items.length" class="trace-list">
          <li v-for="item in sourceView.items" :key="item.evidenceId">
            <div class="trace-item static" :data-testid="`trace-source-${item.evidenceId}`" :data-marked="item.marked">
              <span class="trace-item-name">{{ item.title }}</span>
              <span
                class="tag"
                :class="{ 'tag-unmarked': !item.marked }"
                data-testid="trace-source-value"
              >{{ item.text }}</span>
              <span class="muted">
                <template v-if="item.marked">字段值 {{ item.fieldValue }} · 取值自 {{ item.resolvedFrom }}</template>
                <template v-else>{{ item.resolvedFrom }} 为空 · 未回落到专业原始表</template>
              </span>
            </div>
          </li>
        </ul>
        <p v-else class="muted" data-testid="trace-source-empty">该链路暂无可展示的来源信息。</p>
      </article>

      <!-- 判定标准：链路消费对象清点在界面上可见（无额外跨域契约对象） -->
      <details class="trace-inventory" data-testid="trace-inventory">
        <summary class="muted">链路消费对象清点</summary>
        <p>
          契约对象：<span class="strong">{{ (model.contractInventory?.objects || []).join(' / ') }}</span>
          · 字段：<span class="strong">{{ (model.contractInventory?.fields || []).join(' / ') }}</span>
          · 额外跨域契约对象：<span class="strong" data-testid="trace-inventory-extras">{{ (model.contractInventory?.extras || []).length }}</span>
        </p>
        <p class="muted">来源段未标注时不回落专业原始表（fallbackToRawTables: {{ model.sourceContract?.fallbackToRawTables }}）。</p>
      </details>
    </template>

    <p v-else class="muted" data-testid="trace-empty">
      请从下方「链路起点」选择一个结果指标，开始四层穿透。
    </p>

    <aside v-if="anchors.length && (nav.layerKey === 'result' || !model)" class="trace-anchors">
      <h3 class="rail-title">链路起点（结果指标）</h3>
      <ul class="rail-list">
        <li v-for="a in anchors" :key="a.metricId">
          <a
            class="rail-item"
            :class="{ active: a.metricId === nav.metricId }"
            data-testid="trace-anchor"
            :href="`#/trace/${a.metricId}`"
          >{{ a.name }}</a>
        </li>
      </ul>
    </aside>
  </section>
</template>
