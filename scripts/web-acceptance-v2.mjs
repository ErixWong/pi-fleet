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
let createdHostBearer = '';
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

  let parentTaskId = null;
  for (const title of [
    `Web v2 全景根任务 ${runId}`,
    `Web v2 全景协调任务 ${runId}`,
    `Web v2 全景执行任务 ${runId}`,
  ]) {
    const created = await request('POST', '/api/v2/tasks', {
      title,
      body: `${title}：用于验证多层任务全景呈现。`,
      visibility: 'private',
      deliverable_spec: { items: ['acceptance result'] },
      targets: [{ principal_id: principalId, role: 'assignee' }],
      task: { is_ready: true, ...(parentTaskId ? { parent_task_id: parentTaskId } : {}) },
    });
    if (!created.response.ok || typeof created.data.post_id !== 'string') {
      throw new Error(`创建全景树验收任务失败：${created.response.status} ${JSON.stringify(created.data)}`);
    }
    createdPostIds.push(created.data.post_id);
    parentTaskId = created.data.post_id;
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

  console.log('== 3. 任务详情契约（九键 + 树 parent/children） ==');
  const detailId = createdPostIds[3];
  const detailResponse = page.waitForResponse((response) =>
    response.request().method() === 'GET'
      && response.url().includes(`/api/v2/posts/${encodeURIComponent(detailId)}`));
  await page.goto(`${base}/tasks/${encodeURIComponent(detailId)}`, { waitUntil: 'networkidle' });
  const detailPayload = await (await detailResponse).json();
  const expectedKeys = ['post', 'targets', 'task', 'parent', 'children', 'ancestry', 'channel', 'deliverables', 'verdicts', 'summary', 'recent', 'more'];
  check('任务详情页面渲染', await page.locator('.task-detail-page').count() === 1);
  check('任务详情契约完整（旧九键 + parent/children/ancestry）',
    JSON.stringify(Object.keys(detailPayload).sort()) === JSON.stringify(expectedKeys.sort()),
    JSON.stringify(Object.keys(detailPayload)));
  check('任务详情显示任务内容', await page.locator('h1').filter({ hasText: `Web v2 验收 ${runId}-1` }).count() === 1);

  console.log('== 4. 任务全景树与节点详情 modal ==');
  const panoramaRootId = createdPostIds[0];
  await page.goto(`${base}/tasks/${encodeURIComponent(panoramaRootId)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.task-tree-node');
  const treeRows = page.locator('.task-tree-node');
  check('全景树一次渲染三层节点', await treeRows.count() === 3);
  check('节点行同时显示摘要与状态徽章',
    await treeRows.filter({ hasText: `Web v2 全景执行任务 ${runId}` }).count() === 1
      && await treeRows.locator('.badge-status').count() === 3);
  await treeRows.filter({ hasText: `Web v2 全景执行任务 ${runId}` }).click();
  await page.waitForSelector('.task-panorama-modal .modal-body h3');
  check('点击节点打开详情 modal',
    await page.locator('.task-panorama-modal').count() === 1
      && await page.locator('.task-panorama-modal').getByRole('heading', { name: `Web v2 全景执行任务 ${runId}` }).count() === 1
      && await page.locator('.task-panorama-modal').getByText('用于验证多层任务全景呈现。').count() >= 1);
  await page.locator('.task-panorama-modal button[aria-label="关闭"]').click();

  console.log('== 5. 主机注册一次性 key ==');
  await page.goto(`${base}/hosts`, { waitUntil: 'networkidle' });
  await page.click('button:has-text("注册主机")');
  await page.fill('input[placeholder="例如 build-host-01"]', `web-v2-host-${runId}`);
  await page.click('.modal.show button:has-text("注册并生成 key")');
  await page.waitForSelector('.alert-warning .key-box');
  const keyText = (await page.locator('.alert-warning .key-box').innerText()).trim();
  createdHostBearer = keyText;
  const hostNameShown = await page.locator('.alert-warning').innerText();
  const hostsResponse = await request('GET', '/api/v2/hosts');
  createdHostId = hostsResponse.data.items?.find((host) => host.name === `web-v2-host-${runId}`)?.id ?? '';
  check('主机注册成功并显示一次性 key', keyText.length >= 20 && hostNameShown.includes(`web-v2-host-${runId}`));
  check('主机列表包含新主机', Boolean(createdHostId));

  console.log('== 6. 主机→文件夹→对话导航与 workdir 校验 ==');
  const reportedFolderPath = `/home/web-v2-${runId}/reported`;
  const previousBearer = bearer;
  bearer = createdHostBearer;
  const reportedFolders = await request('POST', '/api/v2/hosts/folders', {
    folders: [reportedFolderPath],
  });
  bearer = previousBearer;
  check('主机 key 上报纯文件夹成功',
    reportedFolders.response.status === 200
      && reportedFolders.data.folders?.some((folder) => folder.path === reportedFolderPath));
  const channelCreate = await request('POST', '/api/v2/channels', {
    host_principal_id: createdHostId,
    workdir: `~/web-v2-${runId}`,
    title: `Web 对话 ${runId}`,
  });
  const channelId = channelCreate.data.channel?.id;
  if (channelId) createdPostIds.push(channelId);
  check('创建带 workdir 的对话', channelCreate.response.status === 201 && typeof channelId === 'string');
  const emptyWorkdir = await request('POST', '/api/v2/channels', {
    host_principal_id: createdHostId,
    workdir: '',
  });
  check('空 workdir 被服务端拒绝', emptyWorkdir.response.status === 400);

  await page.goto(`${base}/channels`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.channels-page');
  check('对话页显示左侧主机和文件夹两级 panel',
    await page.locator('.channel-host-panel').count() === 1
      && await page.locator('.channel-folder-panel').count() === 1);
  const channelViewport = await page.locator('.channel-sidebar').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      viewportHeight: window.innerHeight,
      pageScroll: document.documentElement.scrollHeight > window.innerHeight
        || document.body.scrollHeight > window.innerHeight,
    };
  });
  check('Channels 左侧 rail 贴边并铺满视口',
    channelViewport.left <= 1
      && channelViewport.top <= 1
      && channelViewport.height >= channelViewport.viewportHeight - 1
      && channelViewport.bottom >= channelViewport.viewportHeight - 1
      && !channelViewport.pageScroll,
    JSON.stringify(channelViewport));
  const hostNav = page.locator('.channel-host-list .channel-nav-item').filter({ hasText: `web-v2-host-${runId}` });
  await hostNav.click();
  const reportedLabel = page.locator('.channel-folder-tree .channel-tree-label[title="' + reportedFolderPath + '"]');
  check('上报目录出现在文件夹树', await reportedLabel.count() === 1);
  check('树形渲染根节点与多级缩进', await (async () => {
    // 嵌套渲染：根行直接挂在树容器下（无缩进容器祖先），上报目录行嵌在
    // .channel-tree-children 子容器内（缩进 + 参考线由容器提供）。
    const rootRow = page.locator('.channel-folder-tree > .channel-tree-branch > .channel-tree-row').first();
    const rootOk = await rootRow.count() === 1;
    const nesting = await reportedLabel
      .locator('xpath=ancestor::div[contains(@class,"channel-tree-children")]').count();
    return rootOk && nesting >= 1;
  })());
  check('有对话目录置顶并带对话数徽章', await (async () => {
    const rows = page.locator('.channel-folder-tree .channel-tree-row');
    const firstChild = rows.nth(1);
    return (await firstChild.locator('.channel-tree-label').innerText()).includes('web-v2-')
      && (await firstChild.locator('.badge').innerText()).trim() === '1';
  })());

  console.log('== 6a. 未缓存目录走 browse 控制链路并渲染结果 ==');
  let browsePosts = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/v2/hosts/') && req.url().endsWith('/browse')) {
      browsePosts += 1;
    }
  });
  const reportedRow = reportedLabel.locator('xpath=ancestor::*[contains(@class,"channel-tree-row")]');
  await reportedRow.locator('.channel-tree-toggle').click();
  const browseResponse = await page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/browse'), { timeout: 10_000 });
  const browsePayload = await browseResponse.json();
  const browseRequestId = browsePayload.request_id;
  check('未缓存节点发起 browse 请求', typeof browseRequestId === 'string' && browseRequestId.length > 0);
  check('browse 加载态显示「正在读取主机目录…」',
    await page.locator('.channel-folder-tree').getByText('正在读取主机目录…').count() >= 1);

  // 无真实 daemon：用主机 key 模拟 daemon 回传 list_dir 结果。
  const previousBearer2 = bearer;
  bearer = createdHostBearer;
  const controlAnswer = await request('POST', `/api/v2/hosts/controls/${encodeURIComponent(browseRequestId)}/results`, {
    entries: [{ path: `${reportedFolderPath}/sub1` }],
  });
  bearer = previousBearer2;
  check('daemon 回传 list_dir 结果被接受', controlAnswer.response.status === 200);
  await page.waitForSelector('.channel-folder-tree .channel-tree-label[title="' + reportedFolderPath + '/sub1"]', { timeout: 20_000 });
  check('browse 结果渲染为新树节点', true);
  const sub1Row = page.locator('.channel-folder-tree .channel-tree-row', { has: page.locator('.channel-tree-label[title="' + reportedFolderPath + '/sub1"]') });
  check('新节点按层级缩进（深度 2）',
    // 深度 2 = 祖先链上有两层 .channel-tree-children 缩进容器
    (await sub1Row.locator('xpath=ancestor::div[contains(@class,"channel-tree-children")]').count()) === 2);

  console.log('== 6b. 缓存展开零 browse 请求 ==');
  await reportedRow.locator('.channel-tree-toggle').click(); // 收起
  await page.waitForTimeout(300);
  const browsePostsBefore = browsePosts;
  await reportedRow.locator('.channel-tree-toggle').click(); // 展开（缓存命中）
  await page.waitForSelector('.channel-folder-tree .channel-tree-label[title="' + reportedFolderPath + '/sub1"]', { timeout: 5_000 });
  await page.waitForTimeout(3_000);
  check('缓存命中时展开不重复发 browse 请求', browsePosts === browsePostsBefore);

  await reportedLabel.click();
  check('无对话目录显示读取状态入口', await page.getByRole('button', { name: '发起新对话' }).count() === 1);
  const quickChannelResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && response.url().endsWith('/api/v2/channels'));
  await page.getByRole('button', { name: '发起新对话' }).click();
  const quickChannelPayload = await (await quickChannelResponse).json();
  if (quickChannelPayload.channel?.id) createdPostIds.push(quickChannelPayload.channel.id);
  check('发起新对话立即创建并进入会话',
    quickChannelPayload.channel?.id && quickChannelPayload.channel?.workdir === '~/reported');
  await page.waitForSelector('.channel-conversation');
  check('新会话头部显示所选目录 workdir',
    await page.locator('.channel-conversation').getByText('工作目录：~/reported', { exact: false }).count() >= 1);

  const channelFolderPath = `/home/web-v2-${runId}/web-v2-${runId}`;
  const originalFolder = page.locator('.channel-folder-tree .channel-tree-label[title="' + channelFolderPath + '"]');
  await originalFolder.click();
  const channelSelect = page.locator('#channel-dialog-select');
  check('对话列表改为下拉框',
    await channelSelect.count() === 1
      && await channelSelect.locator('option').count() >= 1
      && (await channelSelect.locator('option').first().innerText()).includes(`Web 对话 ${runId}`));
  await page.waitForSelector('.channel-conversation');
  check('选中对话后显示消息流和 workdir',
    await page.locator('.channel-conversation').getByText(`~/web-v2-${runId}`, { exact: false }).count() >= 1);
  const messageViewport = await page.locator('.channel-messages').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { height: rect.height, overflowY: style.overflowY };
  });
  check('消息流使用独立滚动区域',
    messageViewport.height > 0 && ['auto', 'scroll'].includes(messageViewport.overflowY),
    JSON.stringify(messageViewport));
  const quickChannelResponse2 = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && response.url().endsWith('/api/v2/channels'));
  await page.getByRole('button', { name: '发起新对话' }).click();
  const quickChannelPayload2 = await (await quickChannelResponse2).json();
  if (quickChannelPayload2.channel?.id) createdPostIds.push(quickChannelPayload2.channel.id);
  check('非上报文件夹一键建对话使用目录 workdir',
    quickChannelPayload2.channel?.workdir === `~/web-v2-${runId}`);
  await page.waitForSelector('.channel-conversation');
  check('一键创建后直接进入新会话',
    await page.locator('.channel-conversation').getByText(`工作目录：~/web-v2-${runId}`, { exact: false }).count() >= 1);

  console.log('== 7. 旧路由与已删前端路由不白屏 ==');
  if (channelId) {
    await page.goto(`${base}/channels/${encodeURIComponent(channelId)}`, { waitUntil: 'networkidle' });
    check('旧 /channels/:id 路由可回落并选中对话',
      await page.locator('.channels-page').count() === 1
        && await page.locator('.channel-conversation').count() === 1);
  }
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
