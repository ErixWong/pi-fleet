// 多 agent 协作闭环验收：根任务 → 协调者拆分 → 门控子任务 → 验收放行 → 汇装 → 根任务关闭
// 覆盖因果链门控（is_ready=false 创建、协调者 POST /tasks/:id/ready 放行）全链路。
import 'dotenv/config';
import crypto from 'node:crypto';
import { createPool } from 'mariadb';

const base = process.env.TEST_BASE ?? 'http://127.0.0.1:3000';
const username = process.env.TEST_USERNAME?.trim();
const password = process.env.TEST_PASSWORD;
const accountName = process.env.TEST_ACCOUNT_NAME?.trim();
if (!username || !password) {
  console.error('缺少协作验收登录凭据：请设置 TEST_USERNAME 和 TEST_PASSWORD（可选 TEST_ACCOUNT_NAME）。');
  process.exit(2);
}

const db = createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME_NEW ?? 'erix',
  dateStrings: true,
  connectionLimit: 3,
});

const id = (prefix) => `${prefix}_clb${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const key = () => `pk-${crypto.randomBytes(24).toString('base64url')}`;
const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const runTag = `collab-v2-${Date.now().toString(36)}`;
let passed = 0;
let failed = 0;

let adminBearer = '';
let accountId = '';
const principalIds = [];
const keyIds = [];
const postIds = [];

// 三段式摘要：结论 / 依据 / 风险
const summaryA = `结论：子任务 A 已完成，产出符合验收标准。\n依据：deliverable 已提交并通过预检。\n风险：无。`;
const summaryB = (excerpt) => `结论：子任务 B 已完成，并引用上游 A 的摘要。\n依据：${excerpt}\n风险：无。`;
const summaryRollup = `结论：汇装完成，A、B 两个子任务均已验收通过。\n依据：子任务 A/B verdict 均为 accept。\n风险：无。`;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

// 造一个 host principal + device + api key，返回 { principalId, bearer }
async function makeAgent(name, scopes) {
  const principalId = id('prn');
  const keyId = id('key');
  const bearer = key();
  principalIds.push(principalId);
  keyIds.push(keyId);
  await db.query(
    `INSERT INTO principal (id, account_id, kind, name, created_at)
     VALUES (?, ?, 'host', ?, ?)`,
    [principalId, accountId, `${runTag}-${name}-${principalId}`, now()],
  );
  await db.query(
    `INSERT INTO device (principal_id, hostname, os, created_at)
     VALUES (?, ?, 'linux', ?)`,
    [principalId, `${runTag}-${name}`, now()],
  );
  await db.query(
    `INSERT INTO api_key (id, principal_id, key_hash, label, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [keyId, principalId, hash(bearer), `${runTag}-${name}`, JSON.stringify(scopes), now()],
  );
  return { principalId, bearer };
}

async function loginAdmin() {
  const login = await request('POST', '/api/v2/login', undefined, {
    username,
    password,
    ...(accountName ? { account_name: accountName } : {}),
  });
  if (login.response.status !== 200 || typeof login.data.key !== 'string') {
    throw new Error(`管理员登录失败：${login.response.status} ${JSON.stringify(login.data)}`);
  }
  adminBearer = login.data.key;
  accountId = String(login.data.account?.id ?? '');
  if (!accountId) throw new Error(`登录响应缺少 account.id：${JSON.stringify(login.data)}`);
}

