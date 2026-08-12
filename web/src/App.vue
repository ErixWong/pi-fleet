<script setup>
import { useRoute, useRouter } from 'vue-router';
import { api } from './api';

const route = useRoute();
const router = useRouter();

async function logout() {
  await api.logout();
  router.push('/login');
}
</script>

<template>
  <div class="min-vh-100 d-flex flex-column">
    <nav v-if="route.path !== '/login'" class="navbar navbar-expand navbar-dark bg-dark border-bottom px-3">
      <span class="navbar-brand me-4">⚙ 任务分发平台</span>
      <div class="navbar-nav">
        <router-link to="/" class="nav-link" exact-active-class="active">仪表盘</router-link>
        <router-link to="/tasks" class="nav-link" active-class="active">任务</router-link>
        <router-link to="/agents" class="nav-link" active-class="active">Agent</router-link>
        <router-link to="/topics" class="nav-link" active-class="active">主题报告</router-link>
      </div>
      <div class="ms-auto">
        <button class="btn btn-sm btn-outline-secondary" @click="logout">退出</button>
      </div>
    </nav>
    <main class="container-fluid py-4 flex-grow-1" style="max-width:1200px">
      <router-view />
    </main>
  </div>
</template>
