<script setup>
// F5（PAND-83）断点提示：某段缺失时展示断点说明 + 补录入口。
// 断点只标注该段，不阻断其余段查看（不弹窗、不挡路、不跳走）。
import { refillTargetLabel } from '../trace-nav';

defineProps({
  layer: { type: Object, required: true },
});

defineEmits(['refill']);
</script>

<template>
  <div v-if="layer.status === 'MISSING' && layer.breakpoint" class="alert alert-warning trace-breakpoint" data-testid="breakpoint">
    <div class="trace-breakpoint-head">
      <span class="badge badge-warn" data-testid="breakpoint-label">{{ layer.breakpoint.label }}</span>
      <span class="muted">第 {{ layer.index }} 段「{{ layer.label }}」为断点，不影响其余段查看</span>
    </div>
    <p class="trace-breakpoint-msg" data-testid="breakpoint-message">{{ layer.breakpoint.message }}</p>
    <div class="trace-breakpoint-actions">
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        data-testid="breakpoint-refill"
        :data-refill-action="layer.breakpoint.refill?.action || ''"
        @click="$emit('refill', layer.breakpoint.refill)"
      >
        {{ layer.breakpoint.refill?.label || '补录' }}
      </button>
      <span class="muted" data-testid="breakpoint-refill-target">
        补录入口：{{ refillTargetLabel(layer.breakpoint.refill) }}
      </span>
    </div>
  </div>
</template>
