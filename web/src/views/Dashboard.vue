<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge.vue';

const EVENTS_PER_PAGE = 10;
const EVENTS_WINDOW = 200;

const due = ref({ items: [], total: 0 });
const hosts = ref([]);
const events = ref([]);
const eventsTotal = ref(0);
const eventPage = ref(1);
const loading = ref(true);
const error = ref('');
let refreshTimer = null;

function onlineHosts() {
  return hosts.value.filter((host) => host.status === 'active' && !host.offline).length;
}

const pagedEvents = computed(() => {
  const start = (eventPage.value - 1) * EVENTS_PER_PAGE;
  return events.value.slice(start, start + EVENTS_PER_PAGE);
});

const maxEventPage = computed(() => Math.max(1, Math.ceil(events.value.length / EVENTS_PER_PAGE)));

const ACTION_TEXT = {
  'post.created': '创建了任务',
  'key.created': '创建了 API Key',
  'task.created': '创建了任务',
  'post.deleted': '删除了任务',
  'key.revoked': '吊销了 API Key',
  'deliverable.created': '新增了交付物',
  'task.submitted': '提交了交付',
  'task.claimed': '认领了任务',
  'task.verdict': '验收决定',
  'verdict.created': '提交了验收意见',
  'post.replied': '发表了回复',
  'post.target.read': '阅读了任务',
  'attachment.created': '上传了附件',
  'attachment.scan_status_changed': '附件扫描状态更新',
  'channel.created': '创建了频道',
  'task.reopened': '重开了任务',
  'password.changed': '修改了登录密码',
  'post.edited': '编辑了任务',
  'task.ready_changed': '更新了就绪状态',
  'channel.session_reset': '重置了频道会话',
  'task.precheck_failed': '预检失败',
  'task.reclaimed': '重新认领了任务',
};

const RESOURCE_TEXT = {
  key: 'API Key',
  attachment: '附件',
  deliverable: '交付物',
  principal: '成员',
  channel: '频道',
  post: '任务',
};

const ACTOR_KIND_TEXT = {
  user: '用户',
  host: '主机',
};

