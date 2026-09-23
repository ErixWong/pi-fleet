<script setup>
import {
  computed,
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { renderMd } from '../md';
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
const listOpen = ref(false); // 对话列表默认收起，只留头部栏，节省消息流空间
const refreshingFolders = ref(false);
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

function hostHomePrefix(host) {
  const reportedPath = (host?.folders || [])
    .map((folder) => String(folder?.path || '').trim())
    .find((folder) => folder.startsWith('/home/'));
  const match = reportedPath?.match(/^\/home\/[^/]+/);
  return match?.[0] || '';
}

function folderKey(channel, host = selectedHost.value) {
  const workdir = channel.workdir?.trim();
  if (!workdir) return '__default__';
  const homePrefix = hostHomePrefix(host);
  if (homePrefix && workdir === '~') return homePrefix;
  if (homePrefix && workdir.startsWith('~/')) {
    return `${homePrefix}${workdir.slice(1)}`;
  }
  return workdir;
}

function folderCreateWorkdir(folder, host = selectedHost.value) {
  const workdir = folder?.workdir?.trim() || '~/tmp';
  const homePrefix = hostHomePrefix(host)
    || workdir.match(/^\/home\/[^/]+/)?.[0]
    || '';
  if (homePrefix && workdir === homePrefix) return '~';
  if (homePrefix && workdir.startsWith(`${homePrefix}/`)) {
    return `~${workdir.slice(homePrefix.length)}`;
  }
  return workdir;
}

const folders = computed(() => {
  const grouped = new Map();
  for (const reported of selectedHost.value?.folders || []) {
    const workdir = String(reported?.path || '').trim();
    if (!workdir) continue;
    grouped.set(workdir, {
      key: workdir,
      workdir,
      channels: [],
      lastActivity: '',
      lastReportedAt: String(reported?.last_seen_at || ''),
      reported: true,
    });
  }
  for (const channel of hostChannels.value) {
    const key = folderKey(channel, selectedHost.value);
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        workdir: channel.workdir?.trim() || null,
        channels: [],
        lastActivity: '',
        lastReportedAt: '',
        reported: false,
      });
    }
    const folder = grouped.get(key);
    if (folder.channels.length === 0 && folder.reported) {
      folder.workdir = channel.workdir?.trim() || folder.workdir;
    }
    folder.channels.push(channel);
    if (String(channel.last_activity_at || '') > String(folder.lastActivity || '')) {
      folder.lastActivity = channel.last_activity_at || '';
    }
  }
  return [...grouped.values()].sort((left, right) => {
    const leftRecent = left.lastActivity || left.lastReportedAt;
    const rightRecent = right.lastActivity || right.lastReportedAt;
    return String(rightRecent).localeCompare(String(leftRecent));
  });
});

const selectedFolder = computed(() =>
  folders.value.find((folder) => folder.key === selectedFolderKey.value) || null);
const folderChannels = computed(() => selectedFolder.value?.channels || []);

// ---- 目录树（按需钻目录：缓存直接渲染，未缓存走 browse 控制链路） ----
const treeExpanded = reactive({});
const autoExpanded = new Set(); // 记录已自动展开过的目录 key，手动收起后不再被 watch 重新展开
const browseStatus = reactive({}); // path -> 'loading' | 'error' | 'done'
const browseEmpty = reactive({}); // path -> browse 返回 0 个子目录（给"展开无内容"一个明确反馈）
const browseErrors = reactive({});
const browsedPaths = reactive({});
const browseSeq = reactive({}); // path -> 正在轮询的 request_id

const homePrefix = computed(() => hostHomePrefix(selectedHost.value));
const useTree = computed(() => Boolean(homePrefix.value));

function parentPathOf(path) {
  const root = homePrefix.value;
  if (!root || path === root) return null;
  if (!path.startsWith(`${root}/`)) return null;
  const rest = path.slice(root.length + 1);
  const idx = rest.indexOf('/');
  return idx === -1 ? root : `${root}/${rest.slice(0, idx)}`;
}

