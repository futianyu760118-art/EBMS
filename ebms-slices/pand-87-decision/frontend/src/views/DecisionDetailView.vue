<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api/client';
import { domainLabel, formatDateTime } from '../lib/format';
import { isDecided } from '../lib/decision-view';
import StatusBadge from '../components/StatusBadge.vue';
import BackgroundRefs from '../components/BackgroundRefs.vue';
import OptionList from '../components/OptionList.vue';
import RequiredEvidence from '../components/RequiredEvidence.vue';
import ExecutionTodos from '../components/ExecutionTodos.vue';
import ChangeHistory from '../components/ChangeHistory.vue';
import ConclusionForm from '../components/ConclusionForm.vue';

const props = defineProps({
  id: { type: String, required: true },
});

const decision = ref(null);
const loading = ref(false);
const error = ref('');
const busy = ref(false);
const notice = ref('');

const showLink = ref(false);
const candidates = ref([]);
const linking = ref(false);

// 结论字段：已决策条目必展示 决策人 / 决策时间（判定标准）
const conclusionMeta = computed(() => {
  if (!decision.value) return null;
  return {
    decider: decision.value.decider || '—',
    decidedAt: formatDateTime(decision.value.decidedAt),
    present: decision.value.decidedFieldsPresent,
  };
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    decision.value = await api.getDecision(props.id);
  } catch (err) {
    error.value = err.message || '加载决策详情失败';
  } finally {
    loading.value = false;
  }
}

async function submitConclusion(payload) {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    decision.value = await api.saveConclusion(props.id, payload);
    notice.value = isDecided(decision.value) ? '决策结论已保存并记入变更记录。' : '';
  } catch (err) {
    error.value = err.message || '保存决策结论失败';
  } finally {
    busy.value = false;
  }
}

async function openLink() {
  showLink.value = true;
  linking.value = true;
  error.value = '';
  try {
    const result = await api.todoCandidates(props.id);
    candidates.value = result.items;
  } catch (err) {
    error.value = err.message || '加载可关联 TODO 失败';
  } finally {
    linking.value = false;
  }
}

const selectedTodoIds = ref([]);

function toggleTodo(id) {
  const index = selectedTodoIds.value.indexOf(id);
  if (index >= 0) selectedTodoIds.value.splice(index, 1);
  else selectedTodoIds.value.push(id);
}

async function linkSelected() {
  if (!selectedTodoIds.value.length) return;
  linking.value = true;
  error.value = '';
  try {
    decision.value = await api.linkExecutionTodos(props.id, { todo_ids: [...selectedTodoIds.value] });
    selectedTodoIds.value = [];
    showLink.value = false;
    notice.value = '已关联执行 TODO 并记入变更记录。';
  } catch (err) {
    error.value = err.message || '关联执行 TODO 失败';
  } finally {
    linking.value = false;
  }
}

async function dispatchTodo() {
  const draft = newTodo.value;
  if (!draft.title.trim() || !draft.owner.trim() || !draft.dueAt) {
    error.value = '派发执行 TODO 需填写标题、责任人与截止时间';
    return;
  }
  linking.value = true;
  error.value = '';
  try {
    decision.value = await api.linkExecutionTodos(props.id, {
      todos: [{ title: draft.title.trim(), owner: draft.owner.trim(), due_at: draft.dueAt }],
    });
    newTodo.value = { title: '', owner: '', dueAt: '' };
    showLink.value = false;
    notice.value = '已由决策派发执行 TODO 并记入变更记录。';
  } catch (err) {
    error.value = err.message || '派发执行 TODO 失败';
  } finally {
    linking.value = false;
  }
}

const newTodo = ref({ title: '', owner: '', dueAt: '' });

async function unlink(todoId) {
  error.value = '';
  try {
    decision.value = await api.unlinkExecutionTodo(props.id, todoId);
    notice.value = '已解除执行 TODO 关联并记入变更记录。';
  } catch (err) {
    error.value = err.message || '解除关联失败';
  }
}

onMounted(load);
</script>

