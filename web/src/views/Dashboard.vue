<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge.vue';

const due = ref({ items: [], total: 0 });
const hosts = ref([]);
const events = ref([]);
const loading = ref(true);
const error = ref('');
let refreshTimer = null;

function onlineHosts() {
  return hosts.value.filter((host) => host.status === 'active' && !host.offline).length;
}

function eventIcon(action) {
  if (action.includes('create')) return 'bi-plus-circle';
  if (action.includes('claim')) return 'bi-hand-index-thumb';
  if (action.includes('submit')) return 'bi-upload';
  if (action.includes('accept') || action.includes('approve')) return 'bi-check2-circle';
  if (action.includes('reject') || action.includes('fail')) return 'bi-exclamation-octagon';
  if (action.includes('reopen')) return 'bi-arrow-repeat';
  if (action.includes('reply')) return 'bi-chat-left-text';
  return 'bi-activity';
}

function eventClass(action) {
  if (action.includes('reject') || action.includes('fail')) return 'danger';
  if (action.includes('accept') || action.includes('approve')) return 'success';
  if (action.includes('claim') || action.includes('submit')) return 'info';
  return 'primary';
}

function relativeTime(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value || '—';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(time).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

async function loadDashboard() {
  loading.value = true;
  error.value = '';
  try {
    const [taskData, hostData, eventData] = await Promise.all([
      api.tasks({ view: 'due', page: 1, page_size: 5 }),
      api.hosts(),
      api.events({ limit: 50 }),
    ]);
    due.value = { items: taskData.items ?? [], total: Number(taskData.total ?? 0) };
    hosts.value = hostData.items ?? [];
    events.value = (eventData.items ?? []).slice(-20).reverse();
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadDashboard();
  refreshTimer = setInterval(loadDashboard, 45_000);
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <div class="dashboard-page">
    <div class="dashboard-heading">
      <div>
        <div class="eyebrow"><i class="bi bi-broadcast-pin me-1"></i>COMMAND CENTER</div>
        <h1>全局活动</h1>
        <p>实时掌握待办任务、主机状态与最近事件。</p>
      </div>
      <router-link to="/tasks" class="btn btn-primary">
        <i class="bi bi-list-task me-1"></i>查看任务
      </router-link>
    </div>

    <div v-if="error" class="alert alert-danger d-flex align-items-center gap-2" role="alert">
      <i class="bi bi-exclamation-triangle"></i><span>{{ error }}</span>
    </div>

    <div class="dashboard-metrics mb-4">
      <div class="metric-card">
        <span class="metric-icon metric-icon-info"><i class="bi bi-inbox"></i></span>
        <span><strong>{{ due.total }}</strong><small>待办任务</small></span>
      </div>
      <div class="metric-card">
        <span class="metric-icon metric-icon-success"><i class="bi bi-pc-display"></i></span>
        <span><strong>{{ hosts.length }}</strong><small>主机总数</small></span>
      </div>
      <div class="metric-card">
        <span class="metric-icon metric-icon-primary"><i class="bi bi-wifi"></i></span>
        <span><strong>{{ onlineHosts() }}</strong><small>在线主机</small></span>
      </div>
      <div class="metric-card">
        <span class="metric-icon metric-icon-danger"><i class="bi bi-activity"></i></span>
        <span><strong>{{ events.length }}</strong><small>最近事件</small></span>
      </div>
    </div>

    <div class="row g-4">
      <section class="col-xl-5">
        <div class="activity-card card h-100">
          <div class="activity-card-header">
            <div>
              <h2><i class="bi bi-inbox me-2"></i>待办任务</h2>
              <p>来自 due 视图的最新任务</p>
            </div>
            <router-link to="/tasks?view=due" class="btn btn-sm btn-ghost">全部 <i class="bi bi-arrow-right ms-1"></i></router-link>
          </div>
          <div v-if="loading" class="text-secondary small p-3">加载中…</div>
          <div v-else-if="!due.items.length" class="empty-state activity-empty">
            <i class="bi bi-check2-circle"></i><strong>暂无待办</strong><span>当前没有需要处理的任务。</span>
          </div>
          <div v-else class="list-group list-group-flush">
            <router-link v-for="item in due.items" :key="item.id" :to="`/tasks/${item.id}`" class="list-group-item list-group-item-action bg-transparent px-3 py-3">
              <div class="d-flex align-items-center gap-2">
                <strong class="text-truncate">{{ item.title || '未命名任务' }}</strong>
                <StatusBadge class="ms-auto flex-shrink-0" :status="item.task?.status" />
              </div>
              <div class="text-secondary small mt-1 text-truncate">{{ item.body }}</div>
            </router-link>
          </div>
        </div>
      </section>

      <section class="col-xl-7">
        <div class="activity-card card h-100">
          <div class="activity-card-header">
            <div>
              <h2><i class="bi bi-activity me-2"></i>最近事件</h2>
              <p>平台关键操作按最新发生时间排列</p>
            </div>
            <button class="btn btn-sm btn-ghost" :disabled="loading" title="刷新" @click="loadDashboard">
              <i class="bi bi-arrow-clockwise" :class="{ 'spin-once': loading }"></i>
            </button>
          </div>
          <div v-if="loading" class="timeline-skeleton">
            <div v-for="n in 5" :key="n" class="skeleton-row">
              <span class="skeleton skeleton-dot"></span><span class="skeleton skeleton-line skeleton-line-wide"></span>
            </div>
          </div>
          <div v-else-if="!events.length" class="empty-state activity-empty">
            <i class="bi bi-stars"></i><strong>还没有事件</strong><span>创建任务或连接主机后，最新动态会显示在这里。</span>
          </div>
          <ol v-else class="activity-timeline">
            <li v-for="event in events" :key="event.id" class="activity-item">
              <div class="activity-marker" :class="eventClass(event.action)">
                <i class="bi" :class="eventIcon(event.action)"></i>
              </div>
              <div class="activity-body">
                <div class="activity-summary">{{ event.summary || event.action }}</div>
                <div class="activity-meta">
                  <span>{{ event.actor_name || '系统' }}</span>
                  <router-link v-if="event.resource_type === 'post' && event.resource_id" :to="`/tasks/${event.resource_id}`" class="activity-ref">{{ event.resource_id }}</router-link>
                  <time :datetime="event.occurred_at">{{ relativeTime(event.occurred_at) }}</time>
                </div>
              </div>
            </li>
          </ol>
        </div>
      </section>
    </div>
  </div>
</template>
