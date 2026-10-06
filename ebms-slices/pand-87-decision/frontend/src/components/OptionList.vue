<script setup>
import { optionLabel } from '../lib/decision-view';

// 场景 1：候选方案 ≥ 1 条。options[].id 便于后续与结论对应，展示时按 A/B/C 编号。
defineProps({
  options: { type: Array, default: () => [] },
});
</script>

<template>
  <section class="ebms-block" data-test="options">
    <h3>候选方案<span class="ebms-muted">（{{ options.length }} 项）</span></h3>
    <ul class="ebms-options" data-test="option-list">
      <li v-for="(option, index) in options" :key="option.id || index" class="ebms-option" data-test="option">
        <div class="ebms-option-head">
          <span class="ebms-option-index">{{ optionLabel(index) }}</span>
          <span class="ebms-option-name" data-test="option-name">{{ option.name }}</span>
        </div>
        <p v-if="option.summary" class="ebms-option-summary" data-test="option-summary">{{ option.summary }}</p>
        <ul v-if="option.pros && option.pros.length" class="ebms-option-pros">
          <li v-for="(pro, i) in option.pros" :key="i">利：{{ pro }}</li>
        </ul>
        <ul v-if="option.cons && option.cons.length" class="ebms-option-cons">
          <li v-for="(con, i) in option.cons" :key="i">弊：{{ con }}</li>
        </ul>
      </li>
    </ul>
    <p v-if="!options.length" class="ebms-muted" data-test="option-list-empty">
      尚未登记候选方案（决策须至少 1 条候选方案）。
    </p>
  </section>
</template>
