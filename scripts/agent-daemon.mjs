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
//   PLATFORM_URL=http://x PI_AGENT_KEY=pd-xxx node agent-daemon.mjs
//   （key 缺省自动从 ~/.pi/agent/mcp.json 的 task-dispatch 段读取，与 chat-bridge 一致）
//
// 功能：
//   1. 连平台 WS（/api/agent/chat-stream）：管理员对话推送 → 拉起 pi --mode rpc 会话
//      （打字机流式 / --session-id 续接 / 空闲 kill / 超时保护 / run_user sudo）
//   2. 定时 poll（默认 60s，POLL_MS）：claimDueTasks → 新任务拉起 pi -p 一次性执行
//      （MCP task(submit) 交差；异常退出 / 超时 → POST /api/tasks/result failed 兜底）
//   3. WS 断线 → 退回 chat-check 轮询（对话兜底）+ poll 继续（任务不受影响）
//   4. ~/projects 目录扫描上报（主机会话工作目录选择）
//
// 环境变量：
//   PLATFORM_URL        平台地址（默认 http://127.0.0.1:3000）
//   PI_AGENT_KEY        agent key（优先；否则读 mcp.json task-dispatch）
//   POLL_MS             任务轮询周期（默认 60000）
//   TASK_TIMEOUT_MS     单任务执行超时（默认 1800000 = 30min）
//   WORK_ROOT           沙箱任务工作目录根（默认 ~/pi-agent-work）
//   CHAT_*              对话参数（沿用 chat-bridge：CHAT_IDLE_KILL_MS / CHAT_PI_TIMEOUT_MS / CHAT_POLL_MS / CHAT_PI_THINKING）
//   PI_CLI              pi CLI 绝对路径（默认自动探测）
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const BASE = process.env.PLATFORM_URL ?? 'http://127.0.0.1:3000';
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
  try {
    const cfg = JSON.parse(readFileSync(path.join(os.homedir(), '.pi', 'agent', 'mcp.json'), 'utf8'));
    const srv = cfg.mcpServers?.['task-dispatch'];
    if (srv?.bearerToken) return srv.bearerToken;
    if (srv?.bearerTokenEnv) return process.env[srv.bearerTokenEnv] ?? '';
  } catch { /* fallthrough */ }
  return '';
}
const AGENT_KEY = process.env.PI_AGENT_KEY || readKeyFromPiMcp();
if (!AGENT_KEY) { console.error('缺少 key：设 PI_AGENT_KEY 环境变量，或在 ~/.pi/agent/mcp.json 配 task-dispatch 段'); process.exit(1); }

function piCli() {
  if (process.env.PI_CLI) return process.env.PI_CLI;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const c = path.join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (existsSync(c)) return c;
  }
  return null;
}
const CLI = piCli();

/** pi 调用方式：优先绝对路径（sudo 场景 PATH 受 secure_path 限制） */
function piInvocation() {
  if (CLI) return { cmd: process.execPath, args: [CLI] };
  const candidates = ['/usr/local/bin/pi', '/usr/bin/pi', path.join(os.homedir(), '.npm-global', 'bin', 'pi')];
  for (const p of candidates) if (existsSync(p)) return { cmd: p, args: [] };
  return { cmd: 'pi', args: [] };
}

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

// ════════════════════════════════ 一、任务执行（原模式 A/B） ════════════════════════════════

const execSessions = new Map();   // taskId -> { proc, startedAt, timeoutTimer, outputLog }
const recentlyDone = new Map();   // taskId -> timestamp（防 poll 重复拉起）

