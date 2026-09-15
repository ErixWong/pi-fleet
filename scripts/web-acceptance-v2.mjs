import 'dotenv/config';
import { chromium } from 'playwright';

const base = process.env.TEST_BASE ?? 'http://127.0.0.1:3000';
const username = process.env.TEST_USERNAME?.trim();
const password = process.env.TEST_PASSWORD;
const accountName = process.env.TEST_ACCOUNT_NAME?.trim();

if (!username || !password) {
  console.error('缺少 Web 验收登录凭据：请设置 TEST_USERNAME 和 TEST_PASSWORD（可选 TEST_ACCOUNT_NAME）。');
  process.exit(2);
}

let passed = 0;
let failed = 0;
let bearer = '';
let createdHostId = '';
const createdPostIds = [];
const runId = Date.now().toString(36);

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function createFixtures() {
  const login = await request('POST', '/api/v2/login', {
    username,
    password,
    ...(accountName ? { account_name: accountName } : {}),
  });
  if (!login.response.ok || typeof login.data.key !== 'string') {
    throw new Error(`测试账号登录失败：${login.response.status} ${JSON.stringify(login.data)}`);
  }
  bearer = login.data.key;
  const principalId = login.data.principal?.id;
  if (typeof principalId !== 'string' || principalId.length === 0) {
    throw new Error(`测试账号登录响应缺少 principal.id：${JSON.stringify(login.data)}`);
  }

  for (let index = 0; index < 21; index += 1) {
    const created = await request('POST', '/api/v2/tasks', {
      title: `Web v2 验收 ${runId}-${index + 1}`,
      body: `Web v2 acceptance fixture ${runId}-${index + 1}`,
      visibility: 'private',
      deliverable_spec: { items: ['acceptance result'] },
      targets: [{ principal_id: principalId, role: 'assignee' }],
      task: { is_ready: true },
    });
    if (!created.response.ok || typeof created.data.post_id !== 'string') {
      throw new Error(`创建 Web 验收任务失败：${created.response.status} ${JSON.stringify(created.data)}`);
    }
    createdPostIds.push(created.data.post_id);
  }
}

async function cleanup() {
  for (const postId of createdPostIds) {
    await request('POST', `/api/v2/posts/${encodeURIComponent(postId)}/delete`).catch(() => {});
  }
  if (createdHostId) {
    await request('DELETE', `/api/v2/hosts/${encodeURIComponent(createdHostId)}`).catch(() => {});
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on('pageerror', (error) => console.log(`  PAGEERROR ${error.message}`));

try {
  await createFixtures();
  console.log('== Web UI v2 acceptance ==');

  console.log('== 1. 登录与 Dashboard 摘要 ==');
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[autocomplete="current-password"]', password);
  await page.click('button:has-text("登录")');
  await page.waitForURL((url) => url.pathname === '/');
  await page.waitForSelector('.app-shell');
  check('登录后进入 Dashboard', new URL(page.url()).pathname === '/');
  check('Dashboard 摘要标题渲染', await page.locator('h1:has-text("全局活动")').count() === 1);
  check('Dashboard 摘要卡渲染', await page.locator('.metric-card').count() === 4);
  check('Dashboard 包含待办和主机摘要',
    await page.locator('.metric-card').filter({ hasText: '待办任务' }).count() === 1
      && await page.locator('.metric-card').filter({ hasText: '主机总数' }).count() === 1);

  console.log('== 2. 任务列表筛选与分页 ==');
  await page.goto(`${base}/tasks?view=due`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tasks-page');
  const statusFilter = page.locator('select[aria-label="状态筛选"]');
  await statusFilter.selectOption('open');
  await page.waitForTimeout(300);
  check('任务状态筛选更新查询', new URL(page.url()).searchParams.get('status') === 'open');
  check('筛选后仍显示验收任务', await page.locator('table tbody tr').count() > 0);
  check('任务分页控件出现', await page.locator('ul.pagination').count() === 1);
  await page.locator('button[aria-label="下一页"]').click();
  await page.waitForTimeout(300);
  check('任务列表可翻到第二页', await page.locator('.pagination .active').innerText() === '2');

  console.log('== 3. 任务详情九键契约 ==');
  const detailId = createdPostIds[0];
  const detailResponse = page.waitForResponse((response) =>
    response.request().method() === 'GET'
      && response.url().includes(`/api/v2/posts/${encodeURIComponent(detailId)}`));
  await page.goto(`${base}/tasks/${encodeURIComponent(detailId)}`, { waitUntil: 'networkidle' });
  const detailPayload = await (await detailResponse).json();
  const expectedKeys = ['post', 'targets', 'task', 'channel', 'deliverables', 'verdicts', 'summary', 'recent', 'more'];
  check('任务详情页面渲染', await page.locator('.task-detail-page').count() === 1);
  check('任务详情九键契约完整',
    JSON.stringify(Object.keys(detailPayload).sort()) === JSON.stringify(expectedKeys.sort()),
    JSON.stringify(Object.keys(detailPayload)));
  check('任务详情显示任务内容', await page.locator('h1').filter({ hasText: `Web v2 验收 ${runId}-1` }).count() === 1);

  console.log('== 4. 主机注册一次性 key ==');
  await page.goto(`${base}/hosts`, { waitUntil: 'networkidle' });
  await page.click('button:has-text("注册主机")');
  await page.fill('input[placeholder="例如 build-host-01"]', `web-v2-host-${runId}`);
  await page.click('.modal.show button:has-text("注册并生成 key")');
  await page.waitForSelector('.alert-warning .key-box');
  const keyText = (await page.locator('.alert-warning .key-box').innerText()).trim();
  const hostNameShown = await page.locator('.alert-warning').innerText();
  const hostsResponse = await request('GET', '/api/v2/hosts');
  createdHostId = hostsResponse.data.items?.find((host) => host.name === `web-v2-host-${runId}`)?.id ?? '';
  check('主机注册成功并显示一次性 key', keyText.length >= 20 && hostNameShown.includes(`web-v2-host-${runId}`));
  check('主机列表包含新主机', Boolean(createdHostId));

  console.log('== 5. 已删前端路由不白屏 ==');
  for (const legacyPath of ['/plans', '/settings', '/chat', '/agents']) {
    await page.goto(`${base}${legacyPath}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.app-shell');
    check(`${legacyPath} 回落到可用页面`, await page.locator('.app-shell').count() === 1);
  }
} catch (error) {
  failed += 1;
  console.error(`  FAIL acceptance aborted — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanup();
  await browser.close();
}

console.log(`Web v2 acceptance: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
