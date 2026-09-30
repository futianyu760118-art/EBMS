<script setup>
// F8（PAND-86）人工派发对话框：TODO 两种来源之一「人工派发」的录入入口。
// 关联结果或原因只提交 { refType, refId }，展示文案由服务端回源解析（前端不上传 label）。
import { reactive, ref } from 'vue';
import { api } from '../api/client';

const props = defineProps({
  relatedRefTypes: { type: Array, required: true },
  metrics: { type: Array, default: () => [] },
  reasons: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'created']);

const form = reactive({
  title: '',
  owner: '',
  dueAt: '',
  refType: props.relatedRefTypes[0]?.code || 'result',
  refId: '',
});
const submitting = ref(false);
const error = ref('');
const fieldErrors = ref({});

function candidates() {
  return form.refType === 'result' ? props.metrics : props.reasons;
}

async function submit() {
  error.value = '';
  fieldErrors.value = {};
  submitting.value = true;
  try {
    const relatedRefs = form.refId ? [{ refType: form.refType, refId: form.refId }] : [];
    const result = await api.createTodo({
      title: form.title,
      owner: form.owner,
      // 以本地时间语义提交，避免时区偏移
      dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
      relatedRefs,
    });
    emit('created', result);
  } catch (err) {
    error.value = err.message;
    fieldErrors.value = err.details?.fields || {};
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="人工派发待办">
      <header class="dialog-header">
        <h2>人工派发待办</h2>
        <button class="btn btn-ghost" type="button" @click="emit('close')">关闭</button>
      </header>

      <p class="muted">
        来源为<strong>人工派发</strong>；规则自动产生的待办由规则扫描写入，不在此录入。
      </p>

      <form class="form" @submit.prevent="submit">
        <label class="field">
          <span>事项 <em>*</em></span>
          <input v-model="form.title" type="text" placeholder="例如：补齐华东渠道压货的整改方案" />
          <span v-if="fieldErrors.title" class="field-error">{{ fieldErrors.title }}</span>
        </label>

        <label class="field">
          <span>责任人 <em>*</em></span>
          <input v-model="form.owner" type="text" placeholder="例如：销售中心 / 孙渠道" />
          <span v-if="fieldErrors.owner" class="field-error">{{ fieldErrors.owner }}</span>
        </label>

        <label class="field">
          <span>截止时间</span>
          <input v-model="form.dueAt" type="datetime-local" />
          <span v-if="fieldErrors.dueAt" class="field-error">{{ fieldErrors.dueAt }}</span>
        </label>

        <label class="field">
          <span>关联结果或原因</span>
          <select v-model="form.refType">
            <option v-for="t in relatedRefTypes" :key="t.code" :value="t.code">{{ t.label }}</option>
          </select>
        </label>

        <label class="field">
          <span>选择{{ form.refType === 'result' ? '结果指标' : '原因项' }}</span>
          <select v-model="form.refId">
            <option value="">（不关联）</option>
            <option v-for="c in candidates()" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <span v-if="fieldErrors.relatedRefs" class="field-error">{{ fieldErrors.relatedRefs }}</span>
        </label>

        <p v-if="error" class="alert alert-error">{{ error }}</p>

        <footer class="dialog-footer">
          <button class="btn btn-ghost" type="button" @click="emit('close')">取消</button>
          <button class="btn btn-primary" type="submit" :disabled="submitting">
            {{ submitting ? '提交中…' : '派发' }}
          </button>
        </footer>
      </form>
    </section>
  </div>
</template>
