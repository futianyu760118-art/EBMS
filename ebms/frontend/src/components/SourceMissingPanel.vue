<script setup>
// F4（PAND-82）边界 + 判定标准：来源缺失率与待补清单。
// 缺失率 = 缺失条数 ÷ 总条数；外部来源提供方非空、人工录入录入人与录入时间非空在此可核对。
import { computed } from 'vue';

const props = defineProps({
  stats: { type: Object, default: null },
  list: { type: Object, default: null },
  loading: { type: Boolean, default: false },
});
const emit = defineEmits(['open']);

const hasItems = computed(() => (props.list?.items?.length || 0) > 0);

function open(item) {
  emit('open', item.id);
}
</script>

<template>
  <section class="view source-missing-view">
    <header class="view-header">
      <div>
        <h2>来源待补清单（F4）</h2>
        <p class="muted">每条证据都应标注来源；未标注的在此列出，缺失率可统计。</p>
      </div>
    </header>

    <div v-if="loading" class="muted">加载中…</div>

    <template v-else>
      <ul v-if="stats" class="stat-strip">
        <li data-testid="stat-total">
          <span class="stat-value">{{ stats.totalText }}</span>
          <span class="stat-label muted">证据总条数</span>
        </li>
        <li data-testid="stat-missing">
          <span class="stat-value" :class="{ warn: stats.hasMissing }">{{ stats.missingText }}</span>
          <span class="stat-label muted">{{ list?.marker || '来源缺失' }}</span>
        </li>
        <li data-testid="stat-missing-rate">
          <span class="stat-value">{{ stats.rateText }}</span>
          <span class="stat-label muted">来源缺失率（{{ stats.rateFormula }}）</span>
        </li>
      </ul>

      <section v-if="stats" class="detail-section">
        <h3>来源类别覆盖</h3>
        <ul class="audit-list">
          <li v-for="row in stats.coverageRows" :key="row.key">
            <span class="audit-action">{{ row.label }}</span>
            <span class="muted" :class="{ warn: row.alert && row.count > 0 }">{{ row.count }} 条</span>
          </li>
        </ul>
      </section>

      <section v-if="stats" class="detail-section">
        <h3>判定标准核对</h3>
        <ul class="audit-list">
          <li v-for="row in stats.criteriaRows" :key="row.key">
            <span class="audit-action">{{ row.label }}</span>
            <span :class="row.ok ? 'alert-ok' : 'warn-inline'">
              {{ row.ok ? '满足' : '不满足' }}（{{ row.detail }}）
            </span>
          </li>
        </ul>
      </section>

      <table v-if="list" class="data-table">
        <thead>
          <tr>
            <th>证据类型</th>
            <th>标题</th>
            <th>形成时间</th>
            <th>责任人</th>
            <th>关联原因项</th>
            <th>待补字段</th>
            <th class="col-actions">详情入口</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!hasItems">
            <td colspan="7" class="empty-cell">没有来源缺失的证据。</td>
          </tr>
          <tr v-for="item in list.items" :key="item.id">
            <td><span class="tag">{{ item.typeLabel }}</span></td>
            <td class="strong">{{ item.title }}</td>
            <td>{{ item.formedAtText }}</td>
            <td>{{ item.owner }}</td>
            <td>{{ item.reasonText }}</td>
            <td class="muted">{{ item.pendingText }}</td>
            <td class="col-actions">
              <button class="btn btn-sm" type="button" @click="open(item)">查看来源</button>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>
