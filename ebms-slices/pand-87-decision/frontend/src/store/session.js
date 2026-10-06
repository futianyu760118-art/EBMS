import { reactive } from 'vue';

// 登录态与默认落地视图（由 /api/v1/me/landing 提供）
export const session = reactive({
  user: null,
  landing: null,
  loaded: false,
});

export function setSession({ user, landing }) {
  session.user = user || null;
  session.landing = landing || null;
  session.loaded = true;
}

export function clearSession() {
  session.user = null;
  session.landing = null;
  session.loaded = false;
}
