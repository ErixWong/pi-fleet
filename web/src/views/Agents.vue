<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { Modal } from 'bootstrap';
import { api } from '../api';

const agents = ref([]);
const error = ref('');
const newKey = ref(null); // 注册成功后的 key（仅内存，刷新即失 = 只展示一次）
const form = ref({ name: '', hostname: '', description: '', system_prompt: '', tags: '' });

let modal = null;
const modalEl = ref(null);

onMounted(async () => {
  const data = await api.agents();
  agents.value = data.agents;
});

function open() {
  error.value = '';
  modal = new Modal(modalEl.value);
  modal.show();
}

async function submit() {
  error.value = '';
  try {
    const data = await api.createAgent(form.value);
    modal.hide();
    form.value = { name: '', hostname: '', description: '', system_prompt: '', tags: '' };
    newKey.value = { name: data.agent.name, key: data.key };
    window.scrollTo(0, 0);
    const refreshed = await api.agents();
    agents.value = refreshed.agents;
  } catch (e) {
    error.value = e.message;
  }
}

async function toggle(a) {
  await api.toggleAgent(a.id);
  const data = await api.agents();
  agents.value = data.agents;
}

onBeforeUnmount(() => modal?.dispose());
</script>

<template>
  <div class="d-flex justify-content-between align-items-center mb-3">
    <h4 class="mb-0">Agent 管理</h4>
    <button class="btn btn-primary" @click="open">+ 注册 Agent</button>
  </div>

  <div v-if="newKey" class="alert alert-warning">
    <div class="fw-bold mb-1">⚠️ API Key 已生成（只显示这一次，请立即保存）— {{ newKey.name }}</div>
    <div class="key-box">{{ newKey.key }}</div>
    <div class="small mt-2 text-secondary">此 key 用于 MCP 登录（pi-mcp-adapter 的 <code>PI_AGENT_KEY</code>），数据库只存哈希。</div>
    <button class="btn btn-sm btn-outline-secondary mt-2" @click="newKey = null">我已保存</button>
  </div>

  <div v-if="agents.length === 0" class="card"><div class="card-body text-secondary">还没有 agent，先注册一个。</div></div>
  <table v-else class="table table-hover">
    <thead><tr><th>Agent</th><th>主机</th><th>标签</th><th>状态</th><th>最近活跃</th><th></th></tr></thead>
    <tbody>
      <tr v-for="a in agents" :key="a.id">
        <td>
          <router-link :to="`/agents/${a.id}`">{{ a.name }}</router-link>
          <div class="text-secondary small">{{ a.agent_id }}</div>
        </td>
        <td>{{ a.hostname }}</td>
        <td>{{ a.tags }}</td>
        <td><span class="badge" :class="a.status === 'active' ? 'text-bg-success' : 'text-bg-secondary'">{{ a.status }}</span></td>
        <td class="text-secondary small">{{ a.last_seen_at || '—' }}</td>
        <td>
          <button class="btn btn-sm btn-outline-secondary" @click="toggle(a)">
            {{ a.status === 'active' ? '禁用' : '启用' }}
          </button>
        </td>
      </tr>
    </tbody>
  </table>

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
            <label class="form-label">角色标签（逗号分隔）</label>
            <input v-model="form.tags" class="form-control mb-2" placeholder="web, prod">
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
</template>
