<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Modal } from 'bootstrap';
import { api } from '../api';
import Pagination from '../components/Pagination.vue';

const tab = ref('attachments'); // attachments | llm | prompts | logs
const settings = ref({});
const models = ref([]);
const providers = ref([]);
const saveMsg = ref('');
const err = ref('');
const llmTest = ref(null);
const llmScanning = ref(false);
const scanResult = ref(null);

// 日志 tab（集中：LLM 调用 / 设置变更 / 全局动态，分页）
const logTab = ref('calls'); // 'calls' | 'history' | 'activity'
const logItems = ref([]);
const logTotal = ref(0);
const logPage = ref(1);
const logPageSize = 10;
const logLoading = ref(false);

// Provider 编辑表单（base_url / api_key 在 provider 级共享，一个 provider 挂多个 model）
const provEditing = ref(null); // null=未打开；'__new__' 新增；id 编辑既有
const providerForm = ref(blankProvider());
const provTest = ref(null);
const provModalEl = ref(null);
let provModal = null;

// 当前选中的 provider（左侧列表选中项 → 右侧展开其下模型）
const selectedProvider = ref(null);

function blankProvider() {
  return { id: '', name: '', base_url: '', api_key: '', note: '', enabled: true };
}

/** 选中 provider 的完整信息 */
const providersOfSelected = computed(() => providers.value.find((p) => p.id === selectedProvider.value) || null);
/** 选中 provider 下的模型 */
const modelsOfSelected = computed(() => models.value.filter((m) => m.provider_id === selectedProvider.value));
/** 某 provider 的模型数（列表徽标） */
function modelCount(pid) {
  return models.value.filter((m) => m.provider_id === pid).length;
}

function selectProvider(id) {
  selectedProvider.value = id;
  provEditing.value = null;
  modelEditing.value = null;
}

// 模型编辑表单（挂在 provider 下，行内不再持有 base_url/api_key）
const modelEditing = ref(null); // null=未打开；'__new__' 新增；id 编辑既有
const modelForm = ref(blankModel());
const modelTest = ref(null);
const modelModalEl = ref(null);
let modelModal = null;

function blankModel() {
  return { id: '', provider_id: '', name: '', model: '', vision: false, temperature: null, price: '', note: '', enabled: true };
}

/** 可用模型 = 模型启用 且 所属 provider 启用（用途映射下拉用） */
const usableModels = computed(() => models.value.filter((m) => m.enabled && m.provider_enabled));

async function load() {
  const data = await api.settings();
  settings.value = { ...data.settings };
  providers.value = (await api.llmProviders()).providers || [];
  models.value = (await api.llmModels()).models || [];
  if (tab.value === 'logs') await loadLogs();
  // 默认选中第一个 provider
  if (!selectedProvider.value || !providers.value.some((p) => p.id === selectedProvider.value)) {
    selectedProvider.value = providers.value[0]?.id ?? null;
  }
}

onMounted(load);

// 切到「日志」tab 才加载
watch(tab, (t) => { if (t === 'logs') loadLogs(); });

/** 加载当前日志类型的一页 */
async function loadLogs() {
  logLoading.value = true;
  try {
    if (logTab.value === 'history') {
      const r = await api.settingsHistory(logPage.value, logPageSize);
      logItems.value = r.history || [];
      logTotal.value = r.total ?? 0;
    } else if (logTab.value === 'activity') {
      const r = await api.activity(logPage.value, logPageSize);
      logItems.value = r.activity || [];
      logTotal.value = r.total ?? 0;
    } else {
      const r = await api.llmCalls(logPage.value, logPageSize);
      logItems.value = r.calls || [];
      logTotal.value = r.total ?? 0;
    }
  } catch (e) {
    err.value = e.message;
  } finally {
    logLoading.value = false;
  }
}