function childrenCached(path) {
  return (selectedHost.value?.folders || [])
    .some((folder) => String(folder?.path || '').startsWith(`${path}/`));
}

const treeNodes = computed(() => {
  const map = new Map();
  const root = homePrefix.value;
  if (!root) return map;
  const ensure = (path) => {
    if (!map.has(path)) {
      map.set(path, {
        path,
        name: path === root ? path.slice(path.lastIndexOf('/') + 1) : path.slice(path.lastIndexOf('/') + 1),
        parent: parentPathOf(path),
        channels: [],
      });
    }
    return map.get(path);
  };
  ensure(root);
  for (const group of folders.value) {
    const key = group.key;
    if (key !== root && !key.startsWith(`${root}/`)) continue;
    const chain = [];
    let parent = parentPathOf(key);
    while (parent) {
      chain.push(parent);
      parent = parentPathOf(parent);
    }
    for (const ancestor of chain.reverse()) ensure(ancestor);
    const node = ensure(key);
    node.channels = group.channels;
  }
  return map;
});

function treeChildren(parent) {
  const list = [];
  for (const node of treeNodes.value.values()) {
    if (node.parent === parent) list.push(node);
  }
  return list.sort((left, right) => {
    const leftHot = left.channels.length > 0;
    const rightHot = right.channels.length > 0;
    if (leftHot !== rightHot) return rightHot ? 1 : -1;
    return left.name.localeCompare(right.name);
  });
}

// 有对话的目录置顶展开（祖先链一并展开保证可见）。同一目录只自动展开一次，
// 用户手动收起后（watch 不再覆盖）保持收起状态。
watch(folders, () => {
  if (!useTree.value) return;
  for (const group of folders.value) {
    if (group.channels.length === 0) continue;
    let parent = parentPathOf(group.key);
    const chain = [];
    while (parent) {
      chain.push(parent);
      parent = parentPathOf(parent);
    }
    for (const ancestor of chain.reverse()) {
      treeExpanded[ancestor] = true;
      autoExpanded.add(ancestor);
    }
    if (!autoExpanded.has(group.key)) {
      treeExpanded[group.key] = true;
      autoExpanded.add(group.key);
    }
  }
});

function hasKnownChildren(path) {
  for (const node of treeNodes.value.values()) {
    if (node.parent === path) return true;
  }
  return false;
}

function toggleTreeNode(row) {
  const path = row.path;
  if (treeExpanded[path]) {
    treeExpanded[path] = false;
    return;
  }
  treeExpanded[path] = true;
  maybeBrowse(path);
}

function maybeBrowse(path) {
  if (!useTree.value || !selectedHostId.value) return;
  if (browsedPaths[path] || browseStatus[path] === 'loading') return;
  if (childrenCached(path) || hasKnownChildren(path)) return;
  void requestBrowse(path);
}
async function refreshHosts() {
  const hostData = await api.hosts();
  hosts.value = hostData.items ?? [];
}

async function requestBrowse(path) {
  browseStatus[path] = 'loading';
  browseErrors[path] = '';
  let requestId;
  try {
    const data = await api.browseHost(selectedHostId.value, { path });
    requestId = data.request_id;
  } catch (e) {
    browseStatus[path] = 'error';
    browseErrors[path] = e.message || 'browse 请求失败';
    return;
  }
  void pollBrowse(requestId, path);
}

async function pollBrowse(requestId, path) {
  browseSeq[path] = requestId;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (browseSeq[path] !== requestId) return;
    try {
      const { request } = await api.hostControlRequest(requestId);
      if (request.status === 'answered') {
        browsedPaths[path] = true;
        browseStatus[path] = 'done';
        await refreshHosts();
        // browse 成功但没有子目录：给个明确反馈，否则看起来像"点不开"
        const children = (selectedHost.value?.folders || [])
          .some((folder) => String(folder?.path || '').startsWith(`${path}/`));
        if (!children && !hasKnownChildren(path)) browseEmpty[path] = true;
        return;
      }
      if (request.status === 'expired') {
        browseStatus[path] = 'error';
        browseErrors[path] = '主机未响应';
        return;
      }
    } catch {
      // 状态查询失败时下轮重试，直到超时按主机未响应处理。
    }
  }
  browseStatus[path] = 'error';
  browseErrors[path] = '主机未响应';
}

