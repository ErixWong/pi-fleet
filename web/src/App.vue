<script setup>
import { computed, ref } from 'vue';
import { Dropdown } from 'bootstrap';
import { useRoute, useRouter } from 'vue-router';
import { api } from './api';
import { THEMES, applyTheme, currentTheme } from './theme';

void Dropdown;

const route = useRoute();
const router = useRouter();
const theme = ref(currentTheme());
const isLogin = computed(() => route.path === '/login');
const isFullscreen = computed(() => Boolean(route.meta.fullscreen));

function switchTheme(id) {
  theme.value = id;
  applyTheme(id);
}

function themeIcon() {
  return THEMES.find((item) => item.id === theme.value)?.icon || 'bi-moon-stars';
}

function isRouteActive(path) {
  return path === '/' ? route.path === '/' : route.path.startsWith(path);
}

function logout() {
  api.logout();
  router.push('/login');
}
</script>

<template>
  <div v-if="isLogin" class="login-shell">
    <router-view />
  </div>
  <div v-else class="app-shell" :class="{ 'app-shell-fullscreen': isFullscreen }">
    <aside v-if="!isFullscreen" class="app-rail" aria-label="主导航">
      <router-link to="/" class="rail-brand" title="返回仪表盘" aria-label="返回仪表盘">
        <i class="bi bi-command"></i>
      </router-link>
      <div class="rail-nav">
        <router-link to="/" class="rail-link" :class="{ active: isRouteActive('/') }" title="仪表盘">
          <i class="bi bi-grid-1x2"></i>
        </router-link>
        <router-link to="/tasks" class="rail-link" :class="{ active: isRouteActive('/tasks') }" title="任务">
          <i class="bi bi-list-task"></i>
        </router-link>
        <router-link to="/hosts" class="rail-link" :class="{ active: isRouteActive('/hosts') }" title="主机">
          <i class="bi bi-pc-display"></i>
        </router-link>
        <router-link to="/channels" class="rail-link" :class="{ active: isRouteActive('/channels') }" title="对话">
          <i class="bi bi-chat-dots"></i>
        </router-link>
      </div>
    </aside>

    <div class="app-workspace">
      <header v-if="!isFullscreen" class="app-topbar">
        <div class="app-brand">
          <span class="app-brand-mark"><i class="bi bi-hdd-network"></i></span>
          <span>
            <strong>任务分发平台</strong>
            <small>COMMAND CENTER</small>
          </span>
        </div>
        <div class="app-topbar-actions">
          <router-link to="/settings" class="btn btn-sm btn-ghost" title="个人设置">
            <i class="bi bi-gear"></i><span class="d-none d-sm-inline ms-1">设置</span>
          </router-link>
          <div class="dropdown">
            <button class="btn btn-sm btn-ghost dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false">
              <i class="bi me-1" :class="themeIcon()"></i><span class="d-none d-sm-inline">主题</span>
            </button>
            <ul class="dropdown-menu dropdown-menu-end">
              <li v-for="item in THEMES" :key="item.id">
                <button class="dropdown-item" :class="{ active: theme === item.id }" @click="switchTheme(item.id)">
                  <i class="bi me-2" :class="item.icon"></i>{{ item.name }}
                </button>
              </li>
            </ul>
          </div>
          <button class="btn btn-sm btn-ghost" title="退出登录" @click="logout">
            <i class="bi bi-box-arrow-right"></i><span class="d-none d-sm-inline ms-1">退出</span>
          </button>
        </div>
      </header>
      <main class="app-content" :class="{ 'app-content-fullscreen': isFullscreen }">
        <router-view />
      </main>
    </div>
  </div>
</template>
