<script setup>
import { computed } from 'vue';
import StatusBadge from './StatusBadge.vue';
import PrincipalChip from './PrincipalChip.vue';

const props = defineProps({
  parent: { type: Object, default: null },
  children: { type: Array, default: () => [] },
  tree: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
});

const emit = defineEmits(['select']);

function flattenTree(node, depth = 0, output = []) {
  if (!node) return output;
  output.push({ ...node, depth });
  for (const child of node.children ?? []) flattenTree(child, depth + 1, output);
  return output;
}

function fallbackSummary(child) {
  const submitLine = child.latest_submit_summary?.body?.split(/\r?\n/, 1)[0]?.trim();
  if (submitLine) return submitLine;
  return `${child.title || child.post_id} · ${child.status || '未知'} · ${child.assignee?.name || '未分配'}`;
}

const nodes = computed(() => {
  if (props.tree) return flattenTree(props.tree);
  return props.children.map((child) => ({
    id: child.post_id,
    title: child.title,
    status: child.status,
    summary: fallbackSummary(child),
    executor: null,
    assignee: child.assignee,
    children: [],
    depth: 0,
  }));
});

const rollup = computed(() => {
  const descendants = nodes.value.slice(props.tree ? 1 : 0);
  const done = descendants.filter((node) => node.status === 'done').length;
  const failed = descendants.filter((node) => ['failed', 'cancelled'].includes(node.status)).length;
  return {
    total: descendants.length,
    done,
    failed,
    active: descendants.length - done - failed,
  };
});

function selectNode(node) {
  emit('select', node.id);
}
</script>

<template>
  <section class="card mb-3 task-tree-panel">
    <div class="card-header d-flex align-items-center gap-2">
      <strong><i class="bi bi-diagram-3 me-2"></i>任务全景</strong>
      <span class="text-secondary small ms-auto">
        {{ rollup.total }} 个下级节点
        <span v-if="rollup.total">
          · <span class="text-success">{{ rollup.done }} 完成</span>
          · <span class="text-primary">{{ rollup.active }} 进行中</span>
          · <span class="text-danger">{{ rollup.failed }} 失败</span>
        </span>
      </span>
    </div>
    <div class="card-body">
      <nav v-if="parent" aria-label="父任务" class="mb-2">
        <router-link :to="`/tasks/${parent.id}`" class="small text-decoration-none">
          <i class="bi bi-arrow-up-circle me-1"></i>父任务：{{ parent.title || parent.id }}
        </router-link>
      </nav>

      <div v-if="loading" class="text-secondary small py-3">
        <i class="bi bi-arrow-repeat me-1 spin-once"></i>正在加载完整任务树…
      </div>
      <div v-else-if="error" class="alert alert-warning small py-2 mb-0">
        <i class="bi bi-exclamation-triangle me-1"></i>{{ error }}；已回退显示当前层级。
      </div>
      <div v-if="!loading && nodes.length" class="task-tree" role="tree" aria-label="任务全景树">
        <button
          v-for="node in nodes"
          :key="node.id"
          type="button"
          class="task-tree-node"
          :data-depth="node.depth"
          :style="{ '--tree-depth': node.depth }"
          role="treeitem"
          @click="selectNode(node)"
        >
          <span class="task-tree-branch" aria-hidden="true"><i class="bi bi-chevron-right"></i></span>
          <span class="task-tree-main">
            <span class="task-tree-title text-truncate">{{ node.title || node.id }}</span>
            <span class="task-tree-summary text-truncate">{{ node.summary }}</span>
          </span>
          <StatusBadge :status="node.status" />
          <PrincipalChip v-if="node.assignee" :principal="node.assignee" role="执行者" />
          <span v-if="node.executor" class="small text-secondary text-truncate task-tree-executor">
            <i class="bi bi-cpu me-1"></i>{{ node.executor }}
          </span>
          <span v-if="!node.assignee && !node.executor" class="small text-secondary">未分配</span>
        </button>
      </div>
      <div v-else-if="!loading" class="text-secondary small mb-0">
        <i class="bi bi-info-circle me-1"></i>当前任务还没有下级节点。
      </div>
      <div v-if="nodes.length" class="text-secondary small mt-2">
        <i class="bi bi-info-circle me-1"></i>点击任意节点，在弹窗中查看该任务的完整详情。
      </div>
    </div>
  </section>
</template>
