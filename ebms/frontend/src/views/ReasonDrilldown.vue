<script setup>
import { computed, ref } from 'vue';

import { api } from '../api/client.js';
import {
  createReasonDrilldownStore,
  deviationDirection,
  fallbackNotice,
  isUnattributed,
  summarize,
  visibleDepth,
  visibleReasons,
} from '../stores/reasonDrilldown.js';

import ReasonCard from '../components/ReasonCard.vue';
import ReasonForm from '../components/ReasonForm.vue';
import UnattributedNotice from '../components/UnattributedNotice.vue';

const store = createReasonDrilldownStore({ api });
const { state } = store;

const metricInput = ref('');
const showForm = ref(false);

const payload = computed(() => state.payload);
const summary = computed(() => summarize(state.payload));
const visible = computed(() => visibleReasons(state.payload, state.expandedIds));
const depth = computed(() => visibleDepth(visible.value));
const unattributed = computed(() => isUnattributed(state.payload));
const deviationDir = computed(() => deviationDirection(state.payload));

// 新建原因项的兜底标注：仅回显本次提交中真正走了兜底的那些
const createdFallbacks = computed(() =>
  state.lastCreated
    .map((row) => ({ id: row.attributionId, notice: fallbackNotice(row) }))
    .filter((row) => row.notice),
);

async function submit() {
  const result = await store.submitReason();
  if (result) showForm.value = false;
}

function openForm(parentId = null) {
  store.setFormParent(parentId);
  showForm.value = true;
}

function onLinkFromEmpty() {
  store.resetForm();
  openForm(null);
}
</script>

<template>
  <section class="panel">
    <p class="panel__hint">
      从任一结果指标的偏差穿透到原因项 —— 原因项以 AEOS
      <code>Exception（归因）</code> 契约承载，纯人工判断型原因显式标记为
      <strong>M03 自有归因分析</strong>；影响方向与贡献占比属 M03 归因元数据，
      其依据的专业事实一律消费专业模块 Result。
    </p>
    <form class="query" @submit.prevent="store.load(metricInput)">
      <input
        v-model="metricInput"
        class="query__input"
        placeholder="结果指标 id 或 code，例如 M-REV / revenue"
        aria-label="结果指标"
      />
      <button class="query__submit" type="submit" :disabled="state.loading">
        {{ state.loading ? '查询中…' : '穿透到原因' }}
      </button>
    </form>
    <p class="panel__hint">
      可用示例：
      <button
        v-for="sample in ['M-REV', 'M-PROFIT', 'M-BACKLOG']"
        :key="sample"
        type="button"
        class="chip"
        @click="((metricInput = sample), store.load(sample))"
      >
        {{ sample }}
      </button>
    </p>
    <p v-if="state.error" class="error">{{ state.error.message }}（{{ state.error.code }}）</p>
  </section>

  <template v-if="payload">
    <section class="summary">
      <span>
        指标 <strong>{{ payload.result.name }}</strong>
        <code>{{ payload.result.code }}</code>
      </span>
      <span>
        偏差 <strong>{{ payload.deviation.deviation }}</strong>
        {{ payload.deviation.unit }}（目标 {{ payload.deviation.target }} / 实际
        {{ payload.deviation.actual }}）
      </span>
      <span v-if="deviationDir" class="badge" :data-dir="deviationDir">
        偏差方向 {{ deviationDir === 'positive' ? '正向' : deviationDir === 'negative' ? '负向' : '中性' }}
      </span>
      <span class="summary__split">
        来源 <code>{{ payload.consumption.sourceSystem }}</code> ·
        Result <code>{{ payload.consumption.resultId }}</code> ·
        口径 <code>{{ payload.consumption.calculationVersion }}</code>
      </span>
    </section>

    <section v-if="unattributed">
      <UnattributedNotice
        :empty="payload.empty"
        :link-entry="payload.linkEntry"
        @link="onLinkFromEmpty"
      />
    </section>

    <template v-else>
      <section class="summary">
        <span>
          归因状态 <strong>{{ summary.statusLabel }}</strong>
        </span>
        <span>
          顶层贡献占比合计
          <strong>{{ summary.rootContributionPct }}%</strong>
          <span class="summary__split">（容差 ±{{ summary.tolerancePct }}%）</span>
        </span>
        <span>原因项 <strong>{{ summary.reasonCount }}</strong>（顶层 {{ summary.rootCount }}）</span>
        <span>最深 <strong>{{ summary.maxDepthReached }}</strong> 级，当前展开到第 {{ depth }} 级</span>
        <span class="summary__split">
          映射至 Exception <strong>{{ summary.exceptionCount }}</strong> ·
          M03 自有归因分析 <strong>{{ summary.m03Count }}</strong>
        </span>
      </section>

      <section v-if="payload.notices?.length" class="notices">
        <p v-for="notice in payload.notices" :key="notice.code" class="notice">
          {{ notice.message }}
        </p>
      </section>

      <section v-if="createdFallbacks.length" class="notices">
        <p v-for="row in createdFallbacks" :key="row.id" class="notice">
          <code>{{ row.id }}</code> {{ row.notice.message }}（{{ row.notice.code }}）
        </p>
      </section>

      <section class="block">
        <header class="block__head">
          <h2>原因项</h2>
          <div class="block__actions">
            <button type="button" class="jump" @click="store.expandAll()">全部展开</button>
            <button type="button" class="jump" @click="store.collapseAll()">全部收起</button>
            <button type="button" class="jump" @click="openForm(null)">新增原因</button>
          </div>
        </header>

        <ReasonForm
          v-if="showForm || state.formParentId"
          :form="state.form"
          :submitting="state.submitting"
          :error="state.formError"
          :parent-id="state.formParentId"
          :directions="payload.directions"
          @update="store.setForm($event)"
          @submit="submit"
          @cancel="((showForm = false), store.resetForm())"
        />

        <div class="cards">
          <ReasonCard
            v-for="reason in visible"
            :key="reason.attributionId"
            :reason="reason"
            @toggle="store.toggle($event)"
            @add-child="openForm($event)"
          />
        </div>
      </section>

      <section class="block">
        <h2>专业事实消费声明</h2>
        <p class="page__sub">
          归因所依据的专业事实来自 <code>{{ payload.consumption.sourceSystem }}</code>
          的 Result <code>{{ payload.consumption.resultId }}</code>；
          {{ payload.consumption.note }}
        </p>
      </section>
    </template>
  </template>
</template>
