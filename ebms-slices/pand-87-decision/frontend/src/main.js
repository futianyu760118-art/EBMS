import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import { routes } from './router/routes';
import { getToken } from './api/client';
import './styles.css';

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach((to) => {
  if (to.meta.public) return true;
  return getToken() ? true : { name: 'login' };
});

createApp(App).use(router).mount('#app');
