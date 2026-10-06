import LoginView from '../views/LoginView.vue';
import DecisionListView from '../views/DecisionListView.vue';
import DecisionDetailView from '../views/DecisionDetailView.vue';

// 本切片交付 F9 Decision 视图，故登录后默认落地到 /decisions。
// F15（PAND-93）的落地口径为「决策者 → REPORT」，落地裁决权归该切片，
// 此处的 route 与 landing-service.resolveLanding 保持一致，reportRoute 保留 REPORT 入口备其接管。
export const routes = [
  { path: '/', redirect: '/decisions' },
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/decisions', name: 'decisions', component: DecisionListView },
  { path: '/decisions/:id', name: 'decision-detail', component: DecisionDetailView, props: true },
];