async function cleanup() {
  // 收集根下所有派生 post（子任务、reply、verdict 都以 root_id / parent_id 挂接）
  if (postIds.length > 0) {
    const placeholders = postIds.map(() => '?').join(', ');
    const derived = await db.query(
      `SELECT id FROM post WHERE id NOT IN (${placeholders})
        AND (parent_id IN (${placeholders}) OR root_id IN (${placeholders}))`,
      [...postIds, ...postIds, ...postIds],
    );
    const allIds = [...postIds, ...derived.map((row) => String(row.id))];
    const allPlaceholders = allIds.map(() => '?').join(', ');
    await db.query(`DELETE FROM post_summary WHERE root_id IN (${allPlaceholders})`, allIds);
    await db.query(`DELETE FROM deliverable WHERE post_id IN (${allPlaceholders})`, allIds);
    await db.query(`DELETE FROM post_verdict WHERE post_id IN (${allPlaceholders})`, allIds);
    await db.query(`DELETE FROM post_task WHERE post_id IN (${allPlaceholders})`, allIds);
    await db.query(`DELETE FROM post_target WHERE post_id IN (${allPlaceholders})`, allIds);
    await db.query(`UPDATE post SET parent_id = NULL WHERE parent_id IN (${allPlaceholders})`, allIds);
    await db.query(`DELETE FROM post WHERE id IN (${allPlaceholders})`, allIds);
  }
  if (keyIds.length > 0) {
    const placeholders = keyIds.map(() => '?').join(', ');
    await db.query(`DELETE FROM api_key WHERE id IN (${placeholders})`, keyIds);
  }
  if (principalIds.length > 0) {
    const placeholders = principalIds.map(() => '?').join(', ');
    await db.query(`DELETE FROM api_key WHERE principal_id IN (${placeholders})`, principalIds);
    await db.query(`DELETE FROM device_executor WHERE principal_id IN (${placeholders})`, principalIds);
    await db.query(`DELETE FROM device WHERE principal_id IN (${placeholders})`, principalIds);
    await db.query(`DELETE FROM principal WHERE id IN (${placeholders})`, principalIds);
  }
  await db.end();
}

