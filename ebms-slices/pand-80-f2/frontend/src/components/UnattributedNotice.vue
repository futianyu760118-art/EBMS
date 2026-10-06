<script setup>
// 边界 1：指标无关联原因时显示「未归因」+ 可操作的关联入口，而不是一个空列表。
defineProps({
  empty: { type: Object, required: true },
  linkEntry: { type: Object, required: true },
});
const emit = defineEmits(['link']);
</script>

<template>
  <section class="empty" role="status">
    <h3 class="empty__title">{{ empty.title }}</h3>
    <p class="empty__hint">{{ empty.message }}</p>
    <p class="empty__keep">{{ empty.hint }}</p>
    <button type="button" class="query__submit" @click="emit('link')">
      {{ linkEntry.label }}（{{ linkEntry.method }}）
    </button>
    <p class="empty__policy">
      不显示空列表，也不回落到专业原始表查询
    </p>
  </section>
</template>
