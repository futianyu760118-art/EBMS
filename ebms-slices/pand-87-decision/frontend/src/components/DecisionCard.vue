<script setup>
import StatusBadge from './StatusBadge.vue';
import { domainLabel, formatDateTime } from '../lib/format';

// 列表项：场景 1 的「结论 / 决策人 / 决策时间」与场景 2 的「变更次数」在列表上即可见，
// 无需点进详情才能判断一条决策是否已成立。
defineProps({
  decision: { type: Object, required: true },
});
</script>

<template>
  <article class="ebms-card ebms-decision" data-test="decision-card" :data-decision-id="decision.id">
    <header class="ebms-decision-head">
      <router-link
        class="ebms-decision-title"
        data-test="decision-title"
        :to="{ name: 'decision-detail', params: { id: decision.id } }"
      >{{ decision.title }}</router-link>
      <StatusBadge :status="decision.status" :label="decision.statusLabel" />
      <span class="ebms-tag" data-test="decision-domain">{{ domainLabel(decision.domain) }}</span>
    </header>

    <p class="ebms-decision-background" data-test="decision-background">{{ decision.background }}</p>

    <p class="ebms-conclusion" data-test="decision-conclusion">
      <span class="ebms-diff-label">决策结论</span>
      <span v-if="decision.conclusion">{{ decision.conclusion }}</span>
      <span v-else class="ebms-muted" data-test="decision-conclusion-empty">
        尚未形成结论 —— 本条不计入已决策数量
      </span>
    </p>

    <dl class="ebms-decision-meta">
      <div data-test="decision-decider">
        <dt>决策人</dt>
        <dd>{{ decision.decider || '—' }}</dd>
      </div>
      <div data-test="decision-decided-at">
        <dt>决策时间</dt>
        <dd>{{ formatDateTime(decision.decidedAt) }}</dd>
      </div>
      <div data-test="decision-options">
        <dt>候选方案</dt>
        <dd>{{ decision.optionCount }} 项</dd>
      </div>
      <div data-test="decision-evidence">
        <dt>所需证据</dt>
        <dd>{{ decision.requiredEvidenceCount }} 项</dd>
      </div>
    </dl>

    <footer class="ebms-decision-foot">
      <span class="ebms-muted" data-test="decision-change-hint">
        共 {{ decision.changeCount || 0 }} 条变更记录，其中结论变更 {{ decision.conclusionChangeCount || 0 }} 次
      </span>
      <router-link
        class="ebms-open-detail"
        data-test="decision-open"
        :to="{ name: 'decision-detail', params: { id: decision.id } }"
      >查看详情</router-link>
    </footer>
  </article>
</template>
