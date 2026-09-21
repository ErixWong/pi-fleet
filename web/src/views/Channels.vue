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
const selectedHostId = ref('');
const selectedFolderKey = ref('');
const selectedId = ref('');
const messages = reactive({});
const cursors = reactive({});
const loaded = reactive({});
const loading = ref(true);
const loadingMessages = ref(false);
const creating = ref(false);
const resetting = ref(false);
const sending = ref(false);
const error = ref('');
const sendError = ref('');
const draft = ref('');
const newWorkdir = ref('~/tmp');
const newTitle = ref('');
const showCreate = ref(false);
const sidebarOpen = ref(false);
const messagesEl = ref(null);
let refreshTimer = null;
let refreshing = false;

const selectedChannel = computed(() =>
  channels.value.find((channel) => String(channel.id) === String(selectedId.value)) || null);
const selectedMessages = computed(() => messages[selectedId.value] || []);
const selectedHost = computed(() =>
  hosts.value.find((host) => String(host.id) === String(selectedHostId.value)) || null);
const hostChannels = computed(() =>
  channels.value.filter((channel) => String(channel.host?.id) === String(selectedHostId.value)));

function folderKey(channel) {
  return channel.workdir?.trim() || '__default__';
}

const folders = computed(() => {
  const grouped = new Map();
  for (const channel of hostChannels.value) {
    const key = folderKey(channel);
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        workdir: channel.workdir?.trim() || null,
        channels: [],
        lastActivity: '',
      });
    }
    const folder = grouped.get(key);
    folder.channels.push(channel);
    if (String(channel.last_activity_at || '') > String(folder.lastActivity || '')) {
      folder.lastActivity = channel.last_activity_at || '';
    }
  }
  return [...grouped.values()].sort((left, right) =>
    String(right.lastActivity).localeCompare(String(left.lastActivity)));
});

const selectedFolder = computed(() =>
  folders.value.find((folder) => folder.key === selectedFolderKey.value) || null);
const folderChannels = computed(() => selectedFolder.value?.channels || []);

