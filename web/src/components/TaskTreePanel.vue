<script setup>
import { computed } from 'vue';
import StatusBadge from './StatusBadge.vue';
import PrincipalChip from './PrincipalChip.vue';

const props = defineProps({
  parent: { type: Object, default: null }, // { id, title }
  children: { type: Array, default: () => [] },
});

const rollup = computed(() => {
  const total = props.children.length;
  const done = props.children.filter((child) => child.status === 'done').length;
  const failed = props.children.filter((child) => ['failed', 'cancelled'].includes(child.status)).length;
  return { total, done, failed, active: total - done - failed };
});

const percent = computed(() => (rollup.value.total ? Math.round((rollup.value.done / rollup.value.total) * 100) : 0));
</script>

<template>
  <section class="card mb-3">
    <div class="card-header d-flex align-items-center gap-2">
      <strong><i class="bi bi-diagram-3 me-2"></i>子任务 ({{ rollup.total }})</strong>
      <span class="text-secondary small ms-auto">
        <i class="bi bi-check2-circle text-success me-1"></i>{{ rollup.done }}
        <i class="bi bi-circle-fill text-primary ms-2 me-1"></i>{{ rollup.active }}
        <i class="bi bi-x-circle text-danger ms-2 me-1"></i>{{ rollup.failed }}
      </span>
    </div>
    <div class="card-body">
      <nav v-if="parent" aria-label="父任务" class="mb-2">
        <router-link :to="`/tasks/${parent.id}`" class="small text-decoration-none">
          <i class="bi bi-arrow-up-circle me-1"></i>父任务：{{ parent.title || parent.id }}
        </router-link>
      </nav>
      <div v-if="rollup.total" class="progress mb-3" style="height: 6px" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-bar bg-success" :style="{ width: `${percent}%` }"></div>
      </div>
      <div v-if="rollup.total" class="list-group list-group-flush border rounded">
        <router-link v-for="child in children" :key="child.post_id" :to="`/tasks/${child.post_id}`"
          class="list-group-item list-group-item-action bg-transparent d-flex align-items-center gap-2">
          <StatusBadge :status="child.status" />
          <span class="text-truncate">{{ child.title || child.post_id }}</span>
          <PrincipalChip v-if="child.assignee" :principal="child.assignee" />
          <span v-if="child.latest_verdict" class="badge"
            :class="child.latest_verdict.decision === 'accept' ? 'text-bg-success' : 'text-bg-danger'">
            {{ child.latest_verdict.decision === 'accept' ? '验收通过' : '已打回' }}
          </span>
          <span class="text-secondary small ms-auto flex-shrink-0">尝试 {{ child.attempts }}/{{ child.max_attempts }}</span>
          <i class="bi bi-chevron-right text-secondary"></i>
        </router-link>
      </div>
      <div v-if="rollup.total" class="alert alert-info small py-2 mb-0 mt-3">
        <i class="bi bi-info-circle me-1"></i>执行者的提交摘要发布在各自子任务线程，点击子任务查看。
      </div>
      <div v-if="!rollup.total" class="text-secondary small mb-0">
        <i class="bi bi-info-circle me-1"></i>本任务暂无子任务；如有父任务，可从上方链接返回父任务线程。
      </div>
    </div>
  </section>
</template>
