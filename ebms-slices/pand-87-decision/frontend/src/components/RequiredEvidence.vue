<script setup>
import { formatDate } from '../lib/format';

// 场景 1：决策须记录「所需 Evidence」。字段为空即表示本决策无需外部证据（不视为缺失）。
// provided=false 表示所需证据当前在 F3 证据域中不存在 —— 只提示，不阻断决策形成。
defineProps({
  evidence: { type: Array, default: () => [] },
  summary: { type: Object, default: () => ({ required: 0, provided: 0, missing: 0 }) },
});
</script>

<template>
  <section class="ebms-block" data-test="required-evidence">
    <h3>
      所需证据
      <span class="ebms-muted" data-test="evidence-summary">
        （需 {{ summary.required }} 项，已备 {{ summary.provided }} 项<span v-if="summary.missing">，缺 {{ summary.missing }} 项</span>）
      </span>
    </h3>
    <ul class="ebms-evidence" data-test="evidence-list">
      <li
        v-for="item in evidence"
        :key="item.id"
        class="ebms-evidence-item"
        :class="{ 'is-missing': !item.provided }"
        data-test="evidence-item"
      >
        <div class="ebms-evidence-head">
          <span class="ebms-evidence-title" data-test="evidence-title">
            {{ item.title || '（证据已不存在）' }}
          </span>
          <span class="ebms-tag">{{ item.typeLabel || item.type }}</span>
          <span class="ebms-evidence-flag" data-test="evidence-flag">
            {{ item.provided ? '已具备' : '缺失' }}
          </span>
        </div>
        <div class="ebms-evidence-foot">
          <span v-if="item.owner">提供方：{{ item.owner }}</span>
          <span v-if="item.formedAt">形成时间：{{ formatDate(item.formedAt) }}</span>
        </div>
      </li>
    </ul>
    <p v-if="!evidence.length" class="ebms-muted" data-test="evidence-list-empty">
      本决策无需外部证据。
    </p>
  </section>
</template>
