#!/usr/bin/env node
// chat-bridge：pi agent 对话桥接器（常驻）
// - 连平台 WS /api/agent/chat-stream（Bearer）；收到 conv_new_message → 拉起 pi --mode rpc
// - pi 流式事件（text_delta 打字机增量）→ 平台 conv_stream*（落库 + 前端实时）
// - 每对话一个 pi 子进程（--session-id=convId 续接）：空闲 kill，下条消息拉起续接（记忆保持）
// - WS 断线 → 退回 chat-check 轮询（1.5s）+ 拉起 pi 一次性 chat-reply（不流式）
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
const BASE = process.env.PLATFORM_URL ?? 'http://127.0.0.1:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/api/agent/chat-stream';
const IDLE_KILL_MS = Number(process.env.CHAT_IDLE_KILL_MS ?? 120000); // 回复完成后空闲回收
const PI_TIMEOUT_MS = Number(process.env.CHAT_PI_TIMEOUT_MS ?? 300000);
const POLL_MS = Number(process.env.CHAT_POLL_MS ?? 1500);
// 对话场景首字要快：默认低思考级别（deepseek-v4-flash 默认 high，首 token 极慢）；
// 可 CHAT_PI_THINKING=off|minimal|low|medium|high|xhigh|max 覆盖
const PI_THINKING = process.env.CHAT_PI_THINKING ?? 'low';

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
if (!AGENT_KEY) { console.error('缺少 key'); process.exit(1); }

function piCli() {
  if (process.env.PI_CLI) return process.env.PI_CLI;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const c = path.join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (existsSync(c)) return c;
  }
  return null;
}
const CLI = piCli();

// ── 平台 REST（兜底/上下文） ──
async function api(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${pathname}: ${res.status}`);
  return data;
}

// ── pi 子进程管理（每对话一个；--session-id 续接） ──
const sessions = new Map(); // convId -> { proc, seq, idleTimer, busy }

function killSession(convId) {
  const s = sessions.get(convId);
  if (!s) return;
  clearTimeout(s.idleTimer);
  clearTimeout(s.timeoutTimer);
  try { s.proc.kill(); } catch { /* already dead */ }
  sessions.delete(convId);
  console.log(`[bridge] 空闲回收 ${convId}`);
}

/** 解析对话工作目录并校验必须在主机 home 下（安全限制）；不合法返回 null */
function resolveWorkdir(workdir) {
  if (!workdir) return null;
  const home = os.homedir();
  const p = workdir.startsWith('~/') || workdir === '~'
    ? path.join(home, workdir === '~' ? '' : workdir.slice(2))
    : workdir;
  const resolved = path.resolve(p);
  const homeResolved = path.resolve(home);
  if (resolved === homeResolved || resolved.startsWith(homeResolved + path.sep)) {
    return resolved;
  }
  console.log(`[bridge] 工作目录 ${workdir} 不在 home 下，已忽略（用默认目录）`);
  return null;
}

function scheduleIdleKill(convId) {
  const s = sessions.get(convId);
  if (!s) return;
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => killSession(convId), IDLE_KILL_MS);
}

/** 拉起 pi 会话并注入消息；返回 { start(convId), delta(text), end(convId, content) } 回调 */
function spawnPi(convId, onEvent) {
  const existing = sessions.get(convId);
  const s = existing ?? {
    proc: null, seq: 1, idleTimer: null, timeoutTimer: null, busy: false, buffer: '',
  };
  if (!existing) sessions.set(convId, s);
  if (s.busy) {
    console.log(`[bridge] ${convId} 上一条还在处理中，忽略本次消息`);
    return; // 上一条还没回完，忽略并发（超时保护会兜底解除）
  }
  if (!s.proc || s.proc.killed || s.proc.exitCode !== null) {
    const cwd = resolveWorkdir(s.workdir) ?? process.cwd();
    if (!existsSync(cwd)) {
      try { mkdirSync(cwd, { recursive: true }); } catch (e) { console.log(`[bridge] 创建目录失败 ${cwd}: ${e.message}`); }
    }
    const child = CLI
      ? spawn(process.execPath, [CLI, '--mode', 'rpc', '--session-id', `chat-${convId}`, '--thinking', PI_THINKING], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn('pi', ['--mode', 'rpc', '--session-id', `chat-${convId}`, '--thinking', PI_THINKING], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    s.proc = child;
    console.log(`[bridge] spawn pi ${convId} pid=${child.pid} cwd=${cwd}`);
    child.stderr?.on('data', (d) => console.log(`[bridge][pi-stderr] ${String(d).slice(0, 200)}`));
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
    child.on('close', () => { s.proc = null; s.busy = false; });
    child.on('error', (e) => { console.log(`[bridge][pi-error] ${e.message}`); s.proc = null; s.busy = false; });
    // 会话就绪后注入（rpc 模式直接可写；稍等进程起来）
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
  // 生成超时保护：busy 超过 PI_TIMEOUT_MS（默认 5 分钟）→ 终止 pi + 解除 busy + 回帖提示
  clearTimeout(s.timeoutTimer);
  s.timeoutTimer = setTimeout(() => {
    const ss = sessions.get(convId);
    if (!ss || !ss.busy) return;
    console.log(`[bridge] pi 生成超时（>${PI_TIMEOUT_MS / 1000}s），终止会话 ${convId}`);
    try { ss.proc?.kill(); } catch { /* already dead */ }
    ss.busy = false;
    ss.proc = null;
    forward({ type: 'conv_stream_end', conversation_id: convId, content: `\n\n⏱️ 回复超时已终止（生成超过 ${PI_TIMEOUT_MS / 60000} 分钟），如需继续请重发消息。` });
  }, PI_TIMEOUT_MS);
  const msg = buildPrompt(s);
  console.log(`[bridge] prompt → pi ${convId}: ${msg.slice(0, 60)}`);
  s.proc.stdin.write(JSON.stringify({ type: 'prompt', id: String(s.seq++), message: msg }) + '\n');
}

/** 构造 pi prompt：对话绑定任务时先注入任务上下文，让 agent 明确讨论对象 */
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

/** pi 事件 → 平台流式事件（text_delta 打字机；agent_end 落库） */
function handlePiEvent(convId, evt, onEvent) {
  if (evt.type === 'message_start') {
    onEvent({ type: 'conv_stream_start', conversation_id: convId });
  } else if (evt.type === 'message_update') {
    const am = evt.assistantMessageEvent;
    if (am?.type === 'text_delta' && am.delta) {
      onEvent({ type: 'conv_stream', conversation_id: convId, delta: am.delta });
    }
  } else if (evt.type === 'agent_end') {
    const text = (evt.messages ?? []).filter((m) => m.role === 'assistant').pop()
      ?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('') ?? '';
    console.log(`[bridge] pi agent_end ${convId}: ${text.length} 字`);
    if (text.trim()) onEvent({ type: 'conv_stream_end', conversation_id: convId, content: text.trim() });
    const s = sessions.get(convId);
    if (s) { s.busy = false; clearTimeout(s.timeoutTimer); scheduleIdleKill(convId); }
  }
}

// ── WS 连接（平台 → 桥接器） ──
let ws = null;
function connect() {
  ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${AGENT_KEY}` } });
  ws.on('open', () => console.log(`[bridge] WS 已连接 ${WS_URL}`));
  ws.on('message', (raw) => {
    let evt; try { evt = JSON.parse(String(raw)); } catch { return; }
    if (evt.type === 'conv_new_message' && evt.conversation_id) {
      const s = sessions.get(evt.conversation_id);
      const init = { proc: null, seq: 1, idleTimer: null, timeoutTimer: null, busy: false, buffer: '', pendingMsg: evt.content, taskCtx: evt.task ?? null, workdir: evt.workdir ?? null };
      if (s) { s.pendingMsg = evt.content; if (evt.task) s.taskCtx = evt.task; if (evt.workdir) s.workdir = evt.workdir; }
      else sessions.set(evt.conversation_id, init);
      console.log(`[bridge] ${new Date().toLocaleTimeString()} 新消息 ${evt.conversation_id}: ${String(evt.content).slice(0, 40)}` + (evt.task ? `（任务 ${evt.task.task_id}）` : '') + (evt.workdir ? `（workdir ${evt.workdir}）` : ''));
      spawnPi(evt.conversation_id, forward);
    }
  });
  ws.on('close', () => {
    console.log('[bridge] WS 断开，退回 chat-check 轮询兜底');
    ws = null;
    startPolling();
    setTimeout(connect, 3000);
  });
  ws.on('error', (e) => console.error('[bridge] WS 错误:', e.message));
}

