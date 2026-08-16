<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Modal } from 'bootstrap';
import { api } from '../api';
import Pagination from '../components/Pagination.vue';
import TagBadge from '../components/TagBadge.vue';
import TagPicker from '../components/TagPicker.vue';
import ChatPanel from '../components/ChatPanel.vue';

/** 主机工作台（占屏 ~90%）：
 *  左侧 4/12 主机列表侧边栏；右侧 8/12 内容区——
 *   · 点击主机行 → 主机详情（会话管理/信息/任务）
 *   · 点击行内 💬 → 会话视图（tab 条：主机会话 + 已打开的会话），自动打开第一个会话
 *   · 会话 tab 可切换/关闭，随时回到详情
 */
const agents = ref([]);
const total = ref(0);
const page = ref(1);
const offlineMin = ref(30);

const selectedAgent = ref(null); // 当前选中主机
const mode = ref('empty');       // empty | detail | chat
const tabs = ref([]);            // [{ id: convId|'__host__', title }]
const activeTab = ref('');       // 当前激活 tab
const sidebarCollapsed = ref(false); // 左侧主机面板收起

const route = useRoute();
const router = useRouter();

/** 把当前工作台状态同步到 URL query（对话界面可直达/刷新保持/分享） */
function syncUrl() {
  const q = {};
  if (selectedAgent.value) q.agent = String(selectedAgent.value.id);
  if (mode.value === 'chat') {
    q.mode = 'chat';
    if (activeTab.value && activeTab.value !== HOST_TAB) q.conv = activeTab.value;
  } else if (mode.value === 'detail') {
    q.mode = 'detail';
  }
  router.replace({ path: '/hosts', query: q });
}

// 详情数据
const agent = ref(null);
const tasks = ref([]);
const taskTotal = ref(0);
const taskPage = ref(1);
const conversations = ref([]);
const convTotal = ref(0);
const convPage = ref(1);
const convLoading = ref(false);
const error = ref('');
const newKey = ref(null);

// 新建会话弹窗
const showCreate = ref(false);
const createName = ref('');
const createWorkdir = ref('');
const createMsg = ref('');
const createBusy = ref(false);

// 编辑主机弹窗（名称/标识/描述/提示词/接外单）
const showEdit = ref(false);
const editForm = ref({ name: '', hostname: '', description: '', system_prompt: '', accept_external: false, run_user: '' });
const editBusy = ref(false);
const editMsg = ref('');

// 注册主机弹窗
const tagGroups = ref([]);
const form = ref({ name: '', hostname: '', description: '', system_prompt: '', tags: [], accept_external: false, run_user: '' });
const registerModalEl = ref(null);
let registerModal = null;

async function load() {
  const data = await api.agents(page.value, 10);
  agents.value = data.agents ?? [];
  total.value = data.total ?? 0;
  offlineMin.value = data.offline_after_min ?? 30;
}

async function loadTags() {
  try { tagGroups.value = (await api.tags()).groups || []; } catch { /* 静默 */ }
}

onMounted(async () => { await load(); loadTags(); await restoreFromUrl(); });
onBeforeUnmount(() => { registerModal?.dispose(); });

/** 从 URL query 恢复状态（对话界面独立路由：/hosts?mode=chat&agent=13&conv=conv-xxx） */
async function restoreFromUrl() {
  const q = route.query;
  if (!q.agent) return;
  const a = agents.value.find((x) => String(x.id) === String(q.agent));
  if (!a) return;
  if (q.mode === 'chat') {
    await openChat(a);
    if (q.conv) {
      // 目标会话可能不在第一页列表，尝试直接打开（标题从会话列表匹配，找不到用 convId）
      const conv = conversations.value.find((c) => c.conversation_id === q.conv);
      openConvTab(String(q.conv), conv?.name || String(q.conv));
    }
  } else {
    await selectAgent(a);
  }
}

/** 选中主机 → 显示详情 */
async function selectAgent(a) {
  selectedAgent.value = a;
  mode.value = 'detail';
  activeTab.value = '';
  syncUrl();
  await loadAgent();
}

