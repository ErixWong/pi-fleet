// 全量验收包装：串行跑 MCP / REST / Web UI 三个验收脚本。
// 关键：验收脚本假设「LLM 未配置」（测试门禁降级路径），若管理员已配置真实 LLM provider，
// 发布任务会进 pending_audit 导致断言失败，且扫描会真实调用外部 API。
// 因此跑前临时禁用所有启用的真实 provider，跑完恢复（api_key 保留原值）。
// 注：恢复动作放在独立子进程执行——主进程在 spawnSync 阻塞跑完三个子脚本后，
// undici 长连接状态可能异常（Windows 边角问题，实测 fetch 报 failed），新进程必然新建连接。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';
import { createPool } from 'mariadb';

const BASE = 'http://127.0.0.1:3000';
const PASSWORD = 'admin123';
const here = path.dirname(fileURLToPath(import.meta.url));

async function login() {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`登录失败 ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  return setCookie ? setCookie.split(';')[0] : '';
}

async function api(cookie, method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** 禁用所有启用的真实 provider；返回被禁用的 id 列表 */
async function disableRealLlm(cookie) {
  const { providers } = await api(cookie, 'GET', '/api/settings/llm-providers');
  const disabled = [];
  for (const p of providers) {
    if (p.enabled) {
      // api_key 传 undefined → JSON 省略该字段 → 后端保留原值
      await api(cookie, 'PUT', '/api/settings/llm-providers', { ...p, api_key: undefined, enabled: false });
      disabled.push(p.id);
    }
  }
  return disabled;
}

/** 恢复禁用的 provider（独立子进程执行，避免主进程连接状态问题） */
function restoreLlmSubprocess(savedIds) {
  const script = `
    const BASE = ${JSON.stringify(BASE)};
    const PASSWORD = ${JSON.stringify(PASSWORD)};
    const SAVED = ${JSON.stringify(savedIds)};
    (async () => {
      const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
      const cookie = login.headers.getSetCookie()[0].split(';')[0];
      const h = { 'content-type': 'application/json', cookie };
      const j = async (r) => r.json();
      const { providers } = await fetch(BASE + '/api/settings/llm-providers', { headers: h }).then(j);
      for (const id of SAVED) {
        const p = providers.find((x) => x.id === id);
        if (p) await fetch(BASE + '/api/settings/llm-providers', { method: 'PUT', headers: h, body: JSON.stringify({ ...p, api_key: undefined, enabled: true }) }).then(j);
      }
      const check = await fetch(BASE + '/api/settings/llm-providers', { headers: h }).then(j);
      console.log('[test-all] 恢复真实 LLM provider:', JSON.stringify(check.providers.map((x) => ({ id: x.id, enabled: x.enabled }))));
    })().catch((e) => { console.error('[test-all] 恢复真实 LLM provider 失败:', e.message); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ['-e', script], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('恢复子进程退出码 ' + r.status);
}

/** 验收后清理：只清理验收脚本创建的测试 agent 及其关联（sess-A~E、rest-test、ui-*、test-agent-*），
 *  保留真实接入的 local-pi*。注意：不再全清 tasks/plans——平台可能有管理员创建的真实任务/计划，全清会误删。
 *  （mcp/rest 验收创建的 public 无指派任务会残留，属可接受噪声；必要时手动清理） */
async function cleanupTestData() {
  const pool = createPool({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'task_dispatch',
    connectionLimit: 2,
  });
  try {
    const ids = (await pool.query(
      `SELECT id FROM agents WHERE name IN ('sess-A','sess-B','sess-C','sess-D','sess-E','rest-test') OR name LIKE 'ui-%' OR name LIKE 'test-agent-%'`,
    )).map((r) => Number(r.id));
    if (ids.length > 0) {
      await pool.query('DELETE FROM task_messages WHERE sender_id IN (?)', [ids]);
      await pool.query('DELETE FROM deliverables WHERE agent_id IN (?)', [ids]);
      await pool.query('DELETE FROM reports WHERE agent_id IN (?)', [ids]);
      await pool.query('DELETE FROM tasks WHERE assignee_id IN (?)', [ids]);
      await pool.query('DELETE FROM attachments WHERE owner_agent_id IN (?) OR uploader_agent_id IN (?)', [ids, ids]);
      await pool.query('DELETE FROM agents WHERE id IN (?)', [ids]);
      console.log(`[test-all] 清理测试 agent ${ids.length} 个（保留 local-pi* 与真实任务）`);
    }
  } finally {
    await pool.end();
  }
}

const cookie = await login();
const saved = await disableRealLlm(cookie);
console.log(`[test-all] 临时禁用真实 LLM provider: ${saved.join(', ') || '（无）'}`);

const scripts = ['mcp-acceptance.mjs', 'rest-acceptance.mjs', 'web-acceptance.mjs'];
let exitCode = 0;
try {
  for (const s of scripts) {
    const r = spawnSync(process.execPath, [path.join(here, s)], { stdio: 'inherit' });
    if (r.status !== 0) { exitCode = r.status ?? 1; break; }
  }
} finally {
  if (saved.length > 0) restoreLlmSubprocess(saved);
  await cleanupTestData().catch((e) => console.error('[test-all] 清理测试数据失败:', e.message));
}
process.exit(exitCode);