function retryBrowse(path) {
  browsedPaths[path] = false;
  browseStatus[path] = '';
  browseEmpty[path] = false;
  void requestBrowse(path);
}

const ChannelTreeNode = defineComponent({
  name: 'ChannelTreeNode',
  props: {
    node: { type: Object, required: true },
  },
  setup(props) {
    return () => {
      const node = props.node;
      const expanded = Boolean(treeExpanded[node.path]);
      const children = treeChildren(node.path);
      const status = browseStatus[node.path];
      const rowChildren = [
        h('button', {
          type: 'button',
          class: 'channel-tree-toggle',
          'aria-label': `${expanded ? '收起 ' : '展开 '}${node.name}`,
          onClick: (event) => {
            event.stopPropagation();
            toggleTreeNode(node);
          },
        }, [
          h('i', { class: ['bi', expanded ? 'bi-chevron-down' : 'bi-chevron-right'] }),
        ]),
        h('button', {
          type: 'button',
          class: ['channel-tree-label', selectedFolderKey.value === node.path ? 'active' : ''],
          title: node.path,
          onClick: () => selectTreeNode(node),
        }, [
          h('i', { class: 'bi bi-folder2' }),
          h('strong', { class: 'text-truncate' }, node.name),
          h('span', { class: 'badge text-bg-secondary' }, String(node.channels.length)),
        ]),
      ];

      if (status === 'loading') {
        rowChildren.push(h('span', { class: 'small text-secondary channel-tree-status' }, '正在读取主机目录…'));
      } else if (status === 'error') {
        rowChildren.push(h('button', {
          type: 'button',
          class: 'btn btn-sm btn-link text-danger p-0 channel-tree-status',
          title: browseErrors[node.path],
          onClick: (event) => {
            event.stopPropagation();
            retryBrowse(node.path);
          },
        }, `${browseErrors[node.path] || '读取失败'}，重试`));
      } else if (browseEmpty[node.path]) {
        rowChildren.push(h('span', { class: 'small text-secondary channel-tree-status' }, '（空目录）'));
      }

      return h('div', { class: 'channel-tree-branch' }, [
        h('div', {
          class: [
            'list-group-item',
            'bg-transparent',
            'channel-tree-row',
            selectedFolderKey.value === node.path ? 'active' : '',
          ],
        }, rowChildren),
        expanded && children.length
          ? h('div', { class: 'channel-tree-children' }, children.map((child) =>
            h(ChannelTreeNode, { key: child.path, node: child })))
          : null,
      ]);
    };
  },
});

async function selectTreeNode(row) {
  const group = folders.value.find((folder) => folder.key === row.path);
  if (!group) {
    toggleTreeNode(row);
    return;
  }
  await selectFolder(group);
}

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
    selectedFolderKey.value = folderKey(routeChannel, selectedHost.value);
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

