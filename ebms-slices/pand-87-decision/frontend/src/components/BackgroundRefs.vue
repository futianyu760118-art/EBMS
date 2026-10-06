<script setup>
import { domainLabel } from '../lib/format';

// 场景 1：决策「背景」必须可回溯到 Result / Reason（四层穿透 Reason→Result 一段）。
// available=false 表示关联对象已不存在（如源数据被撤），仍如实展示引用而不隐藏。
defineProps({
  refs: { type: Array, default: () => [] },
  title: { type: String, default: '决策背景' },
});
</script>

<template>
  <section class="ebms-block" data-test="background">
    <h3 data-test="background-title">{{ title }}</h3>
    <ul class="ebms-refs" data-test="background-refs">
      <li
        v-for="ref in refs"
        :key="`${ref.type}-${ref.id}`"
        class="ebms-ref"
        :class="{ 'is-missing': ref.available === false }"
        :data-test="`background-ref-${ref.type}`"
      >
        <span class="ebms-ref-type">{{ ref.typeLabel || (ref.type === 'result' ? '经营结果' : '原因项') }}</span>
        <span class="ebms-ref-label">{{ ref.label || '（引用已失效）' }}</span>
        <span v-if="ref.domain" class="ebms-ref-domain">{{ domainLabel(ref.domain) }}</span>
      </li>
    </ul>
    <p v-if="!refs.length" class="ebms-muted" data-test="background-refs-empty">
      未关联经营结果或原因项。
    </p>
  </section>
</template>
