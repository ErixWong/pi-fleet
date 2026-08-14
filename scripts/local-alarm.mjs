// 本地闹钟脚本（等效 Linux 部署的调度层，Node 版 alarm.sh）
// 流程：REST poll 领取平台任务 → 拉起 pi -p 执行（用 pi 的 MCP 工具干资料收集）→ REST 回传结果
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.PLATFORM_URL ?? 'http://127.0.0.1:3000';
const AGENT_KEY = process.env.PI_AGENT_KEY;
const WORK_ROOT = path.resolve('work');

if (!AGENT_KEY) {
  console.error('缺少 PI_AGENT_KEY 环境变量');
  process.exit(1);
}
mkdirSync(WORK_ROOT, { recursive: true });

const log = (...a) => console.log(`[alarm ${new Date().toLocaleTimeString()}]`, ...a);

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

/** 拉起 pi -p 执行任务，返回 pi 的最终输出文本 */
function runPi(taskId, instruction, timeoutMs) {
  return new Promise((resolve, reject) => {
    const prompt =
      `你正在执行任务 ${taskId}。请严格按以下任务指令完成：\n\n${instruction}\n\n` +
      `完成后，把完整的资料收集结果（调研报告/总结）作为你的最终回复输出，不要省略。`;
    const child = spawn('pi', ['-p', prompt], { shell: true, env: { ...process.env } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('pi 执行超时'));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(stdout.trim());
    });
    child.on('error', reject);
  });
}

// 1. 心跳
await api('POST', '/api/agent/heartbeat', {});
log('心跳 ok');

// 2. poll 领取任务
const { tasks } = await api('POST', '/api/agent/poll', {});
log(`poll 领取 ${tasks.length} 个任务`);

// 2.5 公共池二段式扫描（§9.2 G4）：程序拉公开列表（零 token）→ 有候选才拉起 LLM 判断认领
let pool = [];
try {
  const r = await api('POST', '/api/agent/pool', {});
  pool = r.pool ?? [];
  if (pool.length > 0) log(`公共池 ${pool.length} 个候选任务`);
} catch (e) {
  log(`公共池扫描失败: ${e.message}`);
}
if (pool.length > 0 && tasks.length === 0) {
  // 有候选才拉起 LLM（pi）读描述自主判断是否认领
  const listText = pool
    .map((t) => `- ${t.task_id}「${t.title}」\n  指令：${t.instruction.slice(0, 300)}\n  验收方案：${JSON.stringify(t.deliverable_spec || [])}`)
    .join('\n\n');
  const judgePrompt =
    `你是任务分发平台的一台主机 agent。当前公共池有以下公开任务（已开启接单）：\n\n${listText}\n\n` +
    `请阅读任务描述，判断是否有你能力范围内、值得认领的任务（考虑资源/能力/内外分离边界）。` +
    `若有，调用 MCP task 工具（task-dispatch 服务器）的 task(claim) 认领其中最合适的一个；` +
    `若都不合适，直接回复"无"即可，不要认领。`;
  try {
    const judge = await runPi('pool-judge', judgePrompt, 3 * 60 * 1000);
    log(`公共池判断完成：${judge.slice(0, 200)}`);
  } catch (e) {
    log(`公共池判断失败: ${e.message}`);
  }
}

if (tasks.length === 0 && pool.length === 0) {
  console.log('无任务，结束');
  process.exit(0);
}

// 3. 逐个执行
for (const t of tasks) {
  const taskDir = path.join(WORK_ROOT, 'tasks', t.task_id);
  mkdirSync(taskDir, { recursive: true });
  log(`执行 ${t.task_id}「${t.title}」...`);
  try {
    const output = await runPi(t.task_id, t.instruction, 10 * 60 * 1000);
    const result = output.slice(0, 20000) || '(pi 无输出)';
    writeFileSync(path.join(taskDir, 'output.txt'), result);
    log(`  pi 完成，输出 ${result.length} 字符，回传结果...`);
    await api('POST', '/api/agent/tasks/result', { task_id: t.task_id, status: 'success', result });
    log(`  ✓ ${t.task_id} 已回传（success）`);
  } catch (e) {
    log(`  ✗ ${t.task_id} 执行失败: ${e.message}`);
    await api('POST', '/api/agent/tasks/result', { task_id: t.task_id, status: 'failed', result: e.message });
  }
}
console.log('闹钟完成');
