<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api';

const stats = ref(null);

onMounted(async () => {
  stats.value = await api.stats();
});

function taskBadge(status) {
  return {
    done: 'success',
    failed: 'danger',
    running: 'info',
    assigned: 'warning',
    pending: 'warning',
    cancelled: 'secondary',
  }[status] || 'secondary';
}
</script>

<template>
  <div v-if="stats">
    <h4 class="mb-3">仪表盘</h4>
    <div class="row g-3 mb-4">
      <div class="col"><div class="card"><div class="card-body">
        <div class="fs-3 fw-bold">{{ stats.agents.active ?? 0 }}</div>
        <div class="text-secondary small">启用 Agent</div>
      </div></div></div>
      <div class="col"><div class="card"><div class="card-body">
        <div class="fs-3 fw-bold">{{ (stats.agents.active ?? 0) + (stats.agents.disabled ?? 0) }}</div>
        <div class="text-secondary small">Agent 总数</div>
      </div></div></div>
      <div class="col"><div class="card"><div class="card-body">
        <div class="fs-3 fw-bold">{{ (stats.tasks.pending ?? 0) + (stats.tasks.assigned ?? 0) + (stats.tasks.running ?? 0) }}</div>
        <div class="text-secondary small">进行中任务</div>
      </div></div></div>
      <div class="col"><div class="card"><div class="card-body">
        <div class="fs-3 fw-bold">{{ stats.tasks.done ?? 0 }}</div>
        <div class="text-secondary small">已完成</div>
      </div></div></div>
      <div class="col"><div class="card"><div class="card-body">
        <div class="fs-3 fw-bold text-danger">{{ stats.tasks.failed ?? 0 }}</div>
        <div class="text-secondary small">失败</div>
      </div></div></div>
    </div>

    <h5 class="mb-2">最近报告</h5>
    <div v-if="stats.recentReports.length === 0" class="card"><div class="card-body text-secondary">
      暂无报告。定时任务执行后，agent 会把报告投递到这里。
    </div></div>
    <table v-else class="table table-hover card-table">
      <thead><tr><th>主题</th><th>Agent</th><th>时间</th><th>内容</th></tr></thead>
      <tbody>
        <tr v-for="r in stats.recentReports" :key="r.created_at">
          <td><router-link :to="`/topics/${r.topic}`">{{ r.topic }}</router-link></td>
          <td>{{ r.agent_id }}</td>
          <td class="text-secondary small">{{ r.created_at }}</td>
          <td style="max-width:420px"><span class="d-inline-block text-truncate" style="max-width:400px">{{ r.content }}</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
