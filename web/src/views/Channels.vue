<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge.vue';

const route = useRoute();
const router = useRouter();
const channels = ref([]);
const hosts = ref([]);
const currentPrincipalId = ref('');
const selectedId = ref('');
const messages = reactive({});
const cursors = reactive({});
const loaded = reactive({});
const loading = ref(true);
const loadingMessages = ref(false);
const creating = ref(false);
const sending = ref(false);
const error = ref('');
const sendError = ref('');
const draft = ref('');
const newHostId = ref('');
const messagesEl = ref(null);
let refreshTimer = null;
let refreshing = false;

const selectedChannel = computed(() =>
  channels.value.find((channel) => String(channel.id) === String(selectedId.value)) || null);
const selectedMessages = computed(() => messages[selectedId.value] || []);
const availableHosts = computed(() => hosts.value.filter((host) => host.status === 'active'));

function fmtTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function hostTitle(host) {
  return host?.name || host?.id || '未知主机';
}

function isMine(message) {
  return String(message?.author_principal_id) === String(currentPrincipalId.value);
}

function appendMessages(channelId, items) {
  const existing = new Map((messages[channelId] || []).map((item) => [item.id, item]));
  for (const item of items) {
    if (item?.id) existing.set(item.id, item);
  }
  messages[channelId] = [...existing.values()].sort((left, right) =>
    String(left.id).localeCompare(String(right.id)));
}

async function loadMessages(channelId) {
  if (!channelId || loaded[channelId]) return;
  loadingMessages.value = true;
  try {
    const data = await api.channelMessages(channelId, { limit: 100 });
    messages[channelId] = data.items ?? [];
    cursors[channelId] = data.next_after || messages[channelId].at(-1)?.id || '';
    loaded[channelId] = true;
    await nextTick();
    scrollMessages();
  } catch (e) {
    error.value = e.message;
  } finally {
    loadingMessages.value = false;
  }
}

async function refreshSelectedMessages() {
  const channelId = selectedId.value;
  if (!channelId) return;
  await loadMessages(channelId);
  let after = cursors[channelId] || '';
  while (true) {
    const data = await api.channelMessages(channelId, {
      ...(after ? { after } : {}),
      limit: 100,
    });
    const items = data.items ?? [];
    if (items.length) appendMessages(channelId, items);
    const nextAfter = data.next_after || after;
    if (nextAfter) cursors[channelId] = nextAfter;
    if (!data.has_more || !nextAfter || nextAfter === after) break;
    after = nextAfter;
  }
  await nextTick();
  scrollMessages();
}

async function refreshChannels() {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = await api.channels();
    channels.value = data.items ?? [];
    if (route.params.channelId) {
      const routeId = String(route.params.channelId);
      if (channels.value.some((channel) => String(channel.id) === routeId)) selectedId.value = routeId;
    }
    if (!selectedChannel.value && channels.value.length) {
      selectedId.value = channels.value[0].id;
      await router.replace(`/channels/${encodeURIComponent(selectedId.value)}`);
    }
    await refreshSelectedMessages();
  } catch (e) {
    error.value = e.message;
  } finally {
    refreshing = false;
  }
}

