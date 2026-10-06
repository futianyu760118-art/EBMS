<script setup>
import { computed } from 'vue';

import { DIRECTION_LABELS } from '../stores/reasonDrilldown.js';

// 关联入口表单：引用 Exception 即映射；否则按 M03 自有归因分析登记（边界 2 的兜底入口）。
const props = defineProps({
  form: { type: Object, required: true },
  submitting: { type: Boolean, default: false },
  error: { type: Object, default: null },
  parentId: { type: String, default: null },
  directions: { type: Array, default: () => [] },
});
const emit = defineEmits(['update', 'submit', 'cancel']);

const directionOptions = computed(() =>
  props.directions.length
    ? props.directions
    : Object.entries(DIRECTION_LABELS).map(([value, label]) => ({ value, label })),
);
</script>

<template>
  <form class="reason-form" @submit.prevent="emit('submit')">
    <p class="reason-form__hint">
      引用 Exception 即「映射至 Exception」；留空则按
      <strong>M03 自有归因分析</strong> 登记（缺少 reason_code / severity 时也走此路）。
      <span v-if="parentId">细分层级：<code>{{ parentId }}</code></span>
    </p>

    <div class="reason-form__grid">
      <label>
        <span>exceptionRef（可选）</span>
        <input
          :value="form.exceptionRef"
          placeholder="EXC-SALES-001"
          @input="emit('update', { exceptionRef: $event.target.value })"
        />
      </label>
      <label>
        <span>name（M03 自有归因分析）</span>
        <input
          :value="form.name"
          placeholder="渠道结构变化"
          @input="emit('update', { name: $event.target.value })"
        />
      </label>
      <label>
        <span>影响方向</span>
        <select
          :value="form.direction"
          @change="emit('update', { direction: $event.target.value })"
        >
          <option v-for="option in directionOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label>
        <span>贡献占比 %</span>
        <input
          :value="form.contributionPct"
          type="number"
          min="0"
          max="100"
          step="0.1"
          placeholder="30"
          @input="emit('update', { contributionPct: $event.target.value })"
        />
      </label>
      <label>
        <span>影响量</span>
        <input
          :value="form.impactValue"
          type="number"
          step="0.01"
          placeholder="-12"
          @input="emit('update', { impactValue: $event.target.value })"
        />
      </label>
      <label>
        <span>责任方</span>
        <input
          :value="form.owner"
          placeholder="销售中心"
          @input="emit('update', { owner: $event.target.value })"
        />
      </label>
    </div>

    <p v-if="error" class="error">{{ error.message }}（{{ error.code }}）</p>

    <div class="reason-form__actions">
      <button type="submit" class="query__submit" :disabled="submitting">
        {{ submitting ? '提交中…' : '关联原因' }}
      </button>
      <button type="button" class="jump" @click="emit('cancel')">取消</button>
    </div>
  </form>
</template>
