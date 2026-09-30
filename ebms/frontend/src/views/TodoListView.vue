<script setup>
// F8（PAND-86）TODO 待办视图：聚合待决策者 / 管理责任人处理的事项。
// 覆盖：场景 1 七列列表、场景 2 两种来源（含规则扫描与人工派发）、场景 3 认领/指派/状态流转、
// 场景 4 按责任人/状态/截止时间筛选与逾期区分标记。
// 落点：hash 路由 `#/todo/<id>`（与 F11 四视图同一套 hash 约定，可直接直达并可回退）。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api } from '../api/client';
import { buildTodoModel, buildTodoDetailModel, todoQuery } from '../todo-view';
import { parseHash } from '../view-nav';
import TodoDetailPanel from '../components/TodoDetailPanel.vue';
import TodoCreateDialog from '../components/TodoCreateDialog.vue';
import TodoTable from '../components/TodoTable.vue';

const loading = ref(true);
const error = ref('');
const model = ref(null);
const notice = ref('');

const meta = ref({ statuses: [], sources: [], relatedRefTypes: [] });
const metrics = ref([]);
const reasons = ref([]);

const filters = reactive({ owner: '', status: '', source: '', dueBefore: '', overdue: null });

const detail = ref(null);
const detailLoading = ref(false);
const detailError = ref('');
const actionBusy = ref(false);

const showCreate = ref(false);
const scanning = ref(false);

const hasDetail = computed(() => Boolean(detail.value?.row));

