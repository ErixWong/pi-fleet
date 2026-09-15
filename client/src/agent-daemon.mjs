#!/usr/bin/env node
// pi-agent daemon：轮询 v2 任务并拉起 pi 执行。
//
// 任务的认领、上下文读取和正常提交全部由 pi 通过 v2 MCP 完成。
// daemon 只负责领取到期任务，以及在 pi 异常退出或超时时提交失败预检。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLIENT_CONFIG_PATH = path.join(os.homedir(), '.config', 'pi-agent', 'config.json');
const PI_MCP_CONFIG_PATH = path.join(os.homedir(), '.pi', 'agent', 'mcp.json');
const WORK_ROOT = process.env.WORK_ROOT ?? path.join(os.homedir(), 'pi-agent-work');
const POLL_MS = Number(process.env.POLL_MS ?? 60_000);
const PAGE_SIZE = Number(process.env.TASK_PAGE_SIZE ?? 20);
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS ?? 1_800_000);
const RECENT_DONE_TTL_MS = Number(process.env.RECENT_DONE_TTL_MS ?? 600_000);

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
    throw new Error(`${method} ${pathname}: ${response.status}${detail}`);
  }
  return data;
}

const execSessions = new Map();
const recentlyDone = new Map();

function taskIdOf(item) {
  return String(item?.id ?? item?.post?.id ?? item?.task_id ?? '');
}

function taskDataOf(item) {
  return item?.task && typeof item.task === 'object' ? item.task : {};
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

  let started = 0;
  for (const item of items) {
    const taskId = taskIdOf(item);
    if (!taskId || execSessions.has(taskId) || recentlyDone.has(taskId)) continue;
    spawnTaskAgent(item);
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

function taskPrompt(item, taskId, cwd, sandboxDir) {
  const task = taskDataOf(item);
  const title = String(item.title ?? '');
  const body = String(item.body ?? item.instruction ?? '');
  const lines = [
    '你是任务分发平台的执行 agent，请只处理下面这一项任务。',
    `任务 ID：${taskId}`,
    `标题：${title}`,
    `任务正文：${body}`,
    `当前状态：${String(task.status ?? '')}`,
    `交付物要求：${String(task.deliverable_spec ?? '')}`,
  ];
  if (cwd && sandboxDir === null) {
    lines.push(`工作目录：${cwd}（在此目录完成任务）`);
  }
  lines.push(
    '',
    '先使用 v2 MCP 工具 post(action="detail", id=任务 ID) 获取完整上下文。',
    '如果任务状态是 open，使用 task(action="claim", task_id=任务 ID) 认领；如果是 claimed，继续处理上次被打回的任务。',
    '完成工作后，使用 task(action="submit", task_id=任务 ID, deliverables=[...], message="...") 提交实际交付物。',
    '正常完成必须通过 MCP 提交；不要调用任何旧版接口，也不要处理其他任务。',
  );
  return lines.join('\n');
}

function spawnTaskAgent(item) {
  const taskId = taskIdOf(item);
  const task = taskDataOf(item);
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

  const invocation = buildAgentInvocation(taskPrompt(item, taskId, cwd, sandboxDir));
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
      console.log(`[daemon] 任务 ${taskId} 正常完成（code=0，提交由 pi MCP 完成）`);
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
  try {
    await api('POST', `/api/v2/tasks/${encodeURIComponent(taskId)}/submit`, {
      deliverables: [],
      message: `pi-agent daemon 兜底：${String(result).slice(0, 7900)}`,
    });
    console.log(`[daemon] 已通过 v2 submit 上报任务 ${taskId} 失败预检`);
  } catch (error) {
    console.log(`[daemon] 上报任务 ${taskId} 失败结果时出错: ${error.message}`);
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

void startTaskPolling();
console.log(`[daemon] agent-daemon 启动 key=${AGENT_KEY.slice(0, 8)}… pi work=${WORK_ROOT} poll=${POLL_MS / 1000}s`);