async function loadAgent() {
  if (!selectedAgent.value) return;
  try {
    const data = await api.agent(selectedAgent.value.id, { page: taskPage.value, page_size: 10 });
    agent.value = data.agent;
    tasks.value = data.tasks ?? [];
    taskTotal.value = data.total ?? 0;
    offlineMin.value = data.offline_after_min ?? 30;
  } catch (e) {
    error.value = e.message;
  }
  await loadConversations();
}

async function loadTasks() {
  const data = await api.agent(selectedAgent.value.id, { page: taskPage.value, page_size: 10 });
  agent.value = data.agent;
  tasks.value = data.tasks ?? [];
  taskTotal.value = data.total ?? 0;
}

async function loadConversations() {
  if (!selectedAgent.value) return;
  convLoading.value = true;
  try {
    const data = await api.agentConversations(selectedAgent.value.id, convPage.value, 20);
    conversations.value = data.conversations ?? [];
    convTotal.value = data.total ?? 0;
  } finally {
    convLoading.value = false;
  }
}

const HOST_TAB = '__host__';

function hostTabTitle() {
  return `${agent.value?.name || selectedAgent.value?.name || '主机'} 对话`;
}

function ensureHostTab() {
  if (!tabs.value.some((t) => t.id === HOST_TAB)) {
    tabs.value.push({ id: HOST_TAB, title: hostTabTitle() });
  }
}

/** 点 💬：进入会话视图，打开该主机第一个会话（无会话则主机会话） */
async function openChat(a) {
  const agent = a || selectedAgent.value;
  if (!agent) return;
  if (!selectedAgent.value || String(selectedAgent.value.id) !== String(agent.id)) {
    selectedAgent.value = agent;
  }
  mode.value = 'chat';
  ensureHostTab();
  await loadConversations();
  const first = conversations.value[0];
  if (first) {
    openConvTab(first.conversation_id, first.name || first.conversation_id);
  } else {
    activeTab.value = HOST_TAB;
  }
  syncUrl();
}

/** 打开（或激活）某个会话 tab */
function openConvTab(convId, title) {
  if (!tabs.value.some((t) => t.id === convId)) {
    tabs.value.push({ id: convId, title: title || convId });
  }
  activeTab.value = convId;
  mode.value = 'chat';
  syncUrl();
}

/** 关闭会话 tab（主机 tab 保留） */
function closeTab(id) {
  if (id === HOST_TAB) return;
  const i = tabs.value.findIndex((t) => t.id === id);
  if (i < 0) return;
  tabs.value.splice(i, 1);
  if (activeTab.value === id) {
    activeTab.value = tabs.value.length ? tabs.value[Math.max(0, i - 1)].id : HOST_TAB;
  }
  syncUrl();
}

/** 从会话视图返回主机详情（同步 URL） */
function backToDetail() {
  mode.value = 'detail';
  syncUrl();
}

/** 从详情会话列表打开会话 */
function openConvFromList(c) {
  openConvTab(c.conversation_id, c.name || c.conversation_id);
}

/** 新建会话（弹窗，成功后在会话视图打开） */
function openCreate() {
  createName.value = '';
  createWorkdir.value = '';
  createMsg.value = '';
  showCreate.value = true;
}

async function submitCreate() {
  if (!selectedAgent.value) return;
  // 工作目录固定以 ~/projects/ 为前缀：输入只填子目录名（或留空=~/projects 根）；总是显式提交，创建后不可修改
  const rel = createWorkdir.value.trim().replace(/^~[\/]projects[\/]/, '').replace(/^[\/]+/, '');
  if (rel && (!/^[A-Za-z0-9._-]+([\/][A-Za-z0-9._-]+)*$/.test(rel) || /(^|\/)\.{1,2}(\/|$)/.test(rel))) {
    createMsg.value = '工作目录只允许字母数字/点/下划线/连字符组成的子目录名（如 mini-mes 或 mis/crm），禁 .. / . 段';
    return;
  }
  createBusy.value = true;
  createMsg.value = '';
  try {
    const payload = { agent_id: Number(selectedAgent.value.id) };
    if (createName.value.trim()) payload.name = createName.value.trim();
    payload.workdir = rel ? `~/projects/${rel}` : '~/projects';
    // 运行用户不在此处填写：部署时在主机上指定（agent.run_user），会话继承
    const data = await api.createConversation(payload);
    showCreate.value = false;
    await loadConversations();
    openConvTab(data.conversation.conversation_id, data.conversation.name || data.conversation.conversation_id);
  } catch (e) {
    createMsg.value = e.message;
  } finally {
    createBusy.value = false;
  }
}

