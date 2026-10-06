<script setup>
import { executionSummary } from '../lib/decision-view';
import { formatDate, overdueDays } from '../lib/format';

// 场景 3：决策可关联其执行产生的 TODO，并可回看执行结果。
// 本组件只读取 F8 TODO 域的现状与流转留痕，不做决策效果评价（口径：不强制）。
defineProps({
  execution: {
    type: Object,
    default: () => ({ total: 0, done: 0, progressPct: 0, items: [], note: '', overdue: 0 }),
  },
});

defineEmits(['unlink']);

function isOverdue(todo) {
  return todo.overdue && todo.status !== 'done';
}
</script>

<template>
  <section class="ebms-block" data-test="execution">
    <h3>执行情况<span class="ebms-muted">（{{ executionSummary(execution) }}）</span></h3>

    <ol class="ebms-todos" data-test="execution-list">
      <li v-for="todo in execution.items" :key="todo.id" class="ebms-todo" data-test="execution-item">
        <div class="ebms-todo-head">
          <span class="ebms-todo-title" data-test="execution-title">{{ todo.title }}</span>
          <span class="ebms-status" :class="`is-todo-${todo.status}`" data-test="execution-status">
            {{ todo.statusLabel }}
          </span>
          <span v-if="isOverdue(todo)" class="ebms-flag" data-test="execution-overdue">
            已逾期 {{ overdueDays(todo.dueAt) }} 天
          </span>
        </div>
        <div class="ebms-todo-foot">
          <span>责任人：{{ todo.owner || '—' }}</span>
          <span>截止：{{ formatDate(todo.dueAt) }}</span>
          <span class="ebms-tag" data-test="execution-source">{{ todo.sourceLabel }}</span>
          <ul v-if="todo.relatedRefs && todo.relatedRefs.length" class="ebms-refs is-inline" data-test="execution-refs">
            <li v-for="ref in todo.relatedRefs" :key="ref.id" class="ebms-ref">
              {{ ref.label || ref.id }}
            </li>
          </ul>
          <button
            type="button"
            class="ebms-link-btn"
            data-test="execution-unlink"
            @click="$emit('unlink', todo.id)"
          >解除关联</button>
        </div>
        <ul v-if="todo.history && todo.history.length" class="ebms-todo-history" data-test="execution-history">
          <li v-for="(entry, index) in todo.history" :key="index">
            {{ entry.actorName || '系统' }} · {{ entry.action }} · {{ formatDate(entry.at) }}
          </li>
        </ul>
      </li>
    </ol>

    <p v-if="!execution.total" class="ebms-muted" data-test="execution-empty">
      {{ execution.note || '尚未关联执行 TODO。' }}
    </p>
    <p v-else class="ebms-muted ebms-note" data-test="execution-note">{{ execution.note }}</p>
  </section>
</template>
