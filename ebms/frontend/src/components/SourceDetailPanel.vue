<script setup>
// F4（PAND-82）：单条证据的来源（Source）区块。
// 场景 1 展示来源系统 / 来源单据编号 / 来源数据时间 / 提供方；
// 场景 2 人工录入额外展示录入人与录入时间；场景 3 用类别区分内部系统与外部数据；
// 边界：无来源时打「来源缺失」标记并列出待补字段。
import { computed } from 'vue';

const props = defineProps({
  model: { type: Object, default: null },
});

const title = computed(() => (props.model?.missing ? '来源（Source）：来源缺失' : '来源（Source）'));
</script>

<template>
  <section class="detail-section source-section">
    <h3>{{ title }}</h3>

    <p v-if="!model" class="muted">来源信息加载中…</p>

    <template v-else-if="model.missing">
      <p class="alert alert-warning" role="alert">
        <strong>{{ model.marker }}</strong>
        <span>该证据未标注来源，已计入待补清单。</span>
      </p>
      <dl class="detail-grid">
        <dt>待补字段</dt>
        <dd>{{ model.pendingText || '—' }}</dd>
      </dl>
    </template>

    <template v-else>
      <p class="source-type-line">
        <span class="tag">{{ model.typeLabel }}</span>
        <span class="muted">{{ model.cycleText }}</span>
      </p>

      <dl class="detail-grid">
        <template v-for="row in model.rows" :key="row.key">
          <dt>{{ row.label }}</dt>
          <dd :class="{ muted: row.empty }">{{ row.value }}</dd>
        </template>
      </dl>

      <!-- 场景 2：人工录入来源的追加标注 -->
      <dl v-if="model.manualRows.length" class="detail-grid source-manual-grid">
        <template v-for="row in model.manualRows" :key="row.key">
          <dt>{{ row.label }}</dt>
          <dd :class="{ muted: row.empty }">{{ row.value }}</dd>
        </template>
      </dl>

      <p class="muted source-cutoff">
        数据截止时间 {{ model.cutoffText }}（周期更新，非实时）
      </p>
      <p v-if="model.pendingText" class="warn-inline">待补字段：{{ model.pendingText }}</p>
    </template>
  </section>
</template>
