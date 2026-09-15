<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';

const router = useRouter();
const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    const data = await api.login(username.value.trim(), password.value);
    localStorage.setItem('pm_key', data.key);
    await router.push('/');
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-orbit login-orbit-one"></div>
    <div class="login-orbit login-orbit-two"></div>
    <div class="card border-0 p-2 login-card">
      <div class="card-body p-4">
        <div class="text-center mb-4">
          <div class="mx-auto mb-3 d-flex align-items-center justify-content-center login-logo">
            <i class="bi bi-hdd-network-fill"></i>
          </div>
          <h4 class="mb-1 fw-bold">任务分发平台</h4>
          <div class="text-secondary small">COMMAND CENTER</div>
          <div class="text-secondary small mt-1">主机协作 · 任务分发 · 交付验收</div>
        </div>
        <div v-if="error" class="alert alert-danger py-2 small">
          <i class="bi bi-exclamation-triangle me-1"></i>{{ error }}
        </div>
        <form @submit.prevent="submit">
          <label class="form-label">用户名</label>
          <input v-model="username" type="text" class="form-control form-control-lg mb-3" autocomplete="username" autofocus required>
          <label class="form-label">密码</label>
          <input v-model="password" type="password" class="form-control form-control-lg mb-3" autocomplete="current-password" required>
          <button class="btn btn-primary w-100 py-2" :disabled="loading">
            <i v-if="loading" class="bi bi-arrow-repeat me-1 spin"></i>
            <i v-else class="bi bi-box-arrow-in-right me-1"></i>{{ loading ? '登录中…' : '登录' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spin { display: inline-block; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.login-page {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 1.25rem;
  background: var(--bg-base);
}
.login-card {
  position: relative;
  z-index: 1;
  width: min(400px, 100%);
  background: linear-gradient(160deg, var(--accent-soft), var(--surface-strong));
  border: 1px solid var(--border-soft) !important;
}
.login-logo {
  width: 64px;
  height: 64px;
  border-radius: 1.2rem;
  background: var(--btn-grad);
  box-shadow: 0 10px 30px -8px var(--btn-shadow);
  color: var(--text-strong);
  font-size: 1.8rem;
}
.login-orbit {
  position: absolute;
  width: 28rem;
  height: 28rem;
  border: 1px solid var(--accent-border-hover);
  border-radius: 50%;
  opacity: 0.35;
}
.login-orbit-one { top: -19rem; right: -8rem; }
.login-orbit-two { bottom: -22rem; left: -10rem; width: 34rem; height: 34rem; }
.login-card:hover { transform: translateY(-3px); }
@media (max-width: 575.98px) {
  .login-card .card-body { padding: 1.25rem !important; }
}
</style>
