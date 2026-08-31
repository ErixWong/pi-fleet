#!/usr/bin/env node
// agent-daemon：pi agent 常驻守护进程（任务执行 + 对话桥接 合一）
//
// 替代三种旧部署方式：
//   - 模式 A（定时拉起 pi -p 纯 MCP worker）       → 废弃
//   - 模式 B（alarm.sh 闹钟脚本 + systemd timer）  → 废弃
//   - chat-bridge.mjs（对话桥接常驻）              → 合并进本进程
//
// 一台设备接入平台 = 装好 pi + 本脚本常驻，一条命令搞定。
//
// 运行：
//   PLATFORM_URL=http://x PI_AGENT_KEY=pd-xxx AGENT_CMD=auto node agent-daemon.mjs
//   （key 缺省依次从 config.json、~/.pi/agent/mcp.json 的 task-dispatch 段读取）
//
// 功能：
//   1. 连平台 WS（/api/agent/chat-stream）：管理员对话推送 → 拉起 pi --mode rpc 会话
//      （打字机流式 / --session-id 续接 / 空闲 kill / 超时保护 / run_user sudo）
//   2. 定时 poll（默认 60s，POLL_MS）：claimDueTasks → 新任务拉起配置的 CLI 一次性执行
//      （MCP task(submit) 交差；异常退出 / 超时 → POST /api/tasks/result failed 兜底）
//   3. WS 断线 → 退回 chat-check 轮询（对话兜底）+ poll 继续（任务不受影响）
//   4. ~/projects 目录扫描上报（主机会话工作目录选择）
//
// 环境变量：
//   PLATFORM_URL        平台地址（默认 http://127.0.0.1:3000）
//   PI_AGENT_KEY        agent key（优先；否则读 config.json / mcp.json task-dispatch）
//   AGENT_CMD           执行器：pi / copilot / claude / codex / auto
//   POLL_MS             任务轮询周期（默认 60000）
//   TASK_TIMEOUT_MS     单任务执行超时（默认 1800000 = 30min）
//   WORK_ROOT           沙箱任务工作目录根（默认 ~/pi-agent-work）
//   CHAT_*              对话参数（沿用 chat-bridge：CHAT_IDLE_KILL_MS / CHAT_PI_TIMEOUT_MS / CHAT_POLL_MS / CHAT_PI_THINKING）
//   PI_CLI              pi CLI 绝对路径（默认自动探测）
import { spawn, execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const SUPPORTED_CLIS = ['pi', 'copilot', 'claude', 'codex'];
const CLIENT_CONFIG_PATH = path.join(os.homedir(), '.config', 'pi-agent', 'config.json');
const PI_MCP_CONFIG_PATH = path.join(os.homedir(), '.pi', 'agent', 'mcp.json');

function readJsonFile(filePath) {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readClientConfig() {
  const cfg = readJsonFile(CLIENT_CONFIG_PATH);
  return {
    url: typeof cfg.url === 'string' ? cfg.url.trim() : '',
    key: typeof cfg.key === 'string' ? cfg.key : '',
    cli: typeof cfg.cli === 'string' ? cfg.cli.trim().toLowerCase() : '',
  };
}

function normalizeCli(value) {
  const cli = String(value ?? '').trim().toLowerCase();
  return cli === 'auto' || SUPPORTED_CLIS.includes(cli) ? cli : null;
}

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

const CLIENT_CONFIG = readClientConfig();
const PI_MCP_CONFIG = readJsonFile(PI_MCP_CONFIG_PATH);
const PI_MCP_SERVER = PI_MCP_CONFIG.mcpServers?.['task-dispatch'];
const MCP_SERVER_URL = typeof PI_MCP_SERVER?.url === 'string' ? normalizeBaseUrl(PI_MCP_SERVER.url) : '';
const MCP_BASE_URL = MCP_SERVER_URL.replace(/\/mcp$/, '');
const BASE = normalizeBaseUrl(process.env.PLATFORM_URL || CLIENT_CONFIG.url || MCP_BASE_URL || 'http://127.0.0.1:3000');
const WS_URL = BASE.replace(/^http/, 'ws') + '/api/agent/chat-stream';
const POLL_MS = Number(process.env.POLL_MS ?? 60_000);                 // 任务轮询周期
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS ?? 1_800_000); // 单任务执行超时
const RECENT_DONE_TTL_MS = Number(process.env.RECENT_DONE_TTL_MS ?? 600_000); // 完成后防重复拉起窗口
const IDLE_KILL_MS = Number(process.env.CHAT_IDLE_KILL_MS ?? 120_000); // 对话空闲回收
const PI_TIMEOUT_MS = Number(process.env.CHAT_PI_TIMEOUT_MS ?? 300_000); // 对话生成超时
const POLL_MS_CHAT = Number(process.env.CHAT_POLL_MS ?? 1_500);         // 对话断线轮询周期
const PI_THINKING = process.env.CHAT_PI_THINKING ?? 'low';             // 对话首字要快
const WORK_ROOT = process.env.WORK_ROOT ?? path.join(os.homedir(), 'pi-agent-work');

function readKeyFromPiMcp() {
  if (typeof PI_MCP_SERVER?.bearerToken === 'string') return PI_MCP_SERVER.bearerToken;
  if (typeof PI_MCP_SERVER?.bearerTokenEnv === 'string') return process.env[PI_MCP_SERVER.bearerTokenEnv] ?? '';
  return '';
}

const AGENT_KEY = process.env.PI_AGENT_KEY || CLIENT_CONFIG.key || readKeyFromPiMcp();
if (!AGENT_KEY) { console.error('缺少 key：设 PI_AGENT_KEY 环境变量，或在 ~/.pi/agent/mcp.json 配 task-dispatch 段'); process.exit(1); }

function configuredPiCli() {
  if (process.env.PI_CLI) return process.env.PI_CLI;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const c = path.join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (existsSync(c)) return c;
  }
  return null;
}

