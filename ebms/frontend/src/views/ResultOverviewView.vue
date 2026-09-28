<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import { buildOverviewModel } from '../result-overview';
import ResultMetricTable from '../components/ResultMetricTable.vue';

const loading = ref(true);
const error = ref('');
const model = ref(null);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    model.value = buildOverviewModel(await api.results());
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h2>经营结果指标集</h2>
        <p class="muted">
          周期 <span class="strong">{{ model?.periodLabel || '—' }}</span>
          <span v-if="model"> · 共 {{ model.configuredCount }} 项指标（配置的指标集条目数）</span>
        </p>
      </div>
      <div class="view-actions">
        <button class="btn btn-sm" type="button" :disabled="loading" @click="load">刷新</button>
      </div>
    </header>

    <p v-if="error" class="alert alert-error">{{ error }}</p>
    <p v-else-if="loading" class="muted">加载中…</p>
    <ResultMetricTable v-else-if="model" :model="model" />
  </section>
</template>
