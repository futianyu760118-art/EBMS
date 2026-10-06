<script setup>
import { computed, ref, watch } from 'vue';
import { isDecided } from '../lib/decision-view';

// 场景 2 的界面口径：已形成结论后再修改，必须填写变更理由，
// 否则提交按钮不可用 —— 从交互上堵住「静默修改」，与后端 400 拒绝互为兜底。
const props = defineProps({
  decision: { type: Object, required: true },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(['submit']);

const conclusion = ref('');
const reason = ref('');
const error = ref('');
// 提示只在用户实际改动后出现：刚打开页面就报错会把「还没改」误报成「改错了」
const touched = ref(false);

const revising = computed(() => isDecided(props.decision));
// 修改模式下理由为空即不可提交（首次形成结论无需理由）
const reasonMissing = computed(() => revising.value && !reason.value.trim());
const unchanged = computed(
  () => revising.value && conclusion.value.trim() === (props.decision.conclusion || '').trim()
);
const canSubmit = computed(
  () => !!conclusion.value.trim() && !reasonMissing.value && !unchanged.value && !props.busy
);

const showUnchanged = computed(() => touched.value && unchanged.value);
const showReasonRequired = computed(
  () => touched.value && revising.value && !unchanged.value
    && !!conclusion.value.trim() && !reason.value.trim()
);

watch(
  () => props.decision.conclusion,
  (value) => {
    conclusion.value = value || '';
    reason.value = '';
    error.value = '';
    touched.value = false;
  },
  { immediate: true }
);

function onEdit() {
  touched.value = true;
  error.value = '';
}

function submit() {
  error.value = '';
  if (!conclusion.value.trim()) {
    error.value = '请填写决策结论';
    return;
  }
  if (unchanged.value) {
    error.value = '决策结论未发生变化，无需修改';
    return;
  }
  if (reasonMissing.value) {
    error.value = '修改已有决策结论必须填写变更理由 —— 决策结论不可静默修改';
    return;
  }
  emit('submit', {
    conclusion: conclusion.value.trim(),
    ...(revising.value ? { reason: reason.value.trim() } : {}),
  });
}
</script>

<template>
  <section class="ebms-block ebms-conclusion-form" data-test="conclusion-form">
    <h3>{{ revising ? '修改决策结论' : '形成决策结论' }}</h3>

    <p v-if="revising" class="ebms-muted" data-test="conclusion-hint">
      本次提交将记入变更记录（变更人、时间、变更前后值）；修改已有结论必须填写变更理由
      —— 决策结论不可静默修改。
    </p>

    <form @submit.prevent="submit">
      <label>
        决策结论
        <textarea
          v-model="conclusion"
          rows="3"
          data-test="conclusion-input"
          placeholder="记录本次决策的结论"
          @input="onEdit"
        ></textarea>
      </label>

      <label v-if="revising">
        变更理由（必填）
        <input
          v-model="reason"
          data-test="conclusion-reason"
          placeholder="说明修改结论的依据"
          @input="onEdit"
        />
      </label>

      <div class="ebms-create-actions">
        <button type="submit" :disabled="!canSubmit" data-test="conclusion-submit">
          {{ busy ? '提交中…' : (revising ? '提交修改' : '形成结论') }}
        </button>
      </div>
      <p v-if="error" class="ebms-error" data-test="conclusion-error">{{ error }}</p>
      <p v-else-if="showUnchanged" class="ebms-muted" data-test="conclusion-unchanged">
        结论未发生变化，无需提交（不会产生变更记录）。
      </p>
      <p v-else-if="showReasonRequired" class="ebms-error" data-test="conclusion-reason-required">
        修改已有决策结论必须填写变更理由。
      </p>
    </form>
  </section>
</template>