/** 转发到平台（经 WS 或 REST 兜底） */
function forward(evt) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(evt));
  } else {
    // 断线兜底：非流式直接落库
    if (evt.type === 'conv_stream_end' && evt.content) {
      api('POST', '/api/agent/chat-reply', { conversation_id: evt.conversation_id, content: evt.content }).catch(() => {});
    }
  }
}

// ── 断线兜底：chat-check 轮询（零 token） ──
let polling = false;
async function startPolling() {
  if (polling) return;
  polling = true;
  while (ws === null) {
    try {
      const { conversations } = await api('POST', '/api/agent/chat-check', {});
      if (conversations?.length) {
        for (const c of conversations) {
          // 拉对话 + 任务上下文（兜底路径无推送，需自取）
          let taskCtx = null;
          let workdir = null;
          try {
            const hist = await api('POST', '/api/agent/chat-messages', { conversation_id: c.conversation_id });
            taskCtx = hist.task ?? null;
            workdir = hist.conversation?.workdir ?? null;
          } catch { /* 拉不到上下文不影响回复 */ }
          const s = sessions.get(c.conversation_id);
          const init = { proc: null, seq: 1, idleTimer: null, timeoutTimer: null, busy: false, buffer: '', pendingMsg: c.last_message ?? '请继续我们的对话。', taskCtx, workdir };
          if (s) { s.pendingMsg = c.last_message ?? '请继续我们的对话。'; if (taskCtx) s.taskCtx = taskCtx; if (workdir) s.workdir = workdir; }
          else sessions.set(c.conversation_id, init);
          spawnPi(c.conversation_id, forward);
        }
      }
    } catch { /* 平台不可达 */ }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  polling = false;
}

connect();
console.log(`[bridge] chat-bridge 启动 key=${AGENT_KEY.slice(0, 8)}… pi=${CLI ?? 'pi'}`);
