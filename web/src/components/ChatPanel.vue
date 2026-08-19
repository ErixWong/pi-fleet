<script setup>
import { onMounted, onBeforeUnmount, ref, nextTick, watch } from 'vue';
import { api } from '../api';
import { renderMd } from '../md';

/** 管理员 ↔ agent 对话面板（4/12 侧栏，任务页/主机详情页复用）
 *  props.target：{ agent_id, agent_name, task_id?, task_title? }——任务对话带 task_id/task_title
 *  （头部显示任务上下文）；主机对话只传 agent 信息（无任务上下文）。
 *  props.conversationId：直接打开指定会话（会话管理页跳转用）；否则按 target 新建/复用。
 *  300ms 轮询增量（since_id）渲染打字机；消息 markdown 渲染 */
const props = defineProps({
  target: { type: Object, default: null }, // { agent_id, agent_name, task_id?, task_title? }
  conversationId: { type: String, default: '' }, // 直接打开指定会话（优先于 target）
  fullscreen: { type: Boolean, default: false }, // 全屏对话页模式（高度撑满视口，输入框贴底）
});
const emit = defineEmits(['close']);

const agents = ref([]);
const conversation = ref(null);
const messages = ref([]);
const input = ref('');
const busy = ref(false);
const panelError = ref('');
const bodyEl = ref(null);
const inputEl = ref(null);
const sinceId = ref(0);
const loading = ref(false);
let pollTimer = null;

onMounted(async () => {
  await loadAgents();
  if (props.conversationId) await openConversationById(props.conversationId);
  else if (props.target) await openConversation();
});

onBeforeUnmount(stopPolling);

watch(
  () => props.target,
  async (t) => {
    if (t && !props.conversationId) await openConversation();
  },
);
watch(
  () => props.conversationId,
  async (id) => {
    if (id && id !== conversation.value?.conversation_id) await openConversationById(id);
  },
);

async function loadAgents() {
  try {
    const data = await api.agents(1, 100);
    agents.value = data.agents ?? [];
  } catch {
    /* 静默：agent 列表拉不到不影响对话 */
  }
}

/** 当前对话的 agent 信息（名字/在线） */
const agentInfo = ref(null);
async function refreshAgentInfo() {
  agentInfo.value = agents.value.find((a) => String(a.id) === String(conversation.value?.agent_id)) ?? null;
}

