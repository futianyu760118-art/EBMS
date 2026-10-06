<script setup>
// 边界：暂无决策记录时显示空态与创建入口
defineEmits(['create']);
defineProps({
  description: {
    type: String,
    default: '当前筛选条件下暂无决策记录。',
  },
});
</script>

<template>
  <section class="ebms-card ebms-empty" data-test="empty-state">
    <h2>暂无决策</h2>
    <p data-test="empty-description">{{ description }}</p>
    <button type="button" data-test="create-decision" @click="$emit('create')">
      创建决策
    </button>
  </section>
</template>
