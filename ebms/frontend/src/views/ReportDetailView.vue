<script setup>
// F7（PAND-85）：报告详情——以「结论」为单位的信息组织。
// 场景 2：结论 + 关键结果指标（目标值/实际值/偏差）+ 关联的 TODO / Decision / Evidence 入口。
import { ref, watch } from 'vue';
import { api } from '../api/client';
import { buildReportDetailModel } from '../report-view';
import ResultMetricTable from '../components/ResultMetricTable.vue';
import ViewNavBar from '../components/ViewNavBar.vue';

const props = defineProps({
  reportId: { type: String, required: true },
});
const emit = defineEmits(['navigate', 'back']);

const loading = ref(true);
const error = ref('');
const model = ref(null);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    model.value = buildReportDetailModel(await api.report(props.reportId));
  } catch (err) {
    model.value = null;
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

watch(() => props.reportId, load, { immediate: true });
</script>

<template>
  <section class="view">
    <p v-if="loading" class="muted">加载中…</p>
    <p v-else-if="error" class="alert alert-error" data-testid="report-error">{{ error }}</p>

    <template v-else-if="model">
      <header class="view-header">
        <div>
          <span class="badge">REPORT</span>
          <span class="tag" data-testid="report-domain">{{ model.report.domainLabel }}</span>
          <h2 class="view-title" data-testid="report-title">{{ model.report.title }}</h2>
          <p class="muted">
            <code>{{ model.report.code }}</code> · {{ model.report.periodLabel }}
            <span v-if="model.report.owner"> · {{ model.report.owner }}</span>
          </p>
        </div>
        <div class="view-actions">
          <button class="btn btn-sm" type="button" data-testid="back-to-list" @click="emit('back')">
            返回报告清单
          </button>
        </div>
      </header>

      <h3 class="section-title">结论</h3>
      <p class="content-text report-conclusion" data-testid="report-conclusion">{{ model.report.conclusion }}</p>

      <h3 class="section-title">关键结果指标与偏差</h3>
      <ResultMetricTable :model="model.metricModel" />

      <h3 class="section-title">关联入口</h3>
      <ViewNavBar :model="model.navModel" @navigate="(href) => emit('navigate', href)" />
      <p v-if="model.allDisabled" class="alert alert-info" data-testid="report-no-link">
        该报告暂无关联对象，三个跳转入口均已置灰（{{ model.noLinkHint }}）。
      </p>
    </template>
  </section>
</template>
