<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { Modal } from 'bootstrap';
import { api } from '../api';
import Pagination from '../components/Pagination.vue';
import TagBadge from '../components/TagBadge.vue';
import TagPicker from '../components/TagPicker.vue';

const agents = ref([]);
const error = ref('');
const page = ref(1);
const total = ref(0);
const offlineMin = ref(30);
const newKey = ref(null); // 注册成功后的 key（仅内存，刷新即失 = 只展示一次）
const tagGroups = ref([]); // 标签目录（分组）
const tagFilter = ref(''); // 按标签过滤（name）
const form = ref({ name: '', hostname: '', description: '', system_prompt: '', tags: [], accept_external: false });

let modal = null;
const modalEl = ref(null);
// 行内标签编辑 modal
const editModalEl = ref(null);
let editModal = null;
const editAgent = ref(null);
const editTags = ref([]);

async function load() {
  const data = await api.agents(page.value, 10, tagFilter.value);
  agents.value = data.agents;
  total.value = data.total ?? 0;
  offlineMin.value = data.offline_after_min ?? 30;
}

async function loadTags() {
  try { tagGroups.value = (await api.tags()).groups || []; } catch { /* 静默 */ }
}

onMounted(() => { load(); loadTags(); });

function open() {
  error.value = '';
  form.value = { name: '', hostname: '', description: '', system_prompt: '', tags: [], accept_external: false };
  modal = new Modal(modalEl.value);
  modal.show();
}

async function submit() {
  error.value = '';
  try {
    const data = await api.createAgent({ ...form.value, tags: form.value.tags.join(', ') });
    modal.hide();
    form.value = { name: '', hostname: '', description: '', system_prompt: '', tags: [], accept_external: false };
    newKey.value = { name: data.agent.name, key: data.key };
    window.scrollTo(0, 0);
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function toggle(a) {
  await api.toggleAgent(a.id);
  await load();
}

async function toggleAccept(a) {
  await api.toggleAgentAccept(a.id);
  await load();
}

/** 行内编辑标签 */
function openEditTags(a) {
  error.value = '';
  editAgent.value = a;
  editTags.value = (a.tags_detail || []).map((t) => t.name);
  editModal = new Modal(editModalEl.value);
  editModal.show();
}
async function saveEditTags() {
  if (!editAgent.value) return;
  try {
    await api.setAgentTags(editAgent.value.id, editTags.value);
    editModal?.hide();
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

/** 点击徽标 → 按该标签过滤 */
function filterBy(tag) {
  tagFilter.value = tagFilter.value === tag.name ? '' : tag.name;
  page.value = 1;
  load();
}

onBeforeUnmount(() => { modal?.dispose(); editModal?.dispose(); });
</script>

<template>
  <div class="d-flex justify-content-between align-items-center mb-3">
    <div>
      <h4 class="mb-0 fw-bold">主机管理</h4>
      <div class="text-secondary small">各台设备接入与状态</div>
    </div>
    <button class="btn btn-primary" @click="open"><i class="bi bi-plus-lg me-1"></i>注册主机</button>
  </div>

  <div v-if="newKey" class="alert alert-warning">
    <div class="fw-bold mb-1"><i class="bi bi-key-fill me-1"></i>API Key 已生成（只显示这一次，请立即保存）— {{ newKey.name }}</div>
    <div class="key-box">{{ newKey.key }}</div>
    <div class="small mt-2 text-secondary">此 key 用于该主机接入平台（pi-mcp-adapter 的 <code>PI_AGENT_KEY</code>），数据库只存哈希。</div>
    <button class="btn btn-sm btn-outline-secondary mt-2" @click="newKey = null"><i class="bi bi-check2 me-1"></i>我已保存</button>
  </div>

  <!-- 标签过滤 -->
  <div class="d-flex align-items-center gap-2 mb-2">
    <span class="text-secondary small">按标签过滤：</span>
    <select v-model="tagFilter" class="form-select form-select-sm" style="max-width: 200px" @change="page = 1; load()">
      <option value="">全部</option>
      <optgroup v-for="g in tagGroups" :key="g.category" :label="g.title">
        <option v-for="t in g.tags" :key="t.id" :value="t.name">{{ t.label }}</option>
      </optgroup>
    </select>
    <span v-if="tagFilter" class="badge text-bg-primary">{{ tagFilter }} <i class="bi bi-x" role="button" @click="tagFilter = ''; page = 1; load()"></i></span>
  </div>

  <div v-if="agents.length === 0" class="card"><div class="card-body empty-state">
    <i class="bi bi-pc-display"></i>还没有主机，先注册一个。
  </div></div>
  <table v-else class="table table-hover">
    <thead><tr><th>Agent</th><th>主机</th><th>标签</th><th>接外单</th><th>状态</th><th>最近活跃</th><th></th></tr></thead>
    <tbody>
      <tr v-for="a in agents" :key="a.id">
        <td>
          <router-link :to="`/agents/${a.id}`">{{ a.name }}</router-link>
          <div class="text-secondary small">{{ a.agent_id }}</div>
        </td>
        <td>{{ a.hostname }}</td>
        <td style="max-width: 320px">
          <template v-if="(a.tags_detail || []).length">
            <TagBadge v-for="t in a.tags_detail" :key="t.id" :tag="t" />
          </template>
          <span v-else class="text-secondary small">—</span>
          <button class="btn btn-sm btn-outline-secondary border-0 py-0" title="编辑标签" @click="openEditTags(a)"><i class="bi bi-pencil"></i></button>
        </td>
        <td>
          <span class="badge" :class="a.accept_external ? 'text-bg-warning' : 'text-bg-secondary'" role="button"
                :title="a.accept_external ? '开启中：可认领公共池外单' : '关闭（默认）：只做内部指派任务'" @click="toggleAccept(a)">
            {{ a.accept_external ? '开' : '关' }}
          </span>
        </td>
        <td><span class="badge" :class="a.status === 'active' ? 'text-bg-success' : 'text-bg-secondary'">{{ a.status }}</span>
          <span v-if="a.offline" class="badge text-bg-danger ms-1" :title="`超过 ${offlineMin} 分钟无心跳（最近活跃：${a.last_seen_at || '从未连接'}）`">失联</span>
        </td>
        <td class="text-secondary small">{{ a.last_seen_at || '—' }}</td>
        <td>
          <button class="btn btn-sm btn-outline-secondary" @click="toggle(a)">
            {{ a.status === 'active' ? '禁用' : '启用' }}
          </button>
        </td>
      </tr>
    </tbody>
  </table>

  <div class="mt-2">
    <Pagination :total="total" v-model:page="page" :page-size="10" @change="load" />
  </div>

  <!-- 注册 modal -->
  <div ref="modalEl" class="modal fade" tabindex="-1">
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header"><h5 class="modal-title">注册新 Agent</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <form @submit.prevent="submit">
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

  <!-- 行内标签编辑 modal -->
  <div ref="editModalEl" class="modal fade" tabindex="-1">
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title"><i class="bi bi-tags me-1"></i>编辑标签 — {{ editAgent?.name }}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
          <TagPicker v-model="editTags" :groups="tagGroups" entity-scope="host" />
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
          <button type="button" class="btn btn-primary" @click="saveEditTags">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
