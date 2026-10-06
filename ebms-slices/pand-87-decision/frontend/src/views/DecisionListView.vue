<script setup>
import { onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import { session } from '../store/session';
import { DOMAIN_LABELS } from '../lib/format';
import DecisionCard from '../components/DecisionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import CreateDecisionForm from '../components/CreateDecisionForm.vue';

const route = useRoute();
const router = useRouter();

const items = ref([]);
const summary = ref({ total: 0, decided: 0, pending: 0 });
const meta = ref({ statuses: [], background_ref_types: [] });
const loading = ref(false);
const error = ref('');
const showCreate = ref(false);
const creating = ref(false);
const refs = ref({ results: [], reasons: [], evidences: [] });

const filters = reactive({
  status: route.query.status || '',
  domain: route.query.domain || '',
});

// 可筛选的责任域：决策者看全企业，管理责任人只看本责任域
const domainOptions = ref([]);

function buildDomainOptions(landing) {
  const scope = (landing && landing.scope) || {};
  if (scope.mode === 'domain' && scope.domains && scope.domains.length) {
    return scope.domains.map((value) => ({ value, label: DOMAIN_LABELS[value] || value }));
  }
  return Object.entries(DOMAIN_LABELS)
    .filter(([value]) => value !== 'all')
    .map(([value, label]) => ({ value, label }));
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const result = await api.listDecisions({
      status: filters.status,
      domain: filters.domain,
      limit: 100,
    });
    items.value = result.items;
    summary.value = result.summary;
    meta.value = result.meta;
  } catch (err) {
    error.value = err.message || '加载决策列表失败';
  } finally {
    loading.value = false;
  }
}

function syncQuery() {
  router
    .replace({
      query: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.domain ? { domain: filters.domain } : {}),
      },
    })
    .catch(() => {});
}

watch(() => [filters.status, filters.domain], () => {
  syncQuery();
  load();
});

async function openCreate() {
  showCreate.value = true;
  try {
    refs.value = await api.decisionRefs();
  } catch (err) {
    error.value = err.message || '加载可关联对象失败';
  }
}

async function submitCreate(payload) {
  creating.value = true;
  error.value = '';
  try {
    await api.createDecision(payload);
    showCreate.value = false;
    await load();
  } catch (err) {
    error.value = err.message || '创建决策失败';
  } finally {
    creating.value = false;
  }
}

onMounted(() => {
  domainOptions.value = buildDomainOptions(session.landing);
  load();
});
</script>

<template>
  <section>
    <header class="ebms-view-head">
      <div>
        <h1>Decision 决策视图</h1>
        <p class="ebms-view-sub">
          记录决策背景、候选方案、所需证据与决策结论；结论一经形成即不可静默修改。
        </p>
      </div>
      <button type="button" data-test="open-create" @click="openCreate">创建决策</button>
    </header>

    <p class="ebms-summary" data-test="decision-summary">
      共 {{ summary.total }} 条决策 · 已决策
      <strong data-test="summary-decided">{{ summary.decided }}</strong> 条 · 待决策
      <strong data-test="summary-pending">{{ summary.pending }}</strong> 条
      <span class="ebms-muted" data-test="summary-note">（待决策不计入已决策数量）</span>
    </p>

    <CreateDecisionForm
      v-if="showCreate"
      :refs="refs"
      :busy="creating"
      :allowed-domains="domainOptions.map((d) => d.value)"
      @submit="submitCreate"
      @cancel="showCreate = false"
    />

    <div class="ebms-filters">
      <label>
        决策状态
        <select v-model="filters.status" data-test="filter-status">
          <option value="">全部</option>
          <option v-for="item in meta.statuses" :key="item.value" :value="item.value">
            {{ item.label }}
          </option>
        </select>
      </label>
      <label>
        责任域
        <select v-model="filters.domain" data-test="filter-domain">
          <option value="">全部</option>
          <option v-for="item in domainOptions" :key="item.value" :value="item.value">
            {{ item.label }}
          </option>
        </select>
      </label>
      <button
        type="button"
        data-test="filter-reset"
        @click="filters.status = ''; filters.domain = ''"
      >重置</button>
    </div>

    <p v-if="error" class="ebms-error" data-test="list-error">{{ error }}</p>
    <p v-if="loading" class="ebms-muted" data-test="list-loading">加载中…</p>

    <template v-if="!loading">
      <DecisionCard v-for="decision in items" :key="decision.id" :decision="decision" />
      <EmptyState
        v-if="!items.length"
        description="当前筛选条件下暂无决策记录。"
        @create="openCreate"
      />
    </template>
  </section>
</template>
