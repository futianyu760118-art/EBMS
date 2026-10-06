<script setup>
// F7（PAND-85）：报告卡片——以「结论」为单位呈现一份报告。
// 纯展示组件：入参即 buildReportCard 的结果，便于直接做 SSR 渲染断言。
defineProps({
  card: { type: Object, required: true },
});
const emit = defineEmits(['open']);
</script>

<template>
  <article class="card report-card" data-testid="report-card" :data-code="card.code">
    <header class="report-card-head">
      <div>
        <span class="badge">REPORT</span>
        <span class="tag" data-testid="report-domain">{{ card.domainLabel }}</span>
        <h3 class="report-card-title" data-testid="report-title">{{ card.title }}</h3>
        <p class="muted">
          <code>{{ card.code }}</code> · {{ card.periodLabel }}
          <span v-if="card.owner"> · {{ card.owner }}</span>
        </p>
      </div>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        data-testid="open-report"
        :title="`查看报告：${card.title}`"
        @click="emit('open', card.landingHref)"
      >
        查看报告
      </button>
    </header>

    <p class="report-conclusion" data-testid="report-conclusion">{{ card.conclusion }}</p>

    <ul class="stat-strip">
      <li data-testid="card-metrics">
        <span class="stat-value">{{ card.metricCount }}</span>
        <span class="stat-label muted">关键结果指标</span>
      </li>
      <li data-testid="card-supplied">
        <span class="stat-value">{{ card.suppliedCount }}</span>
        <span class="stat-label muted">已供给实际值</span>
      </li>
      <li data-testid="card-exceeded" :class="{ 'warn-inline': card.exceededCount > 0 }">
        <span class="stat-value">{{ card.exceededCount }}</span>
        <span class="stat-label muted">偏差超阈值</span>
      </li>
      <li data-testid="card-nodata">
        <span class="stat-value">{{ card.noDataCount }}</span>
        <span class="stat-label muted">无数据</span>
      </li>
    </ul>

    <nav class="view-nav" aria-label="报告关联入口">
      <span class="view-nav-title">关联入口</span>
      <div
        v-for="entry in card.entries"
        :key="entry.targetType"
        class="view-nav-group"
        :class="{ disabled: entry.disabled }"
        :data-entry="entry.targetType"
      >
        <span class="view-nav-label">{{ entry.label }}</span>
        <span
          v-if="entry.disabled"
          class="view-nav-hint"
          data-testid="entry-disabled"
          aria-disabled="true"
          :title="entry.hint"
        >{{ entry.hint }}</span>
        <span v-else class="view-nav-count">{{ entry.count }} 项</span>
      </div>
    </nav>
  </article>
</template>
