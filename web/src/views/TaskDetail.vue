<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
// 附件预览 modal 状态：{ attachment, url, kind, text, error }
const preview = ref(null);
let previewUrl = '';
// 附件预览请求序号：连续打开或关闭后，旧请求返回时若 token 已过期则丢弃结果，
// 避免覆盖最新预览；同时兜住组件卸载后异步回调写状态的问题。
let previewRequestSeq = 0;

const task = computed(() => detail.value?.task);
const post = computed(() => detail.value?.post);
const VISIBILITY_LABELS = { private: '私有', account: '账号内', public: '公开' };
const visibilityLabel = computed(() => VISIBILITY_LABELS[post.value?.visibility] || post.value?.visibility || '—');
const hostPrincipal = computed(() =>
  (detail.value?.targets ?? []).find((item) => item.principal?.kind === 'host')?.principal ?? null);
const hostLabel = computed(() => hostPrincipal.value?.name || hostPrincipal.value?.id || '');
const ROLE_LABELS = { author: '发起人', assignee: '执行者', mention: '提及', watcher: '关注者' };
function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}
// 右侧「任务操作」卡片仅在存在即时操作时渲染，避免空卡片。
const hasActions = computed(() => ['open', 'claimed', 'submitted', 'pending_confirm'].includes(task.value?.status));
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

function previewKind(mime) {
  // 规范化：trim + 小写 + 截掉 `; charset=...` 等参数（后端文本类响应会追加 charset）
  const normalized = String(mime ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized === 'application/pdf') return 'pdf';
  if (
    normalized.startsWith('text/')
    || normalized.endsWith('+json')
    || normalized.endsWith('+xml')
    || [
      'application/json',
      'application/xml',
      'application/javascript',
      'application/x-yaml',
      'application/yaml',
      'application/sql',
      'application/markdown',
      'application/x-sh',
    ].includes(normalized)
  ) return 'text';
  return 'unknown';
}

async function openAttachment(attachment) {
  // 先 revoke 上一轮 ObjectURL（closeAttachmentPreview 内部处理），再签发新 token
  closeAttachmentPreview();
  const token = ++previewRequestSeq;
  preview.value = { attachment, url: '', kind: 'loading', text: '', error: '' };
  try {
    const result = await api.attachmentBlob(attachment.id);
    const url = URL.createObjectURL(result.blob);
    const kind = previewKind(attachment.mime || result.blob.type);
    let text = '';
    if (kind === 'text') {
      text = await result.blob.text();
      if (text.length > 200_000) text = `${text.slice(0, 200_000)}\n\n…（内容过长，已截断显示）`;
    }
    if (token !== previewRequestSeq) {
      // 过期请求：立即释放本次 URL 并丢弃结果，不覆盖当前预览状态
      URL.revokeObjectURL(url);
      return;
    }
    previewUrl = url;
    preview.value = { attachment, url, kind, text, error: '' };
  } catch (e) {
    if (token !== previewRequestSeq) return;
    preview.value = { attachment, url: '', kind: 'error', text: '', error: e.message };
  }
}

function downloadPreview() {
  if (!preview.value?.url) return;
  const link = document.createElement('a');
  link.href = preview.value.url;
  link.download = preview.value.attachment.filename || 'attachment';
  link.click();
}

function closeAttachmentPreview() {
  previewRequestSeq += 1; // 使进行中的 openAttachment 请求过期
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }
  preview.value = null;
}

function targetName(target) {
  return target.principal?.name || target.principal?.id || roleLabel(target.role);
}

function openTaskModal(taskId) {
  selectedTaskId.value = taskId;
}

function closeTaskModal() {
  selectedTaskId.value = '';
}

