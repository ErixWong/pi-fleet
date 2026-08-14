<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';

const router = useRouter();
const password = ref('');
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await api.login(password.value);
    router.push('/');
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="d-flex justify-content-center align-items-center" style="min-height:80vh">
    <div class="card border-0 p-2 login-card" style="width:400px">
      <div class="card-body p-4">
        <div class="text-center mb-4">
          <div class="mx-auto mb-3 d-flex align-items-center justify-content-center login-logo">
            <i class="bi bi-hdd-network-fill" style="font-size:1.8rem;color:#fff"></i>
          </div>
          <h4 class="mb-1 fw-bold">任务分发平台</h4>
          <div class="text-secondary small">Agent 协作 · 任务调度 · 报告归档</div>
        </div>
        <div v-if="error" class="alert alert-danger py-2 small"><i class="bi bi-exclamation-triangle me-1"></i>{{ error }}</div>
        <form @submit.prevent="submit">
          <label class="form-label">管理员密码</label>
          <input v-model="password" type="password" class="form-control form-control-lg mb-3" autofocus required placeholder="••••••••">
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
.login-card { background: linear-gradient(160deg, var(--accent-soft), var(--surface)); }
.login-logo {
  width: 64px;
  height: 64px;
  border-radius: 1.2rem;
  background: var(--btn-grad);
  box-shadow: 0 10px 30px -8px var(--btn-shadow);
}
</style>
