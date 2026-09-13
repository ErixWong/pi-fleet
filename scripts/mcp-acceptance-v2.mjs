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

if (phase !== 'read') {
  throw new Error(`only --phase read is implemented in 3b: ${phase}`);
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
const oldDb = createPool({ ...dbOptions(process.env.DB_NAME ?? 'task_dispatch'), connectionLimit: 2 });
let newPrincipalId;
let newDeviceId;
let newKeyId;
let lowKeyId;
let oldAgentId;
let mainKey;
let lowKey;
let oldKey;
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

  const oldKeyValue = key('pd');
  oldKey = oldKeyValue;
  const oldRows = await oldDb.query(
    `INSERT INTO agents
       (agent_id, name, hostname, description, system_prompt, tags, accept_external,
        run_user, agent_cli, key_hash, status, visible, created_at)
     VALUES (?, ?, ?, '', NULL, '', 0, NULL, NULL, ?, 'active', 1, ?)`,
    [`mcp-v2-${Date.now()}`, 'mcp-v2-legacy', 'mcp-acceptance-v2', hash(oldKeyValue), createdAt],
  );
  oldAgentId = oldRows.insertId;
  return accountId;
}

async function cleanup() {
  if (newKeyId || lowKeyId) {
    await newDb.query(
      `DELETE FROM api_key WHERE id IN (?, ?)`,
      [newKeyId, lowKeyId],
    );
  }
  if (newDeviceId) await newDb.query(`DELETE FROM device WHERE principal_id = ?`, [newDeviceId]);
  if (newPrincipalId) await newDb.query(`DELETE FROM principal WHERE id = ?`, [newPrincipalId]);
  if (oldAgentId) await oldDb.query(`DELETE FROM agents WHERE id = ?`, [oldAgentId]);
  await newDb.end();
  await oldDb.end();
}

try {
  await createFixtures();
  const client = await mcpClient(mcpPath, mainKey);
  const lowClient = await mcpClient(mcpPath, lowKey);
  const legacyClient = await mcpClient('/mcp', oldKey);

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
  const expectedKeys = ['post', 'targets', 'task', 'channel', 'deliverables', 'verdicts', 'summary', 'recent', 'more'];
  check('2. post(detail) has exactly the nine contract keys',
    JSON.stringify(Object.keys(detailed.payload).sort()) === JSON.stringify([...expectedKeys].sort()),
    JSON.stringify(Object.keys(detailed.payload)));
  check('3. recent is bounded and bodies are <= 501',
    Array.isArray(detailed.payload.recent)
      && detailed.payload.recent.length <= 5
      && detailed.payload.recent.every((item) => String(item.body ?? '').length <= 501),
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

  const legacyWho = await call(legacyClient, 'whoami', {});
  check('8. old /mcp still exposes legacy whoami agent_id',
    typeof legacyWho.payload.agent_id === 'string',
    JSON.stringify(legacyWho.payload));

  await client.close();
  await lowClient.close();
  await legacyClient.close();
} catch (error) {
  failed += 1;
  console.error(`  FAIL acceptance aborted — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanup();
}

console.log(`MCP v2 read acceptance: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
