<script setup>
import { computed, onMounted, ref } from 'vue';
import { domainLabel } from '../lib/format';

// 场景 1 的录入口径：背景（至少关联 1 条结果/原因）+ 候选方案（≥1） + 所需证据（可空）。
// 新建的决策一律为「待决策」—— 结论由 ConclusionForm 单独形成，二者不混在一步。
const props = defineProps({
  refs: { type: Object, default: () => ({ results: [], reasons: [], evidences: [] }) },
  defaultDomain: { type: String, default: '' },
  allowedDomains: { type: Array, default: () => ['sales', 'production', 'finance', 'supply_chain'] },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(['submit', 'cancel']);

const title = ref('');
const domain = ref(props.defaultDomain || props.allowedDomains[0] || 'production');
const background = ref('');
const selectedRefKeys = ref([]);
const optionNames = ref(['']);
const selectedEvidenceIds = ref([]);
const error = ref('');

onMounted(() => {
  if (!props.defaultDomain && props.refs.results.length) {
    domain.value = props.refs.results[0].domain;
  }
});

const candidateRefs = computed(() => [
  ...props.refs.results.map((item) => ({ ...item, refKey: `result:${item.id}` })),
  ...props.refs.reasons.map((item) => ({ ...item, refKey: `reason:${item.id}` })),
]);

const refsByDomain = computed(() => {
  const groups = new Map();
  for (const item of candidateRefs.value) {
    const key = item.domain || 'all';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()];
});

const canSubmit = computed(
  () => !!title.value.trim() && !!background.value.trim()
    && selectedRefKeys.value.length >= 1
    && optionNames.value.some((name) => name.trim())
    && !props.busy
);

function toggleRef(refKey) {
  const index = selectedRefKeys.value.indexOf(refKey);
  if (index >= 0) selectedRefKeys.value.splice(index, 1);
  else selectedRefKeys.value.push(refKey);
}

function addOption() {
  optionNames.value.push('');
}

function removeOption(index) {
  if (optionNames.value.length <= 1) return;
  optionNames.value.splice(index, 1);
}

function submit() {
  error.value = '';
  if (!title.value.trim()) {
    error.value = '请填写决策事项';
    return;
  }
  if (!background.value.trim()) {
    error.value = '请填写决策背景';
    return;
  }
  if (!selectedRefKeys.value.length) {
    error.value = '决策背景必须至少关联 1 条经营结果或原因项';
    return;
  }
  const options = optionNames.value
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
  if (!options.length) {
    error.value = '候选方案至少 1 条';
    return;
  }
  emit('submit', {
    title: title.value.trim(),
    domain: domain.value,
    background: background.value.trim(),
    related_refs: selectedRefKeys.value.map((refKey) => {
      const [type, id] = refKey.split(':');
      return { type, id };
    }),
    options,
    required_evidence_ids: [...selectedEvidenceIds.value],
  });
}
</script>

<template>
  <section class="ebms-card ebms-create" data-test="create-form">
    <h2>创建决策</h2>
    <form @submit.prevent="submit">
      <label>
        决策事项
        <input v-model="title" data-test="create-title" placeholder="本次需要决策的问题" />
      </label>

      <label>
        责任域
        <select v-model="domain" data-test="create-domain">
          <option v-for="item in allowedDomains" :key="item" :value="item">{{ domainLabel(item) }}</option>
        </select>
      </label>

      <label>
        决策背景
        <textarea v-model="background" rows="3" data-test="create-background"
          placeholder="说明偏差、归因与决策必要性"></textarea>
      </label>

      <fieldset class="ebms-fieldset" data-test="create-refs">
        <legend>背景关联（至少 1 条）</legend>
        <div v-for="[groupDomain, items] in refsByDomain" :key="groupDomain" class="ebms-ref-group">
          <div class="ebms-ref-group-title">{{ domainLabel(groupDomain) }}</div>
          <label v-for="item in items" :key="item.refKey" class="ebms-check">
            <input
              type="checkbox"
              :value="item.refKey"
              :data-test="`create-ref-${item.type}`"
              :checked="selectedRefKeys.includes(item.refKey)"
              @change="toggleRef(item.refKey)"
            />
            <span class="ebms-tag">{{ item.type === 'result' ? '经营结果' : '原因项' }}</span>
            {{ item.label }}
          </label>
        </div>
      </fieldset>

      <fieldset class="ebms-fieldset" data-test="create-options">
        <legend>候选方案（至少 1 条）</legend>
        <div v-for="(_, index) in optionNames" :key="index" class="ebms-option-row">
          <input
            v-model="optionNames[index]"
            :data-test="`create-option-${index}`"
            :placeholder="`候选方案 ${index + 1}`"
          />
          <button
            type="button"
            class="ebms-link-btn"
            data-test="create-option-remove"
            @click="removeOption(index)"
          >删除</button>
        </div>
        <button type="button" class="ebms-link-btn" data-test="create-option-add" @click="addOption">
          增加候选方案
        </button>
      </fieldset>

      <fieldset class="ebms-fieldset" data-test="create-evidences">
        <legend>所需证据（可空 = 无需外部证据）</legend>
        <label v-for="item in refs.evidences" :key="item.id" class="ebms-check">
          <input
            type="checkbox"
            :value="item.id"
            v-model="selectedEvidenceIds"
            data-test="create-evidence"
          />
          <span class="ebms-tag">{{ item.typeLabel || item.type }}</span>
          {{ item.title }}
        </label>
      </fieldset>

      <div class="ebms-create-actions">
        <button type="submit" :disabled="!canSubmit" data-test="create-submit">
          {{ busy ? '提交中…' : '创建决策' }}
        </button>
        <button type="button" data-test="create-cancel" @click="$emit('cancel')">取消</button>
      </div>
      <p v-if="error" class="ebms-error" data-test="create-error">{{ error }}</p>
    </form>
  </section>
</template>
