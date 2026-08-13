<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api';

const stats = ref(null);

onMounted(async () => {
  stats.value = await api.stats();
});

function taskBadge(status) {
  return {
    done: 'text-bg-success',
    failed: 'text-bg-danger',
    running: 'text-bg-info',
    assigned: 'text-bg-warning',
    pending: 'text-bg-warning',
    open: 'text-bg-info',
    resolved: 'text-bg-success',
    cancelled: 'text-bg-secondary',
  }[status] || 'text-bg-secondary';
}
</script>

<template>
  <div v-if="stats">
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div>
        <h4 class="mb-0 fw-bold">仪表盘</h4>
        <div class="text-secondary small">平台运行总览</div>
      </div>
      <router-link to="/tasks" class="btn btn-primary btn-sm"><i class="bi bi-plus-lg me-1"></i>新建任务</router-link>
    </div>

    <div class="row g-3 mb-4">
      <div class="col">
        <div class="card stat-card h-100">
          <div class="card-body d-flex align-items-center gap-3">
            <div class="icon" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)"><i class="bi bi-pc-display"></i></div>
            <div>
              <div class="num">{{ stats.agents.active ?? 0 }}</div>
              <div class="lbl">启用主机</div>
            </div>
          </div>
        </div>
      </div>
      <div class="col">
        <div class="card stat-card h-100">
          <div class="card-body d-flex align-items-center gap-3">
            <div class="icon" style="background:linear-gradient(135deg,#38bdf8,#22d3ee)"><i class="bi bi-lightning-charge-fill"></i></div>
            <div>
              <div class="num">{{ (stats.tasks.open ?? 0) + (stats.tasks.pending ?? 0) + (stats.tasks.running ?? 0) + (stats.tasks.assigned ?? 0) }}</div>
              <div class="lbl">进行中任务</div>
            </div>
          </div>
        </div>
      </div>
      <div class="col">
        <div class="card stat-card h-100">
          <div class="card-body d-flex align-items-center gap-3">
            <div class="icon" style="background:linear-gradient(135deg,#10b981,#34d399)"><i class="bi bi-check2-circle"></i></div>
            <div>
              <div class="num">{{ (stats.tasks.done ?? 0) + (stats.tasks.resolved ?? 0) }}</div>
              <div class="lbl">已完成</div>
            </div>
          </div>
        </div>
      </div>
      <div class="col">
        <div class="card stat-card h-100">
          <div class="card-body d-flex align-items-center gap-3">
            <div class="icon" style="background:linear-gradient(135deg,#f43f5e,#fb7185)"><i class="bi bi-x-circle"></i></div>
            <div>
              <div class="num">{{ stats.tasks.failed ?? 0 }}</div>
              <div class="lbl">失败</div>
            </div>
          </div>
        </div>
      </div>
      <div class="col">
        <div class="card stat-card h-100">
          <div class="card-body d-flex align-items-center gap-3">
            <div class="icon" style="background:linear-gradient(135deg,#f59e0b,#fbbf24)"><i class="bi bi-journal-text"></i></div>
            <div>
              <div class="num">{{ stats.recentReports.length }}</div>
              <div class="lbl">最近报告</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <h6 class="mb-2 fw-bold"><i class="bi bi-journal-richtext me-1"></i>最近报告</h6>
    <div v-if="stats.recentReports.length === 0" class="card"><div class="card-body empty-state">
      <i class="bi bi-inbox"></i>暂无报告。定时任务执行后，agent 会把报告归档到任务下。
    </div></div>
    <div class="row g-3">
      <div v-for="r in stats.recentReports" :key="r.created_at" class="col-lg-6 col-xl-4">
        <div class="card h-100">
          <div class="card-body">
            <div class="d-flex align-items-center justify-content-between mb-2">
              <router-link :to="`/tasks/${r.task_id}`" class="text-decoration-none fw-semibold"><i class="bi bi-list-check me-1"></i>{{ r.task_id }}</router-link>
              <span class="text-secondary small">{{ r.created_at }}</span>
            </div>
            <div class="d-flex align-items-center gap-2 mb-2">
              <span class="badge text-bg-primary"><i class="bi bi-cpu me-1"></i>{{ r.agent_id }}</span>
            </div>
            <div class="text-secondary small text-truncate" style="max-width:100%">{{ r.content }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