async function refreshFolders() {
  if (!selectedHost.value || refreshingFolders.value) return;
  refreshingFolders.value = true;
  try {
    for (const path of Object.keys(browsedPaths)) delete browsedPaths[path];
    for (const path of Object.keys(browseEmpty)) delete browseEmpty[path];
    for (const path of Object.keys(browseErrors)) delete browseErrors[path];

    const root = homePrefix.value;
    if (useTree.value && root) {
      const paths = new Set([root]);
      for (const [path, expanded] of Object.entries(treeExpanded)) {
        if (expanded && (path === root || path.startsWith(`${root}/`))) paths.add(path);
      }
      for (const path of paths) {
        if (browseStatus[path] !== 'loading') void requestBrowse(path);
      }
    }
    await refreshData();
  } finally {
    refreshingFolders.value = false;
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
  selectedFolderKey.value = folderKey(channel, selectedHost.value);
  sidebarOpen.value = false;
  listOpen.value = false; // 选中对话后收起列表，把空间让给消息流
  sendError.value = '';
  await router.push(`/channels/${encodeURIComponent(channel.id)}`);
  await refreshSelectedMessages();
}

function openCreateForm() {
  if (!selectedHost.value) return;
  newWorkdir.value = folderCreateWorkdir(selectedFolder.value, selectedHost.value);
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
    selectedFolderKey.value = folderKey(channel, selectedHost.value);
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
          <strong>文件夹</strong>
          <div class="d-flex align-items-center gap-1">
            <button type="button" class="btn btn-sm btn-ghost channel-folder-refresh"
              :class="{ spin: refreshingFolders }" :disabled="refreshingFolders || !selectedHost"
              aria-label="刷新目录" title="实时读取主机目录" @click="refreshFolders">
              <i class="bi bi-arrow-repeat"></i>
            </button>
            <span class="text-secondary small">{{ folders.length }} 个</span>
          </div>
        </div>
        <div v-if="!selectedHost" class="empty-state py-4">选择主机查看文件夹</div>
        <div v-else-if="!folders.length" class="empty-state py-4">
          <i class="bi bi-folder2-open"></i><strong>暂无文件夹</strong><span>主机上报目录或新建对话后会自动出现。</span>
        </div>
        <template v-else>
          <div v-if="useTree" class="list-group list-group-flush channel-folder-list channel-folder-tree">
            <ChannelTreeNode v-if="treeNodes.get(homePrefix)" :node="treeNodes.get(homePrefix)" />
          </div>
          <div v-else class="list-group list-group-flush channel-folder-list">
            <button v-for="folder in folders" :key="folder.key" type="button"
              class="list-group-item list-group-item-action bg-transparent text-start channel-nav-item"
              :class="{ active: selectedFolderKey === folder.key }"
              :title="folder.channels.length ? '' : '点击后可在此文件夹发起新对话'"
              @click="selectFolder(folder)">
              <div class="d-flex align-items-center gap-2">
                <i class="bi bi-folder2"></i>
                <strong class="text-truncate">{{ folderTitle(folder) }}</strong>
                <span class="badge text-bg-secondary ms-auto">{{ folder.channels.length }}</span>
              </div>
              <div class="small opacity-75 mt-1">
                <template v-if="folder.channels.length">最近：{{ fmtTime(folder.lastActivity) }}</template>
                <template v-else>最近上报：{{ fmtTime(folder.lastReportedAt) }}</template>
              </div>
            </button>
          </div>
        </template>
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
          <section class="card channel-dialog-list" :class="{ 'is-open': listOpen }">
            <div class="card-header d-flex justify-content-between align-items-center gap-2">
              <button type="button" class="btn btn-sm btn-ghost channel-dialog-toggle text-start"
                :aria-expanded="listOpen" @click="listOpen = !listOpen">
                <i class="bi me-2" :class="listOpen ? 'bi-chevron-down' : 'bi-chevron-right'"></i>
                <i class="bi bi-folder2-open me-2"></i>{{ folderTitle(selectedFolder) }}
                <span class="badge text-bg-secondary ms-2">{{ selectedFolder.channels.length }}</span>
              </button>
              <button class="btn btn-sm btn-primary flex-shrink-0" @click="openCreateForm">
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
                  <input v-model="newTitle" class="form-control form-control-sm" aria-label="对话标题" placeholder="可选">
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
            <div v-else-if="listOpen || !selectedId" class="list-group list-group-flush channel-dialog-items">
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
                      <div class="channel-message-body md-content" v-html="renderMd(message.body)"></div>
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
