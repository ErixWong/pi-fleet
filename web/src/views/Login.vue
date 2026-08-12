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
    <div class="card" style="width:380px">
      <div class="card-body p-4">
        <h4 class="mb-3">管理员登录</h4>
        <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
        <form @submit.prevent="submit">
          <label class="form-label">密码</label>
          <input v-model="password" type="password" class="form-control mb-3" autofocus required>
          <button class="btn btn-primary w-100" :disabled="loading">{{ loading ? '登录中…' : '登录' }}</button>
        </form>
      </div>
    </div>
  </div>
</template>