async function renameConv(c) {
  const name = prompt('会话名：', c.name || '');
  if (name === null) return;
  try {
    await api.renameConversation(c.conversation_id, name.trim() || c.name || '会话');
    const t = tabs.value.find((x) => x.id === c.conversation_id);
    if (t) t.title = name.trim() || c.name || c.conversation_id;
    await loadConversations();
  } catch (e) {
    alert(e.message);
  }
}

async function setRunUser(c) {
  const name = prompt('运行 pi 的用户（空=bridge 当前用户；非当前用户需远端 sudoers 白名单）：', c.run_user || '');
  if (name === null) return;
  try {
    await api.setConversationRunUser(c.conversation_id, name.trim() || null);
    await loadConversations();
  } catch (e) {
    alert(e.message);
  }
}

async function archiveConv(c) {
  if (!confirm(`归档会话「${c.name || c.conversation_id}」？（归档后从列表隐藏，历史保留）`)) return;
  try {
    await api.archiveConversation(c.conversation_id);
    const i = tabs.value.findIndex((t) => t.id === c.conversation_id);
    if (i >= 0) closeTab(c.conversation_id);
    await loadConversations();
  } catch (e) {
    alert(e.message);
  }
}

/** 禁用/启用 */
async function toggle() {
  try {
    await api.toggleAgent(selectedAgent.value.id);
    await loadAgent();
    await load();
  } catch (e) {
    alert(e.message);
  }
}

/** 重置 API key */
async function resetKey() {
  if (!confirm('重置 API Key？旧 key 立即失效，新 key 只显示一次。')) return;
  try {
    const data = await api.resetAgentKey(selectedAgent.value.id);
    newKey.value = data.key;
    alert(`新 API Key（只显示一次）：\n\n${data.key}`);
  } catch (e) {
    alert(e.message);
  }
}

/** 接单开关 */
async function toggleAccept() {
  try {
    await api.toggleAgentAccept(selectedAgent.value.id);
    await loadAgent();
  } catch (e) {
    alert(e.message);
  }
}

/** 打开编辑主机弹窗（从当前 agent 详情回填） */
function openEdit() {
  const a = agent.value ?? selectedAgent.value;
  if (!a) return;
  editForm.value = {
    name: a.name ?? '',
    hostname: a.hostname ?? '',
    description: a.description ?? '',
    system_prompt: a.system_prompt ?? '',
    accept_external: !!a.accept_external,
    run_user: a.run_user ?? '',
  };
  editMsg.value = '';
  showEdit.value = true;
}

/** 保存编辑：调 PUT /api/agents/:id（仅传非空字段；提示词可清空=自动生成） */
async function submitEdit() {
  if (!selectedAgent.value) return;
  editBusy.value = true;
  editMsg.value = '';
  try {
    const payload = {
      name: editForm.value.name.trim(),
      hostname: editForm.value.hostname.trim(),
      description: editForm.value.description.trim(),
      system_prompt: editForm.value.system_prompt,
      accept_external: editForm.value.accept_external,
      run_user: editForm.value.run_user.trim(),
    };
    await api.updateAgent(selectedAgent.value.id, payload);
    showEdit.value = false;
    await loadAgent(); // 刷新详情（含提示词/接外单）
    await load();      // 刷新左侧列表（名称可能改了）
  } catch (e) {
    editMsg.value = e.message;
  } finally {
    editBusy.value = false;
  }
}