/** 探测本机已安装的 CLI；systemd 环境也使用 which/where，避免依赖交互 shell。 */
function commandExists(command) {
  if (command === 'pi' && configuredPiCli()) return true;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0;
}

export function detectAvailableClis() {
  return SUPPORTED_CLIS.filter(commandExists);
}

function resolveCli(cli) {
  const normalized = normalizeCli(cli) ?? 'pi';
  if (normalized !== 'auto') return normalized;
  return detectAvailableClis()[0] ?? 'pi';
}

/** 解析 CLI 绝对路径（sudo 场景 PATH 受 secure_path 限制）。 */
function cliInvocation(cli) {
  const selected = resolveCli(cli);
  if (selected === 'pi') {
    const configured = configuredPiCli();
    if (configured) {
      return /\.m?js$/i.test(configured)
        ? { cmd: process.execPath, args: [configured] }
        : { cmd: configured, args: [] };
    }
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [selected], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const found = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return { cmd: found || selected, args: [] };
}

function mcpConfig() {
  return {
    mcpServers: {
      'task-dispatch': {
        type: 'http',
        url: `${BASE}/mcp`,
        headers: { Authorization: `Bearer ${AGENT_KEY}` },
      },
    },
  };
}

function invocationEnv() {
  return { ...process.env, PLATFORM_URL: BASE, PI_AGENT_KEY: AGENT_KEY };
}

/**
 * 构造不同执行器的命令行调用。
 * chat 目前依赖 pi 的 RPC JSON 协议；其他 CLI 统一回退到 pi 并明确提示。
 */
export function buildAgentInvocation(cli, { mode, prompt = '', sessionId = '', cwd: _cwd = undefined }) {
  const selected = resolveCli(cli);
  if (mode === 'chat' && selected !== 'pi') {
    console.warn(`[daemon] ${selected} 暂不支持当前对话 RPC 协议，回退 pi`);
    return buildAgentInvocation('pi', { mode, prompt, sessionId, cwd: _cwd });
  }

  const invocation = cliInvocation(selected);
  if (mode === 'chat') {
    return {
      ...invocation,
      args: [...invocation.args, '--mode', 'rpc', '--session-id', sessionId, '--thinking', PI_THINKING],
      env: invocationEnv(),
    };
  }

  if (selected === 'copilot') {
    return {
      ...invocation,
      args: [
        ...invocation.args,
        '-p',
        '-s',
        '--allow-all-tools',
        '--additional-mcp-config',
        JSON.stringify(mcpConfig()),
        prompt,
      ],
      env: invocationEnv(),
    };
  }
  if (selected === 'claude') {
    return {
      ...invocation,
      args: [...invocation.args, '-p', '--mcp-config', JSON.stringify(mcpConfig()), prompt],
      env: invocationEnv(),
    };
  }
  if (selected === 'codex') {
    return {
      ...invocation,
      args: [...invocation.args, 'exec', '--mcp-config', JSON.stringify(mcpConfig()), prompt],
      env: invocationEnv(),
    };
  }
  return {
    ...invocation,
    args: [...invocation.args, '-p', '-a', prompt],
    env: invocationEnv(),
  };
}

const LOCAL_AGENT_CMD = normalizeCli(process.env.AGENT_CMD || CLIENT_CONFIG.cli) || 'pi';
let AGENT_CMD = LOCAL_AGENT_CMD;

// ── 平台 REST ──
async function api(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${pathname}: ${res.status}`);
  return data;
}

async function refreshAgentConfig() {
  try {
    const data = await api('POST', '/api/agent/config', {});
    const platformCli = normalizeCli(data.agent_cli);
    AGENT_CMD = platformCli || LOCAL_AGENT_CMD;
  } catch (e) {
    console.log(`[daemon] 刷新执行器配置失败: ${e.message}`);
  }
}

// ════════════════════════════════ 一、任务执行（原模式 A/B） ════════════════════════════════

const execSessions = new Map();   // taskId -> { proc, startedAt, timeoutTimer, outputLog }
const recentlyDone = new Map();   // taskId -> timestamp（防 poll 重复拉起）

/** poll 一次：拿到到期任务 → 逐个拉起配置的 CLI 执行（正在执行/刚完成的跳过） */
async function pollTasks() {
  let tasks = [];
  try {
    const r = await api('POST', '/api/agent/poll', {});
    tasks = r.tasks ?? [];
  } catch (e) {
    console.log(`[daemon] poll 失败: ${e.message}`);
    return;
  }
  await refreshAgentConfig();
  await reportProjects();
  const now = Date.now();
  for (const [tid, ts] of recentlyDone) if (now - ts > RECENT_DONE_TTL_MS) recentlyDone.delete(tid);
  let started = 0;
  for (const t of tasks) {
    const tid = String(t.task_id);
    if (execSessions.has(tid) || recentlyDone.has(tid)) continue;
    spawnTaskAgent(t);
    started++;
  }
  if (started > 0) console.log(`[daemon] poll: ${tasks.length} 个到期，拉起 ${started} 个`);
}

/** 解析任务工作目录：~/projects/ 前缀 → home 下（与对话 workdir 同语义）；非法返回 null（用沙箱） */
function resolveTaskWorkdir(workdir, home = os.homedir()) {
  if (!workdir) return null;
  const p = workdir.startsWith('~/') || workdir === '~' ? path.join(home, workdir === '~' ? '' : workdir.slice(2)) : workdir;
  const resolved = path.resolve(p);
  const homeResolved = path.resolve(home);
  return resolved === homeResolved || resolved.startsWith(homeResolved + path.sep) ? resolved : null;
}

/** 任务启动语（CLI 自取上下文；workdir 项目模式不污染项目目录，信息全在启动语） */
function taskPrompt(t, cwd, sandboxDir) {
  const identityStep = resolveCli(AGENT_CMD) === 'pi'
    ? '第一个动作调 whoami 确认身份'
    : '第一个动作通过 MCP 工具 task-dispatch 调用 whoami 确认身份';
  const lines = [
    `你是主机 agent（agent_id 由 whoami 确认）。平台有一个到期任务需要你处理：`,
    `- task_id: ${t.task_id}`,
    `- 标题: ${t.title}`,
    `- 指令: ${t.instruction}`,
  ];
  if (cwd && sandboxDir === null) lines.push(`- 工作目录: ${cwd}（去那里干活，项目目录不被污染；本任务信息只在此 prompt 中）`);
  lines.push(
    `执行步骤：`,
    `1. ${identityStep}，再调 task(list,scope=due) 找到本 task_id 的任务，调 task(detail) 获取完整上下文（消息流/交付物要求）。`,
    `2. 若该任务状态是 claimed，说明你上次交付被验收打回——读拒绝理由，修复后重新提交（claimed 状态下允许再次 submit）。`,
    `3. 认领/开工后立即 task(reply) 回复 'received, starting work'。`,
    `4. 完成前 task(reply) 一次介绍交付物（简短摘要 + 你的过程/困难/心得）。`,
    `5. 最后一个动作 task(submit) 交差。`,
    `只处理上述任务，不要做无关的事。`,
  );
  return lines.join('\n');
}

/** 拉起执行器执行单个任务（一次性；交差靠 MCP task(submit)，本函数只兜底失败） */
function spawnTaskAgent(t) {
  const tid = String(t.task_id);
  const home = os.homedir();
  const wd = resolveTaskWorkdir(t.workdir);
  const sandbox = wd ? null : path.join(WORK_ROOT, 'tasks', tid);
  const cwd = wd ?? sandbox;
  try { mkdirSync(cwd, { recursive: true }); } catch (e) { console.log(`[daemon] 创建目录失败 ${cwd}: ${e.message}`); }

  // 沙箱模式：写 AGENTS.md 简报（项目目录模式不写，避免污染）
  if (sandbox) {
    try {
      for (const d of ['input', 'tmp', 'output']) mkdirSync(path.join(sandbox, d), { recursive: true });
      writeFileSync(path.join(sandbox, 'AGENTS.md'),
        `# 任务 ${tid}\n标题：${t.title}\n指令：${t.instruction}\n`, 'utf8');
    } catch (e) { console.log(`[daemon] 写 AGENTS.md 失败: ${e.message}`); }
  }

  const prompt = taskPrompt(t, wd ?? null, sandbox);
  const invocation = buildAgentInvocation(AGENT_CMD, { mode: 'task', prompt, sessionId: tid, cwd });
  const outLog = sandbox ? path.join(sandbox, 'output', 'stdout.txt') : null;
  console.log(`[daemon] 执行任务 ${tid} cwd=${cwd}` + (t.workdir ? '（项目目录）' : '（沙箱）'));
  const child = spawn(invocation.cmd, invocation.args, {
    cwd, env: invocation.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const s = { proc: child, startedAt: Date.now(), timeoutTimer: null, outBuf: '' };
  execSessions.set(tid, s);
  child.stdout.on('data', (d) => {
    s.outBuf = (s.outBuf + d.toString()).slice(-64 * 1024);
    if (outLog) { try { writeFileSync(outLog, s.outBuf); } catch { /* 忽略 */ } }
  });
  child.stderr?.on('data', (d) => console.log(`[daemon][task-${tid}] ${String(d).slice(0, 200)}`));
  s.timeoutTimer = setTimeout(() => {
    if (!execSessions.has(tid)) return;
    console.log(`[daemon] 任务 ${tid} 执行超时（>${TASK_TIMEOUT_MS / 1000}s），终止`);
    try { child.kill(); } catch { /* already dead */ }
    void reportTaskFailed(tid, `执行超时（超过 ${TASK_TIMEOUT_MS / 60000} 分钟）`);
  }, TASK_TIMEOUT_MS);
  child.on('close', (code, signal) => {
    clearTimeout(s.timeoutTimer);
    execSessions.delete(tid);
    recentlyDone.set(tid, Date.now());
    const tail = s.outBuf.split('\n').slice(-5).join('\n');
    if (code === 0) {
      // 正常退出：CLI 已通过 MCP task(submit) 交差（含验收链），daemon 不干预
      console.log(`[daemon] 任务 ${tid} 正常完成（code=0）`);
    } else {
      console.log(`[daemon] 任务 ${tid} 异常退出 code=${code} signal=${signal}，兜底标记失败`);
      void reportTaskFailed(tid, `执行器异常退出（code=${code ?? signal ?? '?'}）\n\n--- 输出尾部 ---\n${tail}`);
    }
  });
  child.on('error', (e) => {
    console.log(`[daemon] 任务 ${tid} 无法启动执行器: ${e.message}`);
    clearTimeout(s.timeoutTimer);
    execSessions.delete(tid);
    recentlyDone.set(tid, Date.now());
    void reportTaskFailed(tid,     `执行器启动失败：${e.message}`);
  });
}

/** 兜底：任务失败上报（仅 failed；success 必须走 pi 的 submit 验收链，daemon 不代劳） */
async function reportTaskFailed(tid, result) {
  try {
    await api('POST', '/api/agent/tasks/result', { task_id: tid, status: 'failed', result: String(result).slice(0, 8000) });
    console.log(`[daemon] 已上报任务 ${tid} 失败`);
  } catch (e) {
    console.log(`[daemon] 上报任务 ${tid} 失败结果时出错: ${e.message}`);
  }
}

// ════════════════════════════════ 二、对话桥接（原 chat-bridge） ════════════════════════════════

const PROJECTS_DIR = path.join(os.homedir(), 'projects');
const PROJECTS_REPORT_MS = Number(process.env.PROJECTS_REPORT_MS ?? 300_000);
let projectsTimer = null;

function scanProjects() {
  const dirs = [];
  try {
    if (!existsSync(PROJECTS_DIR)) return dirs;
    for (const name of readdirSync(PROJECTS_DIR)) {
      if (name.startsWith('.')) continue;
      const p = path.join(PROJECTS_DIR, name);
      try { if (statSync(p).isDirectory()) dirs.push(name); } catch { /* 忽略 */ }
    }
  } catch (e) { console.log(`[daemon] 扫描 ~/projects 失败: ${e.message}`); }
  return dirs.sort();
}
async function reportProjects() {
  const dirs = scanProjects();
  const clis = detectAvailableClis();
  try {
    await api('POST', '/api/agent/projects', { dirs, clis });
    console.log(`[daemon] 上报 ~/projects ${dirs.length} 个目录，执行器 ${clis.join(',') || '无'}`);
  }
  catch (e) { console.log(`[daemon] 上报 ~/projects 失败: ${e.message}`); }
}
function startProjectsTimer() {
  clearInterval(projectsTimer);
  projectsTimer = setInterval(() => { void reportProjects(); }, PROJECTS_REPORT_MS);
  projectsTimer.unref?.();
}

const sessions = new Map(); // convId -> { proc, seq, idleTimer, busy, ... }

function killSession(convId) {
  const s = sessions.get(convId);
  if (!s) return;
  clearTimeout(s.idleTimer); clearTimeout(s.timeoutTimer);
  try { s.proc.kill(); } catch { /* already dead */ }
  sessions.delete(convId);
  console.log(`[daemon] 空闲回收 ${convId}`);
}
function getUserHome(user) {
  if (!user) return null;
  try {
    const line = execSync(`getent passwd ${user}`, { encoding: 'utf8' }).trim();
    const parts = line.split(':');
    return parts.length >= 6 && parts[5] ? parts[5] : null;
  } catch { return null; }
}
function resolveWorkdir(workdir, home = os.homedir()) {
  if (!workdir) return null;
  const p = workdir.startsWith('~/') || workdir === '~' ? path.join(home, workdir === '~' ? '' : workdir.slice(2)) : workdir;
  const resolved = path.resolve(p);
  const homeResolved = path.resolve(home);
  if (resolved === homeResolved || resolved.startsWith(homeResolved + path.sep)) return resolved;
  console.log(`[daemon] 工作目录 ${workdir} 不在 home(${home}) 下，已忽略`);
  return null;
}
function scheduleIdleKill(convId) {
  const s = sessions.get(convId);
  if (!s) return;
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => killSession(convId), IDLE_KILL_MS);
}

