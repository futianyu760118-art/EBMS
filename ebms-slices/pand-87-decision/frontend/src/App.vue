<script setup>
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, getToken, setToken } from './api/client';
import { session, setSession, clearSession } from './store/session';

const router = useRouter();

onMounted(async () => {
  if (!getToken()) {
    router.replace({ name: 'login' });
    return;
  }
  if (!session.loaded) {
    try {
      const { landing } = await api.landing();
      setSession({ user: session.user, landing });
    } catch (_err) {
      setToken('');
      clearSession();
      router.replace({ name: 'login' });
    }
  }
});

function logout() {
  setToken('');
  clearSession();
  router.replace({ name: 'login' });
}
</script>

<template>
  <div class="ebms-shell">
    <header class="ebms-header">
      <div class="ebms-brand">EBMS 经营管理系统</div>
      <nav class="ebms-nav">
        <router-link :to="{ name: 'decisions' }" data-test="nav-decision">Decision</router-link>
      </nav>
      <div class="ebms-account">
        <span v-if="session.user" data-test="current-user">{{ session.user.displayName }}</span>
        <span v-if="session.landing" class="ebms-scope" data-test="scope-label">
          {{ session.landing.scope.label }}
        </span>
        <button type="button" data-test="logout" @click="logout">退出</button>
      </div>
    </header>
    <main class="ebms-main">
      <router-view />
    </main>
  </div>
</template>
