<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Dropdown } from 'bootstrap';
import { useRoute, useRouter } from 'vue-router';
import { api } from './api';
import { THEMES, applyTheme, currentTheme } from './theme';

void Dropdown;

const route = useRoute();
const router = useRouter();
const theme = ref(currentTheme());

function switchTheme(id) {
  theme.value = id;
  applyTheme(id);
}

const themeIcon = () => THEMES.find(t => t.id === theme.value)?.icon || 'bi-moon-stars';
const isLogin = computed(() => route.path === '/login');
const showSessionContext = computed(() => route.path === '/hosts' || route.path.startsWith('/chat/'));
const agents = ref([]);
const agentLoadError = ref('');
let agentTimer = null;
let routeReady = false;

const sortedAgents = computed(() => [...agents.value].sort((a, b) => {
  const aOnline = a.status === 'active' && !a.offline;
  const bOnline = b.status === 'active' && !b.offline;
  if (aOnline !== bOnline) return aOnline ? -1 : 1;
  const aTime = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
  const bTime = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}));

async function loadAgents() {
  try {
    const data = await api.agentsAll();
    agents.value = data.agents ?? [];
    agentLoadError.value = '';
  } catch (e) {
    agentLoadError.value = e.message;
  }
}

function initials(name) {
  return String(name || '?').trim().slice(0, 1).toUpperCase();
}

function openHost(agent) {
  router.push({ path: '/hosts', query: { agent: String(agent.id) } });
}

function isRouteActive(path) {
  return path === '/' ? route.path === '/' : route.path.startsWith(path);
}

async function logout() {
  await api.logout();
  router.push('/login');
}

onMounted(() => {
  router.isReady().then(() => {
    routeReady = true;
    if (!isLogin.value) {
      loadAgents();
      agentTimer = setInterval(loadAgents, 30_000);
    }
  });
});

watch(() => route.path, () => {
  if (!routeReady) return;
  if (isLogin.value) {
    if (agentTimer) clearInterval(agentTimer);
    agentTimer = null;
    agents.value = [];
    return;
  }
  if (!agentTimer) {
    loadAgents();
    agentTimer = setInterval(loadAgents, 30_000);
  }
});

onBeforeUnmount(() => {
  if (agentTimer) clearInterval(agentTimer);
});
</script>

<template>
  <div v-if="isLogin" class="login-shell">
    <router-view />
  </div>
  <div v-else class="app-shell">
    <aside class="app-rail" aria-label="主导航">
      <router-link to="/" class="rail-brand" title="返回仪表盘" aria-label="返回仪表盘">
        <i class="bi bi-command"></i>
      </router-link>
      <div class="rail-nav">
        <router-link to="/" class="rail-link" :class="{ active: isRouteActive('/') }" title="仪表盘">
          <i class="bi bi-grid-1x2"></i>
        </router-link>
        <router-link to="/plans" class="rail-link" :class="{ active: isRouteActive('/plans') }" title="计划与任务">
          <i class="bi bi-diagram-3"></i>
        </router-link>
      </div>
      <div class="rail-divider"></div>
      <div class="rail-hosts" aria-label="主机列表">
        <button
          v-for="agent in sortedAgents"
          :key="agent.id"
          class="rail-host"
          :class="{ offline: agent.offline || agent.status !== 'active' }"
          :title="`${agent.name}${agent.offline ? ' · 失联' : ''}`"
          @click="openHost(agent)"
        >
          <span class="rail-status-dot" :class="{ online: agent.status === 'active' && !agent.offline }"></span>
          <span class="rail-avatar">{{ initials(agent.name) }}</span>
          <span class="rail-unread-dot" aria-hidden="true"></span>
        </button>
        <span v-if="agentLoadError" class="rail-error" title="主机列表加载失败"><i class="bi bi-exclamation-circle"></i></span>
        <span v-if="!sortedAgents.length && !agentLoadError" class="rail-empty" title="暂无主机"><i class="bi bi-pc-display"></i></span>
      </div>
      <div class="rail-spacer"></div>
      <router-link to="/settings" class="rail-link" :class="{ active: isRouteActive('/settings') }" title="设置">
        <i class="bi bi-gear"></i>
      </router-link>
    </aside>

    <div class="app-workspace" :class="{ 'app-workspace-chat': route.path.startsWith('/chat/') }">
      <header class="app-topbar">
        <div class="app-brand">
          <span class="app-brand-mark"><i class="bi bi-hdd-network"></i></span>
          <span>
            <strong>任务分发平台</strong>
            <small>COMMAND CENTER</small>
          </span>
        </div>
        <div class="app-topbar-actions">
          <div class="dropdown">
            <button class="btn btn-sm btn-ghost dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false">
              <i class="bi me-1" :class="themeIcon()"></i><span class="d-none d-sm-inline">主题</span>
            </button>
            <ul class="dropdown-menu dropdown-menu-end">
              <li v-for="t in THEMES" :key="t.id">
                <button class="dropdown-item" :class="{ active: theme === t.id }" @click="switchTheme(t.id)">
                  <i class="bi me-2" :class="t.icon"></i>{{ t.name }}
                </button>
              </li>
            </ul>
          </div>
          <button class="btn btn-sm btn-ghost" title="退出登录" @click="logout">
            <i class="bi bi-box-arrow-right"></i><span class="d-none d-sm-inline ms-1">退出</span>
          </button>
        </div>
      </header>
      <div v-if="showSessionContext" class="app-contextbar">
        <div class="small fw-semibold"><i class="bi bi-chat-square-text me-2"></i>会话工作区</div>
        <div class="context-links">
          <router-link to="/hosts" :class="{ active: route.path === '/hosts' }">主机工作台</router-link>
          <span class="context-separator">/</span>
          <span class="text-secondary">{{ route.path.startsWith('/chat/') ? '独立对话' : '会话管理' }}</span>
        </div>
      </div>
      <main class="app-content" :class="{ 'app-content-chat': route.path.startsWith('/chat/') }">
        <router-view />
      </main>
    </div>
  </div>
</template>
