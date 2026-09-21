<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { renderMd } from '../md';
import StatusBadge from '../components/StatusBadge.vue';
import PrincipalChip from '../components/PrincipalChip.vue';
import TaskTreePanel from '../components/TaskTreePanel.vue';
import TaskDetailModal from '../components/TaskDetailModal.vue';
import TaskTimeline from '../components/TaskTimeline.vue';

const route = useRoute();
const detail = ref(null);
const olderRecent = ref([]);
const remainingCount = ref(0);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
const replyText = ref('');
const submitName = ref('');
const submitNote = ref('');
const subtree = ref(null);
const subtreeLoading = ref(false);
const subtreeError = ref('');
const selectedTaskId = ref('');

const task = computed(() => detail.value?.task);
const post = computed(() => detail.value?.post);
const assigneePrincipal = computed(() => {
  const assigneeId = task.value?.assignee_principal_id;
  if (!assigneeId) return null;
  const target = (detail.value?.targets ?? []).find(
    (item) => item.role === 'assignee' && item.principal?.id === assigneeId,
  );
  return target?.principal ?? { id: assigneeId, kind: '', name: '' };
});
const verdictByPostId = computed(() => {
  const map = new Map();
  for (const verdict of detail.value?.verdicts ?? []) map.set(verdict.post_id, verdict);
  return map;
});

