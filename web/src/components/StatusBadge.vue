<script setup>
import { computed } from 'vue';

const props = defineProps({
  status: { type: String, default: '' },
  kind: { type: String, default: 'task' },
  offline: { type: Boolean, default: false },
  title: { type: String, default: '' },
});

const labels = {
  task: {
    open: '待执行',
    active: '公共池',
    claimed: '已认领',
    running: '运行中',
    assigned: '已指派',
    pending: '待处理',
    pending_audit: '待审核',
    submitted: '待验收',
    pending_confirm: '待确认',
    blocked: '已阻塞',
    done: '已完成',
    resolved: '已解决',
    failed: '失败',
    rejected: '已打回',
    cancelled: '已取消',
  },
  host: {
    active: '在线',
    disabled: '已禁用',
    offline: '失联',
  },
};

// 语义分色：待处理蓝 / 进行中紫 / 待确认橙 / 完成绿 / 失败·打回红 / 取消·阻塞灰
const colors = {
  task: {
    active: 'text-bg-info',
    open: 'text-bg-info',
    assigned: 'text-bg-info',
    pending: 'text-bg-info',
    claimed: 'text-bg-primary',
    running: 'text-bg-primary',
    submitted: 'text-bg-warning',
    pending_confirm: 'text-bg-warning',
    pending_audit: 'text-bg-warning',
    blocked: 'text-bg-secondary',
    done: 'text-bg-success',
    resolved: 'text-bg-success',
    failed: 'text-bg-danger',
    rejected: 'text-bg-danger',
    cancelled: 'text-bg-secondary',
  },
  host: {
    active: 'text-bg-success',
    offline: 'text-bg-danger',
    disabled: 'text-bg-secondary',
  },
};

const badgeStatus = computed(() => props.offline ? 'offline' : props.status);
const label = computed(() => {
  if (props.offline) return '失联';
  return labels[props.kind]?.[props.status] || props.status || '未知';
});
const colorClass = computed(() => colors[props.kind]?.[badgeStatus.value] || 'text-bg-secondary');
</script>

<template>
  <span class="badge badge-status" :class="colorClass" :title="title || undefined">{{ label }}</span>
</template>
