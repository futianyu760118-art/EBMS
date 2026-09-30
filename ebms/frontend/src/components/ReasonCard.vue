<script setup>
import { computed } from 'vue';

import { kindLabel, reasonFields } from '../stores/reasonDrilldown.js';

// 场景 1：一条原因项的完整展示（原因名称 / 严重度 / 影响方向 / 影响量或贡献占比 / 责任方）。
// 场景 4：同时给出类型判定（映射至 Exception / M03 自有归因分析）。
const props = defineProps({
  reason: { type: Object, required: true },
  fallback: { type: Object, default: null },
});
const emit = defineEmits(['toggle', 'add-child']);

const fields = computed(() => reasonFields(props.reason));
const verdict = computed(() => kindLabel(props.reason));
</script>

<template>
  <article
    class="card reason"
    :class="`card--${reason.kind}`"
    :data-depth="Math.min(reason.depth ?? 0, 6)"
    :data-attribution-id="reason.attributionId"
  >
    <header class="card__head">
      <h3 class="card__title">
        <span v-if="reason.depth > 0" class="card__indent">└</span>
        {{ reason.name }}
        <span class="badge">第 {{ reason.depth }} 级</span>
      </h3>
      <!-- 场景 4：类型判定 -->
      <span class="tag" :class="reason.kind === 'exception' ? 'tag--exc' : 'tag--m03'">
        {{ verdict }}
      </span>
    </header>

    <dl class="card__meta">
      <div v-for="field in fields" :key="field.key" :class="{ 'meta--missing': field.missing }">
        <dt>{{ field.label }}</dt>
        <dd>{{ field.value }}</dd>
      </div>
      <div>
        <dt>影响依据</dt>
        <dd>{{ reason.impactDisplay?.label ?? '—' }}</dd>
      </div>
      <div v-if="reason.evidenceCount != null">
        <dt>证据</dt>
        <dd>{{ reason.evidenceCount }} 条</dd>
      </div>
    </dl>

    <p v-if="fallback" class="notice notice--inline">
      已按 M03 自有归因分析登记：{{ fallback.message }}（{{ fallback.code }}）
    </p>

    <p v-if="reason.truncated" class="notice notice--inline">
      该级以下还有更深的原因项，可继续展开。
    </p>

    <footer class="card__foot reason__actions">
      <button
        v-if="reason.expandable"
        type="button"
        class="jump"
        :aria-expanded="reason.expanded"
        @click="emit('toggle', reason.attributionId)"
      >
        {{ reason.expanded ? '收起' : '展开' }}下一级（{{ reason.childCount }}）
      </button>
      <span v-else class="reason__leaf">已到最末一级</span>
      <button type="button" class="jump" @click="emit('add-child', reason.attributionId)">
        在此项下细分
      </button>
    </footer>
  </article>
</template>
