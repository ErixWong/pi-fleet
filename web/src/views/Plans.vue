<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { Modal } from 'bootstrap';
import { api } from '../api';
import Pagination from '../components/Pagination.vue';

const plans = ref([]);
const error = ref('');
const page = ref(1);
const total = ref(0);
const form = ref(blankForm());
let modal = null;
const modalEl = ref(null);
// 展开的 plan 树缓存：plan_id → planTree.plan
const expanded = ref({});
const treeData = ref({});

function blankForm() {
  return {
    name: '',
    stages: [{ name: '阶段 1', wait_prev: true, recurrence: 'none', window_start: '03:00', window_end: '06:00', tasks: [blankTask()] }],
  };
}
function blankTask() {
  return { title: '', instruction: '', visibility: 'private', assignee: '', deliverable_spec: '[]' };
}

async function load() {
  const data = await api.plans(page.value, 10);
  plans.value = data.plans || [];
  total.value = data.total ?? 0;
}

onMounted(load);

/** 展开/收起 plan → 拉树视图（stage + task） */
async function toggle(p) {
  const pid = p.plan_id;
  if (expanded.value[pid]) {
    expanded.value[pid] = false;
    return;
  }
  expanded.value[pid] = true;
  if (!treeData.value[pid]) {
    try {
      const r = await api.plan(pid);
      if (r.plan) treeData.value[pid] = r.plan;
    } catch (e) {
      error.value = e.message;
    }
  }
}

