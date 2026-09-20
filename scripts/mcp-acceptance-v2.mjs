import 'dotenv/config';
import crypto from 'node:crypto';
import { createPool } from 'mariadb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const phaseIndex = args.indexOf('--phase');
const baseIndex = args.indexOf('--base');
const pathIndex = args.indexOf('--mcp-path');
const phase = phaseIndex >= 0 ? args[phaseIndex + 1] : 'read';
const base = baseIndex >= 0 ? args[baseIndex + 1] : process.env.TEST_BASE ?? 'http://127.0.0.1:3000';
const mcpPath = pathIndex >= 0 ? args[pathIndex + 1] : '/mcp2';

if (!['read', 'write'].includes(phase)) {
  throw new Error(`--phase must be read or write: ${phase}`);
}

const dbOptions = (database) => ({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database,
  dateStrings: true,
});

const now = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const id = (prefix) => `${prefix}_t${Date.now().toString(36)}${crypto.randomBytes(7).toString('hex')}`;
const key = (prefix) => `${prefix}-${crypto.randomBytes(24).toString('base64url')}`;
const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const scopes = [
  'post:read',
  'post:write',
  'task:read',
  'task:write',
  'task:claim',
  'task:submit',
  'task:verdict',
  'attachment:read',
  'attachment:write',
  'device:execute',
  'key:manage',
];

const newDb = createPool({ ...dbOptions(process.env.DB_NAME_NEW ?? 'erix'), connectionLimit: 4 });
let newPrincipalId;
let newDeviceId;
let newKeyId;
let lowKeyId;
let mainKey;
let lowKey;
const postIds = [];
const attachmentIds = [];
let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function mcpClient(endpoint, bearer) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${endpoint}`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'mcp-acceptance-v2', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client, name, arguments_) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  return { result, payload };
}

function deepKeys(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) deepKeys(item, found);
    return found;
  }
  for (const [keyName, child] of Object.entries(value)) {
    found.add(keyName);
    deepKeys(child, found);
  }
  return found;
}

async function createFixtures() {
  const accountRows = await newDb.query(
    `SELECT id FROM account WHERE deleted_at IS NULL ORDER BY id LIMIT 1`,
  );
  if (accountRows.length === 0) throw new Error('erix has no active account');
  const accountId = String(accountRows[0].id);
  newPrincipalId = id('prn');
  newDeviceId = newPrincipalId;
  mainKey = key('pk');
  lowKey = key('pk');
  newKeyId = id('key');
  lowKeyId = id('key');
  const createdAt = now();
  await newDb.query(
    `INSERT INTO principal
       (id, account_id, kind, name, password_hash, host_principal_id, created_at)
     VALUES (?, ?, 'host', ?, NULL, NULL, ?)`,
    [newPrincipalId, accountId, `mcp-v2-${newPrincipalId}`, createdAt],
  );
  await newDb.query(
    `INSERT INTO device (principal_id, hostname, os, run_user, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
    [newDeviceId, 'mcp-acceptance-v2', 'linux', createdAt],
  );
  await newDb.query(
    `INSERT INTO api_key (id, principal_id, key_hash, label, scopes, created_at)
     VALUES (?, ?, ?, 'mcp-v2-main', ?, ?)`,
    [newKeyId, newPrincipalId, hash(mainKey), JSON.stringify(scopes), createdAt],
  );
  await newDb.query(
    `INSERT INTO api_key (id, principal_id, key_hash, label, scopes, created_at)
     VALUES (?, ?, ?, 'mcp-v2-low', ?, ?)`,
    [lowKeyId, newPrincipalId, hash(lowKey), JSON.stringify(['task:read']), createdAt],
  );

  if (phase === 'read') {
    const rootId = id('post');
    const replyId = id('post');
    await newDb.query(
      `INSERT INTO post
         (id, account_id, kind, subtype, author_principal_id, title, body,
          visibility, root_id, created_at)
       VALUES (?, ?, 'note', '', ?, ?, ?, 'public', ?, ?)`,
      [rootId, accountId, newPrincipalId, 'MCP v2 read root', 'read acceptance root', rootId, createdAt],
    );
    await newDb.query(
      `INSERT INTO post
         (id, account_id, kind, subtype, author_principal_id, title, body,
          visibility, parent_id, root_id, created_at)
       VALUES (?, ?, 'note', '', ?, ?, ?, 'public', ?, ?, ?)`,
      [replyId, accountId, newPrincipalId, 'MCP v2 read reply', 'read acceptance reply', rootId, rootId, createdAt],
    );
    postIds.push(rootId, replyId);
  }

  return accountId;
}

