<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';

const SCOPE_OPTIONS = [
  ['post:read', '读取帖子'],
  ['post:write', '发布帖子'],
  ['task:read', '读取任务'],
  ['task:write', '发布任务'],
  ['task:claim', '认领任务'],
  ['task:submit', '提交交付'],
  ['task:verdict', '验收任务'],
  ['attachment:read', '读取附件'],
  ['attachment:write', '上传附件'],
  ['device:execute', '设备执行'],
  ['moderate', '管理审核'],
  ['key:manage', 'Key 管理'],
  ['host:manage', '主机管理'],
];

const router = useRouter();
const keys = ref([]);
const keysLoading = ref(true);
const keysError = ref('');
const whoamiScopes = ref([]);

const pwdForm = ref({ old_password: '', new_password: '', confirm: '' });
const pwdBusy = ref(false);
const pwdError = ref('');
const pwdDone = ref('');

const issueForm = ref({ label: '', scopes: [], expires_at: '', neverExpires: true });
const issueBusy = ref(false);
const issueError = ref('');
const issuedKey = ref(null);

const revokeTarget = ref(null);
const revokeBusy = ref(false);
const revokeError = ref('');
const copied = ref(false);

const availableScopes = computed(() => {
  const held = new Set(whoamiScopes.value);
  return SCOPE_OPTIONS.filter(([scope]) => held.has(scope));
});

async function load() {
  keysLoading.value = true;
  keysError.value = '';
  try {
    const [whoami, data] = await Promise.all([api.whoami(), api.meKeys()]);
    whoamiScopes.value = whoami.scopes ?? [];
    keys.value = data.items ?? [];
  } catch (e) {
    keysError.value = e.message;
  } finally {
    keysLoading.value = false;
  }
}

async function changePassword() {
  pwdError.value = '';
  pwdDone.value = '';
  if (pwdForm.value.new_password !== pwdForm.value.confirm) {
    pwdError.value = '两次输入的新密码不一致';
    return;
  }
  if (!pwdForm.value.new_password) {
    pwdError.value = '新密码不能为空';
    return;
  }
  pwdBusy.value = true;
  try {
    await api.changePassword({
      old_password: pwdForm.value.old_password,
      new_password: pwdForm.value.new_password,
    });
    pwdDone.value = '密码已修改，登录会话已全部失效，请重新登录';
    api.logout();
    setTimeout(() => router.push('/login'), 1200);
  } catch (e) {
    pwdError.value = e.message;
  } finally {
    pwdBusy.value = false;
  }
}

async function issueKey() {
  issueError.value = '';
  issuedKey.value = null;
  if (!issueForm.value.label.trim()) {
    issueError.value = '请填写 key 标签';
    return;
  }
  if (issueForm.value.scopes.length === 0) {
    issueError.value = '请至少勾选一个 scope';
    return;
  }
  issueBusy.value = true;
  try {
    const data = await api.createMeKey({
      label: issueForm.value.label.trim(),
      scopes: issueForm.value.scopes,
      expires_at: issueForm.value.neverExpires || !issueForm.value.expires_at
        ? null
        : `${issueForm.value.expires_at.replace('T', ' ')}:00`.slice(0, 19),
    });
    issuedKey.value = data.key;
    issueForm.value = { label: '', scopes: [], expires_at: '', neverExpires: true };
    await load();
  } catch (e) {
    issueError.value = e.message;
  } finally {
    issueBusy.value = false;
  }
}

function confirmRevoke(key) {
  revokeTarget.value = key;
  revokeError.value = '';
}

async function revokeKey() {
  if (!revokeTarget.value) return;
  revokeBusy.value = true;
  revokeError.value = '';
  try {
    await api.revokeMeKey(revokeTarget.value.id);
    revokeTarget.value = null;
    await load();
  } catch (e) {
    revokeError.value = e.message;
  } finally {
    revokeBusy.value = false;
  }
}

