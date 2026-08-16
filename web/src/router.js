import { createRouter, createWebHistory } from 'vue-router';
import { api } from './api';

const routes = [
  { path: '/login', component: () => import('./views/Login.vue') },
  { path: '/', component: () => import('./views/Dashboard.vue'), meta: { auth: true } },
  { path: '/tasks', redirect: '/plans' },
  { path: '/tasks/:taskId', component: () => import('./views/TaskDetail.vue'), meta: { auth: true } },
  { path: '/plans', component: () => import('./views/Plans.vue'), meta: { auth: true } },
  { path: '/plans/:planId', component: () => import('./views/PlanDetail.vue'), meta: { auth: true } },
  { path: '/agents', redirect: '/hosts' },
  { path: '/hosts', component: () => import('./views/Hosts.vue'), meta: { auth: true } },
  { path: '/agents/:id', component: () => import('./views/AgentDetail.vue'), meta: { auth: true } },
  { path: '/chat/:agentId', component: () => import('./views/ChatPage.vue'), meta: { auth: true } },
  { path: '/chat/:agentId/:convId', component: () => import('./views/ChatPage.vue'), meta: { auth: true } },
  { path: '/settings', component: () => import('./views/Settings.vue'), meta: { auth: true } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  if (to.path === '/login') return true;
  try {
    const data = await api.me();
    if (!data.admin) return '/login';
  } catch {
    return '/login';
  }
  return true;
});
