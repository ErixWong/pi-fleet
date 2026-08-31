<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import ChatPanel from '../components/ChatPanel.vue';

/** 全屏对话页：
 *  /chat/:agentId        → 主机对话（创建/复用该主机默认会话；可设置工作目录让远程 pi 在具体路径下运行）
 *  /chat/:agentId/:convId → 直接打开指定会话（会话管理跳转）
 */
const route = useRoute();
const router = useRouter();
const agentId = route.params.agentId;
const convId = route.params.convId ?? '';
const agent = ref(null);
const error = ref('');

onMounted(async () => {
  try {
    const data = await api.agents(1, 100);
    agent.value = (data.agents ?? []).find((a) => String(a.id) === String(agentId)) ?? null;
    if (!agent.value) error.value = '主机不存在或已禁用';
  } catch (e) {
    error.value = e.message;
  }
});
</script>

<template>
  <div class="chat-page">
    <div class="chat-page-heading">
      <router-link to="/hosts" class="btn btn-sm btn-outline-secondary"><i class="bi bi-arrow-left me-1"></i>主机工作台</router-link>
      <div v-if="agent" class="chat-page-title">
        <span class="chat-page-agent-mark"><i class="bi bi-chat-dots"></i></span>
        <span>
          <strong>{{ agent.name }}</strong>
          <small>#{{ agent.agent_id }} · {{ convId ? '独立会话' : '直接对话' }}</small>
        </span>
        <span class="chat-page-status" :class="{ offline: agent.offline || agent.status !== 'active' }">
          <i class="bi bi-circle-fill"></i>{{ agent.offline || agent.status !== 'active' ? '离线' : '在线' }}
        </span>
      </div>
      <span v-if="error" class="text-danger small">{{ error }}</span>
      <span></span>
    </div>
    <ChatPanel v-if="agent" :target="{ agent_id: agent.id, agent_name: agent.name }" :conversation-id="convId" fullscreen @close="router.push('/hosts')" />
  </div>
</template>

<style scoped>
.chat-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.chat-page :deep(.chat-panel-full) {
  height: auto;
  min-height: 0;
  flex: 1 1 auto;
}
.chat-page-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 42px;
  margin-bottom: 0.75rem;
}
.chat-page-title {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  color: var(--text-body);
}
.chat-page-title strong, .chat-page-title small { display: block; }
.chat-page-title strong { color: var(--text-strong); font-size: 0.85rem; }
.chat-page-title small { color: var(--text-muted); font-size: 0.68rem; }
.chat-page-agent-mark {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.55rem;
  color: var(--accent-text);
  background: var(--accent-soft);
}
.chat-page-status {
  margin-left: 0.4rem;
  color: var(--badge-success-color);
  font-size: 0.68rem;
}
.chat-page-status.offline { color: var(--badge-secondary-color); }
.chat-page-status i { margin-right: 0.25rem; font-size: 0.45rem; }
@media (max-width: 575.98px) {
  .chat-page-heading { align-items: flex-start; flex-wrap: wrap; }
  .chat-page-title { order: -1; width: 100%; }
}
</style>
