<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';

const tab = ref('attachments'); // attachments | llm | prompts
const settings = ref({});
const history = ref([]);
const models = ref([]);
const providers = ref([]);
const calls = ref([]);
const saveMsg = ref('');
const err = ref('');
const llmTest = ref(null);
const llmScanning = ref(false);
const scanResult = ref(null);

// Provider 编辑表单（base_url / api_key 在 provider 级共享，一个 provider 挂多个 model）
const provEditing = ref(null); // null=不编辑；'__new__' 新增；id 编辑既有
const providerForm = ref(blankProvider());
const provTest = ref(null);

function blankProvider() {
  return { id: '', name: '', base_url: '', api_key: '', note: '', enabled: true };
}

// 模型编辑表单（挂在 provider 下，行内不再持有 base_url/api_key）
const modelEditing = ref(null); // null=不编辑；'__new__' 新增；id 编辑既有
const modelForm = ref(blankModel());
const modelTest = ref(null);

function blankModel() {
  return { id: '', provider_id: '', name: '', model: '', vision: false, price: '', note: '', enabled: true };
}

/** 可用模型 = 模型启用 且 所属 provider 启用（用途映射下拉用） */
const usableModels = computed(() => models.value.filter((m) => m.enabled && m.provider_enabled));

async function load() {
  const data = await api.settings();
  settings.value = { ...data.settings };
  history.value = (await api.settingsHistory()).history || [];
  providers.value = (await api.llmProviders()).providers || [];
  models.value = (await api.llmModels()).models || [];
  calls.value = (await api.llmCalls()).calls || [];
}

onMounted(load);

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

// ── Provider CRUD ──
async function saveProvider() {
  err.value = ''; saveMsg.value = '';
  try {
    const payload = { ...providerForm.value };
    if (payload.api_key === '******') delete payload.api_key;
    await api.saveLlmProvider(payload);
    provEditing.value = null;
    providerForm.value = blankProvider();
    providers.value = (await api.llmProviders()).providers || [];
    saveMsg.value = 'Provider 已保存';
  } catch (e) { err.value = e.message; }
}

function addProvider() {
  modelEditing.value = null;
  provEditing.value = '__new__';
  providerForm.value = blankProvider();
}

function editProvider(p) {
  modelEditing.value = null;
  provEditing.value = p.id;
  providerForm.value = { ...p, api_key: '' };
}

function cancelProvEdit() {
  provEditing.value = null;
  providerForm.value = blankProvider();
}

async function removeProvider(id) {
  if (!confirm(`删除 Provider ${id}（其下模型需先清空）？`)) return;
  err.value = '';
  try {
    await api.deleteLlmProvider(id);
    providers.value = (await api.llmProviders()).providers || [];
  } catch (e) { err.value = e.message; }
}

// ── 模型 CRUD（挂在 provider 下） ──
async function saveModel() {
  err.value = ''; saveMsg.value = '';
  try {
    await api.saveLlmModel({ ...modelForm.value });
    modelEditing.value = null;
    modelForm.value = blankModel();
    models.value = (await api.llmModels()).models || [];
    saveMsg.value = '模型已保存';
  } catch (e) { err.value = e.message; }
}

function addModel(providerId) {
  provEditing.value = null;
  modelEditing.value = '__new__';
  modelForm.value = blankModel();
  modelForm.value.provider_id = providerId || providers.value[0]?.id || '';
}

function editModel(m) {
  provEditing.value = null;
  modelEditing.value = m.id;
  modelForm.value = { ...m };
}

function cancelModelEdit() {
  modelEditing.value = null;
  modelForm.value = blankModel();
}

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