function open() {
  error.value = '';
  form.value = blankForm();
  modal = new Modal(modalEl.value);
  modal.show();
}
function addStage() {
  form.value.stages.push({ name: `阶段 ${form.value.stages.length + 1}`, wait_prev: true, recurrence: 'none', window_start: '03:00', window_end: '06:00', tasks: [blankTask()] });
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

function recLabel(r) {
  if (!r || r === 'none') return '—';
  if (r === 'daily') return '每天';
  if (r === 'hourly') return '每小时';
  const m = /^weekly:([0-6])$/.exec(r);
  return m ? `每周${['日', '一', '二', '三', '四', '五', '六'][Number(m[1])]}` : r;
}

async function submit() {
  error.value = '';
  try {
    const payload = {
      name: form.value.name,
      stages: form.value.stages
        .filter((s) => s.name?.trim())
        .map((s) => ({
          name: s.name.trim(),
          wait_prev: s.wait_prev ? 1 : 0,
          recurrence: s.recurrence || 'none',
          window_start: s.recurrence !== 'none' ? s.window_start : undefined,
          window_end: s.recurrence !== 'none' ? s.window_end : undefined,
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
    page.value = 1;
    await load();
  } catch (e) { error.value = e.message; }
}

onBeforeUnmount(() => modal?.dispose());

function badge(status) {
  return {
    active: 'text-bg-primary', paused: 'text-bg-secondary', archived: 'text-bg-dark', done: 'text-bg-success',
  }[status] || 'text-bg-secondary';
}
function tbadge(status) {
  return {
    done: 'text-bg-success', failed: 'text-bg-danger', cancelled: 'text-bg-secondary', blocked: 'text-bg-dark',
    pending_audit: 'text-bg-warning', rejected: 'text-bg-danger', active: 'text-bg-primary', claimed: 'text-bg-warning',
    submitted: 'text-bg-info', pending_confirm: 'text-bg-warning', open: 'text-bg-info', pending: 'text-bg-secondary',
    running: 'text-bg-info', resolved: 'text-bg-success',
  }[status] || 'text-bg-secondary';
}
</script>

<template>
  <div class="d-flex justify-content-between align-items-center mb-3">
    <div>
      <h4 class="mb-0 fw-bold">任务与计划</h4>
      <div class="text-secondary small">plan → stage → task 强制三层；stage 可顺序（等待前序）或并发，可定时（周期生成原子任务）</div>
    </div>
    <button class="btn btn-primary" @click="open"><i class="bi bi-plus-lg me-1"></i>创建计划</button>
  </div>

  <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
  <div v-if="plans.length === 0" class="card"><div class="card-body empty-state">
    <i class="bi bi-diagram-3"></i>还没有计划。创建计划 → 定义 stage（顺序/并发 + 定时）→ 每个 stage 下定义任务。
  </div></div>
  <div v-else class="card">
    <table class="table table-hover mb-0">
      <thead><tr><th style="width:36px"></th><th>计划</th><th>阶段/任务</th><th>定时 stage</th><th>状态</th><th>创建</th></tr></thead>
      <tbody>
        <template v-for="p in plans" :key="p.plan_id">
          <tr style="cursor:pointer" @click="toggle(p)">
            <td><i class="bi" :class="expanded[p.plan_id] ? 'bi-chevron-down' : 'bi-chevron-right'"></i></td>
            <td>
              <span class="fw-semibold">{{ p.name }}</span>
              <span class="text-secondary small ms-2">{{ p.plan_id }}</span>
            </td>
            <td class="text-secondary small">{{ p.stage_count }} 阶段 / {{ p.task_count }} 任务</td>
            <td class="text-secondary small">{{ p.scheduled_stage_count > 0 ? `${p.scheduled_stage_count} 个` : '—' }}</td>
            <td><span class="badge" :class="badge(p.status)">{{ p.status }}</span></td>
            <td class="text-secondary small">{{ p.created_at }}</td>
          </tr>
          <!-- 展开：stage → task 树 -->
          <tr v-if="expanded[p.plan_id] && treeData[p.plan_id]">
            <td></td>
            <td colspan="5">
              <div class="py-2">
                <div v-for="(s, si) in treeData[p.plan_id].stages" :key="s.id" class="mb-2">
                  <div class="d-flex align-items-center gap-2 flex-wrap">
                    <i class="bi bi-folder2-open text-secondary"></i>
                    <span class="fw-semibold small">{{ si + 1 }}. {{ s.name }}</span>
                    <span class="badge text-bg-secondary" style="font-size:0.65rem">{{ s.wait_prev ? '顺序' : '并发' }}</span>
                    <span v-if="s.recurrence !== 'none'" class="badge text-bg-warning" style="font-size:0.65rem">
                      定时 {{ recLabel(s.recurrence) }}{{ s.window_start ? ` ${s.window_start}-${s.window_end}` : '' }}
                    </span>
                    <span v-if="s.next_due_at" class="text-secondary small">下次生成：{{ s.next_due_at }}</span>
                  </div>
                  <div v-if="s.tasks.length === 0" class="text-secondary small ms-3 mt-1">（暂无任务）</div>
                  <table v-else class="table table-sm table-borderless mb-0 ms-3 mt-1" style="max-width:760px">
                    <tbody>
                      <tr v-for="t in s.tasks" :key="t.task_id">
                        <td style="width:24px"><i class="bi bi-file-text text-secondary"></i></td>
                        <td>
                          <router-link :to="`/tasks/${t.task_id}`" class="text-decoration-none">{{ t.title }}</router-link>
                        </td>
                        <td class="text-secondary small">{{ t.assignee || '（待认领）' }}</td>
                        <td class="text-secondary small">{{ t.origin === 'periodic' ? '周期' : '手动' }}</td>
                        <td><span class="badge" :class="tbadge(t.status)" style="font-size:0.65rem">{{ t.status }}</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>

  <div class="mt-2">
    <Pagination :total="total" v-model:page="page" :page-size="10" @change="load" />
  </div>

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
              <div class="col-6">
                <label class="form-label small">计划名称 *</label>
                <input v-model="form.name" class="form-control form-control-sm" required placeholder="如：月末巡检流水线">
              </div>
              <div class="col-6 d-flex align-items-end">
                <span class="text-secondary small">每个 stage 独立设置「等待前序」与「定时」，自由组合</span>
              </div>
            </div>

            <div v-for="(s, si) in form.stages" :key="si" class="border rounded p-2 mb-2">
              <div class="d-flex align-items-center gap-2 mb-1 flex-wrap">
                <input v-model="s.name" class="form-control form-control-sm" style="max-width:180px" placeholder="阶段名称">
                <label class="form-check form-check-inline small mb-0">
                  <input v-model="s.wait_prev" class="form-check-input" type="checkbox">
                  <span class="form-check-label">等待前序完成（顺序；关=并发）</span>
                </label>
                <select v-model="s.recurrence" class="form-select form-select-sm" style="max-width:130px">
                  <option value="none">一次性</option>
                  <option value="daily">每天</option>
                  <option value="weekly:1">每周一</option>
                  <option value="weekly:3">每周三</option>
                  <option value="weekly:5">每周五</option>
                  <option value="hourly">每小时</option>
                </select>
                <template v-if="s.recurrence !== 'none'">
                  <input v-model="s.window_start" type="time" class="form-control form-control-sm" style="max-width:110px" title="错峰窗口起">
                  <span class="text-secondary small">至</span>
                  <input v-model="s.window_end" type="time" class="form-control form-control-sm" style="max-width:110px" title="错峰窗口止">
                </template>
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
            <button type="button" class="btn btn-sm btn-outline-primary" @click="addStage"><i class="bi bi-plus-lg me-1"></i>添加阶段</button>
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
