<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';

const route = useRoute();
const router = useRouter();
const task = ref(null);
const reports = ref([]);
const error = ref('');

onMounted(async () => {
  const data = await api.task(route.params.taskId);
  task.value = data.task;
  reports.value = data.reports;
});

async function cancel() {
  if (!confirm('确定取消该任务？')) return;
  try {
    await api.cancelTask(task.value.task_id);
    const data = await api.task(task.value.task_id);
    task.value = data.task;
  } catch (e) {
    error.value = e.message;
  }
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
  <router-link to="/tasks" class="btn btn-sm btn-outline-secondary mb-3">← 任务列表</router-link>
  <div v-if="task">
    <h4 class="mb-1">{{ task.title }} <span class="text-secondary small">{{ task.task_id }}</span></h4>
    <div class="text-secondary small mb-3">创建于 {{ task.created_at }}</div>
    <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>

    <div class="row">
      <div class="col-md-6">
        <div class="card mb-3">
          <div class="card-body">
            <table class="table table-sm mb-0">
              <tbody>
                <tr><th class="text-secondary" style="width:110px">类型</th>
                  <td><span class="badge" :class="task.kind === 'scheduled' ? 'text-bg-info' : 'text-bg-secondary'">{{ task.kind }}</span></td></tr>
                <tr><th class="text-secondary">状态</th><td><span class="badge badge-status" :class="badge(task.status)">{{ task.status }}</span></td></tr>
                <tr><th class="text-secondary">指派给</th><td>{{ task.assignee_name }} ({{ task.assignee }})</td></tr>
                <tr v-if="task.workdir"><th class="text-secondary">工作目录</th><td><code>{{ task.workdir }}</code></td></tr>
                <template v-if="task.kind === 'scheduled'">
                  <tr><th class="text-secondary">周期</th><td>{{ task.schedule_cron }}</td></tr>
                  <tr><th class="text-secondary">时间窗口</th><td>{{ task.window_start }} ~ {{ task.window_end }}（窗口内随机时刻，错峰）</td></tr>
                  <tr><th class="text-secondary">下次执行</th><td>{{ task.next_due_at }}</td></tr>
                  <tr><th class="text-secondary">报告主题</th><td><router-link :to="`/topics/${task.topic}`">{{ task.topic }}</router-link></td></tr>
                </template>
                <tr><th class="text-secondary">认领时间</th><td>{{ task.claimed_at || '—' }}</td></tr>
              </tbody>
            </table>
            <button v-if="['pending','assigned','running'].includes(task.status)"
              class="btn btn-sm btn-outline-danger mt-3" @click="cancel">取消任务</button>
          </div>
        </div>

        <h6>指令</h6>
        <pre>{{ task.instruction }}</pre>
      </div>

      <div class="col-md-6">
        <h6>执行结果</h6>
        <div class="card mb-3">
          <div class="card-body">
            <template v-if="task.result">
              <span class="badge" :class="task.result_status === 'success' ? 'text-bg-success' : 'text-bg-danger'">
                {{ task.result_status }}
              </span>
              <span class="text-secondary small ms-2">于 {{ task.result_at }}</span>
              <pre class="mt-2 mb-0">{{ task.result }}</pre>
            </template>
            <span v-else class="text-secondary">尚未汇报结果。</span>
          </div>
        </div>

        <h6>关联报告</h6>
        <div v-if="reports.length === 0" class="card"><div class="card-body text-secondary">无关联报告。</div></div>
        <div v-for="r in reports" :key="r.created_at" class="card mb-2">
          <div class="card-body">
            <div class="text-secondary small mb-1">agent <code>{{ r.agent_id }}</code> · {{ r.created_at }}</div>
            <pre class="mb-0">{{ r.content }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
