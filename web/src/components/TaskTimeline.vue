<script setup>
import { computed } from 'vue';

const props = defineProps({
  status: { type: String, default: '' },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 3 },
});

const steps = [
  ['open', '待执行'],
  ['claimed', '已认领'],
  ['submitted', '待验收'],
  ['pending_confirm', '待确认'],
  ['done', '已完成'],
];

const reachedIndex = computed(() => {
  switch (props.status) {
    case 'open':
    case 'pending_audit':
      return 0;
    case 'claimed':
    case 'rejected':
      return 1;
    case 'submitted':
      return 2;
    case 'pending_confirm':
      return 3;
    case 'done':
      return 4;
    default:
      return -1; // failed / cancelled 由 terminal 样式表达
  }
});

const terminal = computed(() => (props.status === 'failed' ? 'failed' : props.status === 'cancelled' ? 'cancelled' : ''));

function stepClass(index) {
  const reached = reachedIndex.value;
  const classes = [];
  if (terminal.value) {
    classes.push(index < steps.length - 1 ? 'is-reached' : terminal.value === 'failed' ? 'is-failed' : 'is-cancelled');
  } else if (reached >= 0 && index < reached) {
    classes.push('is-reached');
  } else if (index === reached) {
    classes.push('is-current');
  } else {
    classes.push('is-pending');
  }
  return classes;
}
</script>

<template>
  <div class="task-timeline mb-1">
    <ol class="list-unstyled d-flex align-items-start mb-1">
      <li v-for="(step, index) in steps" :key="step[0]" class="timeline-step" :class="stepClass(index)">
        <span class="timeline-dot" aria-hidden="true"></span>
        <span class="timeline-label small">{{ step[1] }}</span>
      </li>
    </ol>
    <div class="small text-secondary">
      <template v-if="terminal === 'failed'">任务失败</template>
      <template v-else-if="terminal === 'cancelled'">任务已取消</template>
      <template v-else>尝试 {{ attempts }} / {{ maxAttempts }}</template>
    </div>
  </div>
</template>

<style scoped>
.timeline-step {
  flex: 1;
  position: relative;
  text-align: center;
  min-width: 0;
}

.timeline-step::before {
  content: '';
  position: absolute;
  top: 5px;
  left: -50%;
  width: 100%;
  height: 2px;
  background: var(--bs-border-color, #dee2e6);
}

.timeline-step:first-child::before {
  display: none;
}

.timeline-dot {
  position: relative;
  z-index: 1;
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--bs-secondary-bg, #e9ecef);
  border: 2px solid var(--bs-border-color, #dee2e6);
}

.timeline-label {
  display: block;
  margin-top: 2px;
  color: var(--bs-secondary-color, #6c757d);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.timeline-step.is-reached::before {
  background: var(--bs-success, #198754);
}

.timeline-step.is-reached .timeline-dot {
  background: var(--bs-success, #198754);
  border-color: var(--bs-success, #198754);
}

.timeline-step.is-reached .timeline-label {
  color: var(--bs-success, #198754);
}

.timeline-step.is-current::before {
  background: var(--bs-success, #198754);
}

.timeline-step.is-current .timeline-dot {
  background: #fff;
  border-color: var(--bs-primary, #0d6efd);
  box-shadow: 0 0 0 4px rgba(13, 110, 253, 0.25);
}

.timeline-step.is-current .timeline-label {
  color: var(--bs-primary, #0d6efd);
  font-weight: 600;
}

.timeline-step.is-failed .timeline-dot,
.timeline-step.is-failed::before {
  background: var(--bs-danger, #dc3545);
  border-color: var(--bs-danger, #dc3545);
}

.timeline-step.is-failed .timeline-label {
  color: var(--bs-danger, #dc3545);
}

.timeline-step.is-cancelled .timeline-dot,
.timeline-step.is-cancelled::before {
  background: var(--bs-secondary, #6c757d);
  border-color: var(--bs-secondary, #6c757d);
}

.timeline-step.is-cancelled .timeline-label {
  color: var(--bs-secondary, #6c757d);
}
</style>