function switchLog(t) {
  logTab.value = t;
  logPage.value = 1;
  loadLogs();
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fmtBytes(n) {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

async function saveAttachments() {
  err.value = ''; saveMsg.value = '';
  try {
    await api.saveSettings({
      attachments_root: settings.value.attachments_root,
      quota_bytes: String(num(settings.value.quota_bytes, 1024 * 1024 * 1024)),
      max_attachment_bytes: String(num(settings.value.max_attachment_bytes, 50 * 1024 * 1024)),
      clamd_host: settings.value.clamd_host,
      clamd_port: settings.value.clamd_port,
    });
    saveMsg.value = '附件配置已保存（立即生效）';
  } catch (e) { err.value = e.message; }
}

// ── Provider CRUD（新增/编辑走 modal） ──
function openProviderModal(p = null) {
  modelEditing.value = null;
  provTest.value = null;
  if (p) {
    provEditing.value = p.id;
    selectedProvider.value = p.id;
    providerForm.value = { ...p, api_key: '' };
  } else {
    provEditing.value = '__new__';
    providerForm.value = blankProvider();
  }
  provModal = new Modal(provModalEl.value);
  provModal.show();
}

function closeProviderModal() {
  provModal?.hide();
  provEditing.value = null;
  providerForm.value = blankProvider();
}

async function saveProvider() {
  err.value = ''; saveMsg.value = '';
  try {
    const payload = { ...providerForm.value };
    if (payload.api_key === '******') delete payload.api_key;
    const wasNew = provEditing.value === '__new__';
    const r = await api.saveLlmProvider(payload);
    provModal?.hide();
    provEditing.value = null;
    providerForm.value = blankProvider();
    providers.value = (await api.llmProviders()).providers || [];
    // 新增后自动选中新建的 provider；编辑则保持当前选中
    if (wasNew && r.id) selectedProvider.value = r.id;
    saveMsg.value = 'Provider 已保存';
  } catch (e) { err.value = e.message; }
}

function addProvider() { openProviderModal(); }

function editProvider(p) { openProviderModal(p); }

async function removeProvider(id) {
  if (!confirm(`删除 Provider ${id}（其下模型需先清空）？`)) return;
  err.value = '';
  try {
    await api.deleteLlmProvider(id);
    providers.value = (await api.llmProviders()).providers || [];
    // 被删/失效的选中项 → 回落第一个
    if (!providers.value.some((p) => p.id === selectedProvider.value)) {
      selectedProvider.value = providers.value[0]?.id ?? null;
    }
  } catch (e) { err.value = e.message; }
}

// ── 模型 CRUD（挂在 provider 下；新增/编辑走 modal） ──
function openModelModal(m = null) {
  provEditing.value = null;
  modelTest.value = null;
  if (m) {
    modelEditing.value = m.id;
    modelForm.value = { ...m };
  } else {
    modelEditing.value = '__new__';
    modelForm.value = blankModel();
    modelForm.value.provider_id = selectedProvider.value || providers.value[0]?.id || '';
  }
  modelModal = new Modal(modelModalEl.value);
  modelModal.show();
}

function closeModelModal() {
  modelModal?.hide();
  modelEditing.value = null;
  modelForm.value = blankModel();
}

async function saveModel() {
  err.value = ''; saveMsg.value = '';
  try {
    await api.saveLlmModel({ ...modelForm.value });
    modelModal?.hide();
    modelEditing.value = null;
    modelForm.value = blankModel();
    models.value = (await api.llmModels()).models || [];
    saveMsg.value = '模型已保存';
  } catch (e) { err.value = e.message; }
}

function addModel() { openModelModal(); }

function editModel(m) { openModelModal(m); }

async function removeModel(id) {
  if (!confirm(`删除模型 ${id}？`)) return;
  err.value = '';
  try {
    await api.deleteLlmModel(id);
    models.value = (await api.llmModels()).models || [];
  } catch (e) { err.value = e.message; }
}

async function saveLlmBinding() {
  err.value = ''; saveMsg.value = '';
  try {
    await api.saveSettings({
      llm_audit_model: settings.value.llm_audit_model,
      llm_verify_model: settings.value.llm_verify_model,
      llm_verifier_read_bytes: String(num(settings.value.llm_verifier_read_bytes, 64 * 1024)),
      llm_timeout_ms: String(num(settings.value.llm_timeout_ms, 60000)),
    });
    saveMsg.value = '用途映射已保存';
  } catch (e) { err.value = e.message; }
}

async function savePrompts() {
  err.value = ''; saveMsg.value = '';
  try {
    await api.saveSettings({
      prompt_audit: settings.value.prompt_audit,
      prompt_verify: settings.value.prompt_verify,
    });
    saveMsg.value = '提示词已保存（修改已留痕）';
  } catch (e) { err.value = e.message; }
}

// 测试模型连接：既有模型按 id；新增模型按 provider + 模型串（临时，不落库）
async function testModel() {
  modelTest.value = null;
  try {
    if (modelEditing.value && modelEditing.value !== '__new__') {
      modelTest.value = await api.testLlm({ model_id: modelEditing.value });
    } else {
      modelTest.value = await api.testLlm({ provider_id: modelForm.value.provider_id, model: modelForm.value.model });
    }
  } catch (e) {
    modelTest.value = { ok: false, detail: e.message };
  }
}

// 测试选中 provider 连接（用其下第一个模型）
async function testProvider() {
  provTest.value = null;
  try {
    provTest.value = await api.testLlm({ provider_id: selectedProvider.value || undefined });
  } catch (e) {
    provTest.value = { ok: false, detail: e.message };
  }
}

// 测试第一个可用模型（用途映射区按钮）
async function testDefault() {
  llmTest.value = null;
  try {
    llmTest.value = await api.testLlm({});
  } catch (e) {
    llmTest.value = { ok: false, detail: e.message };
  }
}

onBeforeUnmount(() => { provModal?.dispose(); modelModal?.dispose(); });

async function scanQueues() {
  llmScanning.value = true;
  scanResult.value = null;
  try {
    scanResult.value = await api.llmScan();
    await load();
  } catch (e) {
    err.value = e.message;
  } finally {
    llmScanning.value = false;
  }
}
</script>

<template>
  <div class="d-flex justify-content-between align-items-center mb-3">
    <div>
      <h4 class="mb-0 fw-bold">系统设置</h4>
      <div class="text-secondary small">附件 · LLM（provider → 多模型 / 多模态 / 价格）· 提示词（存库而非 .env，修改即时生效）</div>
    </div>
    <button class="btn btn-outline-primary" @click="scanQueues" :disabled="llmScanning">
      <i class="bi bi-play-circle me-1"></i>{{ llmScanning ? '扫描中…' : '立即扫描审核/验收队列' }}
    </button>
  </div>

  <div v-if="err" class="alert alert-danger py-2">{{ err }}</div>
  <div v-if="saveMsg" class="alert alert-success py-2">{{ saveMsg }}</div>
  <div v-if="scanResult" class="alert alert-info py-2 small">
    扫描完成：审核队列 处理 {{ scanResult.audit.processed }}（驳回 {{ scanResult.audit.rejected }}，降级 {{ scanResult.audit.degraded }}）；
    验收队列 处理 {{ scanResult.verify.processed }}（通过 {{ scanResult.verify.passed }}，驳回 {{ scanResult.verify.failed }}，降级 {{ scanResult.verify.degraded }}）
  </div>

  <!-- Tab 导航 -->
  <ul class="nav nav-tabs">
    <li class="nav-item">
      <button class="nav-link" :class="{ active: tab === 'attachments' }" @click="tab = 'attachments'">
        <i class="bi bi-paperclip me-1"></i>附件
      </button>
    </li>
    <li class="nav-item">
      <button class="nav-link" :class="{ active: tab === 'llm' }" @click="tab = 'llm'">
        <i class="bi bi-cpu me-1"></i>LLM Provider / 模型
        <span v-if="usableModels.length" class="badge text-bg-success ms-1" style="font-size:0.6rem">{{ usableModels.length }}</span>
      </button>
    </li>
    <li class="nav-item">
      <button class="nav-link" :class="{ active: tab === 'prompts' }" @click="tab = 'prompts'">
        <i class="bi bi-chat-quote me-1"></i>提示词
      </button>
    </li>
    <li class="nav-item">
      <button class="nav-link" :class="{ active: tab === 'logs' }" @click="tab = 'logs'">
        <i class="bi bi-journal-text me-1"></i>日志
        <span v-if="logTotal" class="badge text-bg-secondary ms-1" style="font-size:0.6rem">{{ logTotal }}</span>
      </button>
    </li>
  </ul>

  <div class="tab-content border border-top-0 rounded-bottom p-3 surface-panel" style="min-height:60vh">

    <!-- ═══════ Tab：附件 ═══════ -->
    <div v-if="tab === 'attachments'" class="tab-pane active" style="max-width:760px">
      <div class="row g-3">
        <div class="col-12">
          <label class="form-label">附件根路径（可迁移，DB 只存相对路径）</label>
          <input v-model="settings.attachments_root" class="form-control" placeholder="./attachments">
        </div>
        <div class="col-6">
          <label class="form-label">账号配额（字节，默认 1GB）</label>
          <input v-model="settings.quota_bytes" class="form-control" placeholder="1073741824">
          <div class="text-secondary small mt-1">≈ {{ fmtBytes(num(settings.quota_bytes, 0)) }}</div>
        </div>
        <div class="col-6">
          <label class="form-label">单文件上限（字节，默认 50MB）</label>
          <input v-model="settings.max_attachment_bytes" class="form-control" placeholder="52428800">
          <div class="text-secondary small mt-1">≈ {{ fmtBytes(num(settings.max_attachment_bytes, 0)) }}</div>
        </div>
        <div class="col-6">
          <label class="form-label">clamd 主机（空 = 跳过扫描降级标 skipped）</label>
          <input v-model="settings.clamd_host" class="form-control" placeholder="127.0.0.1">
        </div>
        <div class="col-6">
          <label class="form-label">clamd 端口</label>
          <input v-model="settings.clamd_port" class="form-control" placeholder="3310">
        </div>
        <div class="col-12">
          <button class="btn btn-primary" @click="saveAttachments">保存附件配置</button>
        </div>
      </div>
    </div>

    <!-- ═══════ Tab：LLM（左 provider 4/12 · 右 model 8/12） ═══════ -->
    <div v-if="tab === 'llm'" class="tab-pane active">
      <div class="row g-3">

        <!-- ── 左：Provider 管理 panel（4/12） ── -->
        <div class="col-md-4">
          <div class="border rounded p-3 surface-panel h-100">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <h6 class="mb-0 fw-semibold"><i class="bi bi-hdd-network me-1"></i>Provider</h6>
              <button class="btn btn-sm btn-outline-primary" @click="addProvider"><i class="bi bi-plus me-1"></i>新增</button>
            </div>
            <div class="text-secondary small mb-2">Base URL / API Key 在此级共享，一个 provider 挂多个 model。</div>

            <!-- Provider 列表（点击选中 → 右侧展开其下模型；选中项行内操作） -->
            <div class="list-group list-group-flush border rounded" style="max-height:46vh;overflow-y:auto">
              <div v-for="p in providers" :key="p.id" role="button"
                class="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 py-2"
                :class="{ 'bg-primary-subtle border-primary': selectedProvider === p.id }"
                style="cursor:pointer"
                @click="selectProvider(p.id)">
                <div style="min-width:0">
                  <div class="fw-semibold text-truncate">{{ p.name }}
                    <span v-if="!p.enabled" class="badge text-bg-secondary align-middle">禁用</span>
                  </div>
                  <div class="small text-secondary text-truncate"><code>{{ p.id }}</code> · {{ p.base_url }}</div>
                </div>
                <div class="d-flex flex-shrink-0 align-items-center gap-1">
                  <span class="badge text-bg-light border">{{ modelCount(p.id) }} 模型</span>
                  <span v-if="selectedProvider === p.id" class="btn-group btn-group-sm" @click.stop>
                    <button class="btn btn-outline-secondary py-0 px-1" title="编辑" @click="editProvider(p)"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-outline-info py-0 px-1" title="测试连接" @click="testProvider"><i class="bi bi-plug"></i></button>
                    <button class="btn btn-outline-danger py-0 px-1" title="删除" @click="removeProvider(p.id)"><i class="bi bi-trash"></i></button>
                  </span>
                </div>
              </div>
              <div v-if="providers.length === 0" class="text-secondary small p-3">
                未配置 provider。点右上「新增」添加（如 OpenAI / DeepSeek / 本地 vLLM），再在右侧挂模型。
              </div>
            </div>

            <!-- 选中项测试结果 -->
            <div v-if="provTest" class="mt-2 small alert py-1 mb-0" :class="provTest.ok ? 'alert-success' : 'alert-danger'">{{ provTest.ok ? '✓ ' : '✗ ' }}{{ provTest.detail }}</div>
          </div>
        </div>

        <!-- ── 右：Model 管理 panel（8/12） ── -->
        <div class="col-md-8">
          <!-- 模型列表（选中 provider 的模型） -->
          <div class="border rounded p-3 mb-3 surface-panel">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <h6 class="mb-0 fw-semibold"><i class="bi bi-collection me-1"></i>{{ providersOfSelected ? `${providersOfSelected.name} 的模型` : '模型' }}（{{ modelsOfSelected.length }}）</h6>
              <button class="btn btn-sm btn-outline-primary" @click="addModel" :disabled="!selectedProvider"><i class="bi bi-plus me-1"></i>新增模型</button>
            </div>
            <div v-if="!selectedProvider" class="text-secondary small p-3">先在左侧选择或新增一个 provider，再管理其下的模型。</div>
            <div v-else class="table-responsive">
              <table class="table table-sm table-hover align-middle">
                <thead><tr><th>名称</th><th>模型 ID（请求体）</th><th>能力</th><th>价格</th><th>温度</th><th>状态</th><th class="text-end">操作</th></tr></thead>
                <tbody>
                  <tr v-for="m in modelsOfSelected" :key="m.id" :class="{ 'table-secondary': !m.enabled }">
                    <td>{{ m.name }} <span v-if="m.note" class="text-secondary small">({{ m.note }})</span></td>
                    <td class="small">{{ m.model }}</td>
                    <td><span v-if="m.vision" class="badge text-bg-primary" title="多模态，可识图">🖼 多模态</span><span v-else class="text-secondary small">文本</span></td>
                    <td class="small">{{ m.price || '—' }}</td>
                    <td>{{ m.temperature ?? '1（默认）' }}</td>
                    <td>{{ m.enabled ? '✓ 启用' : '✗ 禁用' }}</td>
                    <td class="text-end">
                      <button class="btn btn-sm btn-outline-secondary me-1" @click="editModel(m)">编辑</button>
                      <button class="btn btn-sm btn-outline-danger" @click="removeModel(m.id)">删除</button>
                    </td>
                  </tr>
                  <tr v-if="modelsOfSelected.length === 0">
                    <td colspan="7" class="text-secondary small p-3">该 provider 下暂无模型。点右上「新增模型」添加（如 gpt-4o / deepseek-chat / qwen2.5）。</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 用途映射 -->
          <div class="border rounded p-3 mb-3 surface-panel">
            <h6 class="fw-semibold mb-2"><i class="bi bi-diagram-3 me-1"></i>用途映射与读取边界</h6>
            <div class="row g-2 align-items-end">
              <div class="col-md-3">
                <label class="form-label small">审核用模型</label>
                <select v-model="settings.llm_audit_model" class="form-select form-select-sm">
                  <option value="auto">auto（自动）</option>
                  <option v-for="m in usableModels" :key="m.id" :value="m.id">{{ m.provider_name }} / {{ m.name }}（{{ m.id }}）</option>
                </select>
              </div>
              <div class="col-md-3">
                <label class="form-label small">验收用模型（有图自动多模态）</label>
                <select v-model="settings.llm_verify_model" class="form-select form-select-sm">
                  <option value="auto">auto（有图自动多模态）</option>
                  <option v-for="m in usableModels" :key="m.id" :value="m.id">{{ m.provider_name }} / {{ m.name }}（{{ m.id }}）</option>
                </select>
              </div>
              <div class="col-md-2">
                <label class="form-label small">验收读文本上限（字节）</label>
                <input v-model="settings.llm_verifier_read_bytes" class="form-control form-control-sm" placeholder="65536">
              </div>
              <div class="col-md-2">
                <label class="form-label small">调用超时（毫秒）</label>
                <input v-model="settings.llm_timeout_ms" class="form-control form-control-sm" placeholder="60000">
              </div>
              <div class="col-md-2 d-flex gap-2">
                <button class="btn btn-sm btn-primary" @click="saveLlmBinding">保存</button>
                <button class="btn btn-sm btn-outline-secondary" @click="testDefault">测试默认</button>
              </div>
            </div>
            <div v-if="llmTest" class="mt-2 small alert py-2 mb-0" :class="llmTest.ok ? 'alert-success' : 'alert-danger'">{{ llmTest.ok ? '✓ ' : '✗ ' }}{{ llmTest.detail }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════ Tab：提示词 ═══════ -->
    <div v-if="tab === 'prompts'" class="tab-pane active">
      <div class="row g-3">
        <div class="col-lg-6">
          <label class="form-label">审核提示词（占位符：title / instruction / deliverable_spec；要求输出 JSON：passed + reason）</label>
          <textarea v-model="settings.prompt_audit" class="form-control" rows="14" style="font-family:monospace;font-size:0.8rem"
                    :placeholder="'内置默认：审核描述清晰度+验收方案可操作性，输出 JSON {passed:bool, reason:str}'"></textarea>
        </div>
        <div class="col-lg-6">
          <label class="form-label">验收提示词（额外占位符：deliverables_text；有图片交付物时自动附图片给多模态模型）</label>
          <textarea v-model="settings.prompt_verify" class="form-control" rows="14" style="font-family:monospace;font-size:0.8rem"
                    :placeholder="'内置默认：按验收方案校验交付物，输出 JSON {passed:bool, reason:str}'"></textarea>
        </div>
        <div class="col-12">
          <button class="btn btn-primary" @click="savePrompts">保存提示词（留痕）</button>
          <span class="text-secondary small ms-2">提示词即平台审核口径，修改自动记录 改人 / 改时 / 前值。</span>
        </div>
      </div>
    </div>
  </div>
    <!-- ═══════ Tab：日志（集中 + 分页） ═══════ -->
    <div v-if="tab === 'logs'" class="tab-pane active">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <div class="btn-group btn-group-sm">
          <button class="btn" :class="logTab === 'calls' ? 'btn-primary' : 'btn-outline-primary'" @click="switchLog('calls')">
            <i class="bi bi-cpu me-1"></i>LLM 调用
          </button>
          <button class="btn" :class="logTab === 'history' ? 'btn-primary' : 'btn-outline-primary'" @click="switchLog('history')">
            <i class="bi bi-clock-history me-1"></i>设置变更
          </button>
          <button class="btn" :class="logTab === 'activity' ? 'btn-primary' : 'btn-outline-primary'" @click="switchLog('activity')">
            <i class="bi bi-activity me-1"></i>全局动态
          </button>
        </div>
        <span class="text-secondary small">共 {{ logTotal }} 条 · 每页 {{ logPageSize }}</span>
      </div>

      <div v-if="logLoading" class="text-secondary small p-3">加载中…</div>

      <!-- LLM 调用日志 -->
      <div v-else-if="logTab === 'calls'" class="table-responsive">
        <table class="table table-sm table-hover">
          <thead><tr><th>时间</th><th>Provider</th><th>模型</th><th>用途</th><th>任务</th><th>识图</th><th>tokens(入/出)</th><th>价格</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="c in logItems" :key="c.id">
              <td class="text-secondary small">{{ c.created_at }}</td>
              <td class="small">{{ c.provider_name || c.provider_id || '—' }}</td>
              <td><code>{{ c.model_id }}</code></td>
              <td>{{ c.purpose }}</td>
              <td class="small">{{ c.task_id || '—' }}</td>
              <td>{{ c.vision ? '🖼' : '—' }}</td>
              <td class="small">{{ c.prompt_tokens }} / {{ c.completion_tokens }}</td>
              <td class="small">{{ c.price || '—' }}</td>
              <td><span v-if="c.ok" class="text-success">✓</span><span v-else class="text-danger small" :title="c.error">✗ {{ c.error }}</span></td>
            </tr>
            <tr v-if="logItems.length === 0"><td colspan="9" class="text-secondary small p-3">暂无调用记录。</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 设置/提示词修改留痕 -->
      <div v-else-if="logTab === 'history'" class="table-responsive">
        <table class="table table-sm table-hover">
          <thead><tr><th>时间</th><th>改人</th><th>配置项</th><th>前值（截断）</th><th>新值（截断）</th></tr></thead>
          <tbody>
            <tr v-for="h in logItems" :key="h.id">
              <td class="text-secondary small">{{ h.created_at }}</td>
              <td>{{ h.changed_by }}</td>
              <td><code>{{ h.k }}</code></td>
              <td class="small text-secondary">{{ String(h.old_v || '').slice(0, 80) }}</td>
              <td class="small">{{ String(h.new_v || '').slice(0, 80) }}</td>
            </tr>
            <tr v-if="logItems.length === 0"><td colspan="5" class="text-secondary small p-3">暂无修改记录。</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 全局动态（产出 / 回复） -->
      <div v-else class="table-responsive">
        <table class="table table-sm table-hover">
          <thead><tr><th>时间</th><th>类型</th><th>来源</th><th>任务</th><th>内容（截断）</th></tr></thead>
          <tbody>
            <tr v-for="(a, i) in logItems" :key="i">
              <td class="text-secondary small">{{ a.created_at }}</td>
              <td><span class="badge" :class="a.type === 'report' ? 'text-bg-info' : 'text-bg-light border'">{{ a.type === 'report' ? '产出' : '回复' }}</span></td>
              <td class="small">{{ a.who || '—' }}</td>
              <td class="small">{{ a.task_id || '—' }}</td>
              <td class="small text-secondary">{{ String(a.content || '').slice(0, 120) }}</td>
            </tr>
            <tr v-if="logItems.length === 0"><td colspan="5" class="text-secondary small p-3">暂无动态。</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 分页控件 -->
      <div class="mt-2">
        <Pagination :total="logTotal" v-model:page="logPage" :page-size="logPageSize" @change="loadLogs" />
      </div>
    </div>

  <!-- ── Provider 新增/编辑 modal ── -->
  <div ref="provModalEl" class="modal fade" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header py-2">
          <h5 class="modal-title">{{ provEditing === '__new__' ? '新增 Provider' : `编辑 Provider：${provEditing}` }}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <div class="row g-2">
            <div class="col-12" v-if="provEditing !== '__new__'">
              <label class="form-label small mb-0">ID（主键）</label>
              <input v-model="providerForm.id" class="form-control form-control-sm" disabled>
            </div>
            <div class="col-12">
              <label class="form-label small mb-0">名称 *</label>
              <input v-model="providerForm.name" class="form-control form-control-sm" placeholder="OpenAI">
            </div>
            <div class="col-12">
              <label class="form-label small mb-0">Base URL *（其下所有模型共用）</label>
              <input v-model="providerForm.base_url" class="form-control form-control-sm" placeholder="https://api.openai.com/v1">
            </div>
            <div class="col-12">
              <label class="form-label small mb-0">API Key（空 = 保留原值）</label>
              <input v-model="providerForm.api_key" type="password" class="form-control form-control-sm" placeholder="sk-...">
            </div>
            <div class="col-12">
              <label class="form-label small mb-0">备注</label>
              <input v-model="providerForm.note" class="form-control form-control-sm" placeholder="官方 / 中转 / 本地">
            </div>
            <div class="col-12">
              <div class="form-check form-switch">
                <input v-model="providerForm.enabled" type="checkbox" class="form-check-input" id="pEnable">
                <label class="form-check-label small" for="pEnable">启用</label>
              </div>
            </div>
          </div>
          <div v-if="provTest" class="mt-2 small alert py-2 mb-0" :class="provTest.ok ? 'alert-success' : 'alert-danger'">{{ provTest.ok ? '✓ ' : '✗ ' }}{{ provTest.detail }}</div>
        </div>
        <div class="modal-footer py-2">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
          <button type="button" class="btn btn-primary" @click="saveProvider">保存</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ── 模型新增/编辑 modal（固定挂当前选中 provider） ── -->
  <div ref="modelModalEl" class="modal fade" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header py-2">
          <h5 class="modal-title">{{ modelEditing === '__new__' ? `新增模型（挂 ${providersOfSelected?.name ?? selectedProvider}）` : `编辑模型：${modelEditing}` }}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <div class="row g-2">
            <div class="col-md-6" v-if="modelEditing !== '__new__'">
              <label class="form-label small mb-0">ID（主键）</label>
              <input v-model="modelForm.id" class="form-control form-control-sm" disabled>
            </div>
            <div class="col-md-6">
              <label class="form-label small mb-0">名称 *</label>
              <input v-model="modelForm.name" class="form-control form-control-sm" placeholder="GPT-4o mini">
            </div>
            <div class="col-md-6">
              <label class="form-label small mb-0">模型 ID *（请求体 model 字段）</label>
              <input v-model="modelForm.model" class="form-control form-control-sm" placeholder="gpt-4o-mini">
            </div>
            <div class="col-md-6">
              <label class="form-label small mb-0">温度（0–2，空 = 默认 1）</label>
              <input v-model.number="modelForm.temperature" type="number" step="0.1" min="0" max="2" class="form-control form-control-sm" placeholder="1（部分模型仅允许 1）">
            </div>
            <div class="col-md-6">
              <label class="form-label small mb-0">价格标记（留痕）</label>
              <input v-model="modelForm.price" class="form-control form-control-sm" placeholder="¥1.2/1M tokens">
            </div>
            <div class="col-md-6">
              <label class="form-label small mb-0">备注</label>
              <input v-model="modelForm.note" class="form-control form-control-sm" placeholder="快 / 便宜 / 识图">
            </div>
            <div class="col-md-6 d-flex align-items-end gap-3">
              <div class="form-check form-switch">
                <input v-model="modelForm.vision" type="checkbox" class="form-check-input" id="mVision">
                <label class="form-check-label small" for="mVision">多模态（识图）</label>
              </div>
              <div class="form-check form-switch">
                <input v-model="modelForm.enabled" type="checkbox" class="form-check-input" id="mEnable">
                <label class="form-check-label small" for="mEnable">启用</label>
              </div>
            </div>
          </div>
          <div v-if="modelTest" class="mt-2 small alert py-2 mb-0" :class="modelTest.ok ? 'alert-success' : 'alert-danger'">{{ modelTest.ok ? '✓ ' : '✗ ' }}{{ modelTest.detail }}</div>
        </div>
        <div class="modal-footer py-2">
          <button type="button" class="btn btn-outline-info" @click="testModel"><i class="bi bi-plug me-1"></i>测试此配置</button>
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
          <button type="button" class="btn btn-primary" @click="saveModel">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