async function loadList() {
  loading.value = true;
  error.value = '';
  try {
    model.value = buildTodoModel(await api.todos(todoQuery(filters)));
  } catch (err) {
    error.value = err.message;
    model.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadMeta() {
  try {
    const payload = await api.todoMeta();
    meta.value = {
      statuses: payload.statuses ?? [],
      sources: payload.sources ?? [],
      relatedRefTypes: payload.relatedRefTypes ?? [],
    };
    // 人工派发时可关联「结果或原因」：两者都是 EBMS 已汇聚的结论，前端不做自由文本关联
    const [results, reasonList] = await Promise.all([api.results(), api.reasons()]);
    metrics.value = (results?.items ?? []).map((m) => ({ id: m.id, name: `${m.name}（${m.code}）` }));
    reasons.value = (reasonList ?? []).map((r) => ({ id: r.id, name: r.name }));
  } catch (err) {
    error.value = err.message;
  }
}

/** 详情单独拉取：列表行只带七列，留痕时间线与触发依据在详情里才有。 */
async function openDetail(id) {
  detailLoading.value = true;
  detailError.value = '';
  try {
    detail.value = buildTodoDetailModel(await api.todo(id));
  } catch (err) {
    detailError.value = err.message;
    detail.value = null;
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail() {
  detail.value = null;
  detailError.value = '';
  if (parseHash(location.hash)?.type === 'todo') location.hash = '';
}

async function runAction(label, action) {
  actionBusy.value = true;
  notice.value = '';
  try {
    const result = await action();
    const who = result?.audit?.actorName || result?.audit?.actor;
    notice.value = `${label}成功${who ? `（留痕已记录，操作人 ${who}）` : ''}`;
    await loadList();
    if (hasDetail.value) await openDetail(detail.value.row.id);
  } catch (err) {
    detailError.value = err.message;
    notice.value = '';
  } finally {
    actionBusy.value = false;
  }
}

function claim(row) {
  return runAction('认领', () => api.claimTodo(row.id));
}

function transition({ row, next }) {
  return runAction(next.actionLabel, () => api.transitionTodo(row.id, next.code));
}

function assign({ row, owner }) {
  return runAction('指派', () => api.assignTodo(row.id, owner));
}

async function scanRules() {
  scanning.value = true;
  notice.value = '';
  error.value = '';
  try {
    const result = await api.scanTodos({});
    notice.value =
      `规则扫描完成：命中候选 ${result.candidateCount} 条，新增 ${result.created.length} 条，` +
      `幂等跳过 ${result.skipped.length} 条。`;
    await loadList();
  } catch (err) {
    error.value = err.message;
  } finally {
    scanning.value = false;
  }
}

async function onCreated() {
  showCreate.value = false;
  notice.value = '人工派发的待办已创建（留痕已记录）。';
  await loadList();
}

function resetFilters() {
  filters.owner = '';
  filters.status = '';
  filters.source = '';
  filters.dueBefore = '';
  filters.overdue = null;
  loadList();
}

function syncFromHash() {
  const route = parseHash(location.hash);
  if (route?.type === 'todo') openDetail(route.id);
}

onMounted(async () => {
  await Promise.all([loadList(), loadMeta()]);
  syncFromHash();
  window.addEventListener('hashchange', syncFromHash);
});

onBeforeUnmount(() => window.removeEventListener('hashchange', syncFromHash));
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h2>待办事项</h2>
        <p class="muted">
          聚合待决策者 / 管理责任人处理的事项；来源为<strong>规则自动产生</strong>与<strong>人工派发</strong>两种并存。
        </p>
      </div>
      <div class="view-actions">
        <button class="btn btn-sm" type="button" data-testid="todo-create-open" @click="showCreate = true">
          人工派发
        </button>
        <button class="btn btn-sm" type="button" data-testid="todo-scan" :disabled="scanning" @click="scanRules">
          {{ scanning ? '扫描中…' : '执行规则扫描' }}
        </button>
        <button class="btn btn-sm" type="button" :disabled="loading" @click="loadList">刷新</button>
      </div>
    </header>

    <div class="filter-bar" data-testid="todo-filter-bar">
      <label class="filter-field">
        <span class="muted">责任人</span>
        <input v-model="filters.owner" type="text" data-testid="filter-owner" placeholder="部门 / 姓名" @keyup.enter="loadList" />
      </label>
      <label class="filter-field">
        <span class="muted">状态</span>
        <select v-model="filters.status" data-testid="filter-status" @change="loadList">
          <option value="">全部</option>
          <option v-for="s in meta.statuses" :key="s.code" :value="s.code">{{ s.label }}</option>
        </select>
      </label>
      <label class="filter-field">
        <span class="muted">来源</span>
        <select v-model="filters.source" data-testid="filter-source" @change="loadList">
          <option value="">全部</option>
          <option v-for="s in meta.sources" :key="s.code" :value="s.code">{{ s.label }}</option>
        </select>
      </label>
      <label class="filter-field">
        <span class="muted">截止时间不晚于</span>
        <input v-model="filters.dueBefore" type="date" data-testid="filter-due" @change="loadList" />
      </label>
      <label class="filter-field filter-check">
        <input
          v-model="filters.overdue"
          type="checkbox"
          :true-value="true"
          :false-value="null"
          data-testid="filter-overdue"
          @change="loadList"
        />
        <span class="muted">只看逾期</span>
      </label>
      <button class="btn btn-sm" type="button" data-testid="filter-apply" @click="loadList">筛选</button>
      <button class="btn btn-sm btn-ghost" type="button" data-testid="filter-reset" @click="resetFilters">重置</button>
    </div>

    <p v-if="error" class="alert alert-error">{{ error }}</p>
    <p v-if="notice" class="alert alert-ok" data-testid="todo-notice">{{ notice }}</p>
    <p v-if="loading" class="muted">加载中…</p>

    <div v-else-if="model" class="todo-split" :class="{ 'with-detail': hasDetail }">
      <TodoTable
        :model="model"
        @open="(row) => openDetail(row.id)"
        @claim="claim"
        @transition="transition"
      />

      <div v-if="detailLoading" class="muted">详情加载中…</div>
      <TodoDetailPanel
        v-else-if="detail"
        :model="detail"
        :busy="actionBusy"
        :error="detailError"
        @close="closeDetail"
        @claim="claim"
        @transition="transition"
        @assign="assign"
      />
    </div>

    <TodoCreateDialog
      v-if="showCreate"
      :related-ref-types="meta.relatedRefTypes"
      :metrics="metrics"
      :reasons="reasons"
      @close="showCreate = false"
      @created="onCreated"
    />
  </section>
</template>
