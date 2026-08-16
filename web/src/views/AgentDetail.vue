<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import Pagination from '../components/Pagination.vue';
import TagBadge from '../components/TagBadge.vue';

const route = useRoute();
const router = useRouter();
const agent = ref(null);
const tasks = ref([]);
const conversations = ref([]);
const convTotal = ref(0);
const convPage = ref(1);
const convLoading = ref(false);
const newKey = ref(null); // 重置后的新 key（一次性展示）
const error = ref('');
const page = ref(1);
const total = ref(0);
const offlineMin = ref(30);

// 新建会话弹窗
const showCreate = ref(false);
const createName = ref('');
const createWorkdir = ref('');
const createRunUser = ref('');
const createMsg = ref('');
const createBusy = ref(false);

async function loadTasks() {
  const data = await api.agent(route.params.id, { page: page.value, page_size: 10 });
  agent.value = data.agent;
  tasks.value = data.tasks;
  total.value = data.total ?? 0;
  offlineMin.value = data.offline_after_min ?? 30;
}

async function loadConversations() {
  convLoading.value = true;
  try {
    const data = await api.agentConversations(route.params.id, convPage.value, 20);
    conversations.value = data.conversations ?? [];
    convTotal.value = data.total ?? 0;
  } finally {
    convLoading.value = false;
  }
}

onMounted(() => {
  loadTasks();
  loadConversations();
});

/** 跳转全屏专门对话页（默认主机对话） */
function openChat() {
  router.push(`/chat/${agent.value.id}`);
}

/** 打开指定会话 */
function openConv(convId) {
  router.push(`/chat/${agent.value.id}/${convId}`);
}

function openCreate() {
  createName.value = '';
  createWorkdir.value = '';
  createRunUser.value = '';
  createMsg.value = '';
  showCreate.value = true;
}

/** 禁用/启用（既有按钮，重构时函数丢失一并补回） */
async function toggle() {
  try {
    await api.toggleAgent(agent.value.id);
    await loadTasks();
    await loadConversations();
  } catch (e) {
    alert(e.message);
  }
}

/** 重置 API key（既有按钮补回：新 key 一次性展示） */
async function resetKey() {
  if (!confirm('重置 API Key？旧 key 立即失效，新 key 只显示一次。')) return;
  try {
    const data = await api.resetAgentKey(agent.value.id);
    newKey.value = data.key;
    alert(`新 API Key（只显示一次）：\n\n${data.key}`);
  } catch (e) {
    alert(e.message);
  }
}

/** 接单开关（既有按钮补回） */
async function toggleAccept() {
  try {
    await api.toggleAgentAccept(agent.value.id);
    await loadTasks();
  } catch (e) {
    alert(e.message);
  }
}

/** 删除 agent：无关联物理删除；有关联软删除（visible=0 + disabled，不再显示，历史保留） */
async function removeAgent() {
  if (!confirm(`确定删除主机「${agent.value.name}」？\n\n无关联数据将直接删除；有任务/会话等历史数据则软删除（不再显示、不再接活，历史保留）。`)) return;
  try {
    const data = await api.deleteAgent(agent.value.id);
    if (data.mode === 'soft') {
      alert(`已软删除（有 ${Object.values(data.refs ?? {}).reduce((a, b) => a + b, 0)} 条关联数据）：不再显示、不再接活，历史记录保留。`);
    } else {
      alert('已删除（无关联数据，物理删除）。');
    }
    router.push('/agents');
  } catch (e) {
    alert(e.message);
  }
}

async function submitCreate() {
  createBusy.value = true;
  createMsg.value = '';
  try {
    const payload = { agent_id: Number(route.params.id) };
    if (createName.value.trim()) payload.name = createName.value.trim();
    // 输入框只填子目录名（~/projects/ 前缀在 UI 上固定展示）；提交时拼全路径
    const rel = createWorkdir.value.trim().replace(/^~[\/]projects[\/]/, '').replace(/^[\/]+/, '');
    if (rel) payload.workdir = `~/projects/${rel}`;
    if (createRunUser.value.trim()) payload.run_user = createRunUser.value.trim();
    const data = await api.createConversation(payload);
    showCreate.value = false;
    await loadConversations();
    router.push(`/chat/${route.params.id}/${data.conversation.conversation_id}`);
  } catch (e) {
    createMsg.value = e.message;
  } finally {
    createBusy.value = false;
  }
}

async function renameConv(conv) {
  const name = prompt('会话名：', conv.name || '');
  if (name === null) return;
  try {
    await api.renameConversation(conv.conversation_id, name.trim() || conv.name || '会话');
    await loadConversations();
  } catch (e) {
    alert(e.message);
  }
}

async function setRunUser(conv) {
  const name = prompt('运行 pi 的用户（空=bridge 当前用户；非当前用户需远端 sudoers 白名单）：', conv.run_user || '');
  if (name === null) return;
  try {
    await api.setConversationRunUser(conv.conversation_id, name.trim() || null);
    await loadConversations();
  } catch (e) {
    alert(e.message);
  }
}

