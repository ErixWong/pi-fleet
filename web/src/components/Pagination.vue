<script setup>
/**
 * 通用分页组件（Bootstrap 5 分页条）。
 * 用法：
 *   <Pagination :total="total" v-model:page="page" :page-size="10" @change="load" />
 * - total    总条数（Number）
 * - page     当前页（v-model:page 双向绑定）
 * - pageSize 每页条数（默认 20）
 * - @change  翻页后触发（把新 page 传给后端重新拉数据）
 * 约定：后端分页接口统一返回 { items..., total, page, page_size }。
 */
import { computed } from 'vue';

const props = defineProps({
  total: { type: Number, required: true },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 10 },
});
const emit = defineEmits(['update:page', 'change']);

const totalPages = computed(() => Math.max(1, Math.ceil((props.total || 0) / props.pageSize)));

/** 页码列表（首尾 + 当前窗口 ±2，中间用省略号 … 占位） */
const pageList = computed(() => {
  const n = totalPages.value;
  if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1);
  const cur = Math.min(props.page, n);
  const set = new Set([1, n, cur - 2, cur - 1, cur, cur + 1, cur + 2].filter((p) => p >= 1 && p <= n));
  const sorted = [...set].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
});

function go(p) {
  if (typeof p !== 'number' || p < 1 || p > totalPages.value || p === props.page) return;
  emit('update:page', p);
  emit('change', p);
}
</script>

<template>
  <div v-if="totalPages > 1" class="d-flex flex-wrap justify-content-between align-items-center gap-2">
    <span class="text-secondary small">共 {{ total }} 条 · 第 {{ page }} / {{ totalPages }} 页 · 每页 {{ pageSize }}</span>
    <ul class="pagination pagination-sm mb-0">
      <li class="page-item" :class="{ disabled: page <= 1 }">
        <button class="page-link" type="button" @click="go(page - 1)" aria-label="上一页">&laquo;</button>
      </li>
      <li v-for="(p, i) in pageList" :key="i" class="page-item" :class="{ active: p === page, disabled: p === '…' }">
        <button class="page-link" type="button" @click="go(p)">{{ p }}</button>
      </li>
      <li class="page-item" :class="{ disabled: page >= totalPages }">
        <button class="page-link" type="button" @click="go(page + 1)" aria-label="下一页">&raquo;</button>
      </li>
    </ul>
  </div>
</template>
