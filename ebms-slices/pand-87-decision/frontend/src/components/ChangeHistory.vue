<script setup>
import { changeActionLabel, conclusionDiff } from '../lib/decision-view';
import { formatDateTime } from '../lib/format';

// 场景 2：决策结论不可静默修改 —— 每次修改都必须在变更历史里留下
// 变更人 / 变更时间 / 变更前后值，因此本组件是「留痕」的对外可见形态。
defineProps({
  changes: { type: Array, default: () => [] },
  changeCount: { type: Number, default: 0 },
  conclusionChangeCount: { type: Number, default: 0 },
});
</script>

<template>
  <section class="ebms-block" data-test="change-history">
    <h3>
      变更记录
      <span class="ebms-muted" data-test="change-count">
        （共 {{ changeCount }} 条，其中结论变更 {{ conclusionChangeCount }} 次）
      </span>
    </h3>
    <ol class="ebms-changes" data-test="change-list">
      <li
        v-for="change in changes"
        :key="change.id"
        class="ebms-change"
        :class="{ 'is-conclusion': change.conclusionChanged }"
        data-test="change-item"
        :data-action="change.action"
      >
        <div class="ebms-change-head">
          <span class="ebms-change-action" data-test="change-action">
            {{ change.actionLabel || changeActionLabel(change.action) }}
          </span>
          <span class="ebms-change-meta" data-test="change-meta">
            {{ change.changedByName || '未知' }} · {{ formatDateTime(change.changedAt) }}
          </span>
        </div>

        <template v-if="conclusionDiff(change)">
          <div class="ebms-change-diff" data-test="change-diff">
            <div class="ebms-diff-before" data-test="change-before">
              <span class="ebms-diff-label">变更前</span>
              <p>{{ conclusionDiff(change).before || '（原无结论）' }}</p>
            </div>
            <div class="ebms-diff-after" data-test="change-after">
              <span class="ebms-diff-label">变更后</span>
              <p>{{ conclusionDiff(change).after }}</p>
            </div>
          </div>
        </template>

        <p v-if="change.reason" class="ebms-change-reason" data-test="change-reason">
          变更理由：{{ change.reason }}
        </p>
        <p v-else-if="change.conclusionChanged" class="ebms-change-reason is-warn" data-test="change-reason-missing">
          未记录变更理由
        </p>
      </li>
    </ol>
    <p v-if="!changes.length" class="ebms-muted" data-test="change-list-empty">
      暂无变更记录。
    </p>
  </section>
</template>
