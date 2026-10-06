<script setup>
// F7（PAND-85）：报告清单——登录后的默认落地视图。
// 场景 1：清单即落点，每张卡片一次点击到达报告详情（不再逐级点菜单）。
// 场景 3：按周期与责任域筛选。
// 边界：无 Report 时显示空态与创建入口。
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import {
  buildFilterModel,
  buildReportListModel,
  periodOptionValue,
  parsePeriodOptionValue,
  reportQuery,
} from '../report-view';
import ReportCard from '../components/ReportCard.vue';

const emit = defineEmits(['navigate']);

const loading = ref(true);
const error = ref('');
const model = ref(null);
const filterModel = ref({ domains: [], periods: [] });

// 筛选态：空字符串 = 不限
const period = ref('');
const domain = ref('');

// 创建入口（空态下同样可用）
const showCreate = ref(false);
const creating = ref(false);
const createError = ref('');
const form = ref({ title: '', conclusion: '', periodType: 'month', periodValue: '', domain: '', owner: '' });

async function load() {
  loading.value = true;
  error.value = '';
  const { periodType, periodValue } = parsePeriodOptionValue(period.value);
  try {
    model.value = buildReportListModel(
      await api.reports(reportQuery({ periodType, periodValue, domain: domain.value }))
    );
  } catch (err) {
    error.value = err.message;
    model.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadFilters() {
  try {
    filterModel.value = buildFilterModel(await api.reportFilters());
  } catch (err) {
    error.value = err.message;
  }
}

async function submitCreate() {
  creating.value = true;
  createError.value = '';
  try {
    const created = await api.createReport({ ...form.value });
    showCreate.value = false;
    form.value = { title: '', conclusion: '', periodType: 'month', periodValue: '', domain: '', owner: '' };
    await load();
    // 创建后直接落到该报告：创建入口本身也不制造额外的点击层级
    if (created?.report?.landingHref) emit('navigate', created.report.landingHref);
  } catch (err) {
    createError.value = err.message;
  } finally {
    creating.value = false;
  }
}

onMounted(async () => {
  await loadFilters();
  await load();
});
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h2>报告</h2>
        <p class="muted">
          REPORT 视图以报告 / 结论为单位组织信息
          <span v-if="model"> · 共 {{ model.total }} 份报告</span>
        </p>
      </div>
      <div class="view-actions">
        <button class="btn btn-sm" type="button" :disabled="loading" @click="load">刷新</button>
        <button
          class="btn btn-primary btn-sm"
          type="button"
          data-testid="create-report-toggle"
          @click="showCreate = !showCreate"
        >
          {{ model?.empty ? '创建第一份报告' : '新建报告' }}
        </button>
      </div>
    </header>

    <form class="filter-bar" data-testid="report-filters" @submit.prevent="load">
      <label class="field">
        <span>周期</span>
        <select v-model="period" data-testid="filter-period" @change="load">
          <option value="">全部周期</option>
          <option
            v-for="p in filterModel.periods"
            :key="`${p.periodType}|${p.periodValue}`"
            :value="periodOptionValue(p.periodType, p.periodValue)"
          >
            {{ p.label }}
          </option>
        </select>
      </label>

      <label class="field">
        <span>责任域</span>
        <select v-model="domain" data-testid="filter-domain" @change="load">
          <option value="">全部责任域</option>
          <option v-for="d in filterModel.domains" :key="d.code" :value="d.code">{{ d.label }}</option>
        </select>
      </label>

      <button class="btn btn-sm" type="submit" :disabled="loading">筛选</button>
    </form>

    <p v-if="error" class="alert alert-error">{{ error }}</p>

    <form v-if="showCreate" class="card create-form" data-testid="create-report-form" @submit.prevent="submitCreate">
      <h3>新建报告</h3>
      <p class="muted">报告以「结论」为单位：结论必填，关键结果指标由报告详情关联。</p>

      <label class="field">
        <span>标题</span>
        <input v-model="form.title" type="text" data-testid="create-title" placeholder="如：9月经营月报：订单交付偏差" />
      </label>
      <label class="field">
        <span>结论</span>
        <input v-model="form.conclusion" type="text" data-testid="create-conclusion" placeholder="一句话结论（必填）" />
      </label>
      <div class="field-row">
        <label class="field">
          <span>数据周期类型</span>
          <select v-model="form.periodType" data-testid="create-period-type">
            <option value="month">月</option>
            <option value="week">周</option>
            <option value="day">日</option>
          </select>
        </label>
        <label class="field">
          <span>周期取值</span>
          <input v-model="form.periodValue" type="text" data-testid="create-period-value" placeholder="如：2026-09" />
        </label>
        <label class="field">
          <span>责任域</span>
          <select v-model="form.domain" data-testid="create-domain">
            <option value="">请选择</option>
            <option v-for="d in filterModel.domains" :key="d.code" :value="d.code">{{ d.label }}</option>
          </select>
        </label>
        <label class="field">
          <span>责任人 / 部门</span>
          <input v-model="form.owner" type="text" data-testid="create-owner" placeholder="如：经营管理部" />
        </label>
      </div>

      <p v-if="createError" class="alert alert-error" data-testid="create-error">{{ createError }}</p>
      <div class="view-actions">
        <button class="btn btn-primary btn-sm" type="submit" :disabled="creating">创建</button>
        <button class="btn btn-ghost btn-sm" type="button" @click="showCreate = false">取消</button>
      </div>
    </form>

    <p v-if="loading" class="muted">加载中…</p>

    <template v-else-if="model">
      <div v-if="model.empty" class="card empty-state" data-testid="report-empty">
        <h3>{{ model.emptyState.title }}</h3>
        <p class="muted">{{ model.emptyState.hint }}</p>
        <button class="btn btn-primary btn-sm" type="button" data-testid="empty-create" @click="showCreate = true">
          {{ model.emptyState.actionLabel }}
        </button>
      </div>

      <div v-else class="report-list" data-testid="report-list">
        <ReportCard
          v-for="card in model.cards"
          :key="card.id"
          :card="card"
          @open="(href) => emit('navigate', href)"
        />
      </div>
    </template>
  </section>
</template>
