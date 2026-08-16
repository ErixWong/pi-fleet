<script setup>
import { ref, computed, watch } from 'vue';

/**
 * 标签选择器：按分类分组 chips 多选 + 自定义标签输入
 * props.modelValue：选中的标签 name 数组（与后端 setAgentTags/setTaskTags 对齐，自动解析内置/建自定义）
 * props.entityScope：'host'（显示 环境/部署/OS/架构/运行环境）| 'task'（显示 任务类型/技术栈=both runtime）
 * 已选中的自定义标签（不在目录里）也回显成 chips 可取消。
 */
const props = defineProps({
  groups: { type: Array, default: () => [] },
  modelValue: { type: Array, default: () => [] },
  entityScope: { type: String, default: 'host' },
});
const emit = defineEmits(['update:modelValue']);

const sel = ref(new Set(props.modelValue));
watch(
  () => props.modelValue,
  (v) => { sel.value = new Set(v); },
);

/** 当前实体可用的内置分类（both 双向复用：runtime 两边都显示） */
const visibleGroups = computed(() => {
  const wanted = props.entityScope === 'host' ? ['env', 'deploy', 'os', 'arch', 'runtime'] : ['type', 'runtime'];
  return props.groups
    .filter((g) => wanted.includes(g.category))
    .map((g) => ({
      ...g,
      tags: g.tags.filter((t) => t.scope === 'both' || t.scope === props.entityScope),
    }))
    .filter((g) => g.tags.length > 0);
});

/** 不在目录里的已选标签（自定义，回显可取消） */
const customSelected = computed(() => {
  const known = new Set(visibleGroups.value.flatMap((g) => g.tags.map((t) => t.name)));
  return [...sel.value].filter((n) => !known.has(n));
});

function toggle(name) {
  if (sel.value.has(name)) sel.value.delete(name);
  else sel.value.add(name);
  emit('update:modelValue', [...sel.value]);
}

const customInput = ref('');
function addCustom() {
  const n = customInput.value.trim();
  if (n && !sel.value.has(n)) {
    sel.value.add(n);
    emit('update:modelValue', [...sel.value]);
  }
  customInput.value = '';
}
</script>

<template>
  <div>
    <div v-for="g in visibleGroups" :key="g.category" class="mb-1">
      <span class="text-secondary small me-2" style="width: 90px; display: inline-block">{{ g.title }}</span>
      <button v-for="t in g.tags" :key="t.id" type="button"
              class="btn btn-sm me-1 mb-1"
              :class="sel.has(t.name) ? 'btn-primary' : 'btn-outline-secondary'"
              @click.prevent="toggle(t.name)">
        {{ t.label }}
      </button>
    </div>
    <div v-if="customSelected.length" class="mb-1">
      <span class="text-secondary small me-2" style="width: 90px; display: inline-block">自定义</span>
      <button v-for="n in customSelected" :key="n" type="button" class="btn btn-sm btn-primary me-1 mb-1" @click.prevent="toggle(n)">
        {{ n }} <i class="bi bi-x"></i>
      </button>
    </div>
    <div class="input-group input-group-sm" style="max-width: 300px">
      <input v-model="customInput" class="form-control" placeholder="自定义标签，回车添加" @keydown.enter.prevent="addCustom">
      <button type="button" class="btn btn-outline-secondary" @click.prevent="addCustom"><i class="bi bi-plus"></i></button>
    </div>
  </div>
</template>
