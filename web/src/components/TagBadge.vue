<script setup>
/** 标签徽标：按 category 着色（tag.color 优先，内置分类兜底色） */
const props = defineProps({ tag: Object });
const FALLBACK = {
  env: '#0d6efd', deploy: '#20c997', os: '#198754', arch: '#fd7e14',
  runtime: '#0dcaf0', type: '#6f42c1', custom: '#adb5bd',
};
const color = (t) => t?.color || FALLBACK[t?.category] || '#adb5bd';
</script>

<template>
  <span class="tag-badge d-inline-block px-1 rounded-1 me-1 mb-1"
        :style="{ color: color(tag), backgroundColor: color(tag) + '1f', border: '1px solid ' + color(tag) + '66', fontSize: '0.72rem', lineHeight: 1.4 }"
        :title="`${tag?.name}（${tag?.category}）`">{{ tag?.label || tag?.name }}</span>
</template>
