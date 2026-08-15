<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Modal } from 'bootstrap';
import { api } from '../api';
import { renderMd, renderMdWithAttachments } from '../md';
import Pagination from '../components/Pagination.vue';
import ChatPanel from '../components/ChatPanel.vue';

const route = useRoute();
const task = ref(null);
const reports = ref([]);
const messages = ref([]);
const deliverables = ref({ spec: [], versions: [] });
const replyText = ref('');
const error = ref('');
const msgPage = ref(1);
const messagesTotal = ref(0);

// 与执行 agent 对话（任务详情内嵌面板）
const chatOpen = ref(false);
// 左侧计划结构面板（plan → stage → task 树，可收起，吸附左侧）
const planTree = ref(null);
const planCollapsed = ref(false);
async function loadPlan() {
  if (!task.value?.plan_pub_id) { planTree.value = null; return; }
  try { planTree.value = await api.plan(task.value.plan_pub_id); }
  catch { planTree.value = null; }
}
const activeTask = computed(() =>
  task.value
    ? {
        agent_id: task.value.assignee_id,
        agent_name: task.value.assignee_name || task.value.assignee,
        task_id: task.value.task_id,
        task_title: task.value.title,
      }
    : null,
);
function toggleChat() {
  chatOpen.value = !chatOpen.value;
}

