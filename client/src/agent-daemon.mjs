#!/usr/bin/env node
// pi-agent daemon：轮询 v2 任务并拉起 pi 执行。
//
// daemon 先通过 v2 REST 原子认领到期任务，再由 pi 通过 v2 MCP 读取上下文和提交结果。
// pi 仍会按 prompt 幂等地尝试 claim；正常退出未提交时 daemon 会收集产物兜底提交，
// 异常退出或超时则提交失败预检。

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLIENT_CONFIG_PATH = path.join(os.homedir(), '.config', 'pi-agent', 'config.json');
const PI_MCP_CONFIG_PATH = path.join(os.homedir(), '.pi', 'agent', 'mcp.json');
const WORK_ROOT = process.env.WORK_ROOT ?? path.join(os.homedir(), 'pi-agent-work');
const POLL_MS = Number(process.env.POLL_MS ?? 60_000);
const CHANNEL_POLL_MS = Number(process.env.CHANNEL_POLL_MS ?? 5_000);
const CHANNEL_TIMEOUT_MS = Number(process.env.CHANNEL_TIMEOUT_MS ?? 300_000);
const CHANNEL_MAX_CONCURRENCY = Math.max(1, Number(process.env.CHANNEL_MAX_CONCURRENCY ?? 2));
const CHANNEL_STATE_PATH = process.env.CHANNEL_STATE_PATH
  ?? path.join(os.homedir(), '.config', 'pi-agent', 'channels-state.json');
const CHANNEL_SESSION_DIR = process.env.CHANNEL_SESSION_DIR
  ?? path.join(WORK_ROOT, 'channel-sessions');
const PAGE_SIZE = Number(process.env.TASK_PAGE_SIZE ?? 20);
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS ?? 1_800_000);
const RECENT_DONE_TTL_MS = Number(process.env.RECENT_DONE_TTL_MS ?? 600_000);
const CLAIM_TTL_MS = Number(
  process.env.CLAIM_TTL_MS ?? Math.max(TASK_TIMEOUT_MS, RECENT_DONE_TTL_MS),
);

function readJsonFile(filePath) {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

const CLIENT_CONFIG = readJsonFile(CLIENT_CONFIG_PATH);
const PI_MCP_CONFIG = readJsonFile(PI_MCP_CONFIG_PATH);
const PI_MCP_SERVER = PI_MCP_CONFIG.mcpServers?.['task-dispatch'];
const MCP_SERVER_URL = typeof PI_MCP_SERVER?.url === 'string'
  ? normalizeBaseUrl(PI_MCP_SERVER.url)
  : '';
const MCP_BASE_URL = MCP_SERVER_URL.replace(/\/mcp2$/, '');
const BASE = normalizeBaseUrl(
  process.env.PLATFORM_URL || CLIENT_CONFIG.url || MCP_BASE_URL || 'http://127.0.0.1:3000',
);

function readKeyFromPiMcp() {
  if (typeof PI_MCP_SERVER?.bearerToken === 'string') return PI_MCP_SERVER.bearerToken;
  if (typeof PI_MCP_SERVER?.bearerTokenEnv === 'string') {
    return process.env[PI_MCP_SERVER.bearerTokenEnv] ?? '';
  }
  const authorization = PI_MCP_SERVER?.headers?.Authorization
    ?? PI_MCP_SERVER?.headers?.authorization;
  const match = typeof authorization === 'string'
    ? authorization.match(/^Bearer\s+(\S+)$/i)
    : null;
  return match?.[1] ?? '';
}

const AGENT_KEY = process.env.PI_AGENT_KEY || CLIENT_CONFIG.key || readKeyFromPiMcp();
if (!AGENT_KEY) {
  console.error('缺少 key：请先运行 pi-agent setup --key=<key>');
  process.exit(1);
}

function syncPiMcpConfig() {
  let mcpConfig = {};
  if (existsSync(PI_MCP_CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(PI_MCP_CONFIG_PATH, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('顶层结构不是 JSON 对象');
      }
      mcpConfig = parsed;
    } catch (error) {
      console.log(`[daemon] MCP 配置自愈失败，保留原文件并继续启动：${error.message}`);
      return;
    }
  }

  if (mcpConfig.mcpServers === undefined) {
    mcpConfig.mcpServers = {};
  }
  if (
    !mcpConfig.mcpServers
    || typeof mcpConfig.mcpServers !== 'object'
    || Array.isArray(mcpConfig.mcpServers)
  ) {
    console.log('[daemon] MCP 配置自愈失败，mcpServers 不是对象，保留原文件并继续启动');
    return;
  }

  const oldServer = mcpConfig.mcpServers['task-dispatch'];
  mcpConfig.mcpServers['task-dispatch'] = {
    ...(oldServer && typeof oldServer === 'object' && !Array.isArray(oldServer) ? oldServer : {}),
    type: 'http',
    url: `${BASE}/mcp2`,
    auth: 'bearer',
    bearerToken: AGENT_KEY,
    lifecycle: 'eager',
  };

  const tempPath = `${PI_MCP_CONFIG_PATH}.tmp-${process.pid}`;
  try {
    mkdirSync(path.dirname(PI_MCP_CONFIG_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(tempPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, PI_MCP_CONFIG_PATH);
    chmodSync(PI_MCP_CONFIG_PATH, 0o600);
    console.log(`[daemon] 已同步 pi MCP 配置：${PI_MCP_CONFIG_PATH}`);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* 临时文件不存在或已改名 */ }
    console.log(`[daemon] MCP 配置自愈失败，继续启动：${error.message}`);
  }
}

function configuredPiCli() {
  if (process.env.PI_CLI) return process.env.PI_CLI;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const candidate = path.join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'cli.js',
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function extraBinDirs() {
  const dirs = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, 'npm'));
  }
  const home = os.homedir();
  dirs.push(path.join(home, '.npm-global', 'bin'), path.join(home, '.local', 'bin'), path.join(home, 'bin'));
  if (process.env.NVM_BIN) dirs.push(process.env.NVM_BIN);
  return [...new Set(dirs)];
}

