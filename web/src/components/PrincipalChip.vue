<script setup>
import { computed } from 'vue';

const props = defineProps({
  principal: { type: Object, default: null }, // { id, kind, name }
  role: { type: String, default: '' },
});

const kindMeta = {
  user: { icon: 'bi-person', color: '#0d6efd' },
  host: { icon: 'bi-pc-display', color: '#0dcaf0' },
  agent: { icon: 'bi-robot', color: '#6f42c1' },
  service: { icon: 'bi-gear', color: '#6c757d' },
};

const kindLabels = {
  user: '用户',
  host: '主机',
  agent: '智能体',
  service: '服务',
};

const kind = computed(() => props.principal?.kind || '');
const meta = computed(() => kindMeta[kind.value] ?? kindMeta.service);
const kindLabel = computed(() => kindLabels[kind.value] ?? kind.value);
const displayName = computed(() => props.principal?.name || props.principal?.id || '未知主体');
</script>

<template>
  <span class="principal-chip d-inline-flex align-items-center gap-1">
    <i class="bi" :class="meta.icon" :style="{ color: meta.color }"></i>
    <span class="text-truncate">{{ displayName }}</span>
    <span v-if="kind" class="principal-chip-kind">{{ kindLabel }}</span>
    <span v-if="role" class="principal-chip-kind">· {{ role }}</span>
  </span>
</template>

<style scoped>
/* 低权重描边胶囊：代替原先的 badge 白色实心样式，减少视觉噪音 */
.principal-chip {
  max-width: 16rem;
  padding: 0.02rem 0.5rem;
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  background: transparent;
  color: var(--text-body);
  font-size: 0.78rem;
  font-weight: 500;
  line-height: 1.5;
}

.principal-chip-kind {
  color: var(--text-faint);
  font-size: 0.72rem;
  white-space: nowrap;
}
</style>
