<script setup>
import { ref } from 'vue';
// 引入 Dropdown 模块以注册 bootstrap data-api（data-bs-toggle="dropdown" 依赖它；各视图只 import 了 Modal，不含 dropdown）
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

async function logout() {
  await api.logout();
  router.push('/login');
}
</script>

<template>
  <div class="min-vh-100 d-flex flex-column">
    <nav v-if="route.path !== '/login'" class="navbar navbar-expand px-3">
      <span class="navbar-brand me-3"><i class="bi bi-hdd-network me-1"></i>任务分发平台</span>
      <div class="navbar-nav d-flex gap-1">
        <router-link to="/" class="nav-link" exact-active-class="active"><i class="bi bi-grid-1x2 me-1"></i>仪表盘</router-link>
        <router-link to="/plans" class="nav-link" active-class="active"><i class="bi bi-diagram-3 me-1"></i>任务与计划</router-link>
        <router-link to="/agents" class="nav-link" active-class="active"><i class="bi bi-pc-display me-1"></i>主机</router-link>
        <router-link to="/settings" class="nav-link" active-class="active"><i class="bi bi-gear me-1"></i>设置</router-link>
      </div>
      <div class="ms-auto d-flex align-items-center gap-2">
        <div class="dropdown">
          <button class="btn btn-sm btn-outline-secondary dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false">
            <i class="bi me-1" :class="themeIcon()"></i>主题
          </button>
          <ul class="dropdown-menu dropdown-menu-end">
            <li v-for="t in THEMES" :key="t.id">
              <button class="dropdown-item" :class="{ active: theme === t.id }" @click="switchTheme(t.id)">
                <i class="bi me-2" :class="t.icon"></i>{{ t.name }}
              </button>
            </li>
          </ul>
        </div>
        <button class="btn btn-sm btn-outline-secondary" @click="logout"><i class="bi bi-box-arrow-right me-1"></i>退出</button>
      </div>
    </nav>
    <!-- 加宽布局：全宽 + 适度留白 -->
    <main class="container-fluid py-4 flex-grow-1 px-4 px-xxl-5" style="max-width:1720px; width:100%; margin:0 auto">
      <router-view />
    </main>
  </div>
</template>