async function archiveConv(conv) {
  if (!confirm(`归档会话「${conv.name || conv.conversation_id}」？（归档后从列表隐藏，历史保留）`)) return;
  try {
    await api.archiveConversation(conv.conversation_id);
    await loadConversations();
  } catch (e) {
    alert(e.message);
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
  <div class="d-flex justify-content-between align-items-center mb-3">
    <router-link to="/agents" class="btn btn-sm btn-outline-secondary">← Agent 列表</router-link>
    <div class="d-flex gap-2">
      <button v-if="agent" class="btn btn-sm btn-outline-primary" @click="openChat">
        <i class="bi bi-chat-dots me-1"></i>对话
      </button>
      <button v-if="agent" class="btn btn-sm btn-primary" @click="openCreate">
        <i class="bi bi-plus-lg me-1"></i>新建会话
      </button>
    </div>
  </div>
  <div v-if="agent">
    <h4 class="mb-3">{{ agent.name }} <span class="text-secondary small">{{ agent.agent_id }}</span></h4>

    <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
    <div v-if="newKey" class="alert alert-warning">
      <div class="fw-bold mb-1">⚠️ 新 API Key（旧 key 已失效，只显示这一次）</div>
      <div class="key-box">{{ newKey }}</div>
      <div class="small mt-2 text-secondary">请更新到 agent 机器的 <code>/etc/pi-agent/env</code>（PI_AGENT_KEY）。</div>
      <button class="btn btn-sm btn-outline-secondary mt-2" @click="newKey = null">我已保存</button>
    </div>

    <!-- 会话管理（多会话：每个会话绑定 ~/projects 下的工作目录，远端 pi 按目录续接） -->
    <div class="card mb-3">
      <div class="card-header d-flex justify-content-between align-items-center">
        <span class="fw-bold small"><i class="bi bi-chat-square-text me-1 text-primary"></i>会话管理</span>
        <span class="text-secondary small">远端 pi 在会话指定目录下运行（<code>~/projects/xxx</code>），再次进入先进入目录再 <code>pi -r</code> 续接</span>
      </div>
      <div class="card-body py-2">
        <div v-if="convLoading" class="text-center text-secondary small py-3">加载中…</div>
        <div v-else-if="conversations.length === 0" class="text-center text-secondary small py-3">
          暂无会话。点击右上角「新建会话」创建（选择一个 ~/projects 目录作为起点）。
        </div>
        <table v-else class="table table-sm table-hover align-middle mb-0">
          <thead><tr><th>会话名</th><th>工作目录</th><th>运行用户</th><th>最后消息</th><th>更新时间</th><th class="text-end">操作</th></tr></thead>
          <tbody>
            <tr v-for="c in conversations" :key="c.conversation_id">
              <td>
                <a href="javascript:void(0)" class="fw-bold text-decoration-none" @click="openConv(c.conversation_id)">
                  {{ c.name || '(未命名会话)' }}
                </a>
                <div class="text-secondary small">{{ c.conversation_id }}</div>
              </td>
              <td><code class="small">{{ c.workdir || '—（默认目录）' }}</code></td>
              <td>{{ c.run_user || '当前用户' }}</td>
              <td class="small text-truncate" style="max-width: 240px">{{ c.last_message || '—' }}</td>
              <td class="small text-secondary">{{ fmtTime(c.updated_at) }}</td>
              <td class="text-end text-nowrap">
                <button class="btn btn-sm btn-outline-primary py-0" title="打开会话" @click="openConv(c.conversation_id)"><i class="bi bi-chat-dots"></i></button>
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
    <Pagination :total="total" v-model:page="page" :page-size="10" @change="loadTasks" />
  </div>

  <!-- 新建会话弹窗 -->
  <div v-if="showCreate" class="modal show d-block" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header py-2">
          <h6 class="modal-title">新建会话</h6>
          <button type="button" class="btn-close" @click="showCreate = false"></button>
        </div>
        <div class="modal-body">
          <div class="mb-2">
            <label class="form-label small mb-1">会话名（可选）</label>
            <input v-model="createName" class="form-control form-control-sm" placeholder="如：pi-market 开发 / 数据库维护…">
          </div>
          <div class="mb-2">
            <label class="form-label small mb-1">工作目录（可选；只填 ~/projects/ 下的子目录名，如 mini-mes 或 mis/crm；不填=默认目录）</label>
            <div class="input-group input-group-sm">
              <span class="input-group-text" title="工作目录限定在主机 ~/projects 下">~/projects/</span>
              <input v-model="createWorkdir" class="form-control" placeholder="mini-mes"
                     @keydown.enter.exact.prevent="submitCreate">
            </div>
            <div class="text-secondary small mt-1">目录须为主机真实存在的 ~/projects 子目录（平台严格校验）；不确定有哪些目录可以直接问 agent。</div>
          </div>
          <div class="mb-2">
            <label class="form-label small mb-1">运行 pi 的用户（可选；空=主机 bridge 当前用户）</label>
            <input v-model="createRunUser" class="form-control form-control-sm" placeholder="如 pi-agent（非当前用户需远端 sudoers 白名单）">
          </div>
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
  </div>
</template>