function piInvocation() {
  const configured = configuredPiCli();
  if (configured) {
    return /\.m?js$/i.test(configured)
      ? { cmd: process.execPath, args: [configured] }
      : { cmd: configured, args: [] };
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, ['pi'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const found = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (found) return { cmd: found, args: [] };
  for (const dir of extraBinDirs()) {
    const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `pi${suffix}`);
      if (existsSync(candidate)) return { cmd: candidate, args: [] };
    }
  }
  return { cmd: 'pi', args: [] };
}

function spawnCli(cmd, args, options) {
  const needsShell = process.platform === 'win32' && /\.cmd$/i.test(cmd);
  return spawn(cmd, args, {
    ...options,
    shell: needsShell ? true : (options.shell ?? false),
  });
}

function invocationEnv() {
  return { ...process.env, PLATFORM_URL: BASE, PI_AGENT_KEY: AGENT_KEY };
}

function buildAgentInvocation(prompt) {
  const invocation = piInvocation();
  return {
    ...invocation,
    args: [...invocation.args, '-p', '-a', prompt],
    env: invocationEnv(),
  };
}

function buildChannelInvocation(prompt, sessionId) {
  const invocation = piInvocation();
  return {
    ...invocation,
    args: [
      ...invocation.args,
      '--session-id',
      sessionId,
      '--session-dir',
      CHANNEL_SESSION_DIR,
      '-p',
      prompt,
    ],
    env: invocationEnv(),
  };
}

