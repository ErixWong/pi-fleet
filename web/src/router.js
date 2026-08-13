import { createRouter, createWebHistory } from 'vue-router';
import { api } from './api';

const routes = [
  { path: '/login', component: () => import('./views/Login.vue') },
  { path: '/', component: () => import('./views/Dashboard.vue'), meta: { auth: true } },
  { path: '/tasks', component: () => import('./views/Tasks.vue'), meta: { auth: true } },
  { path: '/tasks/:taskId', component: () => import('./views/TaskDetail.vue'), meta: { auth: true } },
  { path: '/agents', component: () => import('./views/Agents.vue'), meta: { auth: true } },
  { path: '/agents/:id', component: () => import('./views/AgentDetail.vue'), meta: { auth: true } },
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