try {
  await loginAdmin();
  console.log('== 多 agent 协作闭环验收 ==');

  const coordinator = await makeAgent('coordinator', [
    'post:read', 'post:write', 'task:read', 'task:write', 'task:claim', 'task:submit',
  ]);
  const executorA = await makeAgent('executor-a', ['task:read', 'task:claim', 'task:submit']);
  const executorB = await makeAgent('executor-b', ['task:read', 'task:claim', 'task:submit']);
  const verifier = await makeAgent('verifier', ['task:read', 'task:verdict']);

  // 1. 发起人创建根任务，定向给协调者
  const root = await request('POST', '/api/v2/tasks', adminBearer, {
    title: `${runTag} 根任务`,
    body: '协作闭环根任务：拆分 A/B 两个子任务，汇装后关闭。',
    visibility: 'private',
    deliverable_spec: { items: ['汇装总结报告'] },
    targets: [{ principal_id: coordinator.principalId, role: 'assignee' }],
    task: { is_ready: true },
  });
  const rootId = root.data.post_id;
  if (rootId) postIds.push(rootId);
  check('1. 发起人创建根任务并定向协调者',
    root.response.status === 201 && root.data.status === 'open' && typeof rootId === 'string',
    JSON.stringify(root.data));

  // 2. 协调者 claim 根任务
  const rootClaim = await request('POST', `/api/v2/tasks/${rootId}/claim`, coordinator.bearer);
  check('2. 协调者 claim 根任务',
    rootClaim.response.status === 200
      && rootClaim.data.assignee_principal_id === coordinator.principalId,
    JSON.stringify(rootClaim.data));

  // 3. 协调者拆分两个子任务：A 直接放行，B 门控（is_ready=false）
  const subA = await request('POST', '/api/v2/tasks', coordinator.bearer, {
    title: `${runTag} 子任务 A`,
    body: '子任务 A：可立即执行。',
    visibility: 'private',
    deliverable_spec: { items: ['A 产出物'] },
    targets: [{ principal_id: executorA.principalId, role: 'assignee' }],
    task: { is_ready: true, parent_task_id: rootId },
  });
  const subAId = subA.data.post_id;
  if (subAId) postIds.push(subAId);
  check('3a. 协调者创建已放行的子任务 A',
    subA.response.status === 201 && subA.data.status === 'open',
    JSON.stringify(subA.data));

  const subB = await request('POST', '/api/v2/tasks', coordinator.bearer, {
    title: `${runTag} 子任务 B`,
    body: `子任务 B：依赖子任务 A（${subAId}）的摘要，待验收放行后执行。`,
    visibility: 'private',
    deliverable_spec: { items: ['B 产出物'] },
    targets: [{ principal_id: executorB.principalId, role: 'assignee' }],
    task: { is_ready: false, parent_task_id: rootId },
  });
  const subBId = subB.data.post_id;
  if (subBId) postIds.push(subBId);
  check('3b. 协调者创建门控的子任务 B（is_ready=false）',
    subB.response.status === 201 && typeof subBId === 'string',
    JSON.stringify(subB.data));

  const subBDetail = await request('GET', `/api/v2/posts/${subBId}`, coordinator.bearer);
  check('3c. 门控任务 B 详情标记 is_ready=false 且 ancestry 指向根任务',
    subBDetail.response.status === 200
      && subBDetail.data.task?.is_ready === false
      && subBDetail.data.ancestry?.length === 1
      && subBDetail.data.ancestry[0]?.id === rootId,
    JSON.stringify(subBDetail.data?.task));
  const subBRow = await db.query(
    `SELECT parent_task_id FROM post_task WHERE post_id = ? LIMIT 1`,
    [subBId],
  );
  check('3d. 任务 B 的 parent_task_id 指向根任务',
    String(subBRow[0]?.parent_task_id ?? '') === rootId,
    JSON.stringify(subBRow[0]));

  // 4. 执行者 A claim + submit（三段式摘要）
  const claimA = await request('POST', `/api/v2/tasks/${subAId}/claim`, executorA.bearer);
  check('4a. 执行者 A claim 子任务 A',
    claimA.response.status === 200
      && claimA.data.assignee_principal_id === executorA.principalId,
    JSON.stringify(claimA.data));
  const submitA = await request('POST', `/api/v2/tasks/${subAId}/submit`, executorA.bearer, {
    deliverables: [{ name: 'A 产出物', note: '已完成' }],
    message: summaryA,
  });
  check('4b. 执行者 A submit 子任务 A（含三段式摘要）',
    submitA.response.status === 200 && submitA.data.ok === true
      && submitA.data.task?.status === 'submitted',
    JSON.stringify(submitA.data));

  const rootDetail = await request('GET', `/api/v2/posts/${rootId}`, coordinator.bearer);
  const childASummary = (rootDetail.data.children ?? []).find((item) => item.post_id === subAId);
  check('4c. 根任务 children 带执行者 A 的 submit 摘要和作者',
    rootDetail.response.status === 200
      && childASummary?.latest_submit_summary?.body?.startsWith('结论')
      && childASummary.latest_submit_summary.author?.id === executorA.principalId,
    JSON.stringify(childASummary));
  const submitRows = await db.query(
    `SELECT subtype FROM post
      WHERE parent_id = ? AND kind = 'message'
      ORDER BY id DESC
      LIMIT 1`,
    [subAId],
  );
  check('4d. REST submit 摘要 message 带 subtype=submit',
    submitRows[0]?.subtype === 'submit',
    JSON.stringify(submitRows[0]));
  const subtree = await request('GET', `/api/v2/tasks/${rootId}/subtree?depth=1`, coordinator.bearer);
  check('4e. 子树 API 返回一层嵌套树和摘要行',
    subtree.response.status === 200
      && subtree.data.depth === 1
      && subtree.data.root?.children?.some((item) => item.id === subAId && item.summary.startsWith('结论')),
    JSON.stringify(subtree.data));
  const invalidDepth = await request('GET', `/api/v2/tasks/${rootId}/subtree?depth=5`, coordinator.bearer);
  check('4f. 子树深度上限为 4',
    invalidDepth.response.status === 400,
    JSON.stringify(invalidDepth.data));

  const dueBefore = await request('GET', '/api/v2/tasks?view=due', executorB.bearer);
  const dueBeforeIds = (dueBefore.data.items ?? []).map((item) => item.id ?? item.post_id);
  check('4c. 放行前 due 视图对执行者 B 不可见任务 B',
    dueBefore.response.status === 200 && !dueBeforeIds.includes(subBId),
    JSON.stringify(dueBefore.data?.items));

  // 10a. 门控细节：未放行时执行者 B claim 返回错误且不泄漏资源
  const gatedClaim = await request('POST', `/api/v2/tasks/${subBId}/claim`, executorB.bearer);
  check('10a. 未放行时执行者 B claim 任务 B 返回 409',
    gatedClaim.response.status === 409
      && typeof gatedClaim.data.error === 'string'
      && gatedClaim.data.error.includes('not ready'),
    JSON.stringify(gatedClaim.data));
  check('10b. claim 报错不泄漏任务资源（无 deliverable/assignee 细节）',
    !JSON.stringify(gatedClaim.data).includes('deliverable')
      && !JSON.stringify(gatedClaim.data).includes('assignee'));
  const gatedDetail = await request('GET', `/api/v2/posts/${subBId}`, coordinator.bearer);
  check('10c. 门控 claim 失败后任务 B 仍未被认领',
    gatedDetail.data?.task?.assignee_principal_id === null
      && gatedDetail.data?.task?.status === 'open',
    JSON.stringify(gatedDetail.data?.task));

  // 5. 验收者 verdict accept 子任务 A
  const verdictA = await request('POST', `/api/v2/tasks/${subAId}/verdict`, verifier.bearer, {
    decision: 'accept',
    opinion: 'A 验收通过',
  });
  check('5. 验收者 accept 子任务 A',
    verdictA.response.status === 200 && verdictA.data.task?.status === 'done',
    JSON.stringify(verdictA.data));

  // 6. 协调者更新 B 的 body 引用 A 的摘要，然后调用 ready 放行
  const editB = await request('POST', `/api/v2/posts/${subBId}/edit`, coordinator.bearer, {
    body: `子任务 B：上游 A 摘要引用 —— ${summaryA.split('\n')[0]}`,
  });
  check('6a. 协调者更新任务 B body 引用 A 的摘要',
    editB.response.status === 200 && editB.data.ok === true,
    JSON.stringify(editB.data));
  const readyB = await request('POST', `/api/v2/tasks/${subBId}/ready`, coordinator.bearer, {
    ready: true,
  });
  check('6b. 协调者 ready 放行任务 B',
    readyB.response.status === 200
      && readyB.data.ok === true
      && readyB.data.task?.id === subBId
      && readyB.data.task?.is_ready === true,
    JSON.stringify(readyB.data));

  // 10d. 放行后执行者 B 可 claim
  const dueAfter = await request('GET', '/api/v2/tasks?view=due', executorB.bearer);
  const dueAfterIds = (dueAfter.data.items ?? []).map((item) => item.id ?? item.post_id);
  check('10d. 放行后 due 视图对执行者 B 可见任务 B', dueAfterIds.includes(subBId));

  // 7. 执行者 B claim + submit；验收者 accept
  const claimB = await request('POST', `/api/v2/tasks/${subBId}/claim`, executorB.bearer);
  check('7a. 放行后执行者 B claim 任务 B',
    claimB.response.status === 200
      && claimB.data.assignee_principal_id === executorB.principalId,
    JSON.stringify(claimB.data));
  const submitB = await request('POST', `/api/v2/tasks/${subBId}/submit`, executorB.bearer, {
    deliverables: [{ name: 'B 产出物', note: '已完成' }],
    message: summaryB('引用 A 摘要：结论——子任务 A 已完成，产出符合验收标准。'),
  });
  check('7b. 执行者 B submit 任务 B',
    submitB.response.status === 200 && submitB.data.ok === true
      && submitB.data.task?.status === 'submitted',
    JSON.stringify(submitB.data));
  const verdictB = await request('POST', `/api/v2/tasks/${subBId}/verdict`, verifier.bearer, {
    decision: 'accept',
    opinion: 'B 验收通过',
  });
  check('7c. 验收者 accept 子任务 B',
    verdictB.response.status === 200 && verdictB.data.task?.status === 'done',
    JSON.stringify(verdictB.data));

  // 8. 协调者创建汇装任务、submit 汇总摘要；验收者 accept；协调者 submit 根任务；发起人 accept 根任务
  const rollup = await request('POST', '/api/v2/tasks', coordinator.bearer, {
    title: `${runTag} 汇装任务`,
    body: `汇装 A（${subAId}）与 B（${subBId}）的验收结果。`,
    visibility: 'private',
    deliverable_spec: { items: ['汇装总结报告'] },
    targets: [{ principal_id: coordinator.principalId, role: 'assignee' }],
    task: { is_ready: true, parent_task_id: rootId },
  });
  const rollupId = rollup.data.post_id;
  if (rollupId) postIds.push(rollupId);
  check('8a. 协调者创建汇装任务（parent=根任务）',
    rollup.response.status === 201 && typeof rollupId === 'string',
    JSON.stringify(rollup.data));
  await request('POST', `/api/v2/tasks/${rollupId}/claim`, coordinator.bearer);
  const rollupSubmit = await request('POST', `/api/v2/tasks/${rollupId}/submit`, coordinator.bearer, {
    deliverables: [{ name: '汇装总结报告', note: 'A/B 均已验收' }],
    message: summaryRollup,
  });
  check('8b. 协调者 submit 汇装任务（汇总摘要）',
    rollupSubmit.response.status === 200 && rollupSubmit.data.task?.status === 'submitted',
    JSON.stringify(rollupSubmit.data));
  const rollupVerdict = await request('POST', `/api/v2/tasks/${rollupId}/verdict`, verifier.bearer, {
    decision: 'accept',
    opinion: '汇装验收通过',
  });
  check('8c. 验收者 accept 汇装任务',
    rollupVerdict.response.status === 200 && rollupVerdict.data.task?.status === 'done',
    JSON.stringify(rollupVerdict.data));
  const rootSubmit = await request('POST', `/api/v2/tasks/${rootId}/submit`, coordinator.bearer, {
    deliverables: [{ name: '汇装总结报告', note: '闭环完成' }],
    message: `根任务闭环：A/B 验收通过，汇装任务（${rollupId}）已 accept。`,
  });
  check('8d. 协调者 submit 根任务闭环',
    rootSubmit.response.status === 200 && rootSubmit.data.task?.status === 'submitted',
    JSON.stringify(rootSubmit.data));
  const rootVerdict = await request('POST', `/api/v2/tasks/${rootId}/verdict`, adminBearer, {
    decision: 'accept',
    opinion: '根任务验收通过，协作闭环完成',
  });
  check('8e. 发起人 verdict accept 根任务',
    rootVerdict.response.status === 200 && rootVerdict.data.task?.status === 'done',
    JSON.stringify(rootVerdict.data));

  // 9. 事件流与线程/摘要动作
  const events = await request(
    'GET',
    `/api/v2/events?resource_id=${encodeURIComponent(subBId)}&limit=50`,
    adminBearer,
  );
  const actions = (events.data.items ?? []).map((event) => event.action);
  check('9a. 事件流记录任务 B 的关键动作（ready_changed/claimed/submitted/verdict）',
    events.response.status === 200
      && actions.includes('task.ready_changed')
      && actions.includes('task.claimed')
      && actions.includes('task.submitted')
      && actions.includes('task.verdict'),
    JSON.stringify(actions));
  const readyEvent = (events.data.items ?? []).find((event) => event.action === 'task.ready_changed');
  check('9b. ready_changed 事件携带 ready=true 且动作为协调者',
    readyEvent?.actor_principal_id === coordinator.principalId
      && readyEvent?.payload?.ready === true,
    JSON.stringify(readyEvent));

  const thread = await request('GET', `/api/v2/posts/${subAId}`, coordinator.bearer);
  const recentBodies = JSON.stringify(thread.data?.recent ?? []);
  check('9c. 任务 A 线程包含执行者 A 的三段式摘要 reply',
    thread.response.status === 200
      && recentBodies.includes('结论')
      && recentBodies.includes('依据')
      && recentBodies.includes('风险'),
    recentBodies.slice(0, 200));
  const summary = await request('POST', `/api/v2/posts/${encodeURIComponent(rootId)}/summary`, adminBearer, {});
  check('9d. 根任务 summary 动作可用',
    summary.response.status === 200 && 'summary' in summary.data,
    JSON.stringify(summary.data));
} catch (error) {
  failed += 1;
  console.error(`  FAIL acceptance aborted — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanup().catch((error) => console.error('collab cleanup failed:', error.message));
}

console.log(`collab acceptance: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