function payloadField(event, key) {
  const payload = event?.payload;
  if (payload && typeof payload === 'object') {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function actionLabel(event) {
  if (event.action === 'task.verdict') {
    const decision = payloadField(event, 'decision');
    if (decision === 'accept') return '验收通过';
    if (decision === 'reject') return '验收驳回';
  }
  return ACTION_TEXT[event.action] ?? event.action;
}

function actionReason(event) {
  return event.action === 'task.verdict' ? payloadField(event, 'reason') || payloadField(event, 'opinion') : '';
}

function eventIcon(event) {
  switch (event.action) {
    case 'post.created':
    case 'task.created':
    case 'key.created':
    case 'deliverable.created':
    case 'attachment.created':
    case 'channel.created':
      return 'bi-plus-circle';
    case 'key.revoked':
      return 'bi-key';
    case 'task.claimed':
    case 'task.reclaimed':
      return 'bi-hand-index-thumb';
    case 'task.submitted':
      return 'bi-upload';
    case 'task.verdict':
    case 'verdict.created':
      return 'bi-check2-circle';
    case 'task.reopened':
      return 'bi-arrow-repeat';
    case 'post.replied':
      return 'bi-chat-left-text';
    case 'post.target.read':
      return 'bi-eye';
    case 'post.deleted':
      return 'bi-trash3';
    case 'post.edited':
      return 'bi-pencil-square';
    case 'password.changed':
      return 'bi-shield-lock';
    case 'task.precheck_failed':
      return 'bi-exclamation-octagon';
    case 'channel.session_reset':
      return 'bi-arrow-counterclockwise';
    case 'attachment.scan_status_changed':
      return 'bi-shield-check';
    case 'task.ready_changed':
      return 'bi-toggle-on';
    default:
      if (event.action.includes('fail') || event.action.includes('reject')) return 'bi-exclamation-octagon';
      if (event.action.includes('create')) return 'bi-plus-circle';
      if (event.action.includes('claim')) return 'bi-hand-index-thumb';
      if (event.action.includes('submit')) return 'bi-upload';
      if (event.action.includes('accept') || event.action.includes('approve')) return 'bi-check2-circle';
      if (event.action.includes('reply')) return 'bi-chat-left-text';
      if (event.action.includes('reopen')) return 'bi-arrow-repeat';
      return 'bi-activity';
  }
}

function eventClass(event) {
  if (event.action === 'task.verdict') {
    const decision = payloadField(event, 'decision');
    if (decision === 'reject') return 'danger';
    if (decision === 'accept') return 'success';
  }
  if (event.action.includes('reject') || event.action.includes('fail')) return 'danger';
  if (event.action.includes('accept') || event.action.includes('approve')) return 'success';
  if (event.action.includes('revoke') || event.action.includes('deleted')) return 'danger';
  if (event.action.includes('claim') || event.action.includes('submit') || event.action.includes('replied') || event.action.includes('read')) return 'info';
  return 'primary';
}

function actorLabel(event) {
  if (event.actor_name) return event.actor_name;
  return ACTOR_KIND_TEXT[event.actor_kind] ?? '系统';
}

function resourceTitle(event) {
  if (event.resource_type === 'post') return event.resource_title || '未命名任务';
  return RESOURCE_TEXT[event.resource_type] ?? event.resource_type;
}

function fullTime(value) {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return value || '';
  return time.toLocaleString('zh-CN', { hour12: false });
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
      api.events({ order: 'desc', limit: EVENTS_WINDOW }),
    ]);
    due.value = { items: taskData.items ?? [], total: Number(taskData.total ?? 0) };
    hosts.value = hostData.items ?? [];
    events.value = eventData.items ?? [];
    eventsTotal.value = Number(eventData.total ?? events.value.length);
    eventPage.value = Math.min(eventPage.value, maxEventPage.value);
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
        <span><strong>{{ eventsTotal }}</strong><small>最近事件</small></span>
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
          <template v-else>
            <ol class="activity-timeline">
              <li v-for="event in pagedEvents" :key="event.id" class="activity-item">
                <div class="activity-marker" :class="eventClass(event)">
                  <i class="bi" :class="eventIcon(event)"></i>
                </div>
                <div class="activity-body">
                  <div class="activity-summary">{{ actionLabel(event) }}</div>
                  <div class="activity-meta">
                    <span class="activity-actor">{{ actorLabel(event) }}</span>
                    <router-link
                      v-if="event.resource_type === 'post' && event.resource_id"
                      :to="`/tasks/${event.resource_id}`"
                      class="activity-ref activity-ref-title"
                      :title="`任务 ID：${event.resource_id}`"
                    >{{ resourceTitle(event) }}</router-link>
                    <span v-else-if="event.resource_id" class="activity-tag" :title="event.resource_id">{{ resourceTitle(event) }}</span>
                    <span v-if="actionReason(event)" class="activity-reason" :title="actionReason(event)">{{ actionReason(event) }}</span>
                    <time :datetime="event.occurred_at" :title="fullTime(event.occurred_at)">{{ relativeTime(event.occurred_at) }}</time>
                  </div>
                </div>
              </li>
            </ol>
            <nav v-if="maxEventPage > 1" class="activity-pagination">
              <button class="btn btn-sm btn-ghost" :disabled="eventPage <= 1" title="上一页" @click="eventPage -= 1">
                <i class="bi bi-chevron-left"></i>
              </button>
              <span class="activity-page-info">第 {{ eventPage }} / {{ maxEventPage }} 页</span>
              <button class="btn btn-sm btn-ghost" :disabled="eventPage >= maxEventPage" title="下一页" @click="eventPage += 1">
                <i class="bi bi-chevron-right"></i>
              </button>
            </nav>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>