async function cleanup() {
  if (newPrincipalId) {
    const ownedPosts = await newDb.query(
      `SELECT id FROM post WHERE author_principal_id = ?`,
      [newPrincipalId],
    );
    for (const row of ownedPosts) {
      if (!postIds.includes(String(row.id))) postIds.push(String(row.id));
    }
    const ownedAttachments = await newDb.query(
      `SELECT id FROM attachment WHERE owner_principal_id = ?`,
      [newPrincipalId],
    );
    for (const row of ownedAttachments) {
      if (!attachmentIds.includes(String(row.id))) attachmentIds.push(String(row.id));
    }
  }
  if (postIds.length > 0) {
    const placeholders = postIds.map(() => '?').join(', ');
    await newDb.query(`DELETE FROM deliverable WHERE post_id IN (${placeholders})`, postIds);
    await newDb.query(
      `DELETE FROM post_verdict
        WHERE post_id IN (${placeholders}) OR target_task_id IN (${placeholders})`,
      [...postIds, ...postIds],
    );
    await newDb.query(`DELETE FROM post_task WHERE post_id IN (${placeholders})`, postIds);
    await newDb.query(`DELETE FROM post_target WHERE post_id IN (${placeholders})`, postIds);
    await newDb.query(`DELETE FROM post_summary WHERE root_id IN (${placeholders})`, postIds);
    await newDb.query(`UPDATE post SET parent_id = NULL WHERE id IN (${placeholders})`, postIds);
    await newDb.query(`DELETE FROM post WHERE id IN (${placeholders})`, postIds);
  }
  if (attachmentIds.length > 0) {
    const placeholders = attachmentIds.map(() => '?').join(', ');
    await newDb.query(`DELETE FROM deliverable WHERE attachment_id IN (${placeholders})`, attachmentIds);
    await newDb.query(`DELETE FROM attachment WHERE id IN (${placeholders})`, attachmentIds);
  }
  if (newKeyId || lowKeyId) {
    await newDb.query(
      `DELETE FROM api_key WHERE id IN (?, ?)`,
      [newKeyId, lowKeyId],
    );
  }
  if (newDeviceId) await newDb.query(`DELETE FROM device WHERE principal_id = ?`, [newDeviceId]);
  if (newPrincipalId) await newDb.query(`DELETE FROM principal WHERE id = ?`, [newPrincipalId]);
  await newDb.end();
}

