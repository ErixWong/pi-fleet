<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { Modal } from 'bootstrap';
import { api } from '../api';

const tasks = ref([]);
const agents = ref([]);
const filter = ref({ kind: '', status: '' });
const error = ref('');

// 指派任务表单
const manualForm = ref({ title: '', instruction: '', assignee_id: '', workdir: '', visibility: 'private', deliverableSpec: [] });
// 定时任务表单
const schedForm = ref({
  title: '',
  instruction: '',
  assignee_id: '',
  schedule_cron: 'daily',
  window_start: '03:00',
  window_end: '06:00',
  workdir: '',
  deliverableSpec: [],
});

function addDeliverable(form) {
  form.deliverableSpec.push({ name: '', path: '', criteria: '' });
}
function removeDeliverable(form, i) {
  form.deliverableSpec.splice(i, 1);
}
function cleanDeliverables(form) {
  return form.deliverableSpec.filter((d) => d.name && d.name.trim());
}

let manualModal = null;
let schedModal = null;
const manualModalEl = ref(null);
const schedModalEl = ref(null);

async function load() {
  const params = {};
  if (filter.value.kind) params.kind = filter.value.kind;
  if (filter.value.status) params.status = filter.value.status;
  const data = await api.tasks(params);
  tasks.value = data.tasks;
  if (data.agents.length > 0) {
    agents.value = data.agents;
  }
}

onMounted(async () => {
  const data = await api.tasks();
  tasks.value = data.tasks;
  agents.value = data.agents;
});

function openManual() {
  error.value = '';
  manualModal = new Modal(manualModalEl.value);
  manualModal.show();
}
function openSched() {
  error.value = '';
  schedModal = new Modal(schedModalEl.value);
  schedModal.show();
}

