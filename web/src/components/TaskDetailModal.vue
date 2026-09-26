<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../api';
import { renderMd } from '../md';
import StatusBadge from './StatusBadge.vue';
import PrincipalChip from './PrincipalChip.vue';
import TaskTimeline from './TaskTimeline.vue';

const props = defineProps({
  taskId: { type: String, default: '' },
});

const emit = defineEmits(['close']);
const detail = ref(null);
const loading = ref(false);
const error = ref('');
let loadToken = 0;

const task = computed(() => detail.value?.task);
const post = computed(() => detail.value?.post);
const assignee = computed(() => {
  const id = task.value?.assignee_principal_id;
  if (!id) return null;
  const target = (detail.value?.targets ?? []).find(
    (item) => item.role === 'assignee' && item.principal?.id === id,
  );
  return target?.principal ?? { id, kind: '', name: '' };
});
const messages = computed(() => (detail.value?.recent ?? [])
  .filter((item) => item.id !== post.value?.id)
  .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))));

function parseSpec(value) {
  if (!value) return '';
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
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
  const taskId = props.taskId;
  if (!taskId) return;
  const token = ++loadToken;
  loading.value = true;
  error.value = '';
  detail.value = null;
  try {
    const data = await api.post(taskId);
    if (token === loadToken) detail.value = data;
  } catch (cause) {
    if (token === loadToken) error.value = cause.message;
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(() => props.taskId, load, { immediate: true });
</script>

<template>
  <div class="modal show d-block task-panorama-modal" tabindex="-1" role="dialog" aria-modal="true" aria-label="任务详情">
    <div class="modal-dialog modal-dialog-scrollable modal-lg">
      <div class="modal-content">
        <div class="modal-header">
          <h2 class="modal-title h5 mb-0"><i class="bi bi-card-text me-2"></i>任务详情</h2>
          <button type="button" class="btn-close" aria-label="关闭" @click="emit('close')"></button>
        </div>
        <div class="modal-body">
          <div v-if="loading" class="text-secondary text-center py-5">加载任务详情…</div>
          <div v-else-if="error" class="alert alert-danger mb-0">{{ error }}</div>
          <template v-else-if="detail && post && task">
            <div class="d-flex align-items-center gap-2 flex-wrap mb-2">
              <h3 class="h5 fw-bold mb-0">{{ post.title || '未命名任务' }}</h3>
              <StatusBadge :status="task.status" />
              <code class="small">{{ post.id }}</code>
            </div>
            <div class="d-flex align-items-center gap-2 flex-wrap small mb-3">
              <PrincipalChip v-if="post.author" :principal="post.author" role="发起人" />
              <PrincipalChip v-if="assignee" :principal="assignee" role="执行者" />
              <span class="text-secondary">{{ post.created_at }}</span>
            </div>
            <TaskTimeline :status="task.status" :attempts="task.attempts" :max-attempts="task.max_attempts" />
            <div class="md-content mb-3" v-html="renderMd(post.body)"></div>

            <div class="border-top pt-3 mb-3">
              <div class="text-secondary small mb-1">交付要求</div>
              <div class="deliverable-spec small mb-0">{{ parseSpec(task.deliverable_spec) || '未填写' }}</div>
            </div>

            <div v-if="detail.deliverables?.length" class="border-top pt-3 mb-3">
              <div class="text-secondary small mb-1">交付物</div>
              <div v-for="deliverable in detail.deliverables" :key="`${deliverable.name}-${deliverable.version}`" class="d-flex align-items-start gap-2 border-bottom py-2">
                <span class="small text-secondary flex-shrink-0 pt-1">v{{ deliverable.version }}</span>
                <div>
                  <strong>{{ deliverable.name }}</strong>
                  <div v-if="deliverable.note" class="text-secondary small">{{ deliverable.note }}</div>
                  <div v-if="deliverable.attachment" class="text-secondary small">
                    {{ deliverable.attachment.filename }} · {{ fmtSize(deliverable.attachment.size_bytes) }}
                  </div>
                </div>
              </div>
            </div>

            <div class="border-top pt-3">
              <div class="text-secondary small mb-2">最近线程回复</div>
              <div v-if="!messages.length" class="text-secondary small">暂无回复。</div>
              <article v-for="message in messages" :key="message.id" class="border-bottom pb-2 mb-2">
                <div class="d-flex align-items-center gap-2 small mb-1">
                  <PrincipalChip v-if="message.author" :principal="message.author" />
                  <span class="text-secondary">{{ message.created_at }}</span>
                </div>
                <div class="md-content" v-html="renderMd(message.body)"></div>
              </article>
            </div>
          </template>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline-secondary" @click="emit('close')">关闭</button>
          <router-link v-if="taskId" :to="`/tasks/${taskId}`" class="btn btn-primary" @click="emit('close')">
            打开完整页面
          </router-link>
        </div>
      </div>
    </div>
  </div>
  <div class="modal-backdrop show"></div>
</template>
