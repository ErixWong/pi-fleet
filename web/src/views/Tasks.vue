<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { Modal } from 'bootstrap';
import { api } from '../api';

const tasks = ref([]);
const agents = ref([]);
const filter = ref({ kind: '', status: '' });
const error = ref('');

// 指派任务表单
const manualForm = ref({ title: '', instruction: '', assignee_id: '', workdir: '' });
// 定时任务表单
const schedForm = ref({
  title: '',
  instruction: '',
  assignee_id: '',
  schedule_cron: 'daily',
  window_start: '03:00',
  window_end: '06:00',
  topic_name: '',
  workdir: '',
});

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
    await api.createTask({ kind: 'manual', ...manualForm.value });
    manualModal.hide();
    manualForm.value = { title: '', instruction: '', assignee_id: '', workdir: '' };
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function submitSched() {
  error.value = '';
  try {
    await api.createTask({ kind: 'scheduled', ...schedForm.value });
    schedModal.hide();
    schedForm.value = {
      title: '', instruction: '', assignee_id: '',
      schedule_cron: 'daily', window_start: '03:00', window_end: '06:00', topic_name: '', workdir: '',
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
    cancelled: 'text-bg-secondary',
  }[status] || 'text-bg-secondary';
}
</script>

<template>
  <div class="d-flex justify-content-between align-items-center mb-3">
    <h4 class="mb-0">任务管理</h4>
    <div>
      <button class="btn btn-outline-primary me-2" @click="openManual">+ 指派任务</button>
      <button class="btn btn-primary" @click="openSched">+ 定时任务</button>
    </div>
  </div>

  <div class="mb-3 d-flex gap-2">
    <select v-model="filter.kind" class="form-select form-select-sm" style="width:140px" @change="load">
      <option value="">类型: 全部</option>
      <option value="manual">manual</option>
      <option value="scheduled">scheduled</option>
    </select>
    <select v-model="filter.status" class="form-select form-select-sm" style="width:140px" @change="load">
      <option value="">状态: 全部</option>
      <option v-for="s in ['pending','assigned','running','done','failed','cancelled']" :key="s" :value="s">{{ s }}</option>
    </select>
  </div>

  <div v-if="tasks.length === 0" class="card"><div class="card-body text-secondary">暂无任务，点击右上角创建。</div></div>
  <table v-else class="table table-hover">
    <thead><tr><th>任务</th><th>类型</th><th>指派给</th><th>状态</th><th>周期</th><th>下次执行</th><th>结果</th></tr></thead>
    <tbody>
      <tr v-for="t in tasks" :key="t.task_id">
        <td>
          <router-link :to="`/tasks/${t.task_id}`">{{ t.title }}</router-link>
          <div class="text-secondary small">{{ t.task_id }}</div>
        </td>
        <td><span class="badge" :class="t.kind === 'scheduled' ? 'text-bg-info' : 'text-bg-secondary'">{{ t.kind }}</span></td>
        <td>{{ t.assignee }}</td>
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
            <label class="form-label">指派给 *</label>
            <select v-model="manualForm.assignee_id" class="form-select" required>
              <option value="" disabled>选择 agent</option>
              <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }} ({{ a.agent_id }})</option>
            </select>
            <label class="form-label mt-2">工作目录（可选，在既有项目干活时填项目路径）</label>
            <input v-model="manualForm.workdir" class="form-control" placeholder="如 /home/dev/projects/prjxxx1">
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
              <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }} ({{ a.agent_id }})</option>
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
            <label class="form-label mt-2">报告主题（不存在自动创建）</label>
            <input v-model="schedForm.topic_name" class="form-control" placeholder="如 disk-report">
            <label class="form-label mt-2">工作目录（可选，在既有项目干活时填项目路径）</label>
            <input v-model="schedForm.workdir" class="form-control" placeholder="如 /home/dev/projects/prjxxx1">
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