function spawnPiProcess(convId, s, cwd) {
  const invocation = buildAgentInvocation(AGENT_CMD, {
    mode: 'chat',
    prompt: '',
    sessionId: `chat-${convId}`,
    cwd,
  });
  const args = [...invocation.args];
  if (s.name) args.push('--name', String(s.name).slice(0, 120));
  const runUser = s.runUser && s.runUser !== (process.env.USER || os.userInfo().username) ? s.runUser : null;
  if (runUser) {
    const sudoArgs = ['-n', '-u', runUser, '-H', '--', invocation.cmd, ...args];
    return spawn('sudo', sudoArgs, { cwd, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }
  return spawn(invocation.cmd, args, { cwd, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function spawnPi(convId, onEvent) {
  const existing = sessions.get(convId);
  const s = existing ?? { proc: null, seq: 1, idleTimer: null, timeoutTimer: null, busy: false, buffer: '' };
  if (!existing) sessions.set(convId, s);
  if (s.busy) { console.log(`[daemon] ${convId} 上一条还在处理中，忽略`); return; }
  if (!s.proc || s.proc.killed || s.proc.exitCode !== null) {
    const targetHome = s.runUser ? (getUserHome(s.runUser) ?? os.homedir()) : os.homedir();
    const cwd = resolveWorkdir(s.workdir, targetHome) ?? path.join(targetHome, 'projects');
    if (!existsSync(cwd)) {
      try {
        if (s.runUser && targetHome !== os.homedir()) execSync(`sudo -n -u ${s.runUser} mkdir -p "${cwd}"`);
        else mkdirSync(cwd, { recursive: true });
      } catch (e) { console.log(`[daemon] 创建目录失败 ${cwd}: ${e.message}`); }
    }
    const child = spawnPiProcess(convId, s, cwd);
    s.proc = child;
    console.log(`[daemon] spawn pi ${convId} pid=${child.pid} cwd=${cwd}` + (s.runUser ? ` user=${s.runUser}` : '') + (s.name ? ` name=${s.name}` : ''));
    child.stderr?.on('data', (d) => console.log(`[daemon][pi-stderr] ${String(d).slice(0, 200)}`));
    child.stdout.on('data', (d) => {
      s.buffer += d.toString();
      let nl;
      while ((nl = s.buffer.indexOf('\n')) >= 0) {
        const line = s.buffer.slice(0, nl); s.buffer = s.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let evt; try { evt = JSON.parse(line); } catch { continue; }
        handlePiEvent(convId, evt, onEvent);
      }
    });
    child.on('close', (code, signal) => {
      const failed = code !== 0 && !s.replied;
      s.proc = null; s.busy = false; clearTimeout(s.timeoutTimer);
      if (failed) {
        const runUserNote = s.runUser ? `（run_user=${s.runUser}，需远端 sudoers 白名单允许 bridge 用户无密码 sudo 切换）` : '';
        const msg = `\n\n⚠️ pi 进程异常退出（code=${code ?? signal ?? '?'}），本次未产生回复${runUserNote}。请检查 daemon 日志或会话配置后重试。`;
        console.log(`[daemon] pi 异常退出 ${convId} code=${code} signal=${signal}`);
        onEvent({ type: 'conv_stream_end', conversation_id: convId, content: msg });
      }
      scheduleIdleKill(convId);
    });
    child.on('error', (e) => { console.log(`[daemon][pi-error] ${e.message}`); s.proc = null; s.busy = false; });
    setTimeout(() => sendPrompt(convId), 500);
  } else {
    sendPrompt(convId);
  }
}

function sendPrompt(convId) {
  const s = sessions.get(convId);
  if (!s || !s.proc || s.proc.killed) return;
  s.busy = true;
  clearTimeout(s.idleTimer);
  clearTimeout(s.timeoutTimer);
  s.timeoutTimer = setTimeout(() => {
    const ss = sessions.get(convId);
    if (!ss || !ss.busy) return;
    console.log(`[daemon] pi 生成超时（>${PI_TIMEOUT_MS / 1000}s），终止会话 ${convId}`);
    try { ss.proc?.kill(); } catch { /* already dead */ }
    ss.busy = false; ss.proc = null;
    forward({ type: 'conv_stream_end', conversation_id: convId, content: `\n\n⏱️ 回复超时已终止（生成超过 ${PI_TIMEOUT_MS / 60000} 分钟），如需继续请重发消息。` });
  }, PI_TIMEOUT_MS);
  const msg = buildPrompt(s);
  console.log(`[daemon] prompt → pi ${convId}: ${msg.slice(0, 60)}`);
  s.proc.stdin.write(JSON.stringify({ type: 'prompt', id: String(s.seq++), message: msg }) + '\n');
}

function buildPrompt(s) {
  const lines = [];
  if (s.taskCtx) {
    lines.push('【当前对话绑定任务】你正在与平台管理员就以下任务进行对话讨论：');
    lines.push(`- 任务: ${s.taskCtx.task_id}`);
    lines.push(`- 标题: ${s.taskCtx.title}`);
    lines.push(`- 状态: ${s.taskCtx.status}`);
    if (s.taskCtx.instruction_short) lines.push(`- 任务指令摘要: ${s.taskCtx.instruction_short}`);
    lines.push('讨论请围绕该任务展开；如需任务详情/交付物可用 MCP 工具 task(detail) 查看。');
    lines.push('');
  }
  lines.push(`管理员消息：${s.pendingMsg ?? ''}`);
  lines.push('请直接回复管理员（回复内容将作为 agent 消息发送给他，无需客套）。');
  return lines.join('\n');
}

function handlePiEvent(convId, evt, onEvent) {
  if (evt.type === 'message_start') {
    const s = sessions.get(convId);
    if (s) s.replied = false;
    onEvent({ type: 'conv_stream_start', conversation_id: convId });
  } else if (evt.type === 'message_update') {
    const am = evt.assistantMessageEvent;
    if (am?.type === 'text_delta' && am.delta) {
      onEvent({ type: 'conv_stream', conversation_id: convId, delta: am.delta });
    }
  } else if (evt.type === 'agent_end') {
    const text = (evt.messages ?? []).filter((m) => m.role === 'assistant').pop()
      ?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('') ?? '';
    console.log(`[daemon] pi agent_end ${convId}: ${text.length} 字`);
    if (text.trim()) {
      const s = sessions.get(convId);
      if (s) s.replied = true;
      onEvent({ type: 'conv_stream_end', conversation_id: convId, content: text.trim() });
    }
    const s = sessions.get(convId);
    if (s) { s.busy = false; clearTimeout(s.timeoutTimer); scheduleIdleKill(convId); }
  }
}

// ════════════════════════════════ 三、WS 连接 + 轮询主循环 ════════════════════════════════

let ws = null;
function connect() {
  ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${AGENT_KEY}` } });
  ws.on('open', () => console.log(`[daemon] WS 已连接 ${WS_URL}`));
  ws.on('message', (raw) => {
    let evt; try { evt = JSON.parse(String(raw)); } catch { return; }
    if (evt.type === 'projects_rescan') { void reportProjects(); return; }
    if (evt.type === 'conv_new_message' && evt.conversation_id) {
      const s = sessions.get(evt.conversation_id);
      const init = { proc: null, seq: 1, idleTimer: null, timeoutTimer: null, busy: false, buffer: '', pendingMsg: evt.content, taskCtx: evt.task ?? null, workdir: evt.workdir ?? null, runUser: evt.run_user ?? null, name: evt.name ?? null };
      if (s) { s.pendingMsg = evt.content; if (evt.task) s.taskCtx = evt.task; if (evt.workdir) s.workdir = evt.workdir; if (evt.run_user !== undefined) s.runUser = evt.run_user ?? null; if (evt.name !== undefined) s.name = evt.name ?? null; }
      else sessions.set(evt.conversation_id, init);
      console.log(`[daemon] ${new Date().toLocaleTimeString()} 新消息 ${evt.conversation_id}: ${String(evt.content).slice(0, 40)}` + (evt.task ? `（任务 ${evt.task.task_id}）` : '') + (evt.workdir ? `（workdir ${evt.workdir}）` : '') + (evt.run_user ? `（user ${evt.run_user}）` : ''));
      spawnPi(evt.conversation_id, forward);
    }
  });
  ws.on('close', () => {
    console.log('[daemon] WS 断开，退回轮询兜底');
    ws = null;
    startChatPolling();
    setTimeout(connect, 3000);
  });
  ws.on('error', (e) => console.error('[daemon] WS 错误:', e.message));
}

function forward(evt) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(evt));
  } else if (evt.type === 'conv_stream_end' && evt.content) {
    api('POST', '/api/agent/chat-reply', { conversation_id: evt.conversation_id, content: evt.content }).catch(() => {});
  }
}

// 断线兜底：chat-check 轮询（对话）
let chatPolling = false;
async function startChatPolling() {
  if (chatPolling) return;
  chatPolling = true;
  while (ws === null) {
    try {
      const { conversations } = await api('POST', '/api/agent/chat-check', {});
      if (conversations?.length) {
        for (const c of conversations) {
          let taskCtx = null, workdir = null, runUser = null, name = null;
          try {
            const hist = await api('POST', '/api/agent/chat-messages', { conversation_id: c.conversation_id });
            taskCtx = hist.task ?? null; workdir = hist.conversation?.workdir ?? null;
            runUser = hist.conversation?.run_user ?? null; name = hist.conversation?.name ?? null;
          } catch { /* 拉不到上下文不影响回复 */ }
          const s = sessions.get(c.conversation_id);
          const init = { proc: null, seq: 1, idleTimer: null, timeoutTimer: null, busy: false, buffer: '', pendingMsg: c.last_message ?? '请继续我们的对话。', taskCtx, workdir, runUser, name };
          if (s) { s.pendingMsg = c.last_message ?? '请继续我们的对话。'; if (taskCtx) s.taskCtx = taskCtx; if (workdir) s.workdir = workdir; if (runUser !== undefined && runUser !== null) s.runUser = runUser; if (name !== undefined && name !== null) s.name = name; }
          else sessions.set(c.conversation_id, init);
          spawnPi(c.conversation_id, forward);
        }
      }
    } catch { /* 平台不可达 */ }
    await new Promise((r) => setTimeout(r, POLL_MS_CHAT));
  }
  chatPolling = false;
}

// 任务轮询主循环（WS 在不在都跑：平台无任务推送通道，poll 是唯一来源）
let taskPolling = false;
async function startTaskPolling() {
  if (taskPolling) return;
  taskPolling = true;
  while (true) {
    await pollTasks();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

connect();
startTaskPolling();
startProjectsTimer();
void reportProjects();
console.log(`[daemon] agent-daemon 启动 key=${AGENT_KEY.slice(0, 8)}… cli=${AGENT_CMD} work=${WORK_ROOT} poll=${POLL_MS / 1000}s`);
