<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api';

const topics = ref([]);

onMounted(async () => {
  const data = await api.topics();
  topics.value = data.topics;
});
</script>

<template>
  <h4 class="mb-3">主题与报告</h4>
  <div v-if="topics.length === 0" class="card"><div class="card-body text-secondary">
    暂无主题。定时任务创建时会自动创建主题，agent 投递报告后会出现在这里。
  </div></div>
  <table v-else class="table table-hover">
    <thead><tr><th>主题</th><th>报告数</th><th>创建时间</th></tr></thead>
    <tbody>
      <tr v-for="t in topics" :key="t.id">
        <td><router-link :to="`/topics/${t.topic}`">{{ t.topic }}</router-link></td>
        <td>{{ t.report_count }}</td>
        <td class="text-secondary small">{{ t.created_at }}</td>
      </tr>
    </tbody>
  </table>
</template>