/** 删除 agent */
async function removeAgent() {
  if (!confirm(`确定删除主机「${selectedAgent.value.name}」？\n\n无关联数据将直接删除；有任务/会话等历史数据则软删除（不再显示、不再接活，历史保留）。`)) return;
  try {
    const data = await api.deleteAgent(selectedAgent.value.id);
    if (data.mode === 'soft') {
      alert(`已软删除（有 ${Object.values(data.refs ?? {}).reduce((a, b) => a + b, 0)} 条关联数据）：不再显示、不再接活，历史记录保留。`);
    } else {
      alert('已删除（无关联数据，物理删除）。');
    }
    selectedAgent.value = null;
    agent.value = null;
    tabs.value = [];
    activeTab.value = '';
    mode.value = 'empty';
    await load();
  } catch (e) {
    alert(e.message);
  }
}

/** 注册主机 */
function openRegister() {
  error.value = '';
  form.value = { name: '', hostname: '', description: '', system_prompt: '', tags: [], accept_external: false, run_user: '' };
  registerModal = new Modal(registerModalEl.value);
  registerModal.show();
}

async function submitRegister() {
  error.value = '';
  try {
    const data = await api.createAgent({ ...form.value, tags: form.value.tags.join(', ') });
    registerModal.hide();
    newKey.value = { name: data.agent.name, key: data.key };
    await load();
    await selectAgent(data.agent);
  } catch (e) {
    error.value = e.message;
  }
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

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
  <div class="hosts-workspace d-flex flex-column" style="height: calc(100vh - 88px)">
    <!-- ========== 顶部横条：主机标题 + 展开/收起/注册 ========== -->
    <div class="d-flex align-items-center gap-2 px-3 py-2 border-bottom flex-shrink-0">
      <button v-if="sidebarCollapsed" class="btn btn-sm btn-outline-primary" title="展开主机列表" @click="sidebarCollapsed = false">
        <i class="bi bi-chevron-double-right me-1"></i>展开
      </button>
      <button v-if="!sidebarCollapsed" class="btn btn-sm btn-outline-secondary" title="收起侧边栏" @click="sidebarCollapsed = true"><i class="bi bi-chevron-left"></i></button>
      <span class="fw-bold small"><i class="bi bi-pc-display me-1 text-primary"></i>主机</span>
      <div class="ms-auto d-flex gap-1">
        <button v-if="!sidebarCollapsed" class="btn btn-sm btn-primary" @click="openRegister"><i class="bi bi-plus-lg me-1"></i>注册</button>
      </div>
    </div>

    <!-- ========== 主体：左侧主机列表（4/12，可收起）+ 右侧内容（8/12） ========== -->
    <div class="d-flex flex-grow-1" style="min-height: 0">
    <aside v-if="!sidebarCollapsed" class="hosts-side col-3 border-end d-flex flex-column" style="min-width: 240px">
      <div v-if="newKey" class="alert alert-warning m-2 py-2 small mb-0">
        <div class="fw-bold mb-1"><i class="bi bi-key-fill me-1"></i>新 API Key（只显示这一次，请立即保存）— {{ newKey.name }}</div>
        <div class="key-box">{{ newKey.key }}</div>
        <button class="btn btn-sm btn-outline-secondary mt-1" @click="newKey = null"><i class="bi bi-check2 me-1"></i>我已保存</button>
      </div>
      <div class="flex-grow-1 overflow-auto">
        <div v-if="agents.length === 0" class="text-center text-secondary small py-4">还没有主机，先注册一个。</div>
        <div v-for="a in agents" :key="a.id" class="host-item d-flex align-items-center gap-2 px-3 py-2 border-bottom"
             :class="{ 'host-active': selectedAgent && String(selectedAgent.id) === String(a.id) }"
             @click="selectAgent(a)">
          <div class="flex-grow-1 min-w-0">
            <div class="fw-bold small text-truncate">{{ a.name }}</div>
            <div class="text-secondary small text-truncate">{{ a.hostname || a.agent_id }}</div>
            <div class="d-flex gap-1 mt-1">
              <span class="badge" :class="a.status === 'active' ? 'text-bg-success' : 'text-bg-secondary'">{{ a.status }}</span>
              <span v-if="a.offline" class="badge text-bg-danger" :title="`超过 ${offlineMin} 分钟无心跳（最近活跃：${a.last_seen_at || '从未连接'}）`">失联</span>
            </div>
          </div>
          <button class="btn btn-sm btn-outline-primary flex-shrink-0" title="会话" @click.stop="openChat(a)">
            <i class="bi bi-chat-dots"></i>
          </button>
        </div>
        <div v-if="total > 10" class="p-2">
          <Pagination :total="total" v-model:page="page" :page-size="10" @change="load" />
        </div>
      </div>
    </aside>

    <!-- ========== 右侧：内容区（8/12，收起侧栏后占满 12/12） ========== -->
    <section :class="sidebarCollapsed ? 'col-12' : 'col-9'" class="d-flex flex-column" style="min-width: 0">

      <!-- 空状态 -->
      <div v-if="mode === 'empty'" class="flex-grow-1 d-flex align-items-center justify-content-center">
        <div class="text-center text-secondary">
          <i class="bi bi-pc-display d-block mb-2" style="font-size: 3rem; opacity: .35"></i>
          <div>从左侧选择一台主机，查看详情或发起会话</div>
        </div>
      </div>

      <!-- 详情模式 -->
      <div v-else-if="mode === 'detail' && agent" class="flex-grow-1 overflow-auto p-3">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h5 class="mb-0 fw-bold">{{ agent.name }} <span class="text-secondary small fw-normal">{{ agent.agent_id }}</span></h5>
          <div class="d-flex gap-2">
            <button class="btn btn-sm btn-outline-primary" @click="openChat"><i class="bi bi-chat-dots me-1"></i>会话</button>
            <button class="btn btn-sm btn-outline-secondary" @click="openEdit"><i class="bi bi-pencil me-1"></i>编辑</button>
          </div>
        </div>

        <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>

        <!-- 会话管理 -->
        <div class="card mb-3">
          <div class="card-header py-2">
            <span class="fw-bold small"><i class="bi bi-chat-square-text me-1 text-primary"></i>会话管理</span>
            <span class="text-secondary small ms-2">远端 pi 在会话指定目录下运行（<code>~/projects/xxx</code>），点击会话名直接在右侧打开</span>
          </div>
          <div class="card-body py-2">
            <div v-if="convLoading" class="text-center text-secondary small py-3">加载中…</div>
            <div v-else-if="conversations.length === 0" class="text-center text-secondary small py-3">
              暂无会话。点「新建会话」创建（选择一个 ~/projects 目录作为起点）。
            </div>
            <table v-else class="table table-sm table-hover align-middle mb-0">
              <thead><tr><th>会话名</th><th>工作目录</th><th>运行用户</th><th>最后消息</th><th>更新时间</th><th class="text-end">操作</th></tr></thead>
              <tbody>
                <tr v-for="c in conversations" :key="c.conversation_id">
                  <td>
                    <a href="javascript:void(0)" class="fw-bold text-decoration-none" @click="openConvFromList(c)">
                      {{ c.name || '(未命名会话)' }}
                    </a>
                    <div class="text-secondary small">{{ c.conversation_id }}</div>
                  </td>
                  <td><code class="small">{{ c.workdir || '—（默认 ~/projects）' }}</code></td>
                  <td>{{ c.run_user || '当前用户' }}</td>
                  <td class="small text-truncate" style="max-width: 220px">{{ c.last_message || '—' }}</td>
                  <td class="small text-secondary">{{ fmtTime(c.updated_at) }}</td>
                  <td class="text-end text-nowrap">
                    <button class="btn btn-sm btn-outline-primary py-0" title="打开会话" @click="openConvFromList(c)"><i class="bi bi-chat-dots"></i></button>
                    <button class="btn btn-sm btn-outline-secondary py-0 ms-1" title="重命名" @click="renameConv(c)"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-sm btn-outline-secondary py-0 ms-1" title="运行用户" @click="setRunUser(c)"><i class="bi bi-person-gear"></i></button>
                    <button class="btn btn-sm btn-outline-danger py-0 ms-1" title="归档" @click="archiveConv(c)"><i class="bi bi-archive"></i></button>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-if="convTotal > 20" class="mt-2">
              <Pagination :total="convTotal" v-model:page="convPage" :page-size="20" @change="loadConversations" />
            </div>
          </div>
        </div>

        <div class="row">
          <div class="col-md-6">
            <div class="card mb-3">
              <div class="card-body">
                <table class="table table-sm mb-0">
                  <tbody>
                    <tr><th class="text-secondary" style="width:110px">主机标识</th><td>{{ agent.hostname }}</td></tr>
                    <tr><th class="text-secondary">描述</th><td>{{ agent.description }}</td></tr>
                    <tr><th class="text-secondary">角色标签</th>
                      <td>
                        <template v-if="(agent.tags_detail || []).length">
                          <TagBadge v-for="t in agent.tags_detail" :key="t.id" :tag="t" />
                        </template>
                        <span v-else class="text-secondary small">—</span>
                      </td>
                    </tr>
                    <tr><th class="text-secondary">接外单（公共池）</th>
                      <td>
                        <span class="badge" :class="agent.accept_external ? 'text-bg-warning' : 'text-bg-secondary'"
                              role="button" @click="toggleAccept"
                              :title="agent.accept_external ? '开启中：可认领公共池外单（点击关闭）' : '关闭（默认）：只做内部指派任务（点击开启）'">
                          {{ agent.accept_external ? '开' : '关' }}
                        </span>
                        <span class="text-secondary small ms-1">内外分离：接外单的主机应为隔离环境</span>
                      </td></tr>
                    <tr><th class="text-secondary">运行用户</th>
                      <td class="small">{{ agent.run_user || 'bridge 当前用户（未指定）' }}</td></tr>
                    <tr><th class="text-secondary">状态</th>
                      <td><span class="badge" :class="agent.status === 'active' ? 'text-bg-success' : 'text-bg-secondary'">{{ agent.status }}</span>
                        <span v-if="agent.offline" class="badge text-bg-danger ms-1" :title="`超过 ${offlineMin} 分钟无心跳（最近活跃：${agent.last_seen_at || '从未连接'}）`">失联</span>
                      </td></tr>
                    <tr><th class="text-secondary">最近活跃</th><td>{{ agent.last_seen_at || '从未连接' }}</td></tr>
                    <tr><th class="text-secondary">创建时间</th><td>{{ agent.created_at }}</td></tr>
                  </tbody>
                </table>
                <button class="btn btn-sm mt-3" :class="agent.status === 'active' ? 'btn-outline-danger' : 'btn-outline-success'" @click="toggle">
                  {{ agent.status === 'active' ? '禁用此 Agent' : '启用此 Agent' }}
                </button>
                <button class="btn btn-sm btn-outline-warning mt-3 ms-2" @click="resetKey">重置 API Key</button>
                <button class="btn btn-sm btn-outline-danger mt-3 ms-2" @click="removeAgent">删除此 Agent</button>
              </div>
            </div>
          </div>
          <div class="col-md-6">
            <h6>默认提示词</h6>
            <div class="card"><div class="card-body">
              <pre v-if="agent.system_prompt" class="mb-0">{{ agent.system_prompt }}</pre>
              <span v-else class="text-secondary">未设置默认提示词。</span>
            </div></div>
          </div>
        </div>

        <h6 class="mt-3">指派给该 Agent 的任务</h6>
        <div v-if="tasks.length === 0" class="card"><div class="card-body text-secondary">暂无任务。</div></div>
        <table v-else class="table table-hover">
          <thead><tr><th>任务</th><th>状态</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.task_id">
              <td><router-link :to="`/tasks/${t.task_id}`">{{ t.title }}</router-link>
                <div class="text-secondary small">{{ t.task_id }}</div></td>
              <td><span class="badge badge-status" :class="badge(t.status)">{{ t.status }}</span></td>
              <td>{{ t.result_status || '—' }}</td>
            </tr>
          </tbody>
        </table>
        <div class="mt-2">
          <Pagination :total="taskTotal" v-model:page="taskPage" :page-size="10" @change="loadTasks" />
        </div>
      </div>

      <!-- 会话模式：tab 条 + 对话面板 -->
      <div v-else-if="mode === 'chat'" class="flex-grow-1 d-flex flex-column" style="min-height: 0">
        <div class="d-flex align-items-center gap-1 border-bottom px-2 pt-1 chat-tabs">
          <button class="btn btn-sm btn-outline-secondary flex-shrink-0" title="返回主机详情" @click="backToDetail">
            <i class="bi bi-arrow-left"></i>
          </button>
          <div v-for="t in tabs" :key="t.id" class="chat-tab d-flex align-items-center gap-1 px-2 py-1 rounded small border"
               :class="{ 'chat-tab-active': activeTab === t.id }" @click="activeTab = t.id">
            <i class="bi bi-chat-dots"></i>
            <span class="text-truncate" style="max-width: 160px">{{ t.title }}</span>
            <i v-if="t.id !== HOST_TAB" class="bi bi-x-lg chat-tab-close" role="button" @click.stop="closeTab(t.id)"></i>
          </div>
          <button class="btn btn-sm btn-primary flex-shrink-0 ms-auto" title="新建对话" @click="openCreate"><i class="bi bi-plus-lg me-1"></i>新建对话</button>
        </div>
        <div v-if="!activeTab" class="flex-grow-1 d-flex align-items-center justify-content-center text-secondary small">
          没有打开的会话，从左侧会话列表或「新建会话」开始。
        </div>
        <ChatPanel v-else :key="activeTab" class="flex-grow-1"
          :target="{ agent_id: selectedAgent.id, agent_name: selectedAgent.name }"
          :conversation-id="activeTab === HOST_TAB ? '' : activeTab"
          fullscreen @close="backToDetail" />
      </div>
    </section>
    </div>

    <!-- 新建会话弹窗 -->
    <div v-if="showCreate" class="modal show d-block" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header py-2">
            <h6 class="modal-title">新建会话 — {{ selectedAgent?.name }}</h6>
            <button type="button" class="btn-close" @click="showCreate = false"></button>
          </div>
          <div class="modal-body">
            <div class="mb-2">
              <label class="form-label small mb-1">会话名（可选）</label>
              <input v-model="createName" class="form-control form-control-sm" placeholder="如：pi-market 开发 / 数据库维护…">
            </div>
            <div class="mb-2">
              <label class="form-label small mb-1">工作目录（只填 ~/projects/ 下的子目录名，如 mini-mes 或 mis/crm；留空=~/projects 根目录，不存在自动创建）</label>
              <div class="input-group input-group-sm">
                <span class="input-group-text" title="工作目录限定在主机 ~/projects 下">~/projects/</span>
                <input v-model="createWorkdir" class="form-control" placeholder="mini-mes"
                       @keydown.enter.exact.prevent="submitCreate">
              </div>
              <div class="text-secondary small mt-1">填目录须为主机真实存在的 ~/projects 子目录（平台严格校验）；<b>创建后固定，不可修改</b>。</div>
            </div>
            <div class="text-secondary small">运行 pi 的用户在主机上部署时指定（编辑主机可修改），会话自动继承。</div>
            <div v-if="createMsg" class="small text-danger">{{ createMsg }}</div>
          </div>
          <div class="modal-footer py-2">
            <button class="btn btn-sm btn-outline-secondary" @click="showCreate = false">取消</button>
            <button class="btn btn-sm btn-primary" :disabled="createBusy" @click="submitCreate">
              {{ createBusy ? '创建中…' : '创建并进入' }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <div v-if="showCreate" class="modal-backdrop show" @click="showCreate = false"></div>

    <!-- 编辑主机弹窗 -->
    <div v-if="showEdit" class="modal show d-block" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header py-2">
            <h6 class="modal-title">编辑主机 — {{ selectedAgent?.name }}</h6>
            <button type="button" class="btn-close" @click="showEdit = false"></button>
          </div>
          <div class="modal-body">
            <label class="form-label small mb-1">名称 *</label>
            <input v-model="editForm.name" class="form-control form-control-sm mb-2" placeholder="如 web-01 / db-agent">
            <label class="form-label small mb-1">主机标识（在哪）</label>
            <input v-model="editForm.hostname" class="form-control form-control-sm mb-2" placeholder="hostname / IP">
            <label class="form-label small mb-1">描述</label>
            <input v-model="editForm.description" class="form-control form-control-sm mb-2" placeholder="这台机器负责什么">
            <div class="form-check form-switch mb-2">
              <input v-model="editForm.accept_external" type="checkbox" class="form-check-input" id="editAcceptExternal">
              <label class="form-check-label small" for="editAcceptExternal">允许接外单（认领公共池公开任务）</label>
            </div>
            <label class="form-label small mb-1">运行 pi 的用户（部署时指定；空=bridge 当前用户；非当前用户需远端 sudoers 白名单）</label>
            <input v-model="editForm.run_user" class="form-control form-control-sm mb-2" placeholder="如 pi-agent">
            <label class="form-label small mb-1">默认提示词（agent 启动时加载；清空=自动生成）</label>
            <textarea v-model="editForm.system_prompt" class="form-control form-control-sm" rows="5"
              placeholder="你是 web-01 的运维 agent，负责..."></textarea>
            <div v-if="editMsg" class="small text-danger mt-2">{{ editMsg }}</div>
          </div>
          <div class="modal-footer py-2">
            <button class="btn btn-sm btn-outline-secondary" @click="showEdit = false">取消</button>
            <button class="btn btn-sm btn-primary" :disabled="editBusy" @click="submitEdit">
              {{ editBusy ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <div v-if="showEdit" class="modal-backdrop show" @click="showEdit = false"></div>

    <!-- 注册主机弹窗 -->
    <div ref="registerModalEl" class="modal fade" tabindex="-1">
      <div class="modal-dialog modal-lg">
        <div class="modal-content">
          <div class="modal-header"><h5 class="modal-title">注册新 Agent</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
          <form @submit.prevent="submitRegister">
            <div class="modal-body">
              <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
              <label class="form-label">名称 *</label>
              <input v-model="form.name" class="form-control mb-2" required placeholder="如 web-01 / db-agent">
              <label class="form-label">主机标识（在哪）</label>
              <input v-model="form.hostname" class="form-control mb-2" placeholder="hostname / IP，如 10.0.0.5">
              <label class="form-label">描述</label>
              <input v-model="form.description" class="form-control mb-2" placeholder="这台机器负责什么">
              <label class="form-label">角色标签</label>
              <div class="border rounded p-2 mb-2">
                <TagPicker v-model="form.tags" :groups="tagGroups" entity-scope="host" />
              </div>
              <div class="form-check form-switch mb-2">
                <input v-model="form.accept_external" type="checkbox" class="form-check-input" id="acceptExternal">
                <label class="form-check-label" for="acceptExternal">允许接外单（认领公共池公开任务）</label>
                <div class="text-secondary small">默认关闭（safer default）。开启后本主机可自主浏览公共池并认领公开任务；
                  按内外分离原则，接外单的主机应为隔离环境（不持有内部数据与凭据）。</div>
              </div>
              <label class="form-label">运行 pi 的用户（部署时指定；空=bridge 当前用户；非当前用户需远端 sudoers 白名单）</label>
              <input v-model="form.run_user" class="form-control mb-2" placeholder="如 pi-agent">
              <label class="form-label">默认提示词（agent 启动时加载，告知身份与职责）</label>
              <textarea v-model="form.system_prompt" class="form-control" rows="4"
                placeholder="你是 web-01 的运维 agent，负责..."></textarea>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
              <button type="submit" class="btn btn-primary">注册并生成 Key</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hosts-workspace {
  border: 1px solid var(--border-soft, rgba(0, 0, 0, 0.1));
  border-radius: 0.5rem;
  overflow: hidden;
}
.host-item {
  cursor: pointer;
  transition: background-color 0.1s;
}
.host-item:hover {
  background-color: var(--bs-tertiary-bg, rgba(0, 0, 0, 0.03));
}
.host-item.host-active {
  background-color: var(--bs-primary-bg-subtle, rgba(13, 110, 253, 0.08));
  box-shadow: inset 3px 0 0 var(--bs-primary);
}
.chat-tab {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  background: var(--bs-tertiary-bg, rgba(0, 0, 0, 0.03));
}
.chat-tab-active {
  background: var(--bs-primary-bg-subtle, rgba(13, 110, 253, 0.1));
  border-color: var(--bs-primary) !important;
  color: var(--bs-primary);
}
.chat-tab-close:hover {
  color: var(--bs-danger);
}
</style>
