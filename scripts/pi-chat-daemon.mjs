#!/usr/bin/env node
// 常驻对话监听器（零 token）：1-2s 高频 chat-check → 有消息拉起 pi --cwd ~/pi-tasks/{task_id} 回复
// - 只有 LLM 回复才花钱；轮询本身是零 token 的 REST（chat-check 零副作用，可高频）
// - 静默降频：连续无消息自动拉大轮询间隔（省一点轮询量），有新消息立即恢复秒级
// - Ctrl+C 退出；用 task scheduler / systemd / nohup 常驻
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PLATFORM_URL ?? 'http://127.0.0.1:3000';
const POLL_MS = Number(process.env.CHAT_POLL_MS ?? 1500);          // 活跃期轮询间隔（秒级）
const IDLE_MS = Number(process.env.CHAT_IDLE_MS ?? 5000);           // 静默后降频间隔
const IDLE_AFTER_ROUNDS = Number(process.env.CHAT_IDLE_AFTER ?? 80); // 连续多少轮无消息算静默（80×1.5s≈2min）
const PI_TIMEOUT_MS = Number(process.env.CHAT_PI_TIMEOUT_MS ?? 180000);
const TASKS_ROOT = path.join(os.homedir(), 'pi-tasks');             // 任务持久目录 base

/** 从 pi 的 mcp.json 读 task-dispatch 的 key（兼容 bearerToken / bearerTokenEnv） */
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
if (!AGENT_KEY) {
  console.error('缺少 key：设 PI_AGENT_KEY 环境变量，或配置 ~/.pi/agent/mcp.json 的 task-dispatch');
  process.exit(1);
}

async function api(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${pathname}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** 零副作用回合检测：最后消息不是我的 → 轮到回复 */
async function chatCheck() {
  const { tasks } = await api('POST', '/api/agent/chat-check', {});
  return tasks ?? [];
}

/** 解析 pi 的 JS 入口（Windows npm 全局），找不到则回退 PATH 中的 pi 命令 */
function resolvePiCli() {
  if (process.env.PI_CLI) return process.env.PI_CLI;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const c = path.join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (existsSync(c)) return c;
  }
  return null;
}

/** 拉起 pi --cwd ~/pi-tasks/{task_id} 回复本轮对话并更新 AGENTS.md */
function runPiReply(taskId, title, timeoutMs) {
  return new Promise((resolve, reject) => {
    const dir = path.join(TASKS_ROOT, taskId);
    mkdirSync(dir, { recursive: true });
    const prompt =
      `调 task(detail) 查看任务 ${taskId}「${title}」的完整消息流——管理员刚回复了你，最后一条消息是 TA 的，` +
      `你要直接回应那条消息。先读取当前目录的 AGENTS.md 了解前情（若不存在或为空，先用 task(detail) 的任务指令初始化它，` +
      `再补一段"本任务处于对话中"的说明）。然后用 task(reply, type=chat) 回复管理员，内容务实、直接回应 TA 的最后一条消息。` +
      `回复完成后，把本轮对话的要点/结论/待办追加到 AGENTS.md（作为后续轮次的备忘录）。`;
    // 直接 node 跑 pi 的 cli.js（参数数组不经 cmd/shell 拼接，Windows 下中文/引号安全）；cwd 设定任务目录
    const piCli = resolvePiCli();
    const child = piCli
      ? spawn(process.execPath, [piCli, '-p', '-a', prompt], { cwd: dir, env: { ...process.env } })
      : spawn('pi', ['-p', '-a', prompt], { cwd: dir, env: { ...process.env } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('pi 回复超时'));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout.trim());
    });
  });
}

let idleRounds = 0;
console.log(`[pi-chat] daemon 启动 key=${AGENT_KEY.slice(0, 8)}… poll=${POLL_MS}ms idle=${IDLE_MS}ms tasksRoot=${TASKS_ROOT}`);
for (;;) {
  try {
    const tasks = await chatCheck();
    if (tasks.length > 0) {
      idleRounds = 0;
      for (const t of tasks) {
        console.log(`[pi-chat] ${new Date().toLocaleTimeString()} 轮到回复 ${t.task_id}「${t.title}」`);
        try {
          const out = await runPiReply(t.task_id, String(t.title), PI_TIMEOUT_MS);
          console.log(`[pi-chat] 回复完成 ${t.task_id}（${out.length} 字符）`);
        } catch (e) {
          console.error(`[pi-chat] 回复失败 ${t.task_id}: ${e.message}`);
        }
      }
    } else {
      idleRounds++;
    }
    const delay = idleRounds >= IDLE_AFTER_ROUNDS ? IDLE_MS : POLL_MS;
    await new Promise((r) => setTimeout(r, delay));
  } catch (e) {
    console.error(`[pi-chat] chat-check 失败: ${e.message}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
