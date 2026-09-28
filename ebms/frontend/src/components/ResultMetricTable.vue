<script setup>
import { DEVIATION_LABEL, NO_DATA_LABEL } from '../result-overview';

// 纯展示组件：入参即 buildOverviewModel 的结果，便于直接做 SSR 渲染断言。
defineProps({
  model: { type: Object, required: true },
});
</script>

<template>
  <div>
    <!-- 数据来源口径：红线在界面上可见，而非只写在接口里 -->
    <p class="alert alert-info" data-testid="source-notice">{{ model.sourceNotice }}</p>

    <ul class="stat-strip">
      <li v-for="stat in model.stats" :key="stat.key" :data-testid="`stat-${stat.key}`">
        <span class="stat-value">{{ stat.value }}</span>
        <span class="stat-label muted">{{ stat.label }}</span>
      </li>
    </ul>

    <p v-if="model.noDataCount > 0" class="alert alert-warning alert-prominent" data-testid="nodata-notice">
      有 <strong>{{ model.noDataCount }}</strong> 项指标<strong>{{ NO_DATA_LABEL }}</strong>（来源模块未供给/未同步），
      偏差一并无法计算——EBMS 不兜底计算，实际值只来自专业 Owner 模块的 Result。
    </p>

    <p v-if="model.traceabilityNotice" class="alert alert-ok" data-testid="traceability-notice">
      {{ model.traceabilityNotice }}
    </p>

    <table class="data-table metric-table">
      <caption class="muted">
        目标值与实际值均为专业 Owner 模块口径，偏差值按「{{ DEVIATION_LABEL }}」计算
      </caption>
      <thead>
        <tr>
          <th>指标</th>
          <th>实际值来源（Owner）</th>
          <th>目标值</th>
          <th>实际值</th>
          <th>{{ DEVIATION_LABEL }}</th>
          <th>数据截止</th>
          <th>口径版本 · 证据</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="tile in model.tiles" :key="tile.id" data-testid="metric-row" :data-code="tile.code">
          <td>
            <div class="strong">{{ tile.name }}</div>
            <div class="muted">{{ tile.code }} · {{ tile.dimensionLabel }}</div>
            <span
              v-if="tile.exceeded"
              class="badge badge-warn"
              data-testid="metric-exceeded"
              :title="`|偏差率| 超过阈值 ${tile.thresholdPct}%`"
            >超阈值</span>
          </td>
          <td>
            <span class="tag">{{ tile.ownerModule || '未声明' }}</span>
            <div class="muted owner-scope" :title="tile.ownerScope || tile.ownerLabel">{{ tile.ownerLabel }}</div>
          </td>
          <td data-testid="metric-target">{{ tile.targetText }}</td>
          <td data-testid="metric-actual">
            <span v-if="tile.noData" class="nodata-mark" data-testid="metric-nodata">{{ NO_DATA_LABEL }}</span>
            <span v-else class="strong">{{ tile.actualText }}</span>
            <div v-if="tile.noData" class="muted no-data-reason" data-testid="metric-nodata-reason">
              （{{ tile.noDataReason }}）
            </div>
          </td>
          <td data-testid="metric-deviation">
            <div :class="{ 'warn-inline': tile.exceeded }">
              {{ tile.deviationText }}
              <span v-if="tile.deviationPctText">（{{ tile.deviationPctText }}）</span>
            </div>
            <span v-if="tile.attainmentLabel" class="muted">{{ tile.attainmentLabel }}</span>
          </td>
          <td class="muted">{{ tile.cutoff || '—' }}</td>
          <td>
            <div class="trace-line">
              <span class="muted">口径版本</span>
              <span data-testid="metric-version" class="strong">{{ tile.calculationVersion || NO_DATA_LABEL }}</span>
            </div>
            <div class="trace-line">
              <span class="muted">结果标识</span>
              <span data-testid="metric-result-id">{{ tile.resultId || NO_DATA_LABEL }}</span>
            </div>
            <div v-if="tile.evidence.length" class="evidence-chips">
              <template v-for="ref in tile.evidence" :key="ref.id">
                <a
                  v-if="ref.href"
                  class="evidence-chip"
                  data-testid="evidence-chip"
                  :href="ref.href"
                  :title="`${ref.typeLabel} · ${ref.id}`"
                >{{ ref.title }}</a>
                <span v-else class="evidence-chip unresolved" data-testid="evidence-chip-unresolved" :title="ref.id">
                  {{ ref.title }}
                </span>
              </template>
            </div>
            <div v-else class="muted" data-testid="metric-evidence-empty">无证据引用</div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
