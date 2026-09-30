<script setup>
// F4（PAND-82）来源待补视图：缺失率统计 + 待补清单 + 单条来源明细。
// 判定标准「来源缺失率可统计」在此可见：缺失条数 ÷ 总条数。
import { computed, onMounted, ref } from 'vue';
import { api } from '../api/client';
import { buildMissingListView, buildSourceStatsView } from '../source-view';
import SourceMissingPanel from '../components/SourceMissingPanel.vue';
import EvidenceDetailPanel from '../components/EvidenceDetailPanel.vue';

const stats = ref(null);
const list = ref(null);
const loading = ref(true);
const error = ref('');

const detail = ref(null);
const detailSource = ref(null);
const detailOpen = ref(false);
const detailLoading = ref(false);

const statsModel = computed(() => buildSourceStatsView(stats.value));
const listModel = computed(() => buildMissingListView(list.value));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [statsPayload, listPayload] = await Promise.all([api.sourceStats(), api.missingSources()]);
    stats.value = statsPayload;
    list.value = listPayload;
  } catch (err) {
    error.value = err.message;
    stats.value = null;
    list.value = null;
  } finally {
    loading.value = false;
  }
}

async function openEvidence(evidenceId) {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  detailSource.value = null;
  try {
    const [evidence, source] = await Promise.all([
      api.evidenceDetail(evidenceId),
      api.sourceDetail(evidenceId),
    ]);
    detail.value = evidence;
    detailSource.value = source;
  } catch (err) {
    error.value = err.message;
    detailOpen.value = false;
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail() {
  detailOpen.value = false;
  detail.value = null;
  detailSource.value = null;
}

onMounted(load);
</script>

<template>
  <section class="layout-single">
    <p v-if="error" class="alert alert-error">{{ error }}</p>
    <SourceMissingPanel
      :stats="statsModel"
      :list="listModel"
      :loading="loading"
      @open="openEvidence"
    />

    <EvidenceDetailPanel
      v-if="detailOpen"
      :evidence="detail"
      :source="detailSource"
      :loading="detailLoading"
      @close="closeDetail"
    />
  </section>
</template>