function messageVerdict(message) {
  const structured = verdictByPostId.value.get(message.id);
  if (structured) return structured;
  if (message.kind === 'verdict') {
    return { decision: message.body?.startsWith('reject') ? 'reject' : 'accept', opinion: message.body, attempt_no: 0 };
  }
  return null;
}
const thread = computed(() => {
  const source = [...olderRecent.value, ...(detail.value?.recent ?? [])];
  const unique = new Map(source.map((item) => [item.id, item]));
  return [...unique.values()]
    .filter((item) => item.id !== post.value?.id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
});

function parseSpec(value) {
  if (!value) return '';
  if (typeof value !== 'string') return JSON.stringify(value);
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let value = Number(bytes);
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

async function load() {
  loading.value = true;
  error.value = '';
  olderRecent.value = [];
  subtree.value = null;
  subtreeError.value = '';
  try {
    const data = await api.post(route.params.taskId);
    detail.value = data;
    remainingCount.value = Number(data.more?.count ?? 0);
    if (data.post?.kind === 'task') {
      subtreeLoading.value = true;
      try {
        subtree.value = await api.taskSubtree(data.post.id, 4);
      } catch (cause) {
        subtreeError.value = `全景树加载失败：${cause.message}`;
      } finally {
        subtreeLoading.value = false;
      }
    }
  } catch (e) {
    detail.value = null;
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (!post.value || !thread.value.length && !(detail.value?.recent ?? []).length || loadingMore.value) return;
  const all = [...olderRecent.value, ...(detail.value?.recent ?? [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const anchor = all[0];
  if (!anchor) return;
  loadingMore.value = true;
  try {
    const data = await api.postList({ root_id: post.value.root_id, after: anchor.id, limit: 20 });
    olderRecent.value = [...(data.items ?? []).reverse(), ...olderRecent.value];
    const loaded = olderRecent.value.length + (detail.value?.recent?.length ?? 0);
    remainingCount.value = Math.max(0, Number(data.total ?? loaded) - loaded);
  } catch (e) {
    error.value = e.message;
  } finally {
    loadingMore.value = false;
  }
}

async function claim() {
  await runAction(() => api.claimTask(post.value.id));
}

async function submit() {
  if (!submitName.value.trim()) {
    error.value = '请填写交付物名称';
    return;
  }
  await runAction(async () => {
    await api.submitTask(post.value.id, {
      deliverables: [{ name: submitName.value.trim(), note: submitNote.value.trim() || undefined }],
    });
    submitName.value = '';
    submitNote.value = '';
  });
}

async function verdict(decision) {
  const opinion = prompt(decision === 'accept' ? '验收意见（可选）' : '打回意见（可选）', '') ?? null;
  if (opinion === null) return;
  await runAction(() => api.verdictTask(post.value.id, {
    decision,
    opinion: opinion.trim() || undefined,
  }));
}

async function reopen() {
  const reason = prompt('重开原因（可选）', '') ?? null;
  if (reason === null) return;
  await runAction(() => api.reopenTask(post.value.id, { reason: reason.trim() || undefined }));
}

async function reply() {
  if (!replyText.value.trim()) return;
  const body = replyText.value.trim();
  await runAction(async () => {
    await api.replyPost(post.value.id, { body });
    replyText.value = '';
  });
}

async function runAction(action) {
  error.value = '';
  try {
    await action();
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function openAttachment(attachment) {
  try {
    const result = await api.attachmentBlob(attachment.id);
    const url = URL.createObjectURL(result.blob);
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) {
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.filename;
      link.click();
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    error.value = e.message;
  }
}

function targetName(target) {
  return target.principal?.name || target.principal?.id || target.role;
}

function openTaskModal(taskId) {
  selectedTaskId.value = taskId;
}

function closeTaskModal() {
  selectedTaskId.value = '';
}

onMounted(load);
watch(() => route.params.taskId, load);
</script>

<template>
  <div class="task-detail-page">
    <div class="d-flex justify-content-between align-items-center gap-2 mb-3">
      <router-link to="/tasks" class="btn btn-sm btn-outline-secondary"><i class="bi bi-arrow-left me-1"></i>任务列表</router-link>
      <button v-if="task && ['done', 'failed', 'cancelled', 'rejected'].includes(task.status)" class="btn btn-sm btn-outline-warning" @click="reopen">
        <i class="bi bi-arrow-counterclockwise me-1"></i>重开任务
      </button>
    </div>

    <div v-if="loading" class="card"><div class="card-body text-secondary text-center py-5">加载中…</div></div>
    <div v-else-if="error && !detail" class="alert alert-danger">{{ error }}</div>
    <template v-else-if="detail && post && task">
      <div class="card mb-3">
        <div class="card-body">
          <div class="d-flex align-items-center gap-2 flex-wrap mb-2">
            <h1 class="h4 fw-bold mb-0">{{ post.title || '未命名任务' }}</h1>
            <StatusBadge :status="task.status" />
            <span class="badge text-bg-secondary">{{ post.visibility }}</span>
            <code class="small">{{ post.id }}</code>
          </div>
          <div class="d-flex align-items-center gap-2 flex-wrap small mb-1">
            <PrincipalChip v-if="post.author" :principal="post.author" role="发起人" />
            <PrincipalChip v-if="assigneePrincipal" :principal="assigneePrincipal" role="认领" />
            <span class="text-secondary"><i class="bi bi-clock me-1"></i>{{ post.created_at }}</span>
          </div>
          <TaskTimeline :status="task.status" :attempts="task.attempts" :max-attempts="task.max_attempts" />
          <div class="md-content" v-html="renderMd(post.body)"></div>
          <div v-if="detail.targets?.length" class="border-top pt-2 mt-3 small">
            <span class="text-secondary me-2">目标：</span>
            <span v-for="target in detail.targets" :key="`${target.principal?.id || target.role}-${target.role}`" class="d-inline-block me-1">
              <PrincipalChip v-if="target.principal" :principal="target.principal" :role="target.role" />
              <span v-else class="badge text-bg-light me-1">{{ targetName(target) }} · {{ target.role }}</span>
            </span>
          </div>
        </div>
      </div>

      <TaskTreePanel
        v-if="post.kind === 'task'"
        :parent="detail.parent"
        :children="detail.children ?? []"
        :tree="subtree?.root"
        :loading="subtreeLoading"
        :error="subtreeError"
        @select="openTaskModal"
      />

      <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>

      <div class="row g-3">
        <div class="col-xl-8">
          <section class="card mb-3">
            <div class="card-header d-flex align-items-center justify-content-between">
              <strong><i class="bi bi-chat-left-text me-2"></i>消息流</strong>
              <button v-if="remainingCount > 0" class="btn btn-sm btn-outline-secondary" :disabled="loadingMore" @click="loadMore">
                {{ loadingMore ? '加载中…' : `加载更早消息（${remainingCount}）` }}
              </button>
            </div>
            <div class="card-body">
              <div v-if="!thread.length" class="text-secondary small">暂无回复。</div>
              <article v-for="message in thread" :key="message.id" class="border-bottom pb-3 mb-3"
                :class="messageVerdict(message) ? `border-start border-4 ps-2 ${messageVerdict(message).decision === 'accept' ? 'border-success' : 'border-danger'}` : ''">
                <div class="d-flex align-items-center gap-2 small mb-1">
                  <PrincipalChip v-if="message.author" :principal="message.author" />
                  <span v-else class="small text-secondary">未知主体</span>
                  <span v-if="messageVerdict(message)" class="badge"
                    :class="messageVerdict(message).decision === 'accept' ? 'text-bg-success' : 'text-bg-danger'">
                    验收·{{ messageVerdict(message).decision === 'accept' ? '通过' : '打回' }}
                  </span>
                  <span class="text-secondary">{{ message.created_at }}</span>
                </div>
                <div class="md-content" v-html="renderMd(message.body)"></div>
              </article>
            </div>
          </section>

          <section class="card mb-3">
            <div class="card-header"><strong><i class="bi bi-box-seam me-2"></i>交付物</strong></div>
            <div class="card-body">
              <div v-if="task.deliverable_spec" class="mb-3">
                <div class="text-secondary small mb-1">交付要求</div>
                <pre class="small mb-0">{{ parseSpec(task.deliverable_spec) }}</pre>
              </div>
              <div v-if="!detail.deliverables?.length" class="text-secondary small">暂无交付物。</div>
              <div v-for="deliverable in detail.deliverables" :key="`${deliverable.name}-${deliverable.version}`" class="d-flex align-items-start gap-2 border-top py-2">
                <span class="badge" :class="deliverable.current ? 'text-bg-success' : 'text-bg-secondary'">v{{ deliverable.version }}</span>
                <div class="flex-grow-1">
                  <strong>{{ deliverable.name }}</strong>
                  <div v-if="deliverable.note" class="text-secondary small">{{ deliverable.note }}</div>
                  <div v-if="deliverable.attachment" class="small mt-1">
                    <button class="btn btn-link btn-sm p-0" @click="openAttachment(deliverable.attachment)">
                      <i class="bi bi-paperclip me-1"></i>{{ deliverable.attachment.filename }}
                    </button>
                    <span class="text-secondary ms-2">{{ fmtSize(deliverable.attachment.size_bytes) }} · {{ deliverable.attachment.mime }}</span>
                  </div>
                  <span v-else class="text-secondary small d-block mt-1">附件不可见或未绑定</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div class="col-xl-4">
          <section class="card mb-3">
            <div class="card-header"><strong><i class="bi bi-lightning-charge me-2"></i>任务操作</strong></div>
            <div class="card-body">
              <button v-if="task.status === 'open'" class="btn btn-primary w-100 mb-2" @click="claim">认领任务</button>
              <template v-if="task.status === 'claimed'">
                <label class="form-label small">交付物名称 *</label>
                <input v-model="submitName" class="form-control mb-2" placeholder="例如：实现代码">
                <label class="form-label small">交付说明</label>
                <textarea v-model="submitNote" class="form-control mb-2" rows="3"></textarea>
                <button class="btn btn-primary w-100" @click="submit">提交交付物</button>
              </template>
              <template v-if="['submitted', 'pending_confirm'].includes(task.status)">
                <button class="btn btn-success w-100 mb-2" @click="verdict('accept')">验收通过</button>
                <button class="btn btn-outline-danger w-100" @click="verdict('reject')">打回续做</button>
              </template>
              <div v-if="!['open', 'claimed', 'submitted', 'pending_confirm'].includes(task.status)" class="text-secondary small">
                当前状态不提供即时操作。
              </div>
              <div class="small text-secondary mt-3">
                尝试次数：{{ task.attempts }} / {{ task.max_attempts }}<br>
                工作目录：{{ task.workdir || '—' }}<br>
                执行器：{{ task.executor || '—' }}
              </div>
            </div>
          </section>

          <section v-if="detail.verdicts?.length" class="card mb-3">
            <div class="card-header"><strong><i class="bi bi-clipboard-check me-2"></i>验收记录</strong></div>
            <div class="list-group list-group-flush">
              <div v-for="verdict in detail.verdicts" :key="verdict.post_id" class="list-group-item bg-transparent">
                <div class="d-flex justify-content-between align-items-center">
                  <span class="badge" :class="verdict.decision === 'accept' ? 'text-bg-success' : 'text-bg-danger'">
                    {{ verdict.decision === 'accept' ? '通过' : '打回' }}
                  </span>
                  <span class="small text-secondary">第 {{ verdict.attempt_no }} 次</span>
                </div>
                <div class="small text-secondary mt-1">{{ verdict.opinion || '无意见' }}</div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <section class="card">
        <div class="card-body">
          <label class="form-label fw-semibold">回复任务</label>
          <textarea v-model="replyText" class="form-control mb-2" rows="3" placeholder="补充信息、指导执行方或说明验收意见"></textarea>
          <button class="btn btn-primary" :disabled="!replyText.trim()" @click="reply"><i class="bi bi-send me-1"></i>发送回复</button>
        </div>
      </section>
    </template>
    <TaskDetailModal v-if="selectedTaskId" :task-id="selectedTaskId" @close="closeTaskModal" />
  </div>
</template>
