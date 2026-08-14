<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { Modal } from 'bootstrap';
import { api } from '../api';
import { recLabel } from '../utils';

const plans = ref([]);
const error = ref('');
const form = ref(blankForm());
let modal = null;
const modalEl = ref(null);

function blankForm() {
  return {
    name: '', recurrence: 'none', window_start: '03:00', window_end: '06:00',
    stages: [{ name: '阶段 1', tasks: [blankTask()] }],
  };
}
function blankTask() {
  return { title: '', instruction: '', visibility: 'private', assignee: '', deliverable_spec: '[]' };
}

onMounted(async () => {
  plans.value = (await api.plans()).plans || [];
});

function open() {
  error.value = '';
  form.value = blankForm();
  modal = new Modal(modalEl.value);
  modal.show();
}
function addStage() {
  form.value.stages.push({ name: `阶段 ${form.value.stages.length + 1}`, tasks: [blankTask()] });
}
function removeStage(i) {
  form.value.stages.splice(i, 1);
}
function addTask(s) { s.tasks.push(blankTask()); }
function removeTask(s, i) { s.tasks.splice(i, 1); }

function parseSpec(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) && v.length ? v : undefined;
  } catch { return undefined; }
}

async function submit() {
  error.value = '';
  try {
    const payload = {
      name: form.value.name,
      recurrence: form.value.recurrence,
      window_start: form.value.window_start,
      window_end: form.value.window_end,
      stages: form.value.stages
        .filter((s) => s.name?.trim())
        .map((s) => ({
          name: s.name.trim(),
          tasks: s.tasks
            .filter((t) => t.title?.trim() && t.instruction?.trim())
            .map((t) => ({
              title: t.title.trim(),
              instruction: t.instruction.trim(),
              visibility: t.visibility,
              assignee: t.assignee || undefined,
              deliverable_spec: parseSpec(t.deliverable_spec),
            })),
        }))
        .filter((s) => s.tasks.length > 0),
    };
    await api.createPlan(payload);
    modal.hide();
    plans.value = (await api.plans()).plans || [];
  } catch (e) { error.value = e.message; }
}

onBeforeUnmount(() => modal?.dispose());

function badge(status) {
  return {
    active: 'text-bg-primary', paused: 'text-bg-secondary', archived: 'text-bg-dark', done: 'text-bg-success',
  }[status] || 'text-bg-secondary';
}
</script>

<template>
  <div class="d-flex justify-content-between align-items-center mb-3">
    <div>
      <h4 class="mb-0 fw-bold">计划管理</h4>
      <div class="text-secondary small">plan → stage → task 三层编排；顺序闸门，周期序列</div>
    </div>
    <button class="btn btn-primary" @click="open"><i class="bi bi-plus-lg me-1"></i>创建计划</button>
  </div>

  <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
  <div v-if="plans.length === 0" class="card"><div class="card-body empty-state">
    <i class="bi bi-diagram-3"></i>还没有计划。计划用于把多个任务组织成有顺序闸门的阶段流水线；单发任务可直接在「任务」页创建。
  </div></div>
  <table v-else class="table table-hover">
    <thead><tr><th>计划</th><th>周期</th><th>阶段/任务</th><th>状态</th><th>下次克隆</th><th>创建</th></tr></thead>
    <tbody>
      <tr v-for="p in plans" :key="p.plan_id">
        <td><router-link :to="`/plans/${p.plan_id}`">{{ p.name }}</router-link>
          <div class="text-secondary small">{{ p.plan_id }}</div></td>
        <td>{{ recLabel(p.recurrence) }}</td>
        <td class="text-secondary small">{{ p.stage_count }} 阶段 / {{ p.task_count }} 任务</td>
        <td><span class="badge" :class="badge(p.status)">{{ p.status }}</span></td>
        <td class="text-secondary small">{{ p.next_due_at || '—' }}</td>
        <td class="text-secondary small">{{ p.created_at }}</td>
      </tr>
    </tbody>
  </table>

  <!-- 创建计划 modal -->
  <div ref="modalEl" class="modal fade" tabindex="-1">
    <div class="modal-dialog modal-xl modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header py-2"><h5 class="modal-title">创建计划</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <form @submit.prevent="submit">
          <div class="modal-body">
            <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
            <div class="row g-2 mb-2">
              <div class="col-4">
                <label class="form-label small">计划名称 *</label>
                <input v-model="form.name" class="form-control form-control-sm" required placeholder="如：月末巡检流水线">
              </div>
              <div class="col-2">
                <label class="form-label small">周期</label>
                <select v-model="form.recurrence" class="form-select form-select-sm">
                  <option value="none">一次性</option>
                  <option value="daily">每天</option>
                  <option value="weekly:1">每周一</option>
                  <option value="weekly:3">每周三</option>
                  <option value="weekly:5">每周五</option>
                  <option value="hourly">每小时</option>
                </select>
              </div>
              <div class="col-2">
                <label class="form-label small">窗口起</label>
                <input v-model="form.window_start" type="time" class="form-control form-control-sm">
              </div>
              <div class="col-2">
                <label class="form-label small">窗口止（错峰）</label>
                <input v-model="form.window_end" type="time" class="form-control form-control-sm">
              </div>
              <div class="col-2 d-flex align-items-end">
                <span class="text-secondary small">周期计划限单 stage</span>
              </div>
            </div>

            <div v-for="(s, si) in form.stages" :key="si" class="border rounded p-2 mb-2">
              <div class="d-flex align-items-center gap-2 mb-1">
                <input v-model="s.name" class="form-control form-control-sm" style="max-width:200px" placeholder="阶段名称">
                <span class="text-secondary small">阶段 {{ si + 1 }}{{ si === 0 ? '（当前，闸门起点）' : '（前序完成后放行）' }}</span>
                <button type="button" class="btn btn-sm btn-outline-danger ms-auto" @click="removeStage(si)" :disabled="form.stages.length === 1"><i class="bi bi-x"></i></button>
              </div>
              <div v-for="(t, ti) in s.tasks" :key="ti" class="border-top pt-2 mt-1" style="border-color:var(--border-soft)">
                <div class="row g-1">
                  <div class="col-3"><input v-model="t.title" class="form-control form-control-sm" placeholder="任务标题 *"></div>
                  <div class="col-5"><input v-model="t.instruction" class="form-control form-control-sm" placeholder="任务指令 *"></div>
                  <div class="col-2">
                    <select v-model="t.visibility" class="form-select form-select-sm">
                      <option value="private">私有</option>
                      <option value="public">公开（公共池）</option>
                    </select>
                  </div>
                  <div class="col-2 d-flex gap-1">
                    <input v-model="t.assignee" class="form-control form-control-sm" placeholder="执行方 agent_id">
                    <button type="button" class="btn btn-sm btn-outline-danger" @click="removeTask(s, ti)"><i class="bi bi-x"></i></button>
                  </div>
                  <div class="col-12"><input v-model="t.deliverable_spec" class="form-control form-control-sm" placeholder='验收方案 JSON（可选）如 [{"name":"报告","type":".md"}]'></div>
                </div>
              </div>
              <button type="button" class="btn btn-sm btn-outline-secondary mt-1" @click="addTask(s)"><i class="bi bi-plus me-1"></i>添加任务</button>
            </div>
            <button type="button" class="btn btn-sm btn-outline-primary" @click="addStage"><i class="bi bi-plus-lg me-1"></i>添加阶段（顺序闸门）</button>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
            <button type="submit" class="btn btn-primary">创建计划</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