try {
  await createFixtures();
  const client = await mcpClient(mcpPath, mainKey);
  const lowClient = await mcpClient(mcpPath, lowKey);

  if (phase === 'write') {
    console.log('== MCP v2 write acceptance ==');
    const taskCreate = await call(client, 'post', {
      action: 'create',
      kind: 'task',
      title: 'MCP v2 write task',
      body: 'complete the write path',
      visibility: 'private',
      deliverable_spec: { items: ['result'] },
      targets: [{ principal_id: newPrincipalId, role: 'assignee' }],
    });
    const taskId = taskCreate.payload.post_id;
    if (taskId) postIds.push(taskId);
    check('1. post(create task) publishes an open task',
      taskCreate.payload.ok === true && typeof taskId === 'string' && taskCreate.payload.status === 'open',
      JSON.stringify(taskCreate.payload));
    const claimed = await call(client, 'task', { action: 'claim', task_id: taskId });
    check('2. task(claim) assigns the authenticated principal',
      claimed.payload.ok === true && claimed.payload.assignee_principal_id === newPrincipalId,
      JSON.stringify(claimed.payload));
    const uploaded = await call(client, 'attachment', {
      action: 'upload',
      filename: 'result.txt',
      mime: 'text/plain',
      data_base64: Buffer.from('result').toString('base64'),
    });
    if (uploaded.payload.attachment_id) attachmentIds.push(uploaded.payload.attachment_id);
    check('3. attachment(upload) returns an attachment id',
      uploaded.payload.ok === true && typeof uploaded.payload.attachment_id === 'string',
      JSON.stringify(uploaded.payload));
    const submitted = await call(client, 'task', {
      action: 'submit',
      task_id: taskId,
      deliverables: [{ name: 'result', attachment_id: uploaded.payload.attachment_id }],
    });
    check('4. task(submit) returns a passing precheck',
      submitted.payload.ok === true && submitted.payload.precheck?.ok === true
        && submitted.payload.task?.status === 'submitted',
      JSON.stringify(submitted.payload));
    const accepted = await call(client, 'task', {
      action: 'verdict',
      task_id: taskId,
      decision: 'accept',
      opinion: 'accepted',
    });
    check('5. task(verdict accept) closes the task',
      accepted.payload.ok === true && accepted.payload.task?.status === 'done',
      JSON.stringify(accepted.payload));

    const publicCreated = await call(client, 'post', {
      action: 'create',
      kind: 'task',
      title: 'MCP v2 public task',
      body: 'public offer',
      visibility: 'public',
      deliverable_spec: { items: ['result'] },
      targets: [],
    });
    const publicTaskId = publicCreated.payload.post_id;
    if (publicTaskId) postIds.push(publicTaskId);
    await call(client, 'task', { action: 'claim', task_id: publicTaskId });
    await call(client, 'task', {
      action: 'submit',
      task_id: publicTaskId,
      deliverables: [{ name: 'result' }],
    });
    const rejected = await call(client, 'task', {
      action: 'verdict',
      task_id: publicTaskId,
      decision: 'reject',
      opinion: 'please improve',
    });
    check('6. public reject returns to claimed with one attempt',
      rejected.payload.task?.status === 'claimed' && rejected.payload.task?.attempts === 1,
      JSON.stringify(rejected.payload));
    const reopened = await call(client, 'task', { action: 'reopen', task_id: publicTaskId });
    const resubmitted = await call(client, 'task', {
      action: 'submit',
      task_id: publicTaskId,
      deliverables: [{ name: 'result' }],
    });
    const acceptedAgain = await call(client, 'task', {
      action: 'verdict',
      task_id: publicTaskId,
      decision: 'accept',
    });
    if (accepted.payload.verdict?.post_id) postIds.push(accepted.payload.verdict.post_id);
    if (acceptedAgain.payload.verdict?.post_id) postIds.push(acceptedAgain.payload.verdict.post_id);
    check('7. public reject → reopen → submit → accept closes the task',
      reopened.payload.ok === true
        && resubmitted.payload.ok === true
        && acceptedAgain.payload.task?.status === 'done',
      JSON.stringify({ reopened: reopened.payload, resubmitted: resubmitted.payload, accepted: acceptedAgain.payload }));

    const emptyBefore = await newDb.query(`SELECT COUNT(*) AS count FROM post`);
    const emptySpec = await call(client, 'post', {
      action: 'create',
      kind: 'task',
      body: 'must reject empty spec',
      visibility: 'public',
      deliverable_spec: {},
    });
    const emptyAfter = await newDb.query(`SELECT COUNT(*) AS count FROM post`);
    check('8. empty deliverable_spec is rejected without a post',
      emptySpec.result.isError === true && Number(emptyBefore[0].count) === Number(emptyAfter[0].count),
      JSON.stringify(emptySpec.payload));

    const approve = await call(client, 'task', { action: 'approve', task_id: taskId });
    const resolve = await call(client, 'task', { action: 'resolve', task_id: taskId });
    check('9. approve and resolve are unknown task actions',
      approve.result.isError === true && resolve.result.isError === true,
      JSON.stringify({ approve: approve.payload, resolve: resolve.payload }));

    const targetsByCount = [];
    for (const targetCount of [0, 1, 3]) {
      const targetList = targetCount === 0
        ? []
        : targetCount === 1
          ? [{ principal_id: newPrincipalId, role: 'assignee' }]
          : [
              { principal_id: newPrincipalId, role: 'assignee' },
              { principal_id: newPrincipalId, role: 'mention' },
              { principal_id: newPrincipalId, role: 'watcher' },
            ];
      const created = await call(client, 'post', {
        action: 'create',
        kind: 'note',
        body: `target count ${targetCount}`,
        visibility: 'account',
        targets: targetList,
      });
      if (created.payload.post_id) postIds.push(created.payload.post_id);
      targetsByCount.push(created);
    }
    check('10. target 0/1/3 shapes are accepted',
      targetsByCount.every((item) => item.payload.ok === true),
      JSON.stringify(targetsByCount.map((item) => item.payload)));

    const deniedClaim = await call(lowClient, 'task', { action: 'claim', task_id: publicTaskId });
    const deniedSubmit = await call(lowClient, 'task', {
      action: 'submit',
      task_id: publicTaskId,
      deliverables: [{ name: 'result' }],
    });
    const deniedVerdict = await call(lowClient, 'task', {
      action: 'verdict',
      task_id: publicTaskId,
      decision: 'accept',
    });
    const deniedUpload = await call(lowClient, 'attachment', {
      action: 'upload',
      filename: 'denied.txt',
      data_base64: Buffer.from('denied').toString('base64'),
    });
    const deniedDetail = await call(lowClient, 'post', { action: 'detail', id: taskId });
    check('11. scope denial matrix returns MCP errors',
      [deniedClaim, deniedSubmit, deniedVerdict, deniedUpload, deniedDetail]
        .every((item) => item.result.isError === true),
      JSON.stringify([deniedClaim.payload, deniedSubmit.payload, deniedVerdict.payload, deniedUpload.payload, deniedDetail.payload]));

    for (const item of [taskCreate, claimed, uploaded, submitted, accepted, publicCreated, rejected, reopened, resubmitted, acceptedAgain]) {
      const text = JSON.stringify(item.payload);
      check('12. no legacy status string in write response', !/(assigned|running|resolved|blocked)/.test(text), text);
    }
    await client.close();
    await lowClient.close();
  } else {
  console.log('== MCP v2 read acceptance ==');
  const who = await call(client, 'whoami', {});
  check('1. whoami principal.kind + scopes.length >= 11',
    typeof who.payload.principal?.kind === 'string' && who.payload.scopes?.length >= 11,
    JSON.stringify(who.payload));

  const candidates = await newDb.query(
    `SELECT root_id
       FROM post
      WHERE deleted_at IS NULL
      GROUP BY root_id
      HAVING COUNT(*) >= 2
      ORDER BY root_id DESC
      LIMIT 1`,
  );
  const detailRows = await newDb.query(
    `SELECT id, kind, root_id FROM post WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
  );
  if (candidates.length === 0 || detailRows.length === 0) {
    throw new Error('erix needs at least one post and one two-item thread for read acceptance');
  }
  const detailId = String(detailRows[0].id);
  const rootId = String(candidates[0].root_id);
  const detailed = await call(client, 'post', { action: 'detail', id: detailId });
  const expectedKeys = ['post', 'targets', 'task', 'parent', 'children', 'channel', 'deliverables', 'verdicts', 'summary', 'recent', 'more'];
  check('2. post(detail) has exactly the eleven contract keys (legacy nine + tree parent/children)',
    JSON.stringify(Object.keys(detailed.payload).sort()) === JSON.stringify([...expectedKeys].sort()),
    JSON.stringify(Object.keys(detailed.payload)));
  check('3. recent is bounded and bodies are <= 500',
    Array.isArray(detailed.payload.recent)
      && detailed.payload.recent.length <= 5
      && detailed.payload.recent.every((item) => String(item.body ?? '').length <= 500),
    JSON.stringify(detailed.payload.recent));
  const forbidden = ['deleted_at', 'account_id', 'streaming'];
  const detailKeys = deepKeys(detailed.payload);
  const detailKind = detailed.payload.post?.kind;
  const extensionsMatchKind = detailKind === 'task'
    ? detailed.payload.task !== null && detailed.payload.channel === null
    : detailKind === 'channel'
      ? detailed.payload.task === null && detailed.payload.channel !== null
      : detailed.payload.task === null && detailed.payload.channel === null;
  check('4. post(detail) has no internal fields and extensions are mutually exclusive',
    forbidden.every((name) => !detailKeys.has(name)) && extensionsMatchKind,
    JSON.stringify({
      forbidden: [...detailKeys].filter((name) => forbidden.includes(name)),
      kind: detailKind,
      task: detailed.payload.task,
      channel: detailed.payload.channel,
    }));

  const firstPage = await call(client, 'post', {
    action: 'list',
    root_id: rootId,
    page_size: 1,
  });
  const firstItems = firstPage.payload.items ?? [];
  const cursor = firstPage.payload.next_after;
  const secondPage = await call(client, 'post', {
    action: 'list',
    root_id: rootId,
    page_size: 1,
    after: cursor,
  });
  const secondItems = secondPage.payload.items ?? [];
  const firstMin = firstItems.reduce((min, item) => String(item.id) < min ? String(item.id) : min, String(firstItems[0]?.id ?? ''));
  check('5. post(list) keyset pages do not overlap and move backward',
    firstItems.length === 1
      && secondItems.length === 1
      && secondItems.every((item) => !firstItems.some((first) => first.id === item.id))
      && String(secondItems[0].id) < firstMin,
    JSON.stringify({ firstItems, secondItems }));

  const taskViews = await Promise.all(['due', 'mine', 'pool'].map(async (view) => ({
    view,
    result: await call(client, 'task', { action: 'list', view, page_size: 200 }),
  })));
  check('6. task(list) returns all three views with <= 200 items and numeric totals',
    taskViews.every(({ view, result }) =>
      Array.isArray(result.payload.items)
      && result.payload.items.length <= 200
      && typeof result.payload.total === 'number'
      && result.payload.view === view),
    JSON.stringify(taskViews.map(({ view, result }) => ({
      view,
      items: result.payload.items?.length,
      total: result.payload.total,
    }))));

  const denied = await call(lowClient, 'post', { action: 'detail', id: detailId });
  const deniedText = denied.result.content?.find((item) => item.type === 'text')?.text ?? '';
  check('7. post:read scope denial is an MCP error without resource leakage',
    denied.result.isError === true
      && deniedText.includes('not found')
      && !deniedText.includes(detailId)
      && !deniedText.includes(String(detailRows[0].kind)),
    deniedText);

  await client.close();
  await lowClient.close();
  }
} catch (error) {
  failed += 1;
  console.error(`  FAIL acceptance aborted — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanup();
}

console.log(`MCP v2 ${phase} acceptance: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
