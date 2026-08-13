<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { renderMd } from '../md';

const route = useRoute();
const task = ref(null);
const reports = ref([]);
const messages = ref([]);
const deliverables = ref({ spec: [], versions: [] });
const replyText = ref('');
const error = ref('');

async function load() {
  const data = await api.task(route.params.taskId);
  task.value = data.task;
  reports.value = data.reports || [];
  messages.value = data.messages || [];
  deliverables.value = data.deliverables || { spec: [], versions: [] };
}

onMounted(load);

/** 帖子流：首帖=任务要求，随后消息+报告按时间正序合并（论坛式） */
const posts = computed(() => {
  if (!task.value) return [];
  const list = [
    {
      id: 'brief',
      type: 'brief',
      sender: task.value.creator_name || '管理员',
      time: task.value.created_at,
      content: task.value.instruction,
    },
    // 消息：跳过创建时写入的首条（内容=任务要求，避免与首帖重复）
    ...messages.value
      .filter((m) => m.content !== task.value.instruction)
      .map((m) => ({
        id: `m${m.id}`,
        type: 'message',
        sender: m.sender_role === 'admin' ? '管理员' : m.sender_role === 'system' ? '系统' : m.sender_name || 'agent',
        role: m.sender_role,
        time: m.created_at,
        content: m.content,
      })),
    // 报告：agent 产出帖
    ...reports.value.map((r) => ({
      id: `r${r.created_at}`,
      type: 'report',
      sender: r.agent_id || 'agent',
      time: r.created_at,
      content: r.content,
    })),
  ];
  return list.sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? -1 : 1));
});

