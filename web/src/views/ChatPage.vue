<script setup>
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import ChatPanel from '../components/ChatPanel.vue';

/** 全屏专门对话页：与指定主机 agent 直接对话（不绑定任务），可设置工作目录让远程 pi 在具体路径下运行 */
const route = useRoute();
const agentId = route.params.agentId;
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
  <div>
    <div class="d-flex justify-content-between align-items-center mb-2">
      <router-link to="/agents" class="btn btn-sm btn-outline-secondary"><i class="bi bi-arrow-left me-1"></i>主机列表</router-link>
      <div v-if="agent" class="fw-bold small">
        <i class="bi bi-chat-dots me-1 text-primary"></i>{{ agent.name }}
        <span class="text-secondary fw-normal">#{{ agent.agent_id }} · 直接对话</span>
      </div>
      <span v-if="error" class="text-danger small">{{ error }}</span>
      <span></span>
    </div>
    <ChatPanel v-if="agent" :target="{ agent_id: agent.id, agent_name: agent.name }" fullscreen />
  </div>
</template>
