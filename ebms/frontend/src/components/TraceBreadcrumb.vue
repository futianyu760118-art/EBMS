<script setup>
// F5（PAND-83）四层面包屑：段数与导航段数一致（固定四段），不因数据缺段而增减。
// 纯展示：逐层返回由工具栏的「返回上一层」按钮驱动，面包屑只标注段序与段契约。
defineProps({
  items: { type: Array, required: true },
});
</script>

<template>
  <nav class="trace-crumb" data-testid="trace-breadcrumb" aria-label="四层链路导航">
    <template v-for="item in items" :key="item.key">
      <span
        class="trace-crumb-seg"
        :class="[`is-${item.nav}`, { 'is-breakpoint': item.status === 'MISSING' }]"
        :data-testid="`crumb-${item.key}`"
        :data-nav="item.nav"
        :data-status="item.status"
        :data-contract="item.contractRef || ''"
        :title="item.contractRef ? `对应契约：${item.contractRef}` : ''"
      >
        <span class="trace-crumb-index">{{ item.index }}</span>
        <span class="trace-crumb-label">{{ item.label }}</span>
        <span v-if="item.status === 'MISSING'" class="trace-crumb-dot" data-testid="crumb-breakpoint">断点</span>
      </span>
      <span v-if="item.index < items.length" class="trace-crumb-sep" aria-hidden="true">›</span>
    </template>
  </nav>
</template>