async function initialLoad() {
  loading.value = true;
  error.value = '';
  try {
    const [identity, hostData] = await Promise.all([api.whoami(), api.hosts()]);
    currentPrincipalId.value = identity.principal?.id || '';
    hosts.value = hostData.items ?? [];
    newHostId.value = availableHosts.value[0]?.id || '';
    await refreshChannels();
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function selectChannel(channel) {
  selectedId.value = channel.id;
  sendError.value = '';
  await router.push(`/channels/${encodeURIComponent(channel.id)}`);
  await refreshSelectedMessages();
}

async function createChannel() {
  if (!newHostId.value) return;
  creating.value = true;
  error.value = '';
  try {
    const data = await api.createChannel({ host_principal_id: newHostId.value });
    const channel = data.channel;
    await refreshChannels();
    selectedId.value = channel.id;
    await router.push(`/channels/${encodeURIComponent(channel.id)}`);
    await refreshSelectedMessages();
  } catch (e) {
    error.value = e.message;
  } finally {
    creating.value = false;
  }
}

async function sendMessage() {
  const body = draft.value.trim();
  if (!body || !selectedChannel.value || sending.value) return;
  sending.value = true;
  sendError.value = '';
  try {
    const data = await api.sendChannelMessage(selectedChannel.value.id, { body });
    const message = {
      id: data.post_id,
      author_principal_id: currentPrincipalId.value,
      author: { id: currentPrincipalId.value, name: '我' },
      body,
      created_at: new Date().toISOString(),
    };
    appendMessages(selectedChannel.value.id, [message]);
    cursors[selectedChannel.value.id] = data.post_id;
    loaded[selectedChannel.value.id] = true;
    draft.value = '';
    await refreshSelectedMessages();
  } catch (e) {
    sendError.value = e.message;
  } finally {
    sending.value = false;
  }
}

function scrollMessages() {
  if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
}

function startPolling() {
  if (refreshTimer || document.hidden) return;
  refreshTimer = setInterval(() => {
    void refreshChannels();
  }, 3_000);
}

function stopPolling() {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

function onVisibilityChange() {
  if (document.hidden) {
    stopPolling();
  } else {
    void refreshChannels();
    startPolling();
  }
}

watch(() => route.params.channelId, async (value) => {
  const id = value ? String(value) : '';
  if (id && channels.value.some((channel) => String(channel.id) === id)) {
    selectedId.value = id;
    await refreshSelectedMessages();
  }
});

onMounted(async () => {
  document.addEventListener('visibilitychange', onVisibilityChange);
  await initialLoad();
  startPolling();
});

onBeforeUnmount(() => {
  stopPolling();
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<template>
  <div class="channels-page">
    <div class="d-flex justify-content-between align-items-end gap-3 mb-4">
      <div>
        <div class="eyebrow"><i class="bi bi-chat-dots me-1"></i>CHANNELS</div>
        <h1 class="page-title">主机对话</h1>
        <p class="text-secondary mb-0">与在线主机保持一对一实时对话。</p>
      </div>
      <span class="text-secondary small"><i class="bi bi-arrow-repeat me-1"></i>每 3 秒刷新</span>
    </div>

    <div v-if="error" class="alert alert-danger">{{ error }}</div>

    <div class="channel-layout">
      <aside class="channel-sidebar card">
        <div class="card-header">
          <div class="d-flex justify-content-between align-items-center">
            <strong>对话列表</strong><span class="text-secondary small">{{ channels.length }} 个</span>
          </div>
          <div class="input-group input-group-sm mt-3">
            <select v-model="newHostId" class="form-select" aria-label="选择主机">
              <option value="">选择主机…</option>
              <option v-for="host in availableHosts" :key="host.id" :value="host.id">
                {{ hostTitle(host) }}{{ host.offline ? '（离线）' : '' }}
              </option>
            </select>
            <button class="btn btn-primary" :disabled="!newHostId || creating" title="新建对话" @click="createChannel">
              <i class="bi" :class="creating ? 'bi-hourglass-split' : 'bi-plus-lg'"></i>
            </button>
          </div>
        </div>
        <div v-if="loading" class="empty-state py-5">加载中…</div>
        <div v-else-if="!channels.length" class="empty-state py-5">
          <i class="bi bi-chat-square-text"></i><strong>还没有对话</strong><span>选择一台主机，开始第一段对话。</span>
        </div>
        <div v-else class="list-group list-group-flush channel-list">
          <button v-for="channel in channels" :key="channel.id" type="button"
            class="list-group-item list-group-item-action bg-transparent text-start channel-list-item"
            :class="{ active: String(selectedId) === String(channel.id) }" @click="selectChannel(channel)">
            <div class="d-flex align-items-center gap-2">
              <i class="bi bi-pc-display"></i>
              <strong class="text-truncate">{{ channel.host.name }}</strong>
              <span class="channel-online-dot ms-auto" :class="{ online: channel.host.online }"
                :title="channel.host.online ? '在线' : '离线'"></span>
            </div>
            <div class="small opacity-75 mt-1 text-truncate">{{ channel.last_message?.body || '暂无消息' }}</div>
            <time v-if="channel.last_message" class="small opacity-50">{{ fmtTime(channel.last_message.created_at) }}</time>
          </button>
        </div>
      </aside>

      <section class="channel-conversation card">
        <div v-if="!selectedChannel" class="empty-state channel-empty">
          <i class="bi bi-chat-square-heart"></i><strong>选择一个对话</strong><span>左侧选择已有通道，或新建一段主机对话。</span>
        </div>
        <template v-else>
          <div class="card-header d-flex justify-content-between align-items-center">
            <div>
              <strong><i class="bi bi-pc-display me-2"></i>{{ selectedChannel.host.name }}</strong>
              <div class="small text-secondary mt-1">{{ selectedChannel.host.online ? '在线' : '离线' }}</div>
            </div>
            <StatusBadge kind="host" status="active" :offline="!selectedChannel.host.online" />
          </div>
          <div ref="messagesEl" class="channel-messages">
            <div v-if="loadingMessages && !selectedMessages.length" class="empty-state py-5">加载消息中…</div>
            <div v-else-if="!selectedMessages.length" class="empty-state py-5">
              <i class="bi bi-chat-left-dots"></i><strong>开始对话</strong><span>发送一句话，主机会在轮询后回复。</span>
            </div>
            <div v-else class="channel-message-stack">
              <div v-for="message in selectedMessages" :key="message.id" class="channel-message-row" :class="{ mine: isMine(message) }">
                <div class="channel-message-bubble">
                  <div class="channel-message-author">{{ isMine(message) ? '我' : (message.author?.name || '主机') }}</div>
                  <div class="channel-message-body">{{ message.body }}</div>
                  <time>{{ fmtTime(message.created_at) }}</time>
                </div>
              </div>
            </div>
          </div>
          <form class="channel-composer" @submit.prevent="sendMessage">
            <div v-if="sendError" class="alert alert-danger py-2 mb-2">{{ sendError }}</div>
            <div class="input-group">
              <textarea v-model="draft" class="form-control" rows="2" maxlength="10000"
                placeholder="输入消息，可写 @dir=&lt;路径&gt; 问题内容；Enter 发送也可以使用下方按钮" aria-label="消息内容"
                @keydown.enter.exact.prevent="sendMessage"></textarea>
              <button class="btn btn-primary px-4" :disabled="sending || !draft.trim()">
                <i class="bi bi-send me-1"></i>{{ sending ? '发送中…' : '发送' }}
              </button>
            </div>
          </form>
        </template>
      </section>
    </div>
  </div>
</template>