/** 直接打开指定会话（会话管理跳转） */
async function openConversationById(convId) {
  panelError.value = '';
  loading.value = true;
  try {
    const data = await api.conversation(convId);
    conversation.value = data.conversation;
    await loadHistory();
    await refreshAgentInfo();
    startPolling();
    await nextTick();
    inputEl.value?.focus();
  } catch (e) {
    panelError.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function openConversation() {
  panelError.value = '';
  const t = props.target;
  if (!t?.agent_id) return;
  loading.value = true;
  try {
    const body = { agent_id: Number(t.agent_id) };
    if (t.task_id) body.task_id = String(t.task_id);
    const c = await api.createConversation(body);
    conversation.value = c.conversation;
    await loadHistory();
    await refreshAgentInfo();
    startPolling();
    await nextTick();
    inputEl.value?.focus();
  } catch (e) {
    panelError.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function loadHistory() {
  const data = await api.conversationMessages(conversation.value.conversation_id, 1, 100);
  messages.value = data.messages ?? [];
  sinceId.value = messages.value.length ? Number(messages.value[messages.value.length - 1].id) : 0;
  await scrollBottom();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 300);
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function poll() {
  if (!conversation.value) return;
  try {
    const data = await api.conversationSince(conversation.value.conversation_id, sinceId.value);
    const news = data.messages ?? [];
    if (!news.length) return;
    const bottomNear = isNearBottom();
    let hasNew = false;
    for (const m of news) {
      const idx = messages.value.findIndex((x) => String(x.id) === String(m.id));
      if (idx >= 0) {
        // 同 id 内容更新（打字机）：合并；仅当用户贴底时保持滚动跟随，不打断向上浏览
        if (!m.streaming || m.content.length > messages.value[idx].content.length) {
          messages.value[idx].content = m.content;
          messages.value[idx].streaming = m.streaming;
        }
      } else {
        messages.value.push(m);
        hasNew = true;
      }
      sinceId.value = Math.max(sinceId.value, Number(m.id));
    }
    // 只有用户本来就在底部附近才自动滚底（新增消息或打字机保持贴底）
    if (bottomNear) await scrollBottom();
  } catch {
    /* 轮询失败静默（网络抖动） */
  }
}

/** 是否贴底（距底 < 80px 视为正在看最新） */
function isNearBottom() {
  const el = bodyEl.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

async function scrollBottom() {
  await nextTick();
  if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
}

function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function md(src) {
  return renderMd(src ?? '');
}

async function send() {
  const content = input.value.trim();
  if (!content || !conversation.value || busy.value) return;
  busy.value = true;
  panelError.value = '';
  try {
    const r = await api.sendChatMessage(conversation.value.conversation_id, content);
    messages.value.push(r.message);
    sinceId.value = Number(r.message.id);
    input.value = '';
    await scrollBottom();
  } catch (e) {
    panelError.value = e.message;
  } finally {
    busy.value = false;
  }
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

async function archive() {
  if (!conversation.value) return;
  await api.archiveConversation(conversation.value.conversation_id);
  conversation.value = null;
  messages.value = [];
  stopPolling();
}
</script>

<template>
  <div class="card chat-panel d-flex flex-column" :class="props.fullscreen ? 'chat-panel-full' : 'chat-panel-fixed'">
    <!-- 头部：任务上下文 + agent -->
    <div class="card-header py-2 chat-header">
      <div class="d-flex justify-content-between align-items-start gap-2">
        <div class="min-w-0 flex-grow-1">
          <template v-if="conversation">
            <div class="fw-bold small text-truncate">
              <i class="bi bi-chat-dots me-1 text-primary"></i>
              {{ agentInfo?.name || conversation.agent_name || '对话' }}
              <span v-if="conversation.agent_id" class="text-secondary fw-normal">#{{ conversation.agent_id }}</span>
            </div>
            <div v-if="props.task" class="text-secondary small text-truncate chat-task-ctx">
              <i class="bi bi-briefcase me-1"></i>{{ props.task.task_id }} · {{ props.task.task_title }}
            </div>
            <div v-else-if="conversation.task_id && conversation.task_title" class="text-secondary small text-truncate chat-task-ctx">
              <i class="bi bi-briefcase me-1"></i>{{ conversation.task_id }} · {{ conversation.task_title }}
              <span class="badge text-bg-secondary ms-1">{{ conversation.task_status }}</span>
            </div>
          </template>
          <div v-else class="fw-bold small text-secondary">选择任务发起对话</div>
        </div>
        <div class="d-flex gap-1 flex-shrink-0">
          <button v-if="conversation" class="btn btn-sm btn-outline-secondary" title="归档对话" @click="archive">
            <i class="bi bi-archive"></i>
          </button>
          <button class="btn btn-sm btn-outline-secondary" title="收起面板" @click="emit('close')">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>
    </div>

    <!-- 工作目录只读展示（创建时固定，不可修改） -->
    <div v-if="props.fullscreen && conversation" class="px-2 py-1 chat-wd">
      <div class="text-secondary small">
        <i class="bi bi-folder2-open me-1"></i>工作目录：<code class="small">{{ conversation.workdir || '~/projects（默认根目录）' }}</code>
      </div>
    </div>

    <!-- 消息流 -->
    <div class="card-body flex-grow-1 overflow-auto chat-body px-2 py-2" ref="bodyEl">
      <div v-if="loading" class="text-center text-secondary small py-4">
        <span class="spinner-border spinner-border-sm me-1"></span>正在打开对话…
      </div>
      <div v-else-if="!conversation" class="text-center text-secondary small py-4">
        <i class="bi bi-chat-square-dots d-block mb-2" style="font-size: 2rem; opacity: 0.4"></i>
        在任务列表点击任务的 💬 图标，<br>与执行该任务的 agent 对话。
      </div>
      <div v-else-if="messages.length === 0" class="text-center text-secondary small py-4">
        暂无消息，围绕任务说点什么吧 👋
      </div>
      <template v-else>
        <div v-for="m in messages" :key="m.id" class="d-flex mb-2" :class="m.sender_role === 'admin' ? 'justify-content-end' : 'justify-content-start'">
          <div class="chat-bubble px-2 py-1 rounded-3" :class="m.sender_role === 'admin' ? 'bg-primary text-white' : 'bg-light border'"
               style="max-width: 88%">
            <div class="d-flex justify-content-between gap-2" style="font-size: 0.68rem; opacity: 0.75">
              <span>{{ m.sender_role === 'admin' ? '你' : (agentInfo?.name || conversation?.agent_name || 'agent') }}</span>
              <span>{{ fmtTime(m.created_at) }}</span>
            </div>
            <div v-if="m.sender_role === 'agent'" class="chat-md" v-html="md(m.content)"></div>
            <div v-else class="chat-plain" style="white-space: pre-wrap; word-break: break-word">{{ m.content || (m.streaming ? '正在思考…' : '') }}</div>
            <span v-if="m.streaming" class="chat-cursor"></span>
          </div>
        </div>
      </template>
    </div>

    <!-- 输入区 -->
    <div class="card-footer py-2">
      <div v-if="panelError" class="alert alert-danger py-1 small mb-2">{{ panelError }}</div>
      <div class="input-group align-items-center">
        <textarea ref="inputEl" v-model="input" class="form-control form-control-sm chat-input" rows="1"
                  placeholder="围绕任务发消息，Enter 发送 / Shift+Enter 换行"
                  :disabled="!conversation || busy" @keydown="onKeydown"></textarea>
        <button class="btn btn-primary btn-sm ms-1" :disabled="!conversation || busy || !input.trim()" @click="send">
          <i class="bi bi-send"></i>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 面板固定视口高度 + sticky：输入框始终贴视口底部，不随详情内容被撑到半山腰 */
.chat-panel-fixed {
  position: sticky;
  top: 1rem;
  height: calc(100vh - 120px);
  min-height: 320px;
  max-height: calc(100vh - 120px);
}
.chat-panel-full {
  height: calc(100vh - 88px);
  min-height: 480px;
}
.chat-body {
  flex-grow: 1;
  min-height: 0;
  overflow-y: auto;
}
.chat-header {
  border-bottom: 1px solid var(--border-soft, rgba(0, 0, 0, 0.08));
}
.chat-task-ctx {
  background: rgba(0, 0, 0, 0.03);
  border-radius: 4px;
  padding: 1px 6px;
  margin-top: 2px;
}
.chat-md :deep(p) {
  margin-bottom: 0.35rem;
}
.chat-md :deep(p:last-child) {
  margin-bottom: 0;
}
.chat-md :deep(code) {
  background: rgba(0, 0, 0, 0.06);
  padding: 0 3px;
  border-radius: 3px;
  font-size: 0.85em;
}
.chat-md :deep(pre) {
  margin-bottom: 0.35rem;
  max-width: 100%;
  overflow-x: auto;
}
.chat-input {
  resize: none;
  line-height: 1.35;
}
.project-chip {
  font-size: 0.75rem;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: currentColor;
  animation: chat-blink 0.8s step-start infinite;
}
@keyframes chat-blink {
  50% { opacity: 0; }
}
</style>
