<script setup>
import { onMounted, ref, watch } from 'vue';
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
const form = ref({ title: '', body: '', visibility: 'private', deliverable_spec: '' });

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

function openCreate() {
  form.value = { title: '', body: '', visibility: 'private', deliverable_spec: '' };
  createError.value = '';
  showCreate.value = true;
}

async function createTask() {
  if (!form.value.body.trim()) {
    createError.value = '任务描述不能为空';
    return;
  }
  createBusy.value = true;
  createError.value = '';
  try {
    await api.createTask({
      title: form.value.title.trim() || undefined,
      body: form.value.body.trim(),
      visibility: form.value.visibility,
      deliverable_spec: form.value.deliverable_spec.trim() || '完成任务并提交可验收的交付物',
      task: { is_ready: true },
    });
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
          <thead><tr><th>任务</th><th>状态</th><th>可见性</th><th>创建时间</th><th class="text-end">操作</th></tr></thead>
          <tbody>
            <tr v-for="item in items" :key="item.id">
              <td>
                <router-link :to="`/tasks/${item.id}`" class="fw-semibold text-decoration-none">{{ item.title || '未命名任务' }}</router-link>
                <div class="text-secondary small text-truncate" style="max-width: 520px">{{ item.body }}</div>
                <code class="small">{{ item.id }}</code>
              </td>
              <td><StatusBadge :status="item.task?.status" /></td>
              <td><span class="badge text-bg-secondary">{{ item.visibility }}</span></td>
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
              <label class="form-label">可见性</label>
              <select v-model="form.visibility" class="form-select mb-3">
                <option value="private">私有</option>
                <option value="account">账号内</option>
                <option value="public">公共池</option>
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
