<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api, getToken, setToken } from './api/client';
import ReasonEvidenceView from './views/ReasonEvidenceView.vue';
import ReportDetailView from './views/ReportDetailView.vue';
import ReportListView from './views/ReportListView.vue';
import ResultOverviewView from './views/ResultOverviewView.vue';
import ViewExplorer from './views/ViewExplorer.vue';
import { DEFAULT_LANDING_VIEW } from './report-view';
import { parseHash } from './view-nav';

const authed = ref(Boolean(getToken()));
const booting = ref(false);
const error = ref('');

// F7 报告（PAND-85） / F1 经营结果指标集（PAND-79） / F3 原因项证据（PAND-81） / F11 四视图交叉跳转（PAND-89）
// 默认落地 F7：登录即到达报告清单，任一份报告的一次点击可达（AC 场景 1）。
const activeModule = ref(DEFAULT_LANDING_VIEW);
// 报告详情落点（#/report/<id>）：清单 → 详情为一次点击
const selectedReportId = ref('');

const username = ref('owner');
const currentUser = ref(null);

const types = ref([]);
const reasons = ref([]);
const selectedReasonId = ref('');

async function bootstrap() {
  booting.value = true;
  error.value = '';
  try {
    const [typeList, reasonList] = await Promise.all([api.evidenceTypes(), api.reasons()]);
    types.value = typeList;
    reasons.value = reasonList;
    if (!selectedReasonId.value && reasonList.length > 0) {
      selectedReasonId.value = reasonList[0].id;
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    booting.value = false;
  }
}

async function refreshReasons() {
  try {
    reasons.value = await api.reasons();
  } catch (err) {
    error.value = err.message;
  }
}

async function login() {
  error.value = '';
  try {
    const result = await api.devLogin(username.value);
    setToken(result.token);
    currentUser.value = result.user;
    authed.value = true;
    await bootstrap();
  } catch (err) {
    error.value = err.message;
  }
}

function logout() {
  setToken('');
  authed.value = false;
  currentUser.value = null;
}

function openModule(name) {
  activeModule.value = name;
  if (name === 'report') selectedReportId.value = '';
}

/** 报告落点走应用内 hash（与 F11 落点同一契约），使跳转可直达、可回退。 */
function navigateTo(landingHref) {
  const next = `#${landingHref}`;
  if (window.location.hash === next) syncFromHash();
  else window.location.hash = next;
}

function backToList() {
  selectedReportId.value = '';
  if (parseHash(window.location.hash)?.type === 'report') window.location.hash = '';
}

// 落点 hash 的归属：#/report/<id> 由 F7 报告详情解析；
// 其余落点（#/evidence/<id> 等）切到四视图，使「由证据引用可定位到证据」是一次真实跳转。
// F11 浏览态下不抢占用同一契约的报告落点，避免打断 ViewExplorer 的内部选中态。
function syncFromHash() {
  const route = parseHash(window.location.hash);
  if (route && route.type === 'report') {
    if (activeModule.value === 'views') return;
    selectedReportId.value = route.id;
    activeModule.value = 'report';
    return;
  }
  if (route) {
    if (activeModule.value !== 'views') activeModule.value = 'views';
    return;
  }
  // 无落点 hash（浏览器回退到根路径）：报告视图回到清单
  if (activeModule.value === 'report') selectedReportId.value = '';
}

onMounted(() => {
  if (authed.value) bootstrap();
  window.addEventListener('hashchange', syncFromHash);
  syncFromHash();
});

onBeforeUnmount(() => window.removeEventListener('hashchange', syncFromHash));

const selectedReason = () => reasons.value.find((r) => r.id === selectedReasonId.value);
</script>

<template>
  <div class="app">
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark">EBMS</span>
        <span class="brand-sub">经营管理系统 · 报告 / 结果 / 证据</span>
      </div>
      <div v-if="authed" class="app-user">
        <nav class="module-tabs">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :class="{ active: activeModule === 'report' }"
            data-testid="tab-report"
            @click="openModule('report')"
          >
            报告（F7）
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :class="{ active: activeModule === 'results' }"
            @click="openModule('results')"
          >
            经营结果（F1）
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :class="{ active: activeModule === 'reason' }"
            @click="openModule('reason')"
          >
            原因项证据（F3）
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :class="{ active: activeModule === 'views' }"
            @click="openModule('views')"
          >
            四视图导航（F11）
          </button>
        </nav>
        <span class="muted">{{ currentUser?.displayName || '已登录' }}</span>
        <button class="btn btn-ghost btn-sm" type="button" @click="logout">退出</button>
      </div>
    </header>

    <main v-if="!authed" class="login-wrap">
      <form class="card login-card" @submit.prevent="login">
        <h1>登录 EBMS</h1>
        <p class="muted">操作留痕需要可归属的操作人，请先登录。</p>
        <label class="field">
          <span>账号</span>
          <input v-model="username" type="text" placeholder="owner / decider" />
        </label>
        <p v-if="error" class="alert alert-error">{{ error }}</p>
        <button class="btn btn-primary" type="submit">登录</button>
        <p class="muted hint">开发环境账号：<code>decider</code>（决策者）、<code>owner</code>（管理责任人）</p>
      </form>
    </main>

    <main v-else-if="activeModule === 'report'" class="layout-single">
      <ReportDetailView
        v-if="selectedReportId"
        :key="selectedReportId"
        :report-id="selectedReportId"
        @navigate="navigateTo"
        @back="backToList"
      />
      <ReportListView v-else @navigate="navigateTo" />
    </main>

    <main v-else-if="activeModule === 'results'" class="layout-single">
      <ResultOverviewView />
    </main>

    <main v-else-if="activeModule === 'views'" class="layout">
      <ViewExplorer />
    </main>

    <main v-else class="layout">
      <aside class="rail">
        <h2 class="rail-title">原因项</h2>
        <p v-if="booting" class="muted">加载中…</p>
        <ul v-else class="rail-list">
          <li v-for="r in reasons" :key="r.id">
            <button
              type="button"
              class="rail-item"
              :class="{ active: r.id === selectedReasonId, bare: r.evidenceCount === 0 }"
              @click="selectedReasonId = r.id"
            >
              <span class="rail-name">{{ r.name }}</span>
              <span class="rail-count" :class="{ zero: r.evidenceCount === 0 }">
                {{ r.evidenceCount === 0 ? '无证据' : `${r.evidenceCount} 条` }}
              </span>
            </button>
          </li>
        </ul>
      </aside>

      <section class="content">
        <p v-if="error" class="alert alert-error">{{ error }}</p>
        <ReasonEvidenceView
          v-if="selectedReasonId"
          :key="selectedReasonId"
          :reason-id="selectedReasonId"
          :reason-name="selectedReason()?.name || ''"
          :types="types"
          @changed="refreshReasons"
        />
        <p v-else class="muted">暂无原因项数据。</p>
      </section>
    </main>
  </div>
</template>
