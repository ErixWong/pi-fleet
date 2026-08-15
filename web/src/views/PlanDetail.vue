<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { recLabel } from '../utils';

const route = useRoute();
const plan = ref(null);
const error = ref('');

onMounted(load);
async function load() {
  try {
    plan.value = (await api.plan(route.params.planId)).plan;
  } catch (e) { error.value = e.message; }
}

function badge(status) {
  return {
    done: 'text-bg-success', failed: 'text-bg-danger', cancelled: 'text-bg-secondary',
    active: 'text-bg-primary', blocked: 'text-bg-dark', claimed: 'text-bg-warning',
    submitted: 'text-bg-info', pending_confirm: 'text-bg-warning', pending_audit: 'text-bg-warning',
    rejected: 'text-bg-danger', open: 'text-bg-info', running: 'text-bg-info', pending: 'text-bg-warning', resolved: 'text-bg-success',
  }[status] || 'text-bg-secondary';
}

/** stage 是否 stalled（有 failed 任务卡住） */
const stalledStages = computed(() => {
  const m = {};
  for (const s of plan.value?.stages || []) {
    if (s.tasks.some((t) => t.status === 'failed')) m[s.seq] = true;
  }
  return m;
});

async function reopenTask(t) {
  if (!confirm(`重开任务「${t.title}」？尝试次数将清零，任务按落点回到 open/active。`)) return;
  try { await api.taskReopen(t.task_id); await load(); } catch (e) { error.value = e.message; }
}
async function reassignTask(t) {
  const agentId = prompt(`改派「${t.title}」给哪个 agent_id？`, '');
  if (!agentId) return;
  try { await api.taskReassign(t.task_id, agentId.trim()); await load(); } catch (e) { error.value = e.message; }
}
async function cancelTask(t) {
  if (!confirm(`取消「${t.title}」？（取消=跳过，不阻塞闸门）`)) return;
  try { await api.cancelTask(t.task_id); await load(); } catch (e) { error.value = e.message; }
}
async function changeVisibility(t, value) {
  try { await api.taskDeliverableVisibility(t.task_id, value); await load(); } catch (e) { error.value = e.message; }
}
</script>

<template>
  <router-link to="/plans" class="btn btn-sm btn-outline-secondary mb-3"><i class="bi bi-arrow-left me-1"></i>计划列表</router-link>
  <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
  <div v-if="plan">
    <div class="d-flex align-items-center gap-2 mb-3 flex-wrap">
      <h4 class="mb-0 fw-bold">{{ plan.name }}</h4>
      <span class="text-secondary small">{{ plan.plan_id }}</span>
      <span class="badge" :class="plan.status === 'done' ? 'text-bg-success' : plan.status === 'paused' ? 'text-bg-secondary' : 'text-bg-primary'">{{ plan.status }}</span>
      <span v-if="plan.scheduled_stage_count" class="badge text-bg-warning">含定时 stage</span>
    </div>

    <!-- 树视图：stage 竖排，当前高亮 / 后续置灰 / stalled 标红 -->
    <div class="d-flex flex-column gap-3">
      <div v-for="(s, si) in plan.stages" :key="s.id" class="card" :class="{
        'border-primary': s.current,
        'opacity-75': !s.current && plan.status !== 'done',
      }">
        <div class="card-header py-2 d-flex align-items-center gap-2">
          <span class="badge" :class="s.current ? 'text-bg-primary' : stalledStages[s.seq] ? 'text-bg-danger' : 'text-bg-secondary'">
            {{ s.current ? '当前' : stalledStages[s.seq] ? 'stalled' : `阶段 ${si + 1}` }}
          </span>
          <span class="fw-semibold">{{ s.name }}</span>
          <span class="badge text-bg-secondary" style="font-size:0.65rem">{{ s.wait_prev ? '顺序' : '并发' }}</span>
          <span v-if="s.recurrence !== 'none'" class="badge text-bg-warning" style="font-size:0.65rem">定时 {{ recLabel(s.recurrence) }}</span>
          <span v-if="s.next_due_at" class="text-secondary small">下次生成：{{ s.next_due_at }}</span>
          <span class="text-secondary small">seq {{ s.seq }}</span>
          <span v-if="s.skipped.length" class="badge text-bg-secondary ms-auto">跳过：{{ s.skipped.join('、') }}</span>
        </div>
        <div class="card-body p-2">
          <div v-if="s.tasks.length === 0" class="text-secondary small p-2">（空阶段）</div>
          <div v-for="t in s.tasks" :key="t.task_id" class="d-flex align-items-center gap-2 py-1 border-bottom" style="border-color:var(--border-soft)">
            <router-link :to="`/tasks/${t.task_id}`" class="text-decoration-none">{{ t.title }}</router-link>
            <span class="badge" :class="badge(t.status)">{{ t.status }}</span>
            <span class="badge" :class="t.visibility === 'public' ? 'text-bg-primary' : 'text-bg-secondary'">{{ t.visibility }}</span>
            <span class="text-secondary small">{{ t.assignee || (t.status === 'blocked' ? '（闸门中）' : '') }}</span>
            <span v-if="t.deliver_attempts" class="text-secondary small">尝试 {{ t.deliver_attempts }}/{{ t.max_attempts }}</span>
            <!-- failed 处置（§编排五：重开 / 改派 / 取消=跳过） -->
            <span v-if="t.status === 'failed'" class="ms-auto d-flex gap-1">
              <button class="btn btn-sm btn-outline-success" @click="reopenTask(t)">重开</button>
              <button class="btn btn-sm btn-outline-warning" @click="reassignTask(t)">改派</button>
              <button class="btn btn-sm btn-outline-danger" @click="cancelTask(t)">取消(跳过)</button>
            </span>
            <!-- 交付物可见性 -->
            <span v-else class="ms-auto d-flex align-items-center gap-1">
              <span class="text-secondary small">交付物</span>
              <select class="form-select form-select-sm" style="width:130px"
                      :value="t.deliverable_visibility" @change="changeVisibility(t, $event.target.value)">
                <option value="participants">participants</option>
                <option value="account">account</option>
                <option value="public">public</option>
              </select>
            </span>
          </div>
        </div>
      </div>
    </div>
    <div v-if="plan.status === 'done'" class="alert alert-success py-2 mt-3 mb-0">全部阶段完成，计划已自动置 done（只归档不删除）。</div>
  </div>
</template>