async function api(method, pathname, body) {
  const response = await fetch(BASE + pathname, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${AGENT_KEY}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data?.error === 'string' ? `: ${data.error}` : '';
    const error = new Error(`${method} ${pathname}: ${response.status}${detail}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const channelState = readJsonFile(CHANNEL_STATE_PATH);
const persistedCursors = channelState.cursors
  && typeof channelState.cursors === 'object'
  && !Array.isArray(channelState.cursors)
  ? channelState.cursors
  : channelState;
const channelCursors = new Map(
  Object.entries(persistedCursors).filter(([, value]) => typeof value === 'string'),
);
const channelSessionIds = new Map(
  Object.entries(channelState.sessions ?? {}).filter(([, value]) => typeof value === 'string'),
);
const channelSessionInitialized = new Map(
  Object.entries(channelState.initialized ?? {}).filter(([, value]) => typeof value === 'boolean'),
);
const channelResetRevisions = new Map(
  Object.entries(channelState.reset_revisions ?? {})
    .filter(([, value]) => Number.isInteger(Number(value)))
    .map(([key, value]) => [key, Number(value)]),
);
const channelSessions = new Map();
let channelActive = 0;
const channelWaiters = [];
let daemonPrincipalId = '';

function saveChannelState() {
  const state = {
    cursors: Object.fromEntries(channelCursors),
    sessions: Object.fromEntries(channelSessionIds),
    initialized: Object.fromEntries(channelSessionInitialized),
    reset_revisions: Object.fromEntries(channelResetRevisions),
  };
  const tempPath = `${CHANNEL_STATE_PATH}.tmp-${process.pid}`;
  try {
    mkdirSync(path.dirname(CHANNEL_STATE_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, CHANNEL_STATE_PATH);
    chmodSync(CHANNEL_STATE_PATH, 0o600);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* 临时文件不存在或已改名 */ }
    console.log(`[daemon] 对话游标落盘失败：${error.message}`);
  }
}

function setChannelCursor(channelId, cursor) {
  if (!cursor) return;
  if (channelCursors.get(channelId) === cursor) return;
  channelCursors.set(channelId, cursor);
  saveChannelState();
}

function hasPiSession(sessionId) {
  if (!existsSync(CHANNEL_SESSION_DIR)) return false;
  return readdirSync(CHANNEL_SESSION_DIR).some((entry) =>
    entry === sessionId
      || entry.startsWith(`${sessionId}.`)
      || entry.startsWith(`${sessionId}-`));
}

function newChannelSessionId(channelId) {
  return `${channelId}-${randomBytes(4).toString('hex')}`;
}

function syncChannelRevision(channel) {
  const channelId = String(channel?.id ?? '');
  if (!channelId) return;
  const revision = Number(channel?.revision ?? 0);
  const previous = channelResetRevisions.get(channelId);
  if (previous !== undefined && revision > previous) {
    const replacementId = restartChannelSession(channelId);
    console.log(
      `[daemon][channel-${channelId}] 检测到会话重置标记 revision ${previous} -> ${revision} `
      + `，下一条消息使用 session=${replacementId}`,
    );
  }
  if (previous !== revision) {
    channelResetRevisions.set(channelId, revision);
    saveChannelState();
  }
}

function channelSession(channelId) {
  let sessionId = channelSessionIds.get(channelId);
  if (!sessionId) {
    sessionId = channelId;
    channelSessionIds.set(channelId, sessionId);
  }
  const initialized = channelSessionInitialized.get(channelId) === true || hasPiSession(sessionId);
  if (initialized) channelSessionInitialized.set(channelId, true);
  saveChannelState();
  return { sessionId, initialized };
}

function markChannelSessionInitialized(channelId) {
  channelSessionInitialized.set(channelId, true);
  saveChannelState();
}

function restartChannelSession(channelId) {
  const sessionId = newChannelSessionId(channelId);
  channelSessionIds.set(channelId, sessionId);
  channelSessionInitialized.set(channelId, false);
  saveChannelState();
  return sessionId;
}

async function acquireChannelSlot() {
  if (channelActive < CHANNEL_MAX_CONCURRENCY) {
    channelActive += 1;
    return;
  }
  await new Promise((resolve) => channelWaiters.push(resolve));
  channelActive += 1;
}

function releaseChannelSlot() {
  channelActive = Math.max(0, channelActive - 1);
  const next = channelWaiters.shift();
  if (next) next();
}

async function loadDaemonPrincipal() {
  if (daemonPrincipalId) return daemonPrincipalId;
  const result = await api('GET', '/api/v2/whoami');
  const id = result?.principal?.id;
  if (typeof id !== 'string' || !id) throw new Error('whoami response has no principal id');
  daemonPrincipalId = id;
  return daemonPrincipalId;
}

function channelMessageUrl(channelId, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return `/api/v2/channels/${encodeURIComponent(channelId)}/messages${suffix}`;
}

async function nextChannelMessage(channel, principalId) {
  let after = channelCursors.get(channel.id);
  let firstPage = true;
  while (true) {
    const page = await api('GET', channelMessageUrl(channel.id, {
      ...(after ? { after } : {}),
      limit: 100,
    }));
    const items = Array.isArray(page?.items) ? page.items : [];
    for (const item of items) {
      const id = String(item?.id ?? '');
      if (!id) continue;
      if (String(item?.author_principal_id ?? '') === principalId) {
        console.log(`[daemon][channel-${channel.id}] 跳过自身消息 ${id}`);
        setChannelCursor(channel.id, id);
        after = id;
        continue;
      }
      return item;
    }
    if (!page?.has_more || !page?.next_after || page.next_after === after) return null;
    after = String(page.next_after);
    if (firstPage && !channelCursors.has(channel.id)) {
      console.log(`[daemon][channel-${channel.id}] 初次同步历史消息`);
    }
    firstPage = false;
  }
}

function channelSystemPrompt(channel, cwd) {
  const lines = [
    '你正在参与人与主机的一对一实时对话，不是任务执行。',
    `对话通道 ID：${channel.id}`,
    `对方主机名称：${String(channel.host?.name ?? '')}`,
    `工作目录：${cwd}`,
    '允许在 ~ 下自由 cd 与执行命令。',
    '回答规则：简短、直接回答用户；这是对话，不要调用任何 task 相关工具，也不要认领、提交或处理任务。',
    `需要回复时，必须使用 post(action="reply", parent_id="${channel.id}", body="...") 回复到当前通道。`,
    '需要执行命令时可以执行，但不要把命令执行当成任务流程；完成后仍用上述 post reply 汇报。',
  ];
  return lines.join('\n');
}

function channelPrompt(channel, messageBody, cwd, initialized) {
  const body = String(messageBody ?? '');
  if (initialized) return body;
  return `${channelSystemPrompt(channel, cwd)}\n\n当前新消息：${body}`;
}

function resolveChannelWorkdir(channel) {
  const raw = typeof channel?.workdir === 'string' ? channel.workdir.trim() : '';
  if (!raw) {
    const fallback = path.join(os.homedir(), 'tmp');
    console.log(`[daemon][channel-${channel?.id}] workdir 为空，回退 ${fallback}`);
    return fallback;
  }
  const resolved = resolveTaskWorkdir(raw);
  if (!resolved) {
    const fallback = path.join(os.homedir(), 'tmp');
    console.log(`[daemon][channel-${channel?.id}] workdir 不在 home 下，回退 ${fallback}`);
    return fallback;
  }
  return resolved;
}

function runPiForChannel(channelId, prompt, cwd, sessionId) {
  return new Promise((resolve, reject) => {
    mkdirSync(CHANNEL_SESSION_DIR, { recursive: true, mode: 0o700 });
    const invocation = buildChannelInvocation(prompt, sessionId);
    const child = spawnCli(invocation.cmd, invocation.args, {
      cwd,
      env: invocation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout?.on('data', (data) => {
      output = (output + data.toString()).slice(-64 * 1024);
    });
    child.stderr?.on('data', (data) => {
      console.log(`[daemon][channel-${channelId}] ${String(data).slice(0, 400)}`);
    });
    const timeoutTimer = setTimeout(() => {
      console.log(`[daemon][channel-${channelId}] 对话执行超时（>${CHANNEL_TIMEOUT_MS / 1000}s）`);
      try { child.kill(); } catch { /* already dead */ }
      finish(new Error(`对话执行超时（超过 ${CHANNEL_TIMEOUT_MS / 60000} 分钟）`));
    }, CHANNEL_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      if (code === 0) finish(null, output);
      else finish(new Error(`对话执行器异常退出（code=${code ?? signal ?? '?'})`));
    });
    child.on('error', (error) => finish(error));
  });
}

async function reportChannelFailure(channelId, error) {
  console.log(`[daemon][channel-${channelId}] pi 处理失败：${error.message}`);
  try {
    await api('POST', `/api/v2/channels/${encodeURIComponent(channelId)}/messages`, {
      body: '抱歉，这次处理失败，请稍后再试。',
    });
  } catch (replyError) {
    console.log(`[daemon][channel-${channelId}] 发送失败说明也失败：${replyError.message}`);
  }
}

async function reportChannelRestarted(channelId) {
  try {
    await api('POST', `/api/v2/channels/${encodeURIComponent(channelId)}/messages`, {
      body: '会话已重开，已继续处理当前消息。',
    });
  } catch (replyError) {
    console.log(`[daemon][channel-${channelId}] 发送会话重开说明也失败：${replyError.message}`);
  }
}

async function runChannelMessage(channel, message) {
  let slotAcquired = false;
  try {
    await acquireChannelSlot();
    slotAcquired = true;
    const cwd = resolveChannelWorkdir(channel);
    mkdirSync(cwd, { recursive: true });
    let session = channelSession(String(channel.id));
    const prompt = channelPrompt(channel, message.body, cwd, session.initialized);
    console.log(
      `[daemon][channel-${channel.id}] 收到 ${message.id}，session=${session.sessionId} `
      + `模式=${session.initialized ? '续接' : '首次'} prompt=仅当前消息（无历史拼接）`,
    );
    try {
      await runPiForChannel(channel.id, prompt, cwd, session.sessionId);
    } catch (error) {
      if (!session.initialized) throw error;
      const replacementId = restartChannelSession(String(channel.id));
      session = { sessionId: replacementId, initialized: false };
      const restartPrompt = channelPrompt(channel, message.body, cwd, false);
      console.log(
        `[daemon][channel-${channel.id}] 续接失败，换新 session=${replacementId} 重开`,
      );
      await runPiForChannel(channel.id, restartPrompt, cwd, replacementId);
      await reportChannelRestarted(channel.id);
    }
    markChannelSessionInitialized(String(channel.id));
    console.log(`[daemon][channel-${channel.id}] pi 完成 ${message.id} session=${session.sessionId}`);
  } catch (error) {
    await reportChannelFailure(channel.id, error);
  } finally {
    setChannelCursor(channel.id, String(message.id));
    channelSessions.delete(channel.id);
    if (slotAcquired) releaseChannelSlot();
  }
}

async function pollChannels() {
  let principalId;
  try {
    principalId = await loadDaemonPrincipal();
  } catch (error) {
    console.log(`[daemon] channel poll 鉴权失败：${error.message}`);
    return;
  }
  let result;
  try {
    result = await api('GET', '/api/v2/channels');
  } catch (error) {
    console.log(`[daemon] channel poll 失败：${error.message}`);
    return;
  }
  const channels = Array.isArray(result?.items) ? result.items : [];
  for (const channel of channels) {
    const channelId = String(channel?.id ?? '');
    if (!channelId || channelSessions.has(channelId)) continue;
    syncChannelRevision(channel);
    let message;
    try {
      message = await nextChannelMessage(channel, principalId);
    } catch (error) {
      console.log(`[daemon][channel-${channelId}] 拉取消息失败：${error.message}`);
      continue;
    }
    if (!message) continue;
    channelSessions.set(channelId, { messageId: String(message.id), startedAt: Date.now() });
    void runChannelMessage(channel, message);
  }
}

const execSessions = new Map();
const claimedTasks = new Map();
const recentlyDone = new Map();

function taskIdOf(item) {
  return String(item?.id ?? item?.post?.id ?? item?.task_id ?? '');
}

function taskDataOf(item) {
  return item?.task && typeof item.task === 'object' ? item.task : {};
}

function isReopenedClaim(item) {
  const task = taskDataOf(item);
  return task.status === 'claimed'
    && task.assignee_principal_id
    && task.claimed_at === null;
}

async function pollTasks() {
  let items = [];
  try {
    const result = await api('GET', `/api/v2/tasks?view=due&page_size=${PAGE_SIZE}`);
    items = Array.isArray(result.items) ? result.items : [];
  } catch (error) {
    console.log(`[daemon] poll 失败: ${error.message}`);
    return;
  }

  const now = Date.now();
  for (const [taskId, timestamp] of recentlyDone) {
    if (now - timestamp > RECENT_DONE_TTL_MS) recentlyDone.delete(taskId);
  }
  for (const [taskId, claim] of claimedTasks) {
    if (!execSessions.has(taskId) && now - claim.claimedAt > CLAIM_TTL_MS) {
      claimedTasks.delete(taskId);
      console.log(`[daemon] 清理过期认领记录 ${taskId}`);
    }
  }

  let started = 0;
  for (const item of items) {
    const taskId = taskIdOf(item);
    const reopened = isReopenedClaim(item);
    if (
      !taskId
      || execSessions.has(taskId)
      || claimedTasks.has(taskId)
      || (recentlyDone.has(taskId) && !reopened)
    ) continue;
    try {
      await api('POST', `/api/v2/tasks/${encodeURIComponent(taskId)}/claim`);
      claimedTasks.set(taskId, { claimedAt: Date.now() });
    } catch (error) {
      const status = Number(error?.status ?? 0);
      if (status === 404 || status === 409) {
        console.log(`[daemon] 跳过任务 ${taskId}：claim 返回 ${status}（任务已被认领、状态不对或不可见）`);
      } else {
        console.log(`[daemon] 认领任务 ${taskId} 失败，跳过本轮：${error.message}`);
      }
      continue;
    }
    try {
      await spawnTaskAgent(item);
    } catch (error) {
      claimedTasks.delete(taskId);
      console.log(`[daemon] 拉起任务 ${taskId} 失败：${error.message}`);
      continue;
    }
    started += 1;
  }
  if (started > 0) {
    console.log(`[daemon] poll: ${items.length} 个到期，拉起 ${started} 个`);
  }
}

function resolveTaskWorkdir(workdir, home = os.homedir()) {
  if (!workdir) return null;
  const candidate = workdir.startsWith('~/') || workdir === '~'
    ? path.join(home, workdir === '~' ? '' : workdir.slice(2))
    : workdir;
  const resolved = path.resolve(candidate);
  const homeResolved = path.resolve(home);
  return resolved === homeResolved || resolved.startsWith(homeResolved + path.sep)
    ? resolved
    : null;
}

function threadPostLabel(post) {
  const author = post?.author?.name || post?.author?.id || '未知主体';
  const createdAt = String(post?.created_at ?? '未知时间');
  return `[${author} @ ${createdAt}] ${String(post?.body ?? '')}`;
}

const ANCESTRY_NODE_LIMIT = 500;
const ANCESTRY_TOTAL_LIMIT = 2200;

function truncateText(value, limit) {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function formatAncestryBackground(ancestry) {
  if (!Array.isArray(ancestry) || ancestry.length === 0) return '';
  const blocks = [];
  let total = 0;
  for (const node of ancestry) {
    const summary = node?.latest_submit_summary?.body
      ? truncateText(node.latest_submit_summary.body, 260)
      : '暂无提交摘要';
    const block = [
      `上级节点：${String(node?.id ?? '')}`,
      `标题：${truncateText(node?.title, 120)}`,
      `状态：${String(node?.status ?? '未知')}`,
      `摘要：${summary}`,
    ].join('\n');
    const remaining = ANCESTRY_TOTAL_LIMIT - total;
    if (remaining <= 0) break;
    const limited = truncateText(block, Math.min(ANCESTRY_NODE_LIMIT, remaining));
    blocks.push(limited);
    total += limited.length;
  }
  if (blocks.length === 0) return '';
  return [
    '【上级任务链背景（只读）】',
    '以下内容来自上级任务链，只提供位置与上下文；因果依赖仍以本任务任务书显式声明为准。',
    ...blocks.map((block, index) => `--- 上级节点 ${index + 1} ---\n${block}`),
    '【上级任务链背景结束】',
  ].join('\n');
}

async function loadTaskAncestry(taskId) {
  try {
    const detail = await api('GET', `/api/v2/posts/${encodeURIComponent(taskId)}`);
    return Array.isArray(detail?.ancestry) ? detail.ancestry : [];
  } catch (error) {
    console.log(`[daemon] 任务 ${taskId} ancestry 背景加载失败，跳过注入：${error.message}`);
    return [];
  }
}

async function loadTaskThread(taskId) {
  const detail = await api('GET', `/api/v2/posts/${encodeURIComponent(taskId)}`);
  const rootId = String(detail?.post?.root_id ?? taskId);
  const recent = Array.isArray(detail?.recent) ? detail.recent : [];
  const messages = [...recent];
  const seen = new Set(messages.map((post) => String(post?.id ?? '')));
  let remaining = Math.max(0, Number(detail?.more?.count ?? 0));
  let after = recent[0]?.id ? String(recent[0].id) : null;

  while (remaining > 0 && after) {
    const params = new URLSearchParams({
      root_id: rootId,
      after,
      limit: '200',
    });
    const page = await api('GET', `/api/v2/posts?${params.toString()}`);
    const items = Array.isArray(page?.items) ? page.items : [];
    if (items.length === 0) break;
    let added = 0;
    for (const post of items) {
      const id = String(post?.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      messages.push(post);
      added += 1;
    }
    remaining = Math.max(0, remaining - added);
    const nextAfter = page?.next_after ? String(page.next_after) : '';
    if (!nextAfter || nextAfter === after || items.length < 200) break;
    after = nextAfter;
  }

  return messages
    .filter((post) => String(post?.id ?? '') !== taskId)
    .sort((left, right) => {
      const timeOrder = String(left?.created_at ?? '').localeCompare(String(right?.created_at ?? ''));
      return timeOrder || String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
    });
}

function taskPrompt(item, taskId, cwd, sandboxDir, thread = [], ancestry = []) {
  const task = taskDataOf(item);
  const title = String(item.title ?? '');
  const body = String(item.body ?? item.instruction ?? '');
  const ancestryBackground = formatAncestryBackground(ancestry);
  const lines = [
    '你是任务分发平台的执行 agent，请只处理下面这一项任务。',
    ...(ancestryBackground ? ['', ancestryBackground] : []),
    `任务 ID：${taskId}`,
    `标题：${title}`,
    `任务正文：${body}`,
    `当前状态：${String(task.status ?? '')}`,
    `交付物要求：${String(task.deliverable_spec ?? '')}`,
  ];
  if (thread.length > 0) {
    lines.push(
      '',
      '线程回复（按时间顺序，属于对任务的追加上下文）：',
      ...thread.map(threadPostLabel),
    );
  } else {
    lines.push('', '线程回复：暂无追加要求。');
  }
  if (cwd && sandboxDir === null) {
    lines.push(`工作目录：${cwd}（在此目录完成任务）`);
  }
  lines.push(
    '',
    '执行规则：线程里最新的要求优先；如果与原始任务正文冲突，按较新的要求执行，并在交付说明中说明冲突与采用的要求。',
    '执行过程中可以用 post(action="reply", parent_id=任务 ID, body="...") 简短汇报进度或提问（可选，请勿刷屏）。',
    '先使用 v2 MCP 工具 post(action="detail", id=任务 ID) 获取完整上下文。',
    '如果任务状态是 open，使用 task(action="claim", task_id=任务 ID) 认领；如果任务已是 claimed（你已认领），直接继续处理上次被打回的任务。',
    '完成工作后，使用 task(action="submit", task_id=任务 ID, deliverables=[...], message="...") 提交实际交付物。',
    '正常完成必须通过 MCP 提交；不要调用任何旧版接口，也不要处理其他任务。',
  );
  return lines.join('\n');
}

const IGNORED_ARTIFACT_DIRECTORIES = new Set(['input', 'tmp', '.git', 'node_modules']);

function textPreview(filePath) {
  let descriptor;
  try {
    descriptor = openSync(filePath, 'r');
    const buffer = Buffer.alloc(4096);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) return null;
    return sample.toString('utf8').slice(0, 500).replace(/\s+/g, ' ').trim();
  } catch (error) {
    console.log(`[daemon] 读取产物摘要失败 ${filePath}：${error.message}`);
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function collectTaskArtifacts(cwd) {
  const artifacts = [];
  function walk(directory, prefix = '') {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      console.log(`[daemon] 读取产物目录失败 ${directory}：${error.message}`);
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_ARTIFACT_DIRECTORIES.has(entry.name)) {
          walk(filePath, relativeName);
        }
        continue;
      }
      if (!entry.isFile() || relativeName === 'AGENTS.md' || relativeName === 'output/stdout.txt') {
        continue;
      }
      let stats;
      try {
        stats = statSync(filePath);
      } catch (error) {
        console.log(`[daemon] 读取产物信息失败 ${filePath}：${error.message}`);
        continue;
      }
      const preview = textPreview(filePath);
      const note = [
        `大小：${stats.size} 字节`,
        preview === null
          ? '二进制或不可预览文本'
          : `文本摘要：${preview || '（空文件）'}`,
      ].join('；');
      artifacts.push({ name: relativeName, note });
    }
  }
  walk(cwd);
  return artifacts;
}

async function verifySuccessfulTask(taskId, cwd) {
  try {
    const detail = await api('GET', `/api/v2/posts/${encodeURIComponent(taskId)}`);
    const status = detail?.task?.status;
    if (status === 'submitted' || status === 'done') {
      console.log(`[daemon] 任务 ${taskId} 正常完成（code=0，状态=${status}，pi 已通过 MCP 提交）`);
      return;
    }
    if (status !== 'claimed') {
      console.log(`[daemon] 任务 ${taskId} code=0，但当前状态为 ${String(status ?? 'unknown')}，不执行兜底提交`);
      return;
    }

    const deliverables = collectTaskArtifacts(cwd);
    const result = await api('POST', `/api/v2/tasks/${encodeURIComponent(taskId)}/submit`, {
      deliverables,
      message: '由 daemon 兜底提交（执行 agent 未通过 MCP 提交）',
    });
    if (result?.ok === true && ['submitted', 'done'].includes(result?.task?.status)) {
      console.log(`[daemon] 任务 ${taskId} 兜底提交成功（${deliverables.length} 个产物）`);
    } else {
      console.log(
        `[daemon] 任务 ${taskId} 兜底提交未完成：状态=${String(result?.task?.status ?? 'unknown')} `
        + `原因=${JSON.stringify(result?.precheck?.issues ?? [])}`,
      );
    }
  } catch (error) {
    console.log(`[daemon] 任务 ${taskId} 状态校验或兜底提交失败：${error.message}`);
  } finally {
    claimedTasks.delete(taskId);
  }
}

async function spawnTaskAgent(item) {
  const taskId = taskIdOf(item);
  const task = taskDataOf(item);
  const thread = await loadTaskThread(taskId);
  const ancestry = await loadTaskAncestry(taskId);
  const workdir = typeof task.workdir === 'string' ? task.workdir : null;
  const cwd = resolveTaskWorkdir(workdir)
    ?? path.join(WORK_ROOT, 'tasks', taskId);
  const sandboxDir = workdir ? null : cwd;

  try {
    mkdirSync(cwd, { recursive: true });
  } catch (error) {
    console.log(`[daemon] 创建目录失败 ${cwd}: ${error.message}`);
  }
  if (sandboxDir) {
    try {
      for (const directory of ['input', 'tmp', 'output']) {
        mkdirSync(path.join(sandboxDir, directory), { recursive: true });
      }
      writeFileSync(
        path.join(sandboxDir, 'AGENTS.md'),
        `# 任务 ${taskId}\n标题：${String(item.title ?? '')}\n指令：${String(item.body ?? '')}\n`,
        'utf8',
      );
    } catch (error) {
      console.log(`[daemon] 写 AGENTS.md 失败: ${error.message}`);
    }
  }

  console.log(`[daemon] 任务 ${taskId} prompt 纳入线程回复 ${thread.length} 条`);
  const ancestryBackground = formatAncestryBackground(ancestry);
  if (ancestryBackground) {
    console.log(`[daemon][task-${taskId}] prompt 注入 ancestry 背景（${ancestry.length} 个节点）：\n${ancestryBackground}`);
  }
  if (thread.length > 0) {
    console.log(`[daemon][task-${taskId}] 线程回复上下文：\n${thread.map(threadPostLabel).join('\n')}`);
  }
  const invocation = buildAgentInvocation(taskPrompt(item, taskId, cwd, sandboxDir, thread, ancestry));
  const outputLog = sandboxDir ? path.join(sandboxDir, 'output', 'stdout.txt') : null;
  console.log(`[daemon] 执行任务 ${taskId} cwd=${cwd}` + (workdir ? '（项目目录）' : '（沙箱）'));
  const child = spawnCli(invocation.cmd, invocation.args, {
    cwd,
    env: invocation.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const session = {
    proc: child,
    startedAt: Date.now(),
    timeoutTimer: null,
    output: '',
    failureReported: false,
  };
  execSessions.set(taskId, session);
  child.stdout?.on('data', (data) => {
    session.output = (session.output + data.toString()).slice(-64 * 1024);
    if (outputLog) {
      try { writeFileSync(outputLog, session.output); } catch { /* 日志失败不影响任务 */ }
    }
  });
  child.stderr?.on('data', (data) => {
    console.log(`[daemon][task-${taskId}] ${String(data).slice(0, 200)}`);
  });
  session.timeoutTimer = setTimeout(() => {
    if (!execSessions.has(taskId)) return;
    console.log(`[daemon] 任务 ${taskId} 执行超时（>${TASK_TIMEOUT_MS / 1000}s），终止`);
    try { child.kill(); } catch { /* already dead */ }
    void reportTaskFailure(
      taskId,
      session,
      `执行超时（超过 ${TASK_TIMEOUT_MS / 60000} 分钟）`,
    );
  }, TASK_TIMEOUT_MS);
  child.on('close', (code, signal) => {
    clearTimeout(session.timeoutTimer);
    execSessions.delete(taskId);
    recentlyDone.set(taskId, Date.now());
    if (code === 0) {
      void verifySuccessfulTask(taskId, cwd);
      return;
    }
    const tail = session.output.split('\n').slice(-5).join('\n');
    void reportTaskFailure(
      taskId,
      session,
      `执行器异常退出（code=${code ?? signal ?? '?'}）\n\n--- 输出尾部 ---\n${tail}`,
    );
  });
  child.on('error', (error) => {
    clearTimeout(session.timeoutTimer);
    execSessions.delete(taskId);
    recentlyDone.set(taskId, Date.now());
    void reportTaskFailure(taskId, session, `执行器启动失败：${error.message}`);
  });
}

async function reportTaskFailure(taskId, session, result) {
  if (session.failureReported) return;
  session.failureReported = true;
  if (!claimedTasks.has(taskId)) {
    console.log(`[daemon] 跳过任务 ${taskId} 失败上报：本实例没有有效认领记录`);
    return;
  }
  try {
    const detail = await api('GET', `/api/v2/posts/${encodeURIComponent(taskId)}`);
    const status = detail?.task?.status;
    if (status !== 'claimed') {
      console.log(`[daemon] 跳过任务 ${taskId} 失败上报：当前状态为 ${String(status ?? 'unknown')}`);
      return;
    }
    await api('POST', `/api/v2/tasks/${encodeURIComponent(taskId)}/submit`, {
      deliverables: [],
      message: `pi-agent daemon 兜底：${String(result).slice(0, 7900)}`,
    });
    console.log(`[daemon] 已通过 v2 submit 上报任务 ${taskId} 失败预检`);
  } catch (error) {
    console.log(`[daemon] 上报任务 ${taskId} 失败结果时出错: ${error.message}`);
  } finally {
    claimedTasks.delete(taskId);
  }
}

let taskPolling = false;
async function startTaskPolling() {
  if (taskPolling) return;
  taskPolling = true;
  while (true) {
    await pollTasks();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

syncPiMcpConfig();
void startTaskPolling();
let channelPolling = false;
async function startChannelPolling() {
  if (channelPolling) return;
  channelPolling = true;
  while (true) {
    await pollChannels();
    await new Promise((resolve) => setTimeout(resolve, CHANNEL_POLL_MS));
  }
}

void startChannelPolling();
console.log(
  `[daemon] agent-daemon 启动 key=${AGENT_KEY.slice(0, 8)}… `
  + `pi work=${WORK_ROOT} task-poll=${POLL_MS / 1000}s channel-poll=${CHANNEL_POLL_MS / 1000}s`,
);