async function copyIssued() {
  if (!issuedKey.value) return;
  try {
    await navigator.clipboard.writeText(issuedKey.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    revokeError.value = '复制失败，请手动选择复制';
  }
}

function statusOf(key) {
  if (key.revoked_at) return { text: '已吊销', class: 'text-bg-secondary' };
  if (key.expires_at) return { text: `至 ${key.expires_at}`, class: 'text-bg-info' };
  return { text: '永不过期', class: 'text-bg-success' };
}

function formatTime(value) {
  return value || '—';
}

onMounted(load);
</script>

<template>
  <div class="container-fluid py-3 settings-page">
    <div class="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
      <div>
        <h1 class="h4 mb-1 fw-bold">个人设置</h1>
        <div class="text-secondary small">修改密码 · 个人 API key 与会话管理</div>
      </div>
      <button class="btn btn-sm btn-ghost" @click="load" :disabled="keysLoading">
        <i class="bi bi-arrow-repeat" :class="{ spin: keysLoading }"></i> 刷新
      </button>
    </div>

    <div class="row g-3">
      <section class="col-lg-5">
        <div class="card border-0 h-100">
          <div class="card-body p-4">
            <h2 class="h6 fw-bold mb-1"><i class="bi bi-key me-2"></i>修改密码</h2>
            <p class="text-secondary small">修改成功后所有登录会话将被吊销，需要重新登录。</p>
            <div v-if="pwdError" class="alert alert-danger py-2 small">
              <i class="bi bi-exclamation-triangle me-1"></i>{{ pwdError }}
            </div>
            <div v-if="pwdDone" class="alert alert-success py-2 small">
              <i class="bi bi-check2-circle me-1"></i>{{ pwdDone }}
            </div>
            <form @submit.prevent="changePassword">
              <label class="form-label">旧密码</label>
              <input v-model="pwdForm.old_password" type="password" class="form-control mb-3"
                     autocomplete="current-password" required>
              <label class="form-label">新密码</label>
              <input v-model="pwdForm.new_password" type="password" class="form-control mb-3"
                     autocomplete="new-password" required>
              <label class="form-label">确认新密码</label>
              <input v-model="pwdForm.confirm" type="password" class="form-control mb-3"
                     autocomplete="new-password" required>
              <button class="btn btn-primary w-100" :disabled="pwdBusy">
                <i v-if="pwdBusy" class="bi bi-arrow-repeat me-1 spin"></i>{{ pwdBusy ? '提交中…' : '修改密码' }}
              </button>
            </form>
          </div>
        </div>
      </section>

      <section class="col-lg-7">
        <div class="card border-0">
          <div class="card-body p-4">
            <h2 class="h6 fw-bold mb-1"><i class="bi bi-shield-lock me-2"></i>API key 与会话</h2>
            <p class="text-secondary small">登录会话与长期 key 统一管理；吊销后立即失效。</p>

            <div v-if="issuedKey" class="alert alert-warning py-2 small">
              <div class="fw-bold mb-1"><i class="bi bi-exclamation-triangle me-1"></i>新 key 仅此一次展示，请立即保存</div>
              <div class="d-flex align-items-center gap-2 flex-wrap">
                <code class="key-secret text-break">{{ issuedKey }}</code>
                <button class="btn btn-sm btn-outline-primary" @click="copyIssued">
                  <i class="bi" :class="copied ? 'bi-clipboard-check' : 'bi-clipboard'"></i>
                  {{ copied ? '已复制' : '复制' }}
                </button>
                <button class="btn btn-sm btn-ghost" @click="issuedKey = null">我已保存</button>
              </div>
            </div>

            <div v-if="issueError" class="alert alert-danger py-2 small">
              <i class="bi bi-exclamation-triangle me-1"></i>{{ issueError }}
            </div>
            <form class="border rounded-3 p-3 mb-3" @submit.prevent="issueKey">
              <div class="row g-2 align-items-end">
                <div class="col-md-4">
                  <label class="form-label">标签</label>
                  <input v-model="issueForm.label" type="text" class="form-control"
                         placeholder="如 cli / ci" maxlength="64" required>
                </div>
                <div class="col-md-5">
                  <label class="form-label">有效期</label>
                  <div class="d-flex align-items-center gap-2">
                    <div class="form-check mb-0">
                      <input id="never-expires" v-model="issueForm.neverExpires" class="form-check-input" type="checkbox">
                      <label class="form-check-label small" for="never-expires">永不过期</label>
                    </div>
                    <input v-if="!issueForm.neverExpires" v-model="issueForm.expires_at" type="datetime-local"
                           class="form-control form-control-sm">
                  </div>
                </div>
                <div class="col-md-3 text-md-end">
                  <button class="btn btn-primary w-100" :disabled="issueBusy">
                    <i class="bi bi-plus-lg me-1"></i>签发 key
                  </button>
                </div>
              </div>
              <div class="mt-2">
                <label class="form-label mb-1">Scopes（限本人持有的 scope）</label>
                <div class="d-flex flex-wrap gap-2">
                  <div v-for="[scope, name] in availableScopes" :key="scope" class="form-check form-check-inline me-0">
                    <input :id="`scope-${scope}`" v-model="issueForm.scopes" class="form-check-input"
                           type="checkbox" :value="scope">
                    <label class="form-check-label small" :for="`scope-${scope}`" :title="scope">{{ name }}</label>
                  </div>
                </div>
              </div>
            </form>

            <div v-if="keysError" class="alert alert-danger py-2 small">
              <i class="bi bi-exclamation-triangle me-1"></i>{{ keysError }}
            </div>
            <div v-else-if="keysLoading" class="text-secondary small py-3 text-center">
              <i class="bi bi-arrow-repeat spin me-1"></i>加载中…
            </div>
            <div v-else class="table-responsive">
              <table class="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th>标签</th>
                    <th>Scopes</th>
                    <th>状态</th>
                    <th>创建时间</th>
                    <th>最近使用</th>
                    <th class="text-end">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="key in keys" :key="key.id">
                    <td>
                      <span class="fw-semibold">{{ key.label || '（未命名）' }}</span>
                      <span v-if="key.label === 'login'" class="badge text-bg-primary ms-1">会话</span>
                    </td>
                    <td class="scopes-cell"><code class="small">{{ key.scopes.join(', ') }}</code></td>
                    <td><span class="badge" :class="statusOf(key).class">{{ statusOf(key).text }}</span></td>
                    <td class="small text-secondary">{{ formatTime(key.created_at) }}</td>
                    <td class="small text-secondary">{{ formatTime(key.last_used_at) }}</td>
                    <td class="text-end">
                      <button v-if="!key.revoked_at" class="btn btn-sm btn-outline-danger"
                              @click="confirmRevoke(key)">
                        <i class="bi bi-x-circle me-1"></i>吊销
                      </button>
                      <span v-else class="text-secondary small">—</span>
                    </td>
                  </tr>
                  <tr v-if="keys.length === 0">
                    <td colspan="6" class="text-center text-secondary small py-3">暂无 key</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div v-if="revokeTarget" class="modal-backdrop-custom" @click.self="revokeTarget = null">
      <div class="modal-card card border-0">
        <div class="card-body p-4">
          <h3 class="h6 fw-bold">确认吊销 key</h3>
          <p class="small text-secondary mb-1">标签：<span class="fw-semibold">{{ revokeTarget.label || '（未命名）' }}</span></p>
          <p class="small text-secondary">吊销后使用该 key 的客户端将立即无法访问，且不可恢复。</p>
          <div v-if="revokeError" class="alert alert-danger py-2 small">
            <i class="bi bi-exclamation-triangle me-1"></i>{{ revokeError }}
          </div>
          <div class="d-flex justify-content-end gap-2">
            <button class="btn btn-sm btn-ghost" @click="revokeTarget = null">取消</button>
            <button class="btn btn-sm btn-danger" :disabled="revokeBusy" @click="revokeKey">
              <i v-if="revokeBusy" class="bi bi-arrow-repeat me-1 spin"></i>确认吊销
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spin { display: inline-block; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.key-secret { user-select: all; font-size: 0.75rem; word-break: break-all; }
.modal-backdrop-custom {
  position: fixed;
  inset: 0;
  z-index: 1050;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  padding: 1rem;
}
.modal-card { width: min(440px, 100%); }
.scopes-cell { max-width: 240px; }
.scopes-cell code { display: block; word-break: break-all; max-height: 5.5em; overflow-y: auto; }
</style>