/** 重开任务（终态 → open/active，恢复交流通道以便补充信息） */
async function reopenTask() {
  if (!confirm('重开任务将回到可交流状态（open/active），执行 agent 可继续回复补充信息。确认重开？')) return;
  try {
    await api.taskReopen(task.value.task_id);
    error.value = '';
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function load() {
  const data = await api.task(route.params.taskId, { messages_page: msgPage.value, messages_page_size: 10 });
  task.value = data.task;
  reports.value = data.reports || [];
  // 消息接口按倒序分页（最新在前），反转成正序供帖子流渲染（最新在底部）
  messages.value = [...(data.messages || [])].reverse();
  deliverables.value = data.deliverables || { spec: [], versions: [] };
  messagesTotal.value = data.messages_total ?? 0;
  await loadPlan();
}

onMounted(load);

/** 同任务附件映射：交付物引用的附件 filename（小写）→ attachment_id，供 md 图文混编自动解析 */
const attMap = computed(() => {
  const m = {};
  for (const v of deliverables.value.versions || []) {
    if (v.attachment?.attachment_id && v.attachment?.filename) {
      m[String(v.attachment.filename).toLowerCase()] = v.attachment.attachment_id;
    }
  }
  return m;
});

// ── 附件预览 modal（§3.7 落地）：按 mime 分流 image / markdown / pdf / 其他 ──
const previewModalEl = ref(null);
let previewModal = null;
const preview = ref(null); // { attachment, mode, content?, error? }
const previewLoading = ref(false);

const TEXT_LIKE_MIMES = ['text/', 'application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/markdown', 'application/javascript', 'application/x-sh'];

function attachmentUrl(attId) {
  return `/api/attachments/${attId}`;
}

/** 打开预览：图片直接 <img>；文本/md fetch 后渲染；pdf iframe；其他提示下载 */
async function openPreview(v) {
  const att = v.attachment;
  if (!att) return;
  previewLoading.value = true;
  const mime = (att.mime || '').toLowerCase();
  const mode = mime.startsWith('image/')
    ? 'image'
    : mime === 'application/pdf'
      ? 'pdf'
      : TEXT_LIKE_MIMES.some((p) => mime.startsWith(p))
        ? 'markdown'
        : 'other';
  preview.value = { attachment: att, mode, content: '', error: '' };
  if (mode === 'markdown') {
    try {
      const res = await fetch(attachmentUrl(att.attachment_id), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`加载失败 ${res.status}`);
      preview.value.content = await res.text();
    } catch (e) {
      preview.value.error = e.message;
    }
  }
  previewLoading.value = false;
  if (!previewModal) previewModal = new Modal(previewModalEl.value);
  previewModal.show();
}

function closePreview() {
  previewModal?.hide();
  preview.value = null;
}

onBeforeUnmount(() => previewModal?.dispose());

/** 帖子流：首帖=任务要求，随后消息+报告按时间正序合并（论坛式） */
const posts = computed(() => {
  if (!task.value) return [];
  /** 回帖发送者显示：区分 平台(LLM 审核/验收) / 管理员 / 系统 / 主机 agent(名 + 主机) */
  const senderLabel = (m) => {
    if (m.sender_role === 'platform') return '平台';
    if (m.sender_role === 'admin') return '管理员';
    if (m.sender_role === 'system') return '系统';
    const name = m.sender_name || m.agent_id || 'agent';
    return m.sender_hostname ? `${name} · ${m.sender_hostname}` : name;
  };
  const senderKind = (m) => (['platform', 'admin', 'system', 'agent'].includes(m.sender_role) ? m.sender_role : 'agent');
  const list = [
    {
      id: 'brief',
      type: 'brief',
      sender: task.value.creator_name || '管理员',
      senderKind: 'admin',
      time: task.value.created_at,
      content: task.value.instruction,
    },
    // 消息：跳过创建时写入的首条（内容=任务要求，避免与首帖重复）
    ...messages.value
      .filter((m) => m.content !== task.value.instruction)
      .map((m) => ({
        id: `m${m.id}`,
        type: 'message',
        sender: senderLabel(m),
        senderKind: senderKind(m),
        role: m.sender_role,
        time: m.created_at,
        content: m.content,
      })),
    // 报告：agent 产出帖
    ...reports.value.map((r) => ({
      id: `r${r.created_at}`,
      type: 'report',
      sender: senderLabel(r),
      senderKind: 'agent',

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

async function rejectTask() {
  const opinion = prompt('填写打回意见（执行方将按此续做）', '');
  if (opinion === null) return;
  error.value = '';
  try {
    await api.taskReject(task.value.task_id, opinion.trim());
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

function postIcon(type) {
  return { brief: 'bi-pin-angle-fill', message: 'bi-chat-left-text', report: 'bi-journal-check' }[type];
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function scanBadge(s) {
  return {
    clean: 'text-bg-success',
    pending: 'text-bg-warning',
    pending_audit: 'text-bg-warning',
    rejected: 'text-bg-danger',
    skipped: 'text-bg-secondary',
    infected: 'text-bg-danger',
  }[s] || 'text-bg-secondary';
}
</script>

<template>
  <div class="d-flex justify-content-between align-items-center mb-3">
    <router-link to="/tasks" class="btn btn-sm btn-outline-secondary"><i class="bi bi-arrow-left me-1"></i>任务列表</router-link>
    <button v-if="task?.assignee_id" class="btn btn-sm" :class="chatOpen ? 'btn-primary' : 'btn-outline-primary'" @click="toggleChat">
      <i class="bi bi-chat-dots me-1"></i>{{ chatOpen ? '收起对话' : '与 agent 对话' }}
    </button>
  </div>
  <div v-if="task" class="d-flex align-items-start gap-3">
  <!-- 左侧：计划结构面板（吸附，可收起） -->
  <aside v-if="planTree" class="plan-panel card shadow-sm" :class="{ collapsed: planCollapsed }">
    <div class="d-flex align-items-center plan-panel-head">
      <button class="btn btn-sm btn-outline-secondary border-0 p-1" @click="planCollapsed = !planCollapsed"
        :title="planCollapsed ? '展开计划结构' : '收起计划结构'" style="flex-shrink:0">
        <i class="bi" :class="planCollapsed ? 'bi-chevron-right' : 'bi-chevron-left'"></i>
      </button>
      <template v-if="!planCollapsed">
        <router-link :to="`/plans/${planTree.plan.plan_id}`" class="fw-semibold text-decoration-none plan-panel-title">
          <i class="bi bi-diagram-3 me-1"></i>{{ planTree.plan.name }}
        </router-link>
      </template>
    </div>
    <div v-if="!planCollapsed" class="plan-panel-body">
      <div v-for="st in planTree.plan.stages" :key="st.id" class="plan-stage mb-2">
        <div class="d-flex align-items-center gap-1 plan-stage-head">
          <i class="bi bi-layers"></i>
          <span class="fw-semibold text-truncate" :title="st.name">{{ st.name }}</span>
          <span class="ms-auto small text-secondary">S{{ st.seq }}</span>
        </div>
        <div class="plan-stage-meta mb-1">
          <span class="badge text-bg-light me-1">{{ st.wait_prev == 0 ? '并发' : '顺序' }}</span>
          <span v-if="st.recurrence && st.recurrence !== 'none'" class="badge text-bg-info me-1">{{ st.recurrence }}</span>
          <span v-if="st.next_due_at" class="small text-secondary"><i class="bi bi-alarm me-1"></i>{{ st.next_due_at.slice(5, 16) }}</span>
        </div>
        <router-link v-for="t in st.tasks" :key="t.task_id" :to="`/tasks/${t.task_id}`"
          class="plan-task d-flex align-items-center gap-1 text-decoration-none"
          :class="{ 'plan-task-active': t.task_id === task.task_id }">
          <span class="text-truncate flex-fill">{{ t.title }}</span>
          <span class="badge badge-status" :class="badge(t.status)">{{ t.status }}</span>
        </router-link>
      </div>
    </div>
  </aside>
  <div class="flex-grow-1 min-w-0">
  <div class="row g-3">
    <div :class="chatOpen ? 'col-8' : 'col-12'">
    <!-- 任务头部：信息横排 -->
    <div class="card mb-3">
      <div class="card-body">
        <div class="d-flex align-items-center gap-2 flex-wrap mb-2">
          <h4 class="mb-0 fw-bold">{{ task.title }}</h4>
          <span class="text-secondary small">{{ task.task_id }}</span>
          <span class="badge badge-status" :class="badge(task.status)">{{ task.status }}</span>
          <span class="badge" :class="task.visibility === 'public' ? 'text-bg-primary' : 'text-bg-secondary'"
                :title="task.visibility === 'public' ? '公开：公共池可认领' : '私有：仅发起人及指派主机'">{{ task.visibility }}</span>
          <span class="ms-auto text-secondary small text-end">
            <span class="d-block"><i class="bi bi-calendar-plus me-1"></i>创建：{{ task.created_at }}</span>
            <span v-if="task.status === 'resolved' || task.status === 'done'" class="d-block">
              <i class="bi bi-check2-circle me-1"></i>完成：{{ task.result_at }} · {{ task.resolved_by_name || '管理员' }}
            </span>
          </span>
        </div>
        <div class="d-flex flex-wrap gap-4 text-secondary small">
          <span><i class="bi bi-person-plus me-1"></i>发起方：{{ task.creator_name || '管理员' }} {{ task.creator_agent_id || '' }}</span>
          <span><i class="bi bi-person-check me-1"></i>执行方：{{ task.assignee_name }} ({{ task.assignee }})</span>
          <span v-if="task.workdir"><i class="bi bi-folder2-open me-1"></i>工作目录：<code>{{ task.workdir }}</code></span>
          <span v-if="task.deliverable_version"><i class="bi bi-box-seam me-1"></i>交付版本：{{ task.deliverable_version }}</span>
          <span v-if="task.deliver_attempts"><i class="bi bi-arrow-repeat me-1"></i>交付尝试：{{ task.deliver_attempts }}/{{ task.max_attempts }}</span>
          <span v-if="task.status === 'active' && task.visibility === 'public'"><i class="bi bi-globe2 me-1"></i>在公共池中，等待认领</span>
        </div>
        <div v-if="error" class="alert alert-danger py-2 small mt-2 mb-0">{{ error }}</div>
      </div>
    </div>

    <!-- 帖子流：任务要求 + 消息 + 报告（论坛式） -->
    <div class="mb-3">
      <div v-for="p in posts" :key="p.id" class="card mb-2">
        <div class="card-body py-2">
          <div class="d-flex align-items-center gap-2 mb-1">
            <span class="d-inline-flex align-items-center justify-content-center post-ic"
              :class="p.senderKind === 'platform' ? 'sender-platform-bg' : p.senderKind === 'agent' ? 'sender-agent-bg' : (p.type === 'brief' ? 'sender-brief-bg' : p.type === 'report' ? 'sender-report-bg' : 'sender-note-bg')">
              <i class="bi" :class="postIcon(p.type)" style="font-size:0.85rem"></i>
            </span>
            <span class="sender" :class="p.senderKind === 'platform' ? 'sender-platform' : p.senderKind === 'agent' ? 'sender-agent' : (p.type === 'brief' ? 'sender-brief' : p.type === 'report' ? 'sender-report' : 'sender-note')">
              {{ p.sender }}
            </span>
            <span class="badge" :class="p.type === 'brief' ? 'text-bg-primary' : p.type === 'report' ? 'text-bg-success' : 'text-bg-info'" style="font-size:0.65rem">
              {{ p.type === 'brief' ? '任务要求' : p.type === 'report' ? '报告' : '回复' }}
            </span>
            <span v-if="p.senderKind === 'platform'" class="badge text-bg-secondary" style="font-size:0.65rem">平台</span>
            <span v-if="p.senderKind === 'agent' && p.type !== 'report'" class="badge text-bg-success" style="font-size:0.65rem">主机 agent</span>
            <span class="time ms-auto">{{ p.time }}</span>
          </div>
          <div class="md-content mb-0" v-html="p.type === 'brief' ? renderMd(p.content) : renderMdWithAttachments(p.content, attMap)"></div>
        </div>
      </div>
    </div>

    <div class="mt-2 mb-3">
      <Pagination :total="messagesTotal" v-model:page="msgPage" :page-size="10" @change="load" />
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
              <div v-if="v.attachment" class="small mt-1">
                <i class="bi bi-paperclip me-1"></i>
                <a href="javascript:void(0)" @click="openPreview(v)" class="link-primary text-decoration-none">{{ v.attachment.filename }}</a>
                <span class="text-secondary ms-2">{{ fmtSize(v.attachment.size_bytes) }} · {{ v.attachment.mime }}</span>
                <span class="badge ms-2" :class="scanBadge(v.attachment.scan_status)" style="font-size:0.65rem"
                      :title="v.attachment.scan_status === 'skipped' ? '未配置病毒扫描，降级标记（不阻塞）' : '附件扫描状态'">
                  {{ v.attachment.scan_status }}
                </span>
              </div>
              <div v-if="v.path" class="small"><code>{{ v.path }}</code></div>
              <div v-if="v.message" class="small text-secondary">{{ v.message }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 附件预览 modal -->
    <div ref="previewModalEl" class="modal fade" tabindex="-1">
      <div class="modal-dialog modal-xl modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header py-2">
            <h6 class="modal-title d-flex align-items-center gap-2">
              <i class="bi bi-paperclip"></i>
              <span>{{ preview?.attachment.filename }}</span>
              <span class="badge" v-if="preview" :class="scanBadge(preview.attachment.scan_status)" style="font-size:0.65rem">{{ preview.attachment.scan_status }}</span>
            </h6>
            <button type="button" class="btn-close" data-bs-dismiss="modal" @click="preview = null"></button>
          </div>
          <div class="modal-body">
            <div v-if="preview" class="d-flex align-items-center gap-3 text-secondary small mb-2 flex-wrap">
              <span><i class="bi bi-hdd me-1"></i>{{ fmtSize(preview.attachment.size_bytes) }}</span>
              <span><i class="bi bi-file-earmark me-1"></i>{{ preview.attachment.mime }}</span>
              <span><i class="bi bi-upc-scan me-1"></i>{{ preview.attachment.attachment_id }}</span>
              <a class="ms-auto" :href="attachmentUrl(preview.attachment.attachment_id)" target="_blank" rel="noopener">
                <i class="bi bi-download me-1"></i>下载原文件
              </a>
            </div>
            <div v-if="previewLoading" class="text-secondary py-4 text-center">加载中…</div>
            <div v-else-if="preview">
              <!-- 图片：直接渲染，同源带会话，受权限控制 -->
              <img v-if="preview.mode === 'image'" :src="attachmentUrl(preview.attachment.attachment_id)"
                   class="img-fluid border rounded" style="max-height:70vh" :alt="preview.attachment.filename">
              <!-- markdown/文本：fetch 后 marked 渲染（attachment:// 与同任务文件名自动解析） -->
              <div v-else-if="preview.mode === 'markdown'">
                <div v-if="preview.error" class="alert alert-danger py-2 small">{{ preview.error }}</div>
                <div v-else class="md-content" v-html="renderMdWithAttachments(preview.content, attMap)"></div>
              </div>
              <!-- pdf：iframe 原生预览 -->
              <iframe v-else-if="preview.mode === 'pdf'" :src="attachmentUrl(preview.attachment.attachment_id)" class="w-100 border rounded" style="height:70vh"></iframe>
              <!-- 其他：不支持内联，给下载提示 -->
              <div v-else class="text-secondary py-5 text-center">
                <i class="bi bi-file-earmark-x fs-1 d-block mb-2"></i>
                该格式（{{ preview.attachment.mime }}）不支持内联预览，请<a :href="attachmentUrl(preview.attachment.attachment_id)" target="_blank">下载查看</a>。
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 回复框（底部，open/claimed/submitted/pending_confirm 状态） -->
    <div v-if="['open','claimed','submitted','pending_confirm'].includes(task.status)" class="card">
      <div class="card-body">
        <textarea v-model="replyText" class="form-control mb-2" rows="3"
          placeholder="回复该任务（指导 agent 继续 / 提供信息 / 确认结果）..."></textarea>
        <div class="d-flex gap-2">
          <button class="btn btn-primary" @click="reply" :disabled="!replyText.trim()"><i class="bi bi-send me-1"></i>回复</button>
          <button class="btn btn-outline-success" @click="resolveTask"><i class="bi bi-check2-circle me-1"></i>验收通过</button>
          <button v-if="['claimed','submitted','pending_confirm'].includes(task.status)" class="btn btn-outline-danger" @click="rejectTask"><i class="bi bi-x-octagon me-1"></i>打回续做</button>
          <button class="btn btn-outline-danger ms-auto" @click="cancel"><i class="bi bi-x-circle me-1"></i>取消任务</button>
        </div>
      </div>
    </div>
    <div v-else class="mb-2">
      <div class="text-secondary small mb-1">任务已 {{ task.status }}，会话已关闭。</div>
      <div v-if="task.result" class="mt-2">
        <div class="fw-semibold text-secondary mb-1">最终结论</div>
        <div class="card"><div class="card-body md-content" v-html="renderMd(task.result)"></div></div>
      </div>
      <button v-if="['done','cancelled','failed','resolved'].includes(task.status)" class="btn btn-sm btn-outline-warning mt-2" @click="reopenTask">
        <i class="bi bi-arrow-counterclockwise me-1"></i>重开任务（补充信息）
      </button>
    </div>
    </div>
  <div v-if="chatOpen && task?.assignee_id" class="col-4">
    <ChatPanel :task="activeTask" @close="toggleChat" />
  </div>
  </div>
  </div>
  </div>
</template>
