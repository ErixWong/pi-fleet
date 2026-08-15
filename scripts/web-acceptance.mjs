// Web UI 端到端验收（Playwright + chromium）：编排 UI 冒烟
// 覆盖：登录 / 计划创建树表单（多 stage+多 task）/ 计划列表 / 树视图（当前高亮·后续置灰·stalled 标红）
//       / 交付物可见性下拉改档 / failed 处置（重开） / 设置页
// 前置：后端已启动（node dist/src/index.js，端口 3000）、管理员 admin123、web/dist 已构建
// 运行：node scripts/web-acceptance.mjs
import 'dotenv/config';
import { chromium } from 'playwright';
import { createPool } from 'mariadb';

const BASE = 'http://127.0.0.1:3000';
const PASSWORD = 'admin123';
let cookie = '';
let passed = 0, failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, credentials: 'include', body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && !cookie) cookie = setCookie.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const pool = createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'task_dispatch',
  connectionLimit: 2,
});
const ts = Date.now().toString(36);
const PLAN_NAME = `WebUI-${ts}`;
const AGENT_NAME = `ui-${ts}`;
let planId = '', agentId = '';

// ── 0. 清理上次残留（WebUI-* 计划 + ui-* agent；FK 顺序删） ──
async function cleanup() {
  const pl = await pool.query(`SELECT id FROM plans WHERE name LIKE 'WebUI-%'`);
  const stageIds = [];
  for (const p of pl) {
    const st = await pool.query(`SELECT id FROM plan_stages WHERE plan_id = ?`, [p.id]);
    stageIds.push(...st.map((s) => s.id));
  }
  if (stageIds.length) {
    const ph = stageIds.map(() => '?').join(',');
    await pool.query(`DELETE FROM task_messages WHERE task_id IN (SELECT id FROM tasks WHERE stage_id IN (${ph}))`, stageIds);
    await pool.query(`DELETE FROM deliverables WHERE task_id IN (SELECT id FROM tasks WHERE stage_id IN (${ph}))`, stageIds);
    await pool.query(`DELETE FROM reports WHERE task_id IN (SELECT id FROM tasks WHERE stage_id IN (${ph}))`, stageIds);
    await pool.query(`DELETE FROM tasks WHERE stage_id IN (${ph})`, stageIds);
  }
  for (const p of pl) {
    await pool.query(`DELETE FROM plan_stages WHERE plan_id = ?`, [p.id]);
    await pool.query(`DELETE FROM plans WHERE id = ?`, [p.id]);
  }
  const ag = await pool.query(`SELECT id FROM agents WHERE agent_id LIKE 'ui-%'`);
  for (const a of ag) {
    await pool.query(`DELETE FROM attachments WHERE owner_agent_id = ?`, [a.id]);
    await pool.query(`DELETE FROM agents WHERE id = ?`, [a.id]);
  }
}

