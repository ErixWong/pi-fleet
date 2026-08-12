<script setup>
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';

const route = useRoute();
const topic = ref(null);
const reports = ref([]);

onMounted(async () => {
  const data = await api.topic(route.params.topic);
  topic.value = data.topic;
  reports.value = data.reports;
});
</script>

<template>
  <router-link to="/topics" class="btn btn-sm btn-outline-secondary mb-3">← 主题列表</router-link>
  <div v-if="topic">
    <h4 class="mb-3">主题：{{ topic.topic }}</h4>
    <div v-if="reports.length === 0" class="card"><div class="card-body text-secondary">该主题下暂无报告。</div></div>
    <div v-for="r in reports" :key="r.created_at" class="card mb-2">
      <div class="card-body">
        <div class="text-secondary small mb-1">
          <code>{{ r.agent_id }}</code>
          <template v-if="r.task_id"> · 任务 <router-link :to="`/tasks/${r.task_id}`">{{ r.task_id }}</router-link></template>
          · {{ r.created_at }}
        </div>
        <pre class="mb-0">{{ r.content }}</pre>
      </div>
    </div>
  </div>
</template>
