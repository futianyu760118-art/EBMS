<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, setToken } from '../api/client';
import { setSession } from '../store/session';

const router = useRouter();
const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    const result = await api.login(username.value, password.value);
    setToken(result.token);
    setSession({ user: result.user, landing: result.landing });
    if (result.landing && result.landing.view === null) {
      error.value = result.landing.notice;
      return;
    }
    // 登录后直接落到默认视图：本切片为 F9 Decision 视图
    const target = (result.landing && result.landing.route) || '/decisions';
    await router.replace(target);
  } catch (err) {
    error.value = err.message || '登录失败';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="ebms-card ebms-login">
    <h1>EBMS 登录</h1>
    <form @submit.prevent="submit">
      <label>
        账号
        <input v-model="username" data-test="username" autocomplete="username" />
      </label>
      <label>
        密码
        <input v-model="password" type="password" data-test="password" autocomplete="current-password" />
      </label>
      <button type="submit" :disabled="busy" data-test="login-submit">
        {{ busy ? '登录中…' : '登录' }}
      </button>
      <p v-if="error" class="ebms-error" data-test="login-error">{{ error }}</p>
    </form>
  </section>
</template>