function fmtTime(value) {
  if (!value) return '暂无活动';
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

function folderTitle(folder) {
  return folder?.workdir || '默认';
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

function syncSelection() {
  const routeId = route.params.channelId ? String(route.params.channelId) : '';
  const routeChannel = routeId
    ? channels.value.find((channel) => String(channel.id) === routeId)
    : null;
  if (routeChannel) {
    selectedId.value = routeId;
    selectedHostId.value = routeChannel.host.id;
    selectedFolderKey.value = folderKey(routeChannel);
    return;
  }

  if (!selectedHost.value && hosts.value.length) selectedHostId.value = hosts.value[0].id;
  if (!folders.value.some((folder) => folder.key === selectedFolderKey.value)) {
    selectedFolderKey.value = folders.value[0]?.key || '';
  }
  if (!folderChannels.value.some((channel) => String(channel.id) === String(selectedId.value))) {
    selectedId.value = folderChannels.value[0]?.id || '';
  }
}

async function refreshData() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [channelData, hostData] = await Promise.all([api.channels(), api.hosts()]);
    channels.value = channelData.items ?? [];
    hosts.value = hostData.items ?? [];
    syncSelection();
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
    const identity = await api.whoami();
    currentPrincipalId.value = identity.principal?.id || '';
    await refreshData();
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function selectHost(host) {
  selectedHostId.value = host.id;
  selectedFolderKey.value = '';
  selectedId.value = '';
  sidebarOpen.value = false;
  syncSelection();
  showCreate.value = false;
  sendError.value = '';
  void router.push('/channels');
}

async function selectFolder(folder) {
  selectedFolderKey.value = folder.key;
  selectedId.value = folder.channels[0]?.id || '';
  sidebarOpen.value = false;
  showCreate.value = false;
  sendError.value = '';
  if (selectedId.value) {
    await router.push(`/channels/${encodeURIComponent(selectedId.value)}`);
    await refreshSelectedMessages();
  } else {
    await router.push('/channels');
  }
}

async function selectChannel(channel) {
  selectedId.value = channel.id;
  selectedHostId.value = channel.host.id;
  selectedFolderKey.value = folderKey(channel);
  sidebarOpen.value = false;
  sendError.value = '';
  await router.push(`/channels/${encodeURIComponent(channel.id)}`);
  await refreshSelectedMessages();
}

function openCreateForm() {
  if (!selectedHost.value) return;
  newWorkdir.value = selectedFolder.value?.workdir || '~/tmp';
  newTitle.value = '';
  error.value = '';
  showCreate.value = true;
}

async function createChannel() {
  if (!selectedHost.value) {
    error.value = '请先选择主机';
    return;
  }
  if (!newWorkdir.value.trim()) {
    error.value = '工作目录不能为空';
    return;
  }
  creating.value = true;
  error.value = '';
  try {
    const data = await api.createChannel({
      host_principal_id: selectedHost.value.id,
      workdir: newWorkdir.value.trim(),
      ...(newTitle.value.trim() ? { title: newTitle.value.trim() } : {}),
    });
    showCreate.value = false;
    await refreshData();
    await selectChannel(data.channel);
  } catch (e) {
    error.value = e.message;
  } finally {
    creating.value = false;
  }
}

async function resetSession() {
  if (!selectedChannel.value || resetting.value) return;
  resetting.value = true;
  sendError.value = '';
  try {
    await api.resetChannel(selectedChannel.value.id);
    sendError.value = '会话已标记重置，下一条消息将开启新会话。';
    await refreshData();
  } catch (e) {
    sendError.value = e.message;
  } finally {
    resetting.value = false;
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
    void refreshData();
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
    void refreshData();
    startPolling();
  }
}

watch(() => route.params.channelId, async (value) => {
  const id = value ? String(value) : '';
  const channel = channels.value.find((item) => String(item.id) === id);
  if (channel) {
    selectedId.value = id;
    selectedHostId.value = channel.host.id;
    selectedFolderKey.value = folderKey(channel);
    await refreshSelectedMessages();
  } else if (!id) {
    syncSelection();
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
    <div class="channel-layout">
      <aside class="channel-sidebar card" :class="{ 'is-open': sidebarOpen }" aria-label="主机和文件夹导航">
      <div class="channel-sidebar-toolbar">
        <router-link to="/" class="channel-back-link" aria-label="返回仪表盘">
          <i class="bi bi-arrow-left"></i>
        </router-link>
        <div class="min-w-0">
          <div class="eyebrow"><i class="bi bi-chat-dots me-1"></i>CHANNELS</div>
          <strong class="channel-sidebar-title">主机对话</strong>
        </div>
        <span class="text-secondary small ms-auto" title="每 3 秒刷新"><i class="bi bi-arrow-repeat"></i></span>
      </div>

      <section class="channel-panel-section channel-host-panel">
        <div class="card-header d-flex justify-content-between align-items-center">
          <strong>主机</strong><span class="text-secondary small">{{ hosts.length }} 台</span>
        </div>
        <div v-if="loading" class="empty-state py-4">加载中…</div>
        <div v-else-if="!hosts.length" class="empty-state py-4">
          <i class="bi bi-pc-display"></i><strong>还没有主机</strong><span>先注册一台主机。</span>
        </div>
        <div v-else class="list-group list-group-flush channel-host-list">
          <button v-for="host in hosts" :key="host.id" type="button"
            class="list-group-item list-group-item-action bg-transparent text-start channel-nav-item"
            :class="{ active: String(selectedHostId) === String(host.id) }" @click="selectHost(host)">
            <div class="d-flex align-items-center gap-2">
              <i class="bi bi-pc-display"></i>
              <strong class="text-truncate">{{ hostTitle(host) }}</strong>
              <StatusBadge class="ms-auto" kind="host" :status="host.status" :offline="host.offline" />
            </div>
            <div class="small opacity-75 mt-1 text-truncate">{{ host.id }}</div>
          </button>
        </div>
      </section>

      <section class="channel-panel-section channel-folder-panel">
        <div class="card-header d-flex justify-content-between align-items-center">
          <strong>文件夹</strong><span class="text-secondary small">{{ folders.length }} 个</span>
        </div>
        <div v-if="!selectedHost" class="empty-state py-4">选择主机查看文件夹</div>
        <div v-else-if="!folders.length" class="empty-state py-4">
          <i class="bi bi-folder2-open"></i><strong>暂无对话文件夹</strong><span>新建对话后会自动出现。</span>
        </div>
        <div v-else class="list-group list-group-flush channel-folder-list">
          <button v-for="folder in folders" :key="folder.key" type="button"
            class="list-group-item list-group-item-action bg-transparent text-start channel-nav-item"
            :class="{ active: selectedFolderKey === folder.key }" @click="selectFolder(folder)">
            <div class="d-flex align-items-center gap-2">
              <i class="bi bi-folder2"></i>
              <strong class="text-truncate">{{ folderTitle(folder) }}</strong>
              <span class="badge text-bg-secondary ms-auto">{{ folder.channels.length }}</span>
            </div>
            <div class="small opacity-75 mt-1">最近：{{ fmtTime(folder.lastActivity) }}</div>
          </button>
        </div>
      </section>
      </aside>

      <button v-if="sidebarOpen" type="button" class="channel-sidebar-backdrop" aria-label="关闭导航" @click="sidebarOpen = false"></button>

      <section class="channel-main">
        <button type="button" class="channel-mobile-toggle btn btn-sm btn-ghost" aria-label="打开主机和文件夹导航"
          @click="sidebarOpen = true">
          <i class="bi bi-layout-sidebar-inset me-1"></i>导航
        </button>
        <div v-if="error" class="alert alert-danger channel-alert">{{ error }}</div>
        <div v-if="!selectedFolder" class="card channel-empty">
          <i class="bi bi-arrow-left-circle"></i><strong>选择一个文件夹</strong>
          <span>从左侧选择主机和工作目录，查看该目录下的对话。</span>
        </div>
        <template v-else>
          <section class="card channel-dialog-list">
            <div class="card-header d-flex justify-content-between align-items-center gap-2">
              <div>
                <strong><i class="bi bi-folder2-open me-2"></i>{{ folderTitle(selectedFolder) }}</strong>
                <div class="small text-secondary mt-1">{{ selectedFolder.channels.length }} 个对话 · {{ selectedHost ? hostTitle(selectedHost) : '' }}</div>
              </div>
              <button class="btn btn-sm btn-primary" @click="openCreateForm">
                <i class="bi bi-plus-lg me-1"></i>发起新对话
              </button>
            </div>
            <form v-if="showCreate" class="card-body border-bottom" @submit.prevent="createChannel">
              <div class="row g-2 align-items-end">
                <div class="col-md-5">
                  <label class="form-label small">工作目录 *</label>
                  <input v-model="newWorkdir" class="form-control form-control-sm" required
                    aria-label="工作目录" placeholder="例如 ~/projects/demo">
                </div>
                <div class="col-md-5">
                  <label class="form-label small">对话标题</label>
                  <input v-model="newTitle" class="form-control form-control-sm" placeholder="可选">
                </div>
                <div class="col-md-2 d-flex gap-2">
                  <button class="btn btn-sm btn-primary flex-grow-1" :disabled="creating">
                    {{ creating ? '创建中…' : '创建' }}
                  </button>
                  <button type="button" class="btn btn-sm btn-outline-secondary" @click="showCreate = false">取消</button>
                </div>
              </div>
              <div class="small text-secondary mt-2">主机固定为「{{ hostTitle(selectedHost) }}」，工作目录必须位于 ~ 下。</div>
            </form>
            <div v-if="!folderChannels.length" class="empty-state py-4">
              <i class="bi bi-chat-square-text"></i><strong>该文件夹暂无对话</strong><span>点击右上角发起第一段对话。</span>
            </div>
            <div v-else class="list-group list-group-flush channel-dialog-items">
              <button v-for="channel in folderChannels" :key="channel.id" type="button"
                class="list-group-item list-group-item-action bg-transparent text-start channel-dialog-item"
                :class="{ active: String(selectedId) === String(channel.id) }" @click="selectChannel(channel)">
                <div class="d-flex align-items-center gap-2">
                  <i class="bi bi-chat-left-text"></i>
                  <strong class="text-truncate">{{ channel.title || '未命名对话' }}</strong>
                  <span class="badge text-bg-secondary ms-auto">{{ channel.message_count }}</span>
                </div>
                <div class="small opacity-75 mt-1 text-truncate">工作目录：{{ channel.workdir || '默认（~/tmp）' }}</div>
                <div class="small opacity-50 mt-1">{{ fmtTime(channel.last_activity_at) }}</div>
              </button>
            </div>
          </section>

          <section class="channel-conversation card">
            <div v-if="!selectedChannel" class="empty-state channel-empty">
              <i class="bi bi-chat-square-heart"></i><strong>选择一个对话</strong><span>上方列表选择对话后显示消息流。</span>
            </div>
            <template v-else>
              <div class="card-header d-flex justify-content-between align-items-center gap-3">
                <div class="text-truncate">
                  <strong><i class="bi bi-chat-dots me-2"></i>{{ selectedChannel.title || '未命名对话' }}</strong>
                  <div class="small text-secondary mt-1 text-truncate">
                    {{ selectedHost ? hostTitle(selectedHost) : selectedChannel.host.name }} · 工作目录：{{ selectedChannel.workdir || '默认（~/tmp）' }}
                  </div>
                </div>
                <div class="d-flex align-items-center gap-2 flex-shrink-0">
                  <StatusBadge kind="host" :status="selectedHost?.status || 'active'" :offline="selectedHost?.offline ?? !selectedChannel.host.online" />
                  <button class="btn btn-sm btn-outline-warning" :disabled="resetting" @click="resetSession">
                    <i class="bi bi-arrow-counterclockwise me-1"></i>{{ resetting ? '重置中…' : '重置会话' }}
                  </button>
                </div>
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
                <div v-if="sendError" class="alert alert-info py-2 mb-2">{{ sendError }}</div>
                <div class="input-group">
                  <textarea v-model="draft" class="form-control" rows="2" maxlength="10000"
                    placeholder="输入消息，工作目录由当前对话固定" aria-label="消息内容"
                    @keydown.enter.exact.prevent="sendMessage"></textarea>
                  <button class="btn btn-primary px-4" :disabled="sending || !draft.trim()">
                    <i class="bi bi-send me-1"></i>{{ sending ? '发送中…' : '发送' }}
                  </button>
                </div>
              </form>
            </template>
          </section>
        </template>
      </section>
    </div>
  </div>
</template>