<template>
  <section>
    <p class="ebms-breadcrumb">
      <router-link :to="{ name: 'decisions' }" data-test="back-to-list">← 返回决策列表</router-link>
    </p>

    <p v-if="loading" class="ebms-muted" data-test="detail-loading">加载中…</p>
    <p v-if="error" class="ebms-error" data-test="detail-error">{{ error }}</p>
    <p v-if="notice" class="ebms-notice" data-test="detail-notice">{{ notice }}</p>

    <template v-if="decision">
      <header class="ebms-card ebms-decision-detail-head">
        <div class="ebms-decision-head">
          <h1 data-test="detail-title">{{ decision.title }}</h1>
          <StatusBadge :status="decision.status" :label="decision.statusLabel" />
          <span class="ebms-tag" data-test="detail-domain">{{ domainLabel(decision.domain) }}</span>
        </div>

        <dl class="ebms-decision-meta">
          <div data-test="detail-decider">
            <dt>决策人</dt>
            <dd>{{ conclusionMeta.decider }}</dd>
          </div>
          <div data-test="detail-decided-at">
            <dt>决策时间</dt>
            <dd>{{ conclusionMeta.decidedAt }}</dd>
          </div>
          <div data-test="detail-created-at">
            <dt>创建时间</dt>
            <dd>{{ formatDateTime(decision.createdAt) }}</dd>
          </div>
        </dl>

        <section class="ebms-block">
          <h3>决策结论</h3>
          <p
            v-if="decision.conclusion"
            class="ebms-conclusion"
            data-test="detail-conclusion"
          >{{ decision.conclusion }}</p>
          <p v-else class="ebms-muted" data-test="detail-conclusion-pending">
            尚未形成决策结论 —— 本条为「待决策」，不计入已决策数量。
          </p>
          <p v-if="decision.decided && !conclusionMeta.present" class="ebms-error" data-test="detail-invariant-violation">
            已决策条目缺少决策人或决策时间，数据异常。
          </p>
        </section>

        <section class="ebms-block">
          <h3>决策背景</h3>
          <p class="ebms-conclusion" data-test="detail-background">{{ decision.background }}</p>
        </section>
      </header>

      <div class="ebms-card">
        <BackgroundRefs :refs="decision.relatedRefs" title="背景关联（结果 / 原因）" />
        <OptionList :options="decision.options" />
        <RequiredEvidence :evidence="decision.requiredEvidence" :summary="decision.evidenceSummary" />
      </div>

      <div class="ebms-card">
        <div class="ebms-block-head">
          <h3>执行 TODO</h3>
          <button type="button" data-test="open-link" @click="openLink">关联 / 派发执行 TODO</button>
        </div>

        <div v-if="showLink" class="ebms-link-panel" data-test="link-panel">
          <fieldset class="ebms-fieldset" data-test="link-existing">
            <legend>关联已有 TODO</legend>
            <p v-if="linking" class="ebms-muted">加载中…</p>
            <label
              v-for="todo in candidates"
              :key="todo.id"
              class="ebms-check"
              :class="{ 'is-linked-elsewhere': todo.linkedDecisionId && !todo.linkedHere }"
              data-test="candidate-item"
            >
              <input
                type="checkbox"
                :value="todo.id"
                :checked="selectedTodoIds.includes(todo.id)"
                @change="toggleTodo(todo.id)"
              />
              <span class="ebms-tag">{{ todo.statusLabel }}</span>
              {{ todo.title }}
              <span v-if="todo.linkedHere" class="ebms-muted" data-test="candidate-linked-here">（已关联本决策）</span>
              <span v-else-if="todo.linkedDecisionId" class="ebms-muted" data-test="candidate-linked-other">
                （已关联其他决策）
              </span>
            </label>
            <p v-if="!linking && !candidates.length" class="ebms-muted">暂无可关联的 TODO。</p>
            <button
              type="button"
              data-test="link-submit"
              :disabled="!selectedTodoIds.length || linking"
              @click="linkSelected"
            >关联所选 TODO</button>
          </fieldset>

          <fieldset class="ebms-fieldset" data-test="dispatch-new">
            <legend>由决策派发新 TODO</legend>
            <label>
              标题
              <input v-model="newTodo.title" data-test="dispatch-title" />
            </label>
            <label>
              责任人
              <input v-model="newTodo.owner" data-test="dispatch-owner" />
            </label>
            <label>
              截止时间
              <input v-model="newTodo.dueAt" type="datetime-local" data-test="dispatch-due" />
            </label>
            <button type="button" data-test="dispatch-submit" :disabled="linking" @click="dispatchTodo">
              派发 TODO
            </button>
          </fieldset>

          <button type="button" class="ebms-link-btn" data-test="link-cancel" @click="showLink = false">
            收起
          </button>
        </div>

        <ExecutionTodos :execution="decision.execution" @unlink="unlink" />
      </div>

      <div class="ebms-card">
        <ConclusionForm :decision="decision" :busy="busy" @submit="submitConclusion" />
        <ChangeHistory
          :changes="decision.changes"
          :change-count="decision.changeCount"
          :conclusion-change-count="decision.conclusionChangeCount"
        />
      </div>
    </template>
  </section>
</template>
