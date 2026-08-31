<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api';

const stats = ref(null);
const events = ref([]);
const eventsTotal = ref(0);
const eventsPage = ref(1);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
let refreshTimer = null;

function activeTaskCount() {
  const tasks = stats.value?.tasks ?? {};
  return ['open', 'claimed', 'running', 'assigned', 'pending', 'pending_audit', 'submitted', 'pending_confirm']
    .reduce((sum, key) => sum + Number(tasks[key] ?? 0), 0);
}

function completedTaskCount() {
  const tasks = stats.value?.tasks ?? {};
  return Number(tasks.done ?? 0) + Number(tasks.resolved ?? 0);
}

function actorLabel(actor) {
  return { agent: 'Agent', admin: '管理员', system: '系统' }[actor] || actor;
}

function eventIcon(type) {
  if (type.includes('created')) return 'bi-plus-circle';
  if (type.includes('claim')) return 'bi-hand-index-thumb';
  if (type.includes('submit')) return 'bi-upload';
  if (type.includes('approve') || type.includes('passed') || type.includes('resolved')) return 'bi-check2-circle';
  if (type.includes('reject') || type.includes('failed')) return 'bi-exclamation-octagon';
  if (type.includes('reopen') || type.includes('revise')) return 'bi-arrow-repeat';
  if (type.includes('release')) return 'bi-unlock';
  if (type.includes('skip')) return 'bi-fast-forward';
  if (type.includes('reply')) return 'bi-chat-left-text';
  if (type.includes('cancel')) return 'bi-x-circle';
  return 'bi-activity';
}

function eventClass(type) {
  if (type.includes('reject') || type.includes('failed') || type.includes('cancel')) return 'danger';
  if (type.includes('approve') || type.includes('passed') || type.includes('resolved')) return 'success';
  if (type.includes('claim') || type.includes('submit') || type.includes('release')) return 'info';
  return 'primary';
}

function relativeTime(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(time).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

async function loadDashboard() {
  error.value = '';
  try {
    const [nextStats, nextEvents] = await Promise.all([
      api.stats(),
      api.events({ page: 1, page_size: 20 }),
    ]);
    stats.value = nextStats;
    events.value = nextEvents.items ?? [];
    eventsTotal.value = Number(nextEvents.total ?? events.value.length);
    eventsPage.value = 1;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (loadingMore.value || events.value.length >= eventsTotal.value) return;
  loadingMore.value = true;
  try {
    const nextPage = eventsPage.value + 1;
    const data = await api.events({ page: nextPage, page_size: 20 });
    events.value.push(...(data.items ?? []));
    eventsPage.value = nextPage;
    eventsTotal.value = Number(data.total ?? eventsTotal.value);
  } catch (e) {
    error.value = e.message;
  } finally {
    loadingMore.value = false;
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
        <p>实时掌握主机、任务与计划的最新动态。</p>
      </div>
      <router-link to="/tasks" class="btn btn-primary">
        <i class="bi bi-plus-lg me-1"></i>新建任务
      </router-link>
    </div>

    <div v-if="error" class="alert alert-danger d-flex align-items-center gap-2" role="alert">
      <i class="bi bi-exclamation-triangle"></i><span>{{ error }}</span>
    </div>

    <div v-if="stats" class="dashboard-status card mb-4">
      <div class="dashboard-status-main">
        <span class="status-pulse" :class="{ warning: (stats.agents.offline ?? 0) > 0 }"></span>
        <div>
          <div class="status-title">主机状态</div>
          <div class="status-value">
            <strong>{{ stats.agents.active ?? 0 }}</strong> 台启用
            <span v-if="(stats.agents.offline ?? 0) > 0" class="status-offline">· {{ stats.agents.offline }} 台失联</span>
          </div>
        </div>
        <span class="status-threshold">超过 {{ stats.offline_after_min ?? 30 }} 分钟无心跳即标记失联</span>
      </div>
      <router-link to="/hosts" class="btn btn-sm btn-outline-secondary">查看主机 <i class="bi bi-arrow-right ms-1"></i></router-link>
    </div>

    <div v-if="stats" class="dashboard-metrics mb-4">
      <div class="metric-card">
        <span class="metric-icon metric-icon-info"><i class="bi bi-lightning-charge"></i></span>
        <span><strong>{{ activeTaskCount() }}</strong><small>进行中任务</small></span>
      </div>
      <div class="metric-card">
        <span class="metric-icon metric-icon-success"><i class="bi bi-check2"></i></span>
        <span><strong>{{ completedTaskCount() }}</strong><small>已完成</small></span>
      </div>
      <div class="metric-card">
        <span class="metric-icon metric-icon-danger"><i class="bi bi-exclamation-octagon"></i></span>
        <span><strong>{{ stats.tasks.failed ?? 0 }}</strong><small>失败待处理</small></span>
      </div>
      <div class="metric-card">
        <span class="metric-icon metric-icon-primary"><i class="bi bi-file-earmark-text"></i></span>
        <span><strong>{{ stats.recentReports?.length ?? 0 }}</strong><small>最近报告</small></span>
      </div>
    </div>

    <section class="activity-card card">
      <div class="activity-card-header">
        <div>
          <h2><i class="bi bi-activity me-2"></i>活动流</h2>
          <p>平台内所有关键操作按时间倒序排列</p>
        </div>
        <button class="btn btn-sm btn-ghost" :disabled="loading" title="刷新活动流" @click="loadDashboard">
          <i class="bi bi-arrow-clockwise" :class="{ 'spin-once': loading }"></i>
        </button>
      </div>

      <div v-if="loading" class="timeline-skeleton" aria-label="正在加载活动流">
        <div v-for="n in 5" :key="n" class="skeleton-row">
          <span class="skeleton skeleton-dot"></span>
          <span class="skeleton skeleton-line skeleton-line-wide"></span>
          <span class="skeleton skeleton-line skeleton-line-short"></span>
        </div>
      </div>
      <div v-else-if="events.length === 0" class="empty-state activity-empty">
        <i class="bi bi-stars"></i>
        <strong>还没有活动</strong>
        <span>创建任务或连接主机后，最新动态会显示在这里。</span>
      </div>
      <ol v-else class="activity-timeline">
        <li v-for="event in events" :key="event.id" class="activity-item">
          <div class="activity-marker" :class="eventClass(event.type)">
            <i class="bi" :class="eventIcon(event.type)"></i>
          </div>
          <div class="activity-body">
            <div class="activity-summary">{{ event.summary }}</div>
            <div class="activity-meta">
              <span class="activity-actor">{{ actorLabel(event.actor) }}<template v-if="event.agent_name"> · {{ event.agent_name }}</template></span>
              <router-link v-if="event.task_id" :to="`/tasks/${event.task_id}`" class="activity-ref">{{ event.task_id }}</router-link>
              <router-link v-else-if="event.plan_id" :to="`/plans/${event.plan_id}`" class="activity-ref">{{ event.plan_id }}</router-link>
              <time :datetime="event.created_at" :title="event.created_at">{{ relativeTime(event.created_at) }}</time>
            </div>
          </div>
        </li>
      </ol>
      <div v-if="!loading && events.length > 0 && events.length < eventsTotal" class="activity-more">
        <button class="btn btn-sm btn-outline-secondary" :disabled="loadingMore" @click="loadMore">
          <span v-if="loadingMore" class="spinner-border spinner-border-sm me-1"></span>
          {{ loadingMore ? '加载中…' : '加载更多' }}
        </button>
      </div>
    </section>
  </div>
</template>
