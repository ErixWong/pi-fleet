<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import Pagination from '../components/Pagination.vue';
import StatusBadge from '../components/StatusBadge.vue';

const route = useRoute();
const router = useRouter();
const view = ref(['due', 'mine', 'pool'].includes(route.query.view) ? route.query.view : 'due');
const status = ref(typeof route.query.status === 'string' ? route.query.status : '');
const items = ref([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const error = ref('');
const showCreate = ref(false);
const createBusy = ref(false);
const createError = ref('');
const hosts = ref([]);
const hostsLoading = ref(false);
const form = ref({ title: '', body: '', visibility: 'public', deliverable_spec: '', targets: [] });
const hasTargets = computed(() => form.value.targets.some((id) => Boolean(id)));
const visibilityOptions = computed(() => hasTargets.value
  ? [
      ['private', '私有（仅指派主机可见）'],
      ['account', '账号内'],
      ['public', '公共池'],
    ]
  : [
      ['account', '账号内'],
      ['public', '公共池'],
    ]);

const statuses = [
  ['pending_audit', '待审核'],
  ['rejected', '已拒绝'],
  ['open', '待执行'],
  ['claimed', '已认领'],
  ['submitted', '待验收'],
  ['pending_confirm', '待确认'],
  ['done', '已完成'],
  ['failed', '失败'],
  ['cancelled', '已取消'],
];

function syncQuery() {
  const query = { view: view.value };
  if (status.value) query.status = status.value;
  router.replace({ path: '/tasks', query });
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.tasks({
      view: view.value,
      status: status.value || undefined,
      page: page.value,
      page_size: 20,
    });
    items.value = data.items ?? [];
    total.value = Number(data.total ?? 0);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function changeView(nextView) {
  view.value = nextView;
  page.value = 1;
  syncQuery();
  load();
}

function changeStatus() {
  page.value = 1;
  syncQuery();
  load();
}

async function loadHosts() {
  hostsLoading.value = true;
  try {
    const data = await api.hosts();
    hosts.value = data.items ?? [];
  } catch (e) {
    createError.value = e.message;
  } finally {
    hostsLoading.value = false;
  }
}

function openCreate() {
  form.value = { title: '', body: '', visibility: 'public', deliverable_spec: '', targets: [] };
  createError.value = '';
  showCreate.value = true;
  void loadHosts();
}

function normalizeTargets() {
  const selected = form.value.targets.filter(Boolean);
  if (selected.length !== form.value.targets.length) form.value.targets = selected;
}

function hostLabel(host) {
  const state = host.offline || host.status !== 'active' ? '离线' : '在线';
  return `${host.name || host.id}（${state}）`;
}

function targetLabel(target) {
  return target.principal?.name || target.principal?.id || target.principal_id || target.role;
}

async function createTask() {
  if (!form.value.body.trim()) {
    createError.value = '任务描述不能为空';
    return;
  }
  createBusy.value = true;
  createError.value = '';
  try {
    const payload = {
      title: form.value.title.trim() || undefined,
      body: form.value.body.trim(),
      visibility: form.value.visibility,
      deliverable_spec: form.value.deliverable_spec.trim() || '完成任务并提交可验收的交付物',
      task: { is_ready: true },
    };
    const targets = form.value.targets
      .filter(Boolean)
      .map((principal_id) => ({ principal_id, role: 'assignee' }));
    if (targets.length) payload.targets = targets;
    await api.createTask(payload);
    showCreate.value = false;
    page.value = 1;
    await load();
  } catch (e) {
    createError.value = e.message;
  } finally {
    createBusy.value = false;
  }
}

onMounted(() => {
  load();
  if (route.query.create === '1') openCreate();
});

watch(() => route.query.create, (value) => {
  if (value === '1') openCreate();
});

watch(hasTargets, (selected) => {
  if (selected && form.value.visibility !== 'private') {
    form.value.visibility = 'private';
  } else if (!selected && form.value.visibility === 'private') {
    form.value.visibility = 'public';
  }
});
</script>

<template>
  <div class="tasks-page">
    <div class="d-flex align-items-end justify-content-between gap-3 mb-4">
      <div>
        <div class="eyebrow"><i class="bi bi-list-task me-1"></i>TASKS</div>
        <h1 class="page-title">任务列表</h1>
        <p class="text-secondary mb-0">按待办、我的任务或公共池浏览任务。</p>
      </div>
      <button class="btn btn-primary" @click="openCreate"><i class="bi bi-plus-lg me-1"></i>新建任务</button>
    </div>

    <div v-if="error" class="alert alert-danger">{{ error }}</div>

    <div class="card mb-3">
      <div class="card-body d-flex flex-wrap align-items-center gap-2">
        <div class="btn-group" role="tablist" aria-label="任务视图">
          <button v-for="item in [['due', '待办'], ['mine', '我的任务'], ['pool', '公共池']]" :key="item[0]" class="btn btn-sm"
            :class="view === item[0] ? 'btn-primary' : 'btn-outline-secondary'" @click="changeView(item[0])">
            {{ item[1] }}
          </button>
        </div>
        <select v-model="status" class="form-select form-select-sm ms-auto" style="max-width: 190px" aria-label="状态筛选" @change="changeStatus">
          <option value="">全部状态</option>
          <option v-for="item in statuses" :key="item[0]" :value="item[0]">{{ item[1] }}</option>
        </select>
      </div>
    </div>

    <div class="card">
      <div v-if="loading" class="card-body text-secondary text-center py-5">加载中…</div>
      <div v-else-if="!items.length" class="card-body empty-state py-5">
        <i class="bi bi-inbox"></i><strong>没有任务</strong><span>调整视图或筛选条件后再试。</span>
      </div>
      <div v-else class="table-responsive">
        <table class="table table-hover align-middle mb-0">
          <thead><tr><th>任务</th><th>状态</th><th>可见性</th><th>指派目标</th><th>创建时间</th><th class="text-end">操作</th></tr></thead>
          <tbody>
            <tr v-for="item in items" :key="item.id">
              <td>
                <router-link :to="`/tasks/${item.id}`" class="fw-semibold text-decoration-none">{{ item.title || '未命名任务' }}</router-link>
                <div class="text-secondary small text-truncate" style="max-width: 520px">{{ item.body }}</div>
                <code class="small">{{ item.id }}</code>
              </td>
              <td><StatusBadge :status="item.task?.status" /></td>
              <td><span class="badge text-bg-secondary">{{ item.visibility }}</span></td>
              <td class="small">
                <template v-if="item.targets?.length">
                  <span v-for="target in item.targets" :key="`${target.principal?.id || target.principal_id}-${target.role}`" class="badge text-bg-light me-1">
                    {{ targetLabel(target) }} · {{ target.role }}
                  </span>
                </template>
                <span v-else class="text-secondary">公共池</span>
              </td>
              <td class="small text-secondary">{{ item.created_at }}</td>
              <td class="text-end"><router-link :to="`/tasks/${item.id}`" class="btn btn-sm btn-outline-primary">详情</router-link></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!loading && items.length" class="card-footer bg-transparent">
        <Pagination :total="total" v-model:page="page" :page-size="20" @change="load" />
      </div>
    </div>

    <div v-if="showCreate" class="modal show d-block" tabindex="-1" role="dialog" aria-modal="true">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">新建任务</h5>
            <button type="button" class="btn-close" aria-label="关闭" @click="showCreate = false"></button>
          </div>
          <form @submit.prevent="createTask">
            <div class="modal-body">
              <label class="form-label">标题</label>
              <input v-model="form.title" class="form-control mb-3" maxlength="255" placeholder="可选">
              <label class="form-label">任务描述 *</label>
              <textarea v-model="form.body" class="form-control mb-3" rows="5" required></textarea>
              <label class="form-label">指派主机</label>
              <select v-model="form.targets" class="form-select mb-2" multiple size="4" :disabled="hostsLoading" @change="normalizeTargets">
                <option value="">不指定（使用公共池）</option>
                <option v-for="host in hosts" :key="host.id" :value="host.id" :disabled="host.status !== 'active'">
                  {{ hostLabel(host) }}
                </option>
              </select>
              <div class="text-secondary small mb-3">
                <span v-if="hostsLoading">正在加载主机…</span>
                <span v-else-if="hasTargets">已指派主机；可见性已切换为私有，只有指派目标可见。</span>
                <span v-else>不指定主机时任务进入账号内或公共池，主机可自行领取。</span>
              </div>
              <label class="form-label">可见性</label>
              <select v-model="form.visibility" class="form-select mb-3">
                <option v-for="option in visibilityOptions" :key="option[0]" :value="option[0]">{{ option[1] }}</option>
              </select>
              <label class="form-label">交付要求</label>
              <textarea v-model="form.deliverable_spec" class="form-control" rows="3" placeholder="留空将使用默认交付要求"></textarea>
              <div v-if="createError" class="alert alert-danger py-2 mt-3 mb-0">{{ createError }}</div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" @click="showCreate = false">取消</button>
              <button class="btn btn-primary" :disabled="createBusy">{{ createBusy ? '创建中…' : '创建任务' }}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
    <div v-if="showCreate" class="modal-backdrop show"></div>
  </div>
</template>
