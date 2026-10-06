<script setup>
import { computed } from 'vue';
import { statusLabel } from '../lib/decision-view';

const props = defineProps({
  status: { type: String, required: true },
  label: { type: String, default: '' },
});

const text = computed(() => props.label || statusLabel(props.status));
</script>

<template>
  <span
    class="ebms-status"
    :class="`is-${status}`"
    data-test="decision-status"
    :data-status="status"
  >{{ text }}</span>
</template>