// 测试 provider 连接（用其下第一个模型；新建时无 id → 测默认）
async function testProvider() {
  provTest.value = null;
  try {
    provTest.value = await api.testLlm({ provider_id: provEditing.value && provEditing.value !== '__new__' ? provEditing.value : undefined });
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

    <!-- ═══════ Tab：LLM（provider → 多 model） ═══════ -->
    <div v-if="tab === 'llm'" class="tab-pane active">

      <!-- Provider 列表：base_url / API Key 在此级共享 -->
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h6 class="mb-0 fw-semibold"><i class="bi bi-hdd-network me-1"></i>Provider 列表（一个 provider 对应多个 model，Base URL / API Key 在 provider 级共享）</h6>
        <button class="btn btn-sm btn-outline-primary" @click="addProvider"><i class="bi bi-plus me-1"></i>新增 Provider</button>
      </div>
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle">
          <thead><tr><th>ID</th><th>名称</th><th>Base URL</th><th>API Key</th><th>模型数</th><th>状态</th><th class="text-end">操作</th></tr></thead>
          <tbody>
            <tr v-for="p in providers" :key="p.id" :class="{ 'table-secondary': !p.enabled }">
              <td><code>{{ p.id }}</code></td>
              <td>{{ p.name }} <span v-if="p.note" class="text-secondary small">({{ p.note }})</span></td>
              <td class="small text-secondary">{{ p.base_url }}</td>
              <td class="small">{{ p.api_key || '—' }}</td>
              <td><span class="badge text-bg-secondary">{{ models.filter(m => m.provider_id === p.id).length }}</span></td>
              <td>{{ p.enabled ? '✓ 启用' : '✗ 禁用' }}</td>
              <td class="text-end">
                <button class="btn btn-sm btn-outline-secondary me-1" @click="editProvider(p)">编辑</button>
                <button class="btn btn-sm btn-outline-primary me-1" @click="addModel(p.id)"><i class="bi bi-plus me-1"></i>模型</button>
                <button class="btn btn-sm btn-outline-danger" @click="removeProvider(p.id)">删除</button>
              </td>
            </tr>
            <tr v-if="providers.length === 0">
              <td colspan="7" class="text-secondary small p-3">未配置 LLM provider。先添加 provider（如 OpenAI / DeepSeek / 本地 vLLM），再在其下挂多个模型。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Provider 编辑表单 -->
      <div v-if="provEditing !== null" class="border rounded p-3 mb-3 surface-panel-strong">
        <h6 class="fw-semibold mb-2">{{ provEditing === '__new__' ? '新增 Provider' : `编辑 Provider：${provEditing}` }}</h6>
        <div class="row g-2">
          <div class="col-md-3" v-if="provEditing !== '__new__'">
            <label class="form-label small">ID（主键，自动生成）</label>
            <input v-model="providerForm.id" class="form-control form-control-sm" disabled>
          </div>
          <div class="col-md-3">
            <label class="form-label small">名称 *</label>
            <input v-model="providerForm.name" class="form-control form-control-sm" placeholder="OpenAI">
          </div>
          <div class="col-md-3">
            <label class="form-label small">Base URL *（其下所有模型共用）</label>
            <input v-model="providerForm.base_url" class="form-control form-control-sm" placeholder="https://api.openai.com/v1">
          </div>
          <div class="col-md-3">
            <label class="form-label small">API Key（空 = 保留原值）</label>
            <input v-model="providerForm.api_key" type="password" class="form-control form-control-sm" placeholder="sk-...">
          </div>
          <div class="col-md-3">
            <label class="form-label small">备注</label>
            <input v-model="providerForm.note" class="form-control form-control-sm" placeholder="官方 / 中转 / 本地">
          </div>
          <div class="col-md-3 d-flex align-items-end gap-3">
            <div class="form-check form-switch">
              <input v-model="providerForm.enabled" type="checkbox" class="form-check-input" id="pEnable">
              <label class="form-check-label small" for="pEnable">启用</label>
            </div>
          </div>
        </div>
        <div class="mt-2 d-flex gap-2">
          <button class="btn btn-sm btn-primary" @click="saveProvider">保存</button>
          <button class="btn btn-sm btn-outline-secondary" @click="cancelProvEdit">取消</button>
          <button class="btn btn-sm btn-outline-info ms-auto" @click="testProvider"><i class="bi bi-plug me-1"></i>测试此 Provider</button>
        </div>
        <div v-if="provTest" class="mt-2 small alert py-2 mb-0" :class="provTest.ok ? 'alert-success' : 'alert-danger'">{{ provTest.ok ? '✓ ' : '✗ ' }}{{ provTest.detail }}</div>
      </div>

      <!-- 模型列表：挂在 provider 下 -->
      <div class="d-flex justify-content-between align-items-center mt-4 mb-2">
        <h6 class="mb-0 fw-semibold"><i class="bi bi-collection me-1"></i>模型列表（挂在 provider 下；多模态 / 价格标记 / 启用）</h6>
        <button class="btn btn-sm btn-outline-primary" @click="addModel()"><i class="bi bi-plus me-1"></i>新增模型</button>
      </div>
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle">
          <thead><tr><th>Provider</th><th>ID</th><th>名称</th><th>模型 ID（请求体）</th><th>能力</th><th>价格</th><th>状态</th><th class="text-end">操作</th></tr></thead>
          <tbody>
            <tr v-for="m in models" :key="m.id" :class="{ 'table-secondary': !m.enabled || !m.provider_enabled }">
              <td><span class="badge text-bg-light border">{{ m.provider_name || m.provider_id }}</span></td>
              <td><code>{{ m.id }}</code></td>
              <td>{{ m.name }} <span v-if="m.note" class="text-secondary small">({{ m.note }})</span></td>
              <td class="small">{{ m.model }}</td>
              <td><span v-if="m.vision" class="badge text-bg-primary" title="多模态，可识图">🖼 多模态</span><span v-else class="text-secondary small">文本</span></td>
              <td class="small">{{ m.price || '—' }}</td>
              <td>{{ m.enabled && m.provider_enabled ? '✓ 启用' : '✗ 禁用' }}</td>
              <td class="text-end">
                <button class="btn btn-sm btn-outline-secondary me-1" @click="editModel(m)">编辑</button>
                <button class="btn btn-sm btn-outline-danger" @click="removeModel(m.id)">删除</button>
              </td>
            </tr>
            <tr v-if="models.length === 0">
              <td colspan="8" class="text-secondary small p-3">暂无模型。先在上方添加 Provider，再在 provider 下新增模型（如 gpt-4o / deepseek-chat / qwen2.5）。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 模型编辑表单 -->
      <div v-if="modelEditing !== null" class="border rounded p-3 mb-3 surface-panel-strong">
        <h6 class="fw-semibold mb-2">{{ modelEditing === '__new__' ? '新增模型' : `编辑模型：${modelEditing}` }}</h6>
        <div class="row g-2">
          <div class="col-md-3" v-if="modelEditing !== '__new__'">
            <label class="form-label small">ID（主键，自动生成）</label>
            <input v-model="modelForm.id" class="form-control form-control-sm" disabled>
          </div>
          <div class="col-md-3">
            <label class="form-label small">所属 Provider *</label>
            <select v-model="modelForm.provider_id" class="form-select form-select-sm">
              <option value="" disabled>选择 provider…</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}（{{ p.id }}）</option>
            </select>
          </div>
          <div class="col-md-3">
            <label class="form-label small">名称 *</label>
            <input v-model="modelForm.name" class="form-control form-control-sm" placeholder="GPT-4o mini">
          </div>
          <div class="col-md-3">
            <label class="form-label small">模型 ID *（请求体 model 字段）</label>
            <input v-model="modelForm.model" class="form-control form-control-sm" placeholder="gpt-4o-mini">
          </div>
          <div class="col-md-3">
            <label class="form-label small">价格标记（留痕）</label>
            <input v-model="modelForm.price" class="form-control form-control-sm" placeholder="¥1.2/1M tokens">
          </div>
          <div class="col-md-3">
            <label class="form-label small">备注</label>
            <input v-model="modelForm.note" class="form-control form-control-sm" placeholder="快 / 便宜 / 识图">
          </div>
          <div class="col-md-3 d-flex align-items-end gap-3">
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
        <div class="mt-2 d-flex gap-2">
          <button class="btn btn-sm btn-primary" @click="saveModel">保存</button>
          <button class="btn btn-sm btn-outline-secondary" @click="cancelModelEdit">取消</button>
          <button class="btn btn-sm btn-outline-info ms-auto" @click="testModel"><i class="bi bi-plug me-1"></i>测试此配置</button>
        </div>
        <div v-if="modelTest" class="mt-2 small alert py-2 mb-0" :class="modelTest.ok ? 'alert-success' : 'alert-danger'">{{ modelTest.ok ? '✓ ' : '✗ ' }}{{ modelTest.detail }}</div>
      </div>

      <!-- 用途映射 -->
      <div class="border rounded p-3 mb-3">
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

      <!-- 调用日志 -->
      <div>
        <h6 class="fw-semibold mb-2"><i class="bi bi-receipt me-1"></i>调用日志（成本归平台：provider / 模型 / 用途 / tokens / 价格）</h6>
        <div class="table-responsive">
          <table class="table table-sm table-hover">
            <thead><tr><th>时间</th><th>Provider</th><th>模型</th><th>用途</th><th>任务</th><th>识图</th><th>tokens(入/出)</th><th>价格</th><th>结果</th></tr></thead>
            <tbody>
              <tr v-for="c in calls" :key="c.id">
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
              <tr v-if="calls.length === 0"><td colspan="9" class="text-secondary small p-3">暂无调用记录。</td></tr>
            </tbody>
          </table>
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

      <hr class="my-4">
      <h6 class="fw-semibold mb-2"><i class="bi bi-clock-history me-1"></i>提示词修改历史</h6>
      <div class="table-responsive">
        <table class="table table-sm table-hover">
          <thead><tr><th>时间</th><th>改人</th><th>配置项</th><th>前值（截断）</th><th>新值（截断）</th></tr></thead>
          <tbody>
            <tr v-for="h in history" :key="h.id">
              <td class="text-secondary small">{{ h.created_at }}</td>
              <td>{{ h.changed_by }}</td>
              <td><code>{{ h.k }}</code></td>
              <td class="small text-secondary">{{ String(h.old_v || '').slice(0, 80) }}</td>
              <td class="small">{{ String(h.new_v || '').slice(0, 80) }}</td>
            </tr>
            <tr v-if="history.length === 0"><td colspan="5" class="text-secondary small p-3">暂无修改记录。</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
