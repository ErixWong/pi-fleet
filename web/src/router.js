import { createRouter, createWebHistory } from 'vue-router';
import { api } from './api';

const routes = [
  { path: '/login', component: () => import('./views/Login.vue') },
  { path: '/', component: () => import('./views/Dashboard.vue'), meta: { auth: true } },
  { path: '/tasks', component: () => import('./views/Tasks.vue'), meta: { auth: true } },
  { path: '/tasks/:taskId', component: () => import('./views/TaskDetail.vue'), meta: { auth: true } },
  { path: '/hosts', component: () => import('./views/Hosts.vue'), meta: { auth: true } },
  { path: '/settings', component: () => import('./views/Settings.vue'), meta: { auth: true } },
  {
    path: '/channels/:channelId?',
    component: () => import('./views/Channels.vue'),
    meta: { auth: true, fullscreen: true },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  if (to.path === '/login') return true;
  if (!localStorage.getItem('pm_key')) return '/login';
  try {
    await api.whoami();
    return true;
  } catch {
    return '/login';
  }
});