try {
  await cleanup();
  console.log('== Web UI 验收（编排冒烟） ==');
  // Node 侧 API 会话（与浏览器会话独立）：登录拿 cookie，供 API 辅助（建 agent / 查询）
  await api('POST', '/api/login', { password: PASSWORD });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  // confirm 对话框一律接受（重开/取消）
  page.on('dialog', (d) => d.accept());

  // ── 1. 登录 → 仪表盘 ──
  console.log('== 1. 登录 ==');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button:has-text("登录")');
  await page.waitForURL((u) => u.pathname === '/');
  check('登录后跳转仪表盘', page.url().endsWith('/'), page.url());
  await page.waitForSelector('h4');
  check('仪表盘渲染', (await page.locator('h4:has-text("仪表盘")').count()) === 1);

  // ── 2. 准备测试 agent（API） + 创建一次性 plan（UI 树表单） ──
  console.log('== 2. 创建计划（UI 树表单：2 stage / 3 task） ==');
  const ag = await api('POST', '/api/agents', { name: AGENT_NAME, hostname: '10.0.0.9', accept_external: true });
  agentId = ag.agent.agent_id;
  check('测试 agent 已创建（API 辅助）', !!agentId);

  await page.goto(`${BASE}/plans`, { waitUntil: 'networkidle' });
  await page.click('button:has-text("创建计划")');
  await page.waitForSelector('.modal.show');
  check('创建计划 modal 打开', (await page.locator('.modal.show').count()) === 1);
  await page.fill('input[placeholder="如：月末巡检流水线"]', PLAN_NAME);
  // stage1 task0：private + assignee
  await page.fill('input[placeholder="任务标题 *"] >> nth=0', '准备数据');
  await page.fill('input[placeholder="任务指令 *"] >> nth=0', '整理输入数据');
  await page.fill('input[placeholder="执行方 agent_id"] >> nth=0', agentId);
  // stage1 task1：public（公共池）
  await page.click('.modal.show button:has-text("添加任务")');
  await page.fill('input[placeholder="任务标题 *"] >> nth=1', '生成清单');
  await page.fill('input[placeholder="任务指令 *"] >> nth=1', '输出清单');
  await page.locator('input[placeholder="任务标题 *"] >> nth=1')
    .locator('xpath=ancestor::div[contains(@class,"border-top")]').locator('select').selectOption('public');
  // 添加 stage2（顺序闸门）
  await page.click('.modal.show button:has-text("添加阶段")');
  check('添加阶段后出现第二个阶段输入', (await page.locator('input[placeholder="阶段名称"]').count()) === 2);
  await page.fill('input[placeholder="任务标题 *"] >> nth=2', '执行分析');
  await page.fill('input[placeholder="任务指令 *"] >> nth=2', '基于清单分析');
  await page.fill('input[placeholder="执行方 agent_id"] >> nth=2', agentId);
  await page.click('.modal-footer button[type=submit]');
  await page.waitForSelector('.modal.show', { state: 'hidden' });
  await page.waitForTimeout(600); // 列表刷新
  check('计划出现在列表', (await page.locator(`table tbody >> text="${PLAN_NAME}"`).count()) >= 1);
  check('列表显示阶段/任务数', (await page.locator(`table tbody >> text="${PLAN_NAME}"`).first().locator('xpath=ancestor::tr').locator('td:has-text("阶段")').count()) >= 1);

  // ── 3. 树视图：当前 stage 高亮 / 后续置灰 / blocked ──
  console.log('== 3. plan 树视图 ==');
  const plans = await api('GET', '/api/plans');
  planId = plans.plans.find((p) => p.name === PLAN_NAME).plan_id;
  await page.click(`table tbody a:has-text("${PLAN_NAME}")`);
  await page.waitForURL((u) => u.pathname.startsWith('/plans/'));
  await page.waitForSelector('.card');
  check('树视图渲染（2 个 stage card）', (await page.locator('.card').count()) >= 2);
  // stage1 当前：border-primary + 徽标「当前」
  const s1Card = page.locator('.card').first();
  check('stage1 高亮（border-primary + 当前徽标）',
    (await s1Card.getAttribute('class')).includes('border-primary') && (await s1Card.locator('text=当前').count()) === 1);
  const s2Card = page.locator('.card').nth(1);
  check('stage2 置灰（opacity-75 + 阶段 2 徽标）',
    (await s2Card.getAttribute('class')).includes('opacity-75') && (await s2Card.locator('text=阶段 2').count()) >= 1);
  check('stage2 任务 blocked（闸门中）',
    (await s2Card.locator('text=blocked').count()) === 1);
  check('stage1 任务 open/active',
    (await s1Card.locator('text=open').count()) >= 1 && (await s1Card.locator('text=active').count()) >= 1);

  // ── 4. 交付物可见性下拉改档（UI）→ 回帖留痕（API 验证） ──
  console.log('== 4. 交付物可见性改档 ==');
  const s1TaskRow = s1Card.locator('div.border-bottom').first();
  const dvSelect = s1TaskRow.locator('select');
  check('交付物可见性下拉存在（默认 participants）', (await dvSelect.count()) === 1 && (await dvSelect.inputValue()) === 'participants');
  await dvSelect.selectOption('public');
  await page.waitForTimeout(500);
  check('改档后 select 值 public', (await dvSelect.inputValue()) === 'public');
  const t1 = await api('GET', '/api/tasks'); // 取该 plan 的第一个任务 task_id
  const tree = await api('GET', `/api/plans/${planId}`);
  const stage1Task = tree.plan.stages[0].tasks.find((t) => t.title === '准备数据');
  const t1Detail = await api('GET', `/api/tasks/${stage1Task.task_id}`);
  check('改档留痕回帖（[交付物可见性]）', t1Detail.messages.some((m) => m.content.includes('交付物可见性') && m.content.includes('public')), JSON.stringify(t1Detail.messages.map((m) => m.content)));

  // ── 5. failed 处置：置 failed → stalled 标红 + 处置按钮 → 重开回 open ──
  // 用 stage2（非当前 stage）任务：current 徽标优先于 stalled，非当前 stage 有 failed 才显示 stalled 徽标
  console.log('== 5. failed 处置（重开） ==');
  const stage2Task = tree.plan.stages[1].tasks[0];
  await pool.query(`UPDATE tasks SET status='failed', deliver_attempts=2, result='[ui-test]' WHERE task_id = ?`, [stage2Task.task_id]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.card');
  const s2Card2 = page.locator('.card').nth(1);
  check('failed 任务显示 failed 徽标', (await s2Card2.locator('text=failed').count()) >= 1);
  check('stage stalled 标红（stalled 徽标）', (await s2Card2.locator('text=stalled').count()) === 1 && (await s2Card2.locator('span.badge.text-bg-danger').count()) >= 1);
  const failRow = s2Card2.locator('div.border-bottom').filter({ hasText: '执行分析' });
  check('处置按钮出现（重开/改派/取消）',
    (await failRow.locator('button:has-text("重开")').count()) === 1 &&
    (await failRow.locator('button:has-text("改派")').count()) === 1 &&
    (await failRow.locator('button:has-text("取消(跳过)")').count()) === 1);
  await failRow.locator('button:has-text("重开")').click();
  await page.waitForTimeout(800); // confirm 自动接受 + load() 刷新
  const s2Card3 = page.locator('.card').nth(1);
  const reopenedRow = s2Card3.locator('div.border-bottom').filter({ hasText: '执行分析' });
  check('重开后回 open（private+assignee 落点）+ 处置按钮消失',
    (await reopenedRow.locator('text=open').count()) >= 1 && (await reopenedRow.locator('button:has-text("重开")').count()) === 0);
  const reopenedDetail = await api('GET', `/api/tasks/${stage2Task.task_id}`);
  check('重开留痕回帖（[处置] 发起人重开）', reopenedDetail.messages.some((m) => m.content.includes('发起人重开') && m.content.includes('open')), JSON.stringify(reopenedDetail.messages.map((m) => m.content)));

  // ── 6. 设置页渲染 ──
  console.log('== 6. 设置页 ==');
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  check('设置页渲染（系统设置标题）', (await page.locator('h4:has-text("系统设置")').count()) === 1);

  await page.screenshot({ path: 'web-acceptance-final.png', fullPage: false });
  await browser.close();
} catch (err) {
  console.error('脚本异常:', err.message);
  failed++;
} finally {
  await pool.end();
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
