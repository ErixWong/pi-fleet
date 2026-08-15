<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import Pagination from '../components/Pagination.vue';

const route = useRoute();
const router = useRouter();
const agent = ref(null);
const tasks = ref([]);
const newKey = ref(null); // 重置后的新 key（一次性展示）
const error = ref('');
const page = ref(1);
const total = ref(0);
const offlineMin = ref(30);

async function loadTasks() {
  const data = await api.agent(route.params.id, { page: page.value, page_size: 10 });
  agent.value = data.agent;
  tasks.value = data.tasks;
  total.value = data.total ?? 0;
  offlineMin.value = data.offline_after_min ?? 30;
}

onMounted(loadTasks);

/** 跳转全屏专门对话页 */
function openChat() {
  router.push(`/chat/${agent.value.id}`);
}

async function toggle() {
  await api.toggleAgent(agent.value.id);
  await loadTasks();
}

async function resetKey() {
  if (!confirm('确定重置 API Key？旧 key 将立即失效，需要更新到 agent 机器上。')) return;
  error.value = '';
  try {
    const data = await api.resetAgentKey(agent.value.id);
    newKey.value = data.key;
    window.scrollTo(0, 0);
  } catch (e) {
    error.value = e.message;
  }
}

async function toggleAccept() {
  await api.toggleAgentAccept(agent.value.id);
  const data = await api.agent(agent.value.id);
  agent.value = data.agent;
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
    <button v-if="agent" class="btn btn-sm btn-primary" @click="openChat">
      <i class="bi bi-chat-dots me-1"></i>对话
    </button>
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

    <div class="row">
      <div class="col-md-6">
        <div class="card mb-3">
          <div class="card-body">
            <table class="table table-sm mb-0">
              <tbody>
                <tr><th class="text-secondary" style="width:110px">主机标识</th><td>{{ agent.hostname }}</td></tr>
                <tr><th class="text-secondary">描述</th><td>{{ agent.description }}</td></tr>
                <tr><th class="text-secondary">角色标签</th><td>{{ agent.tags }}</td></tr>
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
                    <span v-if="agent.offline" class="badge text-bg-danger ms-1" title="超过 {{ offlineMin }} 分钟无心跳（最近活跃：{{ agent.last_seen_at || '从未连接' }}）">失联</span>
                  </td></tr>
                <tr><th class="text-secondary">最近活跃</th><td>{{ agent.last_seen_at || '从未连接' }}</td></tr>
                <tr><th class="text-secondary">创建时间</th><td>{{ agent.created_at }}</td></tr>
              </tbody>
            </table>
            <button class="btn btn-sm mt-3" :class="agent.status === 'active' ? 'btn-outline-danger' : 'btn-outline-success'" @click="toggle">
              {{ agent.status === 'active' ? '禁用此 Agent' : '启用此 Agent' }}
            </button>
            <button class="btn btn-sm btn-outline-warning mt-3 ms-2" @click="resetKey">重置 API Key</button>
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
      <thead><tr><th>任务</th><th>类型</th><th>状态</th><th>下次执行</th><th>结果</th></tr></thead>
      <tbody>
        <tr v-for="t in tasks" :key="t.task_id">
          <td><router-link :to="`/tasks/${t.task_id}`">{{ t.title }}</router-link>
            <div class="text-secondary small">{{ t.task_id }}</div></td>
          <td><span class="badge" :class="t.kind === 'scheduled' ? 'text-bg-info' : 'text-bg-secondary'">{{ t.kind }}</span></td>
          <td><span class="badge badge-status" :class="badge(t.status)">{{ t.status }}</span></td>
          <td class="text-secondary small">{{ t.next_due_at || '—' }}</td>
          <td>{{ t.result_status || '—' }}</td>
        </tr>
      </tbody>
    </table>

  <div class="mt-2">
    <Pagination :total="total" v-model:page="page" :page-size="10" @change="loadTasks" />
  </div>
  </div>
</template>
