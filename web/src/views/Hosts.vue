<script setup>
import { computed, onMounted, ref } from 'vue';
import { Modal } from 'bootstrap';
import { useRouter } from 'vue-router';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge.vue';
import PrincipalChip from '../components/PrincipalChip.vue';

const hosts = ref([]);
const selectedId = ref('');
const loading = ref(true);
const error = ref('');
const offlineAfter = ref(30);
const newKey = ref(null);
const showRegister = ref(false);
const registerForm = ref({ name: '' });
const registerError = ref('');
const registerBusy = ref(false);
const editName = ref('');
const editStatus = ref('active');
const editBusy = ref(false);
const editError = ref('');
const registerModalEl = ref(null);
let registerModal = null;
const router = useRouter();
const activeTab = ref('overview');
const hostTasks = ref([]);
const hostEvents = ref([]);
const workLoading = ref(false);
const workError = ref('');

const selectedHost = computed(() => hosts.value.find((host) => String(host.id) === String(selectedId.value)) || null);
const activeTasks = computed(() => hostTasks.value.filter((item) => ['claimed', 'submitted'].includes(item.task?.status)));

function hostTitle(host) {
  return host.name || host.id;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.hosts();
    hosts.value = data.items ?? [];
    offlineAfter.value = Number(data.offline_after_min ?? 30);
    if (!selectedHost.value && hosts.value.length) selectedId.value = hosts.value[0].id;
    if (selectedHost.value) {
      editName.value = selectedHost.value.name;
      editStatus.value = selectedHost.value.status;
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function selectHost(host) {
  selectedId.value = host.id;
  editName.value = host.name;
  editStatus.value = host.status;
  editError.value = '';
  hostTasks.value = [];
  hostEvents.value = [];
  workError.value = '';
  if (activeTab.value !== 'overview') void loadHostWork();
}

function setTab(tab) {
  activeTab.value = tab;
  if (tab !== 'overview') void loadHostWork();
}

async function loadHostWork() {
  if (!selectedHost.value || workLoading.value) return;
  workLoading.value = true;
  workError.value = '';
  try {
    const [taskData, eventData] = await Promise.all([
      api.tasks({ view: 'mine', assignee: selectedHost.value.id, page_size: 50 }),
      // 倒序取最新 20 条，再 reverse 成时间正序展示
      api.events({ actor_principal_id: selectedHost.value.id, limit: 20, order: 'desc' }),
    ]);
    hostTasks.value = taskData.items ?? [];
    hostEvents.value = (eventData.items ?? []).reverse();
  } catch (e) {
    workError.value = e.message;
  } finally {
    workLoading.value = false;
  }
}

function eventIcon(action) {
  if (action.includes('create')) return 'bi-plus-circle';
  if (action.includes('claim')) return 'bi-hand-index-thumb';
  if (action.includes('submit')) return 'bi-upload';
  if (action.includes('accept') || action.includes('approve')) return 'bi-check2-circle';
  if (action.includes('reject') || action.includes('fail')) return 'bi-exclamation-octagon';
  if (action.includes('reopen')) return 'bi-arrow-repeat';
  if (action.includes('reply')) return 'bi-chat-left-text';
  return 'bi-activity';
}

function eventClass(action) {
  if (action.includes('reject') || action.includes('fail')) return 'text-bg-danger';
  if (action.includes('accept') || action.includes('approve')) return 'text-bg-success';
  if (action.includes('claim') || action.includes('submit')) return 'text-bg-info';
  return 'text-bg-primary';
}

function relativeTime(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value || '—';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(time).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

async function openChannel(host) {
  try {
    const data = await api.createChannel({ host_principal_id: host.id });
    await router.push(`/channels/${encodeURIComponent(data.channel.id)}`);
  } catch (e) {
    error.value = e.message;
  }
}

function openRegister() {
  registerForm.value = { name: '' };
  registerError.value = '';
  showRegister.value = true;
  registerModal = new Modal(registerModalEl.value);
  registerModal.show();
}

function closeRegister() {
  registerModal?.hide();
  showRegister.value = false;
}

async function registerHost() {
  if (!registerForm.value.name.trim()) {
    registerError.value = '主机名称不能为空';
    return;
  }
  registerBusy.value = true;
  registerError.value = '';
  try {
    const data = await api.createHost({ name: registerForm.value.name.trim() });
    newKey.value = { name: data.host.name, key: data.key };
    closeRegister();
    await load();
    selectHost(data.host);
  } catch (e) {
    registerError.value = e.message;
  } finally {
    registerBusy.value = false;
  }
}

async function saveHost() {
  if (!selectedHost.value || !editName.value.trim()) return;
  editBusy.value = true;
  editError.value = '';
  try {
    const data = await api.updateHost(selectedHost.value.id, {
      name: editName.value.trim(),
      status: editStatus.value,
    });
    const index = hosts.value.findIndex((host) => host.id === data.host.id);
    if (index >= 0) hosts.value[index] = data.host;
  } catch (e) {
    editError.value = e.message;
  } finally {
    editBusy.value = false;
  }
}

async function rotateKey() {
  if (!selectedHost.value || !confirm(`轮换「${hostTitle(selectedHost.value)}」的 key？旧 key 将进入宽限期。`)) return;
  try {
    const data = await api.rotateHostKey(selectedHost.value.id);
    newKey.value = { name: selectedHost.value.name, key: data.key };
  } catch (e) {
    error.value = e.message;
  }
}

async function deleteHost() {
  if (!selectedHost.value || !confirm(`确定删除主机「${hostTitle(selectedHost.value)}」？`)) return;
  try {
    await api.deleteHost(selectedHost.value.id);
    selectedId.value = '';
    newKey.value = null;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function copyKey() {
  if (!newKey.value) return;
  try {
    await navigator.clipboard.writeText(newKey.value.key);
  } catch {
    error.value = '复制失败，请手动保存这把一次性 key';
  }
}

function fmtTime(value) {
  if (!value) return '从未连接';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

onMounted(async () => {
  await load();
  void loadHostWork();
});
</script>

<template>
  <div class="hosts-page">
    <div class="d-flex justify-content-between align-items-end gap-3 mb-4">
      <div>
        <div class="eyebrow"><i class="bi bi-pc-display me-1"></i>HOSTS</div>
        <h1 class="page-title">主机工作台</h1>
        <p class="text-secondary mb-0">管理接入主机、状态和一次性 API key。</p>
      </div>
      <button class="btn btn-primary" @click="openRegister"><i class="bi bi-plus-lg me-1"></i>注册主机</button>
    </div>

    <div v-if="error" class="alert alert-danger">{{ error }}</div>
    <div v-if="newKey" class="alert alert-warning d-flex align-items-start gap-3">
      <i class="bi bi-key-fill fs-4"></i>
      <div class="flex-grow-1">
        <strong>新 key 只显示这一次（{{ newKey.name }}）</strong>
        <div class="key-box mt-2">{{ newKey.key }}</div>
        <div class="d-flex gap-2 mt-2">
          <button class="btn btn-sm btn-outline-secondary" @click="copyKey"><i class="bi bi-clipboard me-1"></i>复制 key</button>
          <button class="btn btn-sm btn-outline-secondary" @click="newKey = null">我已保存</button>
        </div>
      </div>
    </div>

    <div class="row g-4">
      <section class="col-lg-5">
        <div class="card">
          <div class="card-header d-flex justify-content-between align-items-center">
            <strong>主机列表</strong><span class="text-secondary small">{{ hosts.length }} 台</span>
          </div>
          <div v-if="loading" class="card-body text-secondary text-center py-5">加载中…</div>
          <div v-else-if="!hosts.length" class="card-body empty-state py-5">
            <i class="bi bi-pc-display"></i><strong>还没有主机</strong><span>注册一台主机开始接入。</span>
          </div>
          <div v-else class="list-group list-group-flush">
            <div v-for="host in hosts" :key="host.id" class="list-group-item list-group-item-action bg-transparent text-start"
              :class="{ active: String(selectedId) === String(host.id) }" role="button" tabindex="0"
              @click="selectHost(host)" @keydown.enter="selectHost(host)">
              <div class="d-flex align-items-center gap-2">
                <i class="bi bi-pc-display"></i>
                <strong class="text-truncate">{{ hostTitle(host) }}</strong>
                <StatusBadge class="ms-auto" kind="host" :status="host.status" :offline="host.offline"
                  :title="host.offline ? `超过 ${offlineAfter} 分钟无心跳` : ''" />
                <button type="button" class="btn btn-sm btn-ghost py-0 px-2" title="打开对话" @click.stop="openChannel(host)">
                  <i class="bi bi-chat-dots"></i>
                </button>
              </div>
              <div class="small opacity-75 mt-1 text-truncate">{{ host.id }} · 最近活跃：{{ fmtTime(host.last_seen) }}</div>
            </div>
          </div>
        </div>
      </section>

      <section class="col-lg-7">
        <div v-if="!selectedHost" class="card h-100">
          <div class="card-body empty-state py-5"><i class="bi bi-arrow-left-circle"></i><strong>选择一台主机</strong><span>主机详情会显示在这里。</span></div>
        </div>
        <div v-else class="card">
          <div class="card-header d-flex justify-content-between align-items-center">
            <strong><i class="bi bi-pc-display me-2"></i>{{ hostTitle(selectedHost) }}</strong>
            <code class="small">{{ selectedHost.id }}</code>
          </div>
          <ul class="nav nav-tabs px-3 pt-2" role="tablist">
            <li class="nav-item" role="presentation">
              <button class="nav-link" :class="{ active: activeTab === 'overview' }" role="tab" @click="setTab('overview')">概览</button>
            </li>
            <li class="nav-item" role="presentation">
              <button class="nav-link" :class="{ active: activeTab === 'work' }" role="tab" @click="setTab('work')">
                正在执行<span v-if="activeTasks.length" class="badge text-bg-primary ms-1">{{ activeTasks.length }}</span>
              </button>
            </li>
            <li class="nav-item" role="presentation">
              <button class="nav-link" :class="{ active: activeTab === 'activity' }" role="tab" @click="setTab('activity')">最近活动</button>
            </li>
          </ul>
          <div v-if="workError" class="alert alert-danger py-2 mx-3 mb-0 mt-3">{{ workError }}</div>
          <div v-show="activeTab === 'overview'" class="card-body">
            <div v-if="editError" class="alert alert-danger py-2">{{ editError }}</div>
            <div class="row g-3 mb-3">
              <div class="col-sm-6">
                <label class="form-label small">名称</label>
                <input v-model="editName" class="form-control">
              </div>
              <div class="col-sm-6">
                <label class="form-label small">状态</label>
                <select v-model="editStatus" class="form-select">
                  <option value="active">启用</option>
                  <option value="disabled">禁用</option>
                </select>
              </div>
            </div>
            <dl class="row small mb-4">
              <dt class="col-sm-4 text-secondary">当前状态</dt><dd class="col-sm-8"><StatusBadge kind="host" :status="selectedHost.status" :offline="selectedHost.offline" /></dd>
              <dt class="col-sm-4 text-secondary">最近心跳</dt><dd class="col-sm-8">{{ fmtTime(selectedHost.last_seen) }}</dd>
              <dt class="col-sm-4 text-secondary">创建时间</dt><dd class="col-sm-8">{{ fmtTime(selectedHost.created_at) }}</dd>
            </dl>
            <div class="d-flex flex-wrap gap-2">
              <button class="btn btn-outline-primary" @click="openChannel(selectedHost)"><i class="bi bi-chat-dots me-1"></i>对话</button>
              <button class="btn btn-primary" :disabled="editBusy" @click="saveHost">{{ editBusy ? '保存中…' : '保存修改' }}</button>
              <button class="btn btn-outline-warning" @click="rotateKey"><i class="bi bi-arrow-repeat me-1"></i>轮换 key</button>
              <button class="btn btn-outline-danger ms-auto" @click="deleteHost"><i class="bi bi-trash me-1"></i>删除主机</button>
            </div>
          </div>

          <div v-show="activeTab === 'work'" class="card-body">
            <div v-if="workLoading" class="text-secondary small py-3 text-center">加载中…</div>
            <div v-else-if="!activeTasks.length" class="text-secondary small py-3 text-center">
              <i class="bi bi-cup-hot me-1"></i>该主机当前没有正在执行的任务。
            </div>
            <div v-else class="list-group list-group-flush">
              <router-link v-for="item in activeTasks" :key="item.id" :to="`/tasks/${item.id}`"
                class="list-group-item list-group-item-action bg-transparent px-0 d-flex align-items-center gap-2">
                <StatusBadge :status="item.task?.status" />
                <span class="text-truncate">{{ item.title || item.id }}</span>
                <PrincipalChip v-if="item.author" :principal="item.author" role="发起人" />
                <span class="text-secondary small ms-auto flex-shrink-0">{{ item.created_at }}</span>
                <i class="bi bi-chevron-right text-secondary"></i>
              </router-link>
            </div>
          </div>

          <div v-show="activeTab === 'activity'" class="card-body">
            <div v-if="workLoading" class="text-secondary small py-3 text-center">加载中…</div>
            <div v-else-if="!hostEvents.length" class="text-secondary small py-3 text-center">
              <i class="bi bi-stars me-1"></i>暂无该主机触发的事件。
            </div>
            <ol v-else class="list-unstyled mb-0">
              <li v-for="event in hostEvents" :key="event.id" class="d-flex align-items-start gap-2 py-2 border-bottom">
                <span class="badge" :class="eventClass(event.action)"><i class="bi" :class="eventIcon(event.action)"></i></span>
                <div class="flex-grow-1">
                  <div class="small">{{ event.summary || event.action }}</div>
                  <div class="small text-secondary">
                    <router-link v-if="event.resource_type === 'post' && event.resource_id" :to="`/tasks/${event.resource_id}`">{{ event.resource_id }}</router-link>
                    <time class="ms-2" :datetime="event.occurred_at">{{ relativeTime(event.occurred_at) }}</time>
                  </div>
                </div>
              </li>
            </ol>
          </div>
        </div>
      </section>
    </div>

    <div ref="registerModalEl" class="modal fade" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog">
        <form class="modal-content" @submit.prevent="registerHost">
          <div class="modal-header"><h5 class="modal-title">注册主机</h5><button type="button" class="btn-close" @click="closeRegister"></button></div>
          <div class="modal-body">
            <label class="form-label">主机名称 *</label>
            <input v-model="registerForm.name" class="form-control" autofocus required placeholder="例如 build-host-01">
            <div class="text-secondary small mt-2">注册成功后 key 只返回一次，请交给主机上的 agent-daemon。</div>
            <div v-if="registerError" class="alert alert-danger py-2 mt-3 mb-0">{{ registerError }}</div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" @click="closeRegister">取消</button>
            <button class="btn btn-primary" :disabled="registerBusy">{{ registerBusy ? '注册中…' : '注册并生成 key' }}</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