async function submitManual() {
  error.value = '';
  try {
    const spec = cleanDeliverables(manualForm.value);
    await api.createTask({ kind: 'manual', ...manualForm.value, deliverable_spec: spec.length ? spec : undefined });
    manualModal.hide();
    manualForm.value = { title: '', instruction: '', assignee_id: '', workdir: '', visibility: 'private', deliverableSpec: [] };
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function submitSched() {
  error.value = '';
  try {
    const spec = cleanDeliverables(schedForm.value);
    await api.createTask({ kind: 'scheduled', ...schedForm.value, deliverable_spec: spec.length ? spec : undefined });
    schedModal.hide();
    schedForm.value = {
      title: '', instruction: '', assignee_id: '',
      schedule_cron: 'daily', window_start: '03:00', window_end: '06:00', workdir: '', deliverableSpec: [],
    };
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

onBeforeUnmount(() => {
  manualModal?.dispose();
  schedModal?.dispose();
});

function badge(status) {
  return {
    done: 'text-bg-success',
    failed: 'text-bg-danger',
    running: 'text-bg-info',
    assigned: 'text-bg-warning',
    pending: 'text-bg-warning',
    pending_audit: 'text-bg-warning',
    rejected: 'text-bg-danger',
    active: 'text-bg-primary',
    claimed: 'text-bg-warning',
    submitted: 'text-bg-info',
    pending_confirm: 'text-bg-warning',
    open: 'text-bg-info',
    resolved: 'text-bg-success',
    cancelled: 'text-bg-secondary',
  }[status] || 'text-bg-secondary';
}
</script>

<template>
  <div class="d-flex justify-content-between align-items-center mb-3">
    <div>
      <h4 class="mb-0 fw-bold">任务管理</h4>
      <div class="text-secondary small">指派 / 定时 / 协作会话</div>
    </div>
    <div>
      <button class="btn btn-outline-secondary me-2" @click="openManual"><i class="bi bi-person-plus me-1"></i>指派任务</button>
      <button class="btn btn-primary" @click="openSched"><i class="bi bi-clock-history me-1"></i>定时任务</button>
    </div>
  </div>

  <div class="mb-3 d-flex gap-2">
    <select v-model="filter.kind" class="form-select form-select-sm" style="width:150px" @change="load">
      <option value="">类型: 全部</option>
      <option value="manual">manual</option>
      <option value="scheduled">scheduled</option>
    </select>
    <select v-model="filter.status" class="form-select form-select-sm" style="width:150px" @change="load">
      <option value="">状态: 全部</option>
      <option v-for="s in ['pending_audit','rejected','active','claimed','submitted','pending_confirm','open','pending','running','done','failed','resolved','cancelled']" :key="s" :value="s">{{ s }}</option>
    </select>
  </div>

  <div v-if="tasks.length === 0" class="card"><div class="card-body empty-state">
    <i class="bi bi-inbox"></i>暂无任务，点击右上角创建。
  </div></div>
  <table v-else class="table table-hover">
    <thead><tr><th>任务</th><th>类型</th><th>可见性</th><th>指派给</th><th>状态</th><th>周期</th><th>下次执行</th><th>结果</th></tr></thead>
    <tbody>
      <tr v-for="t in tasks" :key="t.task_id">
        <td>
          <router-link :to="`/tasks/${t.task_id}`">{{ t.title }}</router-link>
          <div class="text-secondary small">{{ t.task_id }}</div>
        </td>
        <td><span class="badge" :class="t.kind === 'scheduled' ? 'text-bg-info' : 'text-bg-secondary'">{{ t.kind }}</span></td>
        <td>
          <span class="badge" :class="t.visibility === 'public' ? 'text-bg-primary' : 'text-bg-secondary'"
                :title="t.visibility === 'public' ? '公开：在公共池，可被其他主机认领' : '私有：仅发起人及指派主机可见'">
            {{ t.visibility }}
          </span>
        </td>
        <td>{{ t.assignee || (t.status === 'active' ? '（待认领）' : '—') }}</td>
        <td><span class="badge badge-status" :class="badge(t.status)">{{ t.status }}</span></td>
        <td class="text-secondary small">{{ t.schedule_cron || '—' }}</td>
        <td class="text-secondary small">{{ t.next_due_at || '—' }}</td>
        <td>{{ t.result_status || '—' }}</td>
      </tr>
    </tbody>
  </table>

  <!-- 指派任务 modal -->
  <div ref="manualModalEl" class="modal fade" tabindex="-1">
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header"><h5 class="modal-title">创建指派任务</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <form @submit.prevent="submitManual">
          <div class="modal-body">
            <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
            <label class="form-label">标题 *</label>
            <input v-model="manualForm.title" class="form-control mb-2" required placeholder="如：修复登录页 500 错误">
            <label class="form-label">自然语言指令 *</label>
            <textarea v-model="manualForm.instruction" class="form-control mb-2" rows="5" required
              placeholder="详细描述要 agent 做什么，包括上下文、验收标准..."></textarea>
            <label class="form-label">可见性（§3.2）</label>
            <select v-model="manualForm.visibility" class="form-select mb-2">
              <option value="private">私有（指派给指定主机）</option>
              <option value="public">公开（丢到公共池，任意开启接单的主机可认领）</option>
            </select>
            <template v-if="manualForm.visibility === 'private'">
              <label class="form-label">指派给 *</label>
              <select v-model="manualForm.assignee_id" class="form-select" required>
                <option value="" disabled>选择 agent</option>
                <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }} · {{ a.hostname || a.agent_id }}</option>
              </select>
            </template>
            <template v-else>
              <div class="alert alert-info py-2 small mb-2">公开任务进入公共池，由开启「接外单」开关的主机 agent 阅读描述后自主认领（先到先得）。</div>
            </template>
            <label class="form-label mt-2">工作目录（可选，在既有项目干活时填项目路径）</label>
            <input v-model="manualForm.workdir" class="form-control" placeholder="如 /home/dev/projects/prjxxx1">
            <label class="form-label mt-2">交付物约定（可选，任务要交付什么 + 验收标准）</label>
            <div v-for="(d, i) in manualForm.deliverableSpec" :key="i" class="border rounded p-2 mb-2" style="border-color:var(--border-soft)">
              <div class="row g-2 align-items-center">
                <div class="col-4"><input v-model="d.name" class="form-control form-control-sm" placeholder="名称 *（如 代码变更）"></div>
                <div class="col-4"><input v-model="d.path" class="form-control form-control-sm" placeholder="路径（src/login.ts）"></div>
                <div class="col-3"><input v-model="d.criteria" class="form-control form-control-sm" placeholder="验收标准（通过单测）"></div>
                <div class="col-1"><button type="button" class="btn btn-sm btn-outline-danger w-100" @click="removeDeliverable(manualForm, i)"><i class="bi bi-x"></i></button></div>
              </div>
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary" @click="addDeliverable(manualForm)"><i class="bi bi-plus me-1"></i>添加交付物</button>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
            <button type="submit" class="btn btn-primary">创建</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <!-- 定时任务 modal -->
  <div ref="schedModalEl" class="modal fade" tabindex="-1">
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header"><h5 class="modal-title">创建定时任务</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <form @submit.prevent="submitSched">
          <div class="modal-body">
            <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
            <label class="form-label">标题 *</label>
            <input v-model="schedForm.title" class="form-control mb-2" required placeholder="如：每日磁盘空间检查">
            <label class="form-label">自然语言指令 *</label>
            <textarea v-model="schedForm.instruction" class="form-control mb-2" rows="5" required
              placeholder="如：检查 / 和 /var 分区磁盘使用率，超过 80% 列出最占空间的目录，写报告投递到主题"></textarea>
            <label class="form-label">指派给 *</label>
            <select v-model="schedForm.assignee_id" class="form-select mb-2" required>
              <option value="" disabled>选择 agent</option>
              <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }} · {{ a.hostname || a.agent_id }}</option>
            </select>
            <div class="row">
              <div class="col-4">
                <label class="form-label">周期</label>
                <select v-model="schedForm.schedule_cron" class="form-select">
                  <option value="daily">每天</option>
                  <option value="weekly:1">每周一</option>
                  <option value="weekly:3">每周三</option>
                  <option value="weekly:5">每周五</option>
                  <option value="hourly">每小时</option>
                </select>
              </div>
              <div class="col-4">
                <label class="form-label">窗口起</label>
                <input v-model="schedForm.window_start" type="time" class="form-control">
              </div>
              <div class="col-4">
                <label class="form-label">窗口止（错峰随机执行）</label>
                <input v-model="schedForm.window_end" type="time" class="form-control">
              </div>
            </div>
            <label class="form-label mt-2">工作目录（可选，在既有项目干活时填项目路径）</label>
            <input v-model="schedForm.workdir" class="form-control" placeholder="如 /home/dev/projects/prjxxx1">
            <label class="form-label mt-2">交付物约定（可选，任务要交付什么 + 验收标准）</label>
            <div v-for="(d, i) in schedForm.deliverableSpec" :key="i" class="border rounded p-2 mb-2" style="border-color:var(--border-soft)">
              <div class="row g-2 align-items-center">
                <div class="col-4"><input v-model="d.name" class="form-control form-control-sm" placeholder="名称 *（如 代码变更）"></div>
                <div class="col-4"><input v-model="d.path" class="form-control form-control-sm" placeholder="路径（src/login.ts）"></div>
                <div class="col-3"><input v-model="d.criteria" class="form-control form-control-sm" placeholder="验收标准（通过单测）"></div>
                <div class="col-1"><button type="button" class="btn btn-sm btn-outline-danger w-100" @click="removeDeliverable(schedForm, i)"><i class="bi bi-x"></i></button></div>
              </div>
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary" @click="addDeliverable(schedForm)"><i class="bi bi-plus me-1"></i>添加交付物</button>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
            <button type="submit" class="btn btn-primary">创建</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