onMounted(load);
watch(() => route.params.taskId, load);
// 路由离开/组件卸载时清理预览，避免 ObjectURL 泄漏和卸载后写状态
onBeforeUnmount(closeAttachmentPreview);
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
          <!-- 标题区：标题 + 状态 -->
          <div class="d-flex align-items-center gap-2 flex-wrap mb-2">
            <h1 class="h4 fw-bold mb-0">{{ post.title || '未命名任务' }}</h1>
            <StatusBadge :status="task.status" />
          </div>
          <!-- 元信息区：发起人 / 执行者 / 执行主机 / 创建时间（低对比度） -->
          <div class="d-flex align-items-center gap-2 flex-wrap small mb-1">
            <PrincipalChip v-if="post.author" :principal="post.author" role="发起人" />
            <PrincipalChip v-if="assigneePrincipal" :principal="assigneePrincipal" role="执行者" />
            <span v-if="hostLabel" class="text-secondary"><i class="bi bi-pc-display me-1"></i>执行主机：{{ hostLabel }}</span>
            <span class="text-secondary"><i class="bi bi-clock me-1"></i>创建时间：{{ post.created_at }}</span>
          </div>
          <div class="task-meta-faint small mb-2">
            <code class="task-post-id">{{ post.id }}</code>
            <span>可见范围：{{ visibilityLabel }}</span>
            <span>工作目录：{{ task.workdir || '—' }}</span>
            <span>执行器：{{ task.executor || '—' }}</span>
          </div>
          <!-- 进度区：时间线（含尝试次数，全页仅此一处） -->
          <TaskTimeline :status="task.status" :attempts="task.attempts" :max-attempts="task.max_attempts" />
          <!-- 内容区：任务说明 + 目标 -->
          <div class="md-content" v-html="renderMd(post.body)"></div>
          <div v-if="detail.targets?.length" class="border-top pt-2 mt-3 small">
            <span class="text-secondary me-2">目标：</span>
            <span v-for="target in detail.targets" :key="`${target.principal?.id || target.role}-${target.role}`" class="d-inline-block me-1">
              <PrincipalChip v-if="target.principal" :principal="target.principal" :role="roleLabel(target.role)" />
              <span v-else class="text-secondary me-1">{{ targetName(target) }} · {{ roleLabel(target.role) }}</span>
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
              <!-- 回复框移入消息流卡片底部 -->
              <div class="border-top pt-3">
                <label class="form-label fw-semibold" for="task-reply-input">回复任务</label>
                <textarea id="task-reply-input" v-model="replyText" class="form-control mb-2" rows="3" placeholder="补充信息、指导执行方或说明验收意见"></textarea>
                <button class="btn btn-primary" :disabled="!replyText.trim()" @click="reply"><i class="bi bi-send me-1"></i>发送回复</button>
              </div>
            </div>
          </section>

          <section class="card mb-3">
            <div class="card-header"><strong><i class="bi bi-box-seam me-2"></i>交付物</strong></div>
            <div class="card-body">
              <div v-if="task.deliverable_spec" class="mb-3">
                <div class="text-secondary small mb-1">交付要求</div>
                <div class="deliverable-spec small mb-0">{{ parseSpec(task.deliverable_spec) }}</div>
              </div>
              <div v-if="!detail.deliverables?.length" class="text-secondary small">暂无交付物。</div>
              <div v-for="deliverable in detail.deliverables" :key="`${deliverable.name}-${deliverable.version}`" class="d-flex align-items-start gap-2 border-top py-2">
                <span class="small text-secondary flex-shrink-0 pt-1">v{{ deliverable.version }}</span>
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
          <section v-if="hasActions" class="card mb-3 task-actions-card">
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

    </template>
    <div v-if="preview" class="modal show d-block attachment-preview-modal" tabindex="-1" role="dialog" aria-modal="true"
      :aria-label="`预览 ${preview.attachment.filename || '附件'}`">
      <div class="modal-dialog modal-lg modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h2 class="modal-title h5 mb-0 text-truncate"><i class="bi bi-eye me-2"></i>{{ preview.attachment.filename || '附件预览' }}</h2>
            <button type="button" class="btn-close" aria-label="关闭" @click="closeAttachmentPreview"></button>
          </div>
          <div class="modal-body">
            <div v-if="preview.kind === 'loading'" class="text-secondary text-center py-5">
              <i class="bi bi-arrow-repeat me-1 spin-once"></i>正在加载附件预览…
            </div>
            <div v-else-if="preview.kind === 'error'" class="alert alert-danger mb-0">{{ preview.error }}</div>
            <div v-else-if="preview.kind === 'image'" class="text-center">
              <img :src="preview.url" :alt="preview.attachment.filename || '附件图片'" class="img-fluid rounded" style="max-height: 70vh;">
            </div>
            <iframe v-else-if="preview.kind === 'pdf'" :src="preview.url" class="w-100 border-0 rounded" style="height: 70vh; background: #fff;"
              :title="preview.attachment.filename || '附件 PDF'"></iframe>
            <pre v-else-if="preview.kind === 'text'" class="mb-0">{{ preview.text }}</pre>
            <div v-else class="text-center py-4">
              <i class="bi bi-file-earmark-x fs-1 d-block mb-2 text-secondary"></i>
              <p class="mb-3">该附件类型暂不支持在线预览<span v-if="preview.attachment.mime">（{{ preview.attachment.mime }}）</span>，请下载后查看。</p>
              <button type="button" class="btn btn-primary" @click="downloadPreview"><i class="bi bi-download me-1"></i>下载附件</button>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" :disabled="!preview.url" @click="downloadPreview">
              <i class="bi bi-download me-1"></i>下载
            </button>
            <button type="button" class="btn btn-primary" @click="closeAttachmentPreview">关闭</button>
          </div>
        </div>
      </div>
    </div>
    <div v-if="preview" class="modal-backdrop show" @click="closeAttachmentPreview"></div>
    <TaskDetailModal v-if="selectedTaskId" :task-id="selectedTaskId" @close="closeTaskModal" />
  </div>
</template>

<style scoped>
/* pst_ ID：低对比 monospace，移出标题行 */
.task-post-id {
  background: transparent;
  color: var(--text-faint);
  font-size: 0.78rem;
  padding: 0;
}

/* 元信息第二行：可见范围 / 工作目录 / 执行器 */
.task-meta-faint {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.25rem;
  color: var(--text-faint);
}

/* 右侧「任务操作」卡片：桌面端 sticky 吸附 */
.task-actions-card {
  position: sticky;
  top: 1rem;
}

@media (max-width: 1199.98px) {
  .task-actions-card {
    position: static;
  }
}
</style>
