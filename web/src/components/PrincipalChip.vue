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

const kind = computed(() => props.principal?.kind || '');
const meta = computed(() => kindMeta[kind.value] ?? kindMeta.service);
const displayName = computed(() => props.principal?.name || props.principal?.id || '未知主体');
</script>

<template>
  <span class="badge text-bg-light border d-inline-flex align-items-center gap-1 principal-chip">
    <i class="bi" :class="meta.icon" :style="{ color: meta.color }"></i>
    <span class="text-truncate">{{ displayName }}</span>
    <span v-if="kind" class="text-secondary">{{ kind }}</span>
    <span v-if="role" class="text-secondary">· {{ role }}</span>
  </span>
</template>