async function cancel() {
  if (!confirm('确定取消该任务？')) return;
  try {
    await api.cancelTask(task.value.task_id);
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function reply() {
  if (!replyText.value.trim()) return;
  error.value = '';
  try {
    await api.taskReply(task.value.task_id, replyText.value.trim());
    replyText.value = '';
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function resolveTask() {
  const finalResult = prompt('可选：填写最终结论（回车关闭任务）', '');
  if (finalResult === null) return;
  error.value = '';
  try {
    await api.taskResolve(task.value.task_id, finalResult.trim());
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

function badge(status) {
  return {
    done: 'text-bg-success',
    failed: 'text-bg-danger',
    running: 'text-bg-info',
    pending: 'text-bg-warning',
    open: 'text-bg-info',
    resolved: 'text-bg-success',
    cancelled: 'text-bg-secondary',
  }[status] || 'text-bg-secondary';
}

function postIcon(type) {
  return { brief: 'bi-pin-angle-fill', message: 'bi-chat-left-text', report: 'bi-journal-check' }[type];
}

function postColor(type) {
  return {
    brief: 'rgba(99,102,241,0.18)',
    message: 'rgba(56,189,248,0.14)',
    report: 'rgba(16,185,129,0.14)',
  }[type];
}
</script>

<template>
  <router-link to="/tasks" class="btn btn-sm btn-outline-secondary mb-3"><i class="bi bi-arrow-left me-1"></i>任务列表</router-link>
  <div v-if="task">
    <!-- 任务头部：信息横排 -->
    <div class="card mb-3">
      <div class="card-body">
        <div class="d-flex align-items-center gap-2 flex-wrap mb-2">
          <h4 class="mb-0 fw-bold">{{ task.title }}</h4>
          <span class="text-secondary small">{{ task.task_id }}</span>
          <span class="badge badge-status" :class="badge(task.status)">{{ task.status }}</span>
          <span class="badge" :class="task.kind === 'scheduled' ? 'text-bg-info' : 'text-bg-secondary'">{{ task.kind }}</span>
        </div>
        <div class="d-flex flex-wrap gap-4 text-secondary small">
          <span><i class="bi bi-person-plus me-1"></i>发起方：{{ task.creator_name || '管理员' }} {{ task.creator_agent_id || '' }}</span>
          <span><i class="bi bi-person-check me-1"></i>执行方：{{ task.assignee_name }} ({{ task.assignee }})</span>
          <span v-if="task.workdir"><i class="bi bi-folder2-open me-1"></i>工作目录：<code>{{ task.workdir }}</code></span>
          <template v-if="task.kind === 'scheduled'">
            <span><i class="bi bi-arrow-repeat me-1"></i>周期：{{ task.schedule_cron }}</span>
            <span><i class="bi bi-alarm me-1"></i>下次：{{ task.next_due_at }}</span>
          </template>
          <span><i class="bi bi-clock me-1"></i>创建：{{ task.created_at }}</span>
          <span v-if="task.status === 'resolved' || task.status === 'done'">
            <i class="bi bi-check2-circle me-1"></i>完成：{{ task.resolved_by_name || '管理员' }} · {{ task.result_at }}
          </span>
          <span v-if="task.deliverable_version"><i class="bi bi-box-seam me-1"></i>交付版本：{{ task.deliverable_version }}</span>
        </div>
        <div v-if="error" class="alert alert-danger py-2 small mt-2 mb-0">{{ error }}</div>
      </div>
    </div>

    <!-- 帖子流：任务要求 + 消息 + 报告（论坛式） -->
    <div class="mb-3">
      <div v-for="p in posts" :key="p.id" class="card mb-2">
        <div class="card-body py-2">
          <div class="d-flex align-items-center gap-2 mb-1">
            <span class="d-inline-flex align-items-center justify-content-center"
              :style="{ width: '26px', height: '26px', borderRadius: '0.5rem', background: postColor(p.type), color: '#c7d2fe' }">
              <i class="bi" :class="postIcon(p.type)" style="font-size:0.85rem"></i>
            </span>
            <span class="sender" :style="{ color: p.type === 'brief' ? '#a5b4fc' : p.type === 'report' ? '#34d399' : '#7dd3fc' }">
              {{ p.sender }}
            </span>
            <span class="badge" :class="p.type === 'brief' ? 'text-bg-primary' : p.type === 'report' ? 'text-bg-success' : 'text-bg-info'" style="font-size:0.65rem">
              {{ p.type === 'brief' ? '任务要求' : p.type === 'report' ? '报告' : '回复' }}
            </span>
            <span class="time ms-auto">{{ p.time }}</span>
          </div>
          <div class="md-content mb-0" v-html="renderMd(p.content)"></div>
        </div>
      </div>
    </div>

    <!-- 交付物：约定 + 版本 -->
    <div v-if="deliverables.spec.length || deliverables.versions.length" class="card mb-3">
      <div class="card-body">
        <h6 class="fw-bold mb-2"><i class="bi bi-box-seam me-1"></i>交付物</h6>
        <div v-if="deliverables.spec.length" class="mb-3">
          <div class="text-secondary small mb-1">约定清单</div>
          <table class="table table-sm">
            <thead><tr><th>名称</th><th>路径</th><th>验收标准</th></tr></thead>
            <tbody>
              <tr v-for="s in deliverables.spec" :key="s.name">
                <td class="fw-semibold">{{ s.name }}</td>
                <td><code>{{ s.path || '—' }}</code></td>
                <td>{{ s.criteria || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="deliverables.versions.length">
          <div class="text-secondary small mb-1">已提交版本</div>
          <div v-for="v in deliverables.versions" :key="v.id" class="d-flex align-items-start gap-2 py-2 border-bottom" style="border-color:var(--border-soft)">
            <span class="badge" :class="v.current ? 'text-bg-success' : 'text-bg-secondary'">{{ v.version }}</span>
            <div class="flex-grow-1">
              <div class="d-flex gap-2 align-items-center flex-wrap">
                <span class="fw-semibold small">{{ v.name }}</span>
                <span class="text-secondary small">{{ v.created_at }}</span>
                <span v-if="v.current" class="badge text-bg-info" style="font-size:0.65rem">当前</span>
              </div>
              <div v-if="v.path" class="small"><code>{{ v.path }}</code></div>
              <div v-if="v.message" class="small text-secondary">{{ v.message }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 回复框（底部，open 状态） -->
    <div v-if="task.status === 'open'" class="card">
      <div class="card-body">
        <textarea v-model="replyText" class="form-control mb-2" rows="3"
          placeholder="回复该任务（指导 agent 继续 / 提供信息 / 确认结果）..."></textarea>
        <div class="d-flex gap-2">
          <button class="btn btn-primary" @click="reply" :disabled="!replyText.trim()"><i class="bi bi-send me-1"></i>回复</button>
          <button class="btn btn-outline-success" @click="resolveTask"><i class="bi bi-check2-circle me-1"></i>完成任务</button>
          <button class="btn btn-outline-danger ms-auto" @click="cancel"><i class="bi bi-x-circle me-1"></i>取消任务</button>
        </div>
      </div>
    </div>
    <div v-else class="text-secondary small mb-2">
      任务已 {{ task.status }}，会话已关闭。
      <div v-if="task.result" class="mt-2">
        <div class="fw-semibold text-secondary mb-1">最终结论</div>
        <div class="card"><div class="card-body md-content" v-html="renderMd(task.result)"></div></div>
      </div>
    </div>
  </div>
</template>