/** poll 一次：拿到到期任务 → 逐个拉起 pi 执行（正在执行/刚完成的跳过） */
async function pollTasks() {
  let tasks = [];
  try {
    const r = await api('POST', '/api/agent/poll', {});
    tasks = r.tasks ?? [];
  } catch (e) {
    console.log(`[daemon] poll 失败: ${e.message}`);
    return;
  }
  const now = Date.now();
  for (const [tid, ts] of recentlyDone) if (now - ts > RECENT_DONE_TTL_MS) recentlyDone.delete(tid);
  let started = 0;
  for (const t of tasks) {
    const tid = String(t.task_id);
    if (execSessions.has(tid) || recentlyDone.has(tid)) continue;
    spawnTaskPi(t);
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

/** 任务启动语（-p 模式，pi 自取上下文；workdir 项目模式不污染项目目录，信息全在启动语） */
function taskPrompt(t, cwd, sandboxDir) {
  const lines = [
    `你是主机 agent（agent_id 由 whoami 确认）。平台有一个到期任务需要你处理：`,
    `- task_id: ${t.task_id}`,
    `- 标题: ${t.title}`,
    `- 指令: ${t.instruction}`,
  ];
  if (cwd && sandboxDir === null) lines.push(`- 工作目录: ${cwd}（去那里干活，项目目录不被污染；本任务信息只在此 prompt 中）`);
  lines.push(
    `执行步骤：`,
    `1. 第一个动作调 whoami 确认身份，再调 task(list,scope=due) 找到本 task_id 的任务，调 task(detail) 获取完整上下文（消息流/交付物要求）。`,
    `2. 若该任务状态是 claimed，说明你上次交付被验收打回——读拒绝理由，修复后重新提交（claimed 状态下允许再次 submit）。`,
    `3. 认领/开工后立即 task(reply) 回复 'received, starting work'。`,
    `4. 完成前 task(reply) 一次介绍交付物（简短摘要 + 你的过程/困难/心得）。`,
    `5. 最后一个动作 task(submit) 交差。`,
    `只处理上述任务，不要做无关的事。`,
  );
  return lines.join('\n');
}

/** 拉起 pi 执行单个任务（-p 一次性；交差靠 MCP task(submit)，本函数只兜底失败） */
function spawnTaskPi(t) {
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

  const { cmd, args: invArgs } = piInvocation();
  const prompt = taskPrompt(t, wd ?? null, sandbox);
  const outLog = sandbox ? path.join(sandbox, 'output', 'stdout.txt') : null;
  console.log(`[daemon] 执行任务 ${tid} cwd=${cwd}` + (t.workdir ? '（项目目录）' : '（沙箱）'));
  // 注意：pi 没有 --cwd 参数，工作目录用 spawn 的 cwd 选项注入
  const child = spawn(cmd, [...invArgs, '-p', '-a', prompt], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
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
      // 正常退出：pi 已通过 MCP task(submit) 交差（含验收链），daemon 不干预
      console.log(`[daemon] 任务 ${tid} 正常完成（code=0）`);
    } else {
      console.log(`[daemon] 任务 ${tid} 异常退出 code=${code} signal=${signal}，兜底标记失败`);
      void reportTaskFailed(tid, `pi 执行异常退出（code=${code ?? signal ?? '?'}）\n\n--- 输出尾部 ---\n${tail}`);
    }
  });
  child.on('error', (e) => {
    console.log(`[daemon] 任务 ${tid} 无法启动 pi: ${e.message}`);
    clearTimeout(s.timeoutTimer);
    execSessions.delete(tid);
    recentlyDone.set(tid, Date.now());
    void reportTaskFailed(tid, `pi 启动失败：${e.message}`);
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
  try { await api('POST', '/api/agent/projects', { dirs }); console.log(`[daemon] 上报 ~/projects ${dirs.length} 个目录`); }
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
  const args = ['--mode', 'rpc', '--session-id', `chat-${convId}`, '--thinking', PI_THINKING];
  if (s.name) args.push('--name', String(s.name).slice(0, 120));
  const nodeExe = process.execPath;
  const runUser = s.runUser && s.runUser !== (process.env.USER || os.userInfo().username) ? s.runUser : null;
  if (runUser) {
    const { cmd, args: invArgs } = piInvocation();
    const sudoArgs = ['-n', '-u', runUser, '-H', '--', cmd, ...invArgs, ...args];
    return spawn('sudo', sudoArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }
  // 统一走 piInvocation（绝对路径优先，避免 PATH 不含 pi 时报 ENOENT）；
  // CLI 命中时 cmd=node、args=[cli.js]；回退时 cmd='pi' 靠 PATH
  const { cmd, args: invArgs } = piInvocation();
  return spawn(cmd, [...invArgs, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
console.log(`[daemon] agent-daemon 启动 key=${AGENT_KEY.slice(0, 8)}… pi=${CLI ?? 'pi'} work=${WORK_ROOT} poll=${POLL_MS / 1000}s`);
