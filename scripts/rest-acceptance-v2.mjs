import 'dotenv/config';
import crypto from 'node:crypto';
import { createPool } from 'mariadb';

const base = process.env.TEST_BASE ?? 'http://127.0.0.1:3000';
const db = createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME_NEW ?? 'erix',
  dateStrings: true,
  connectionLimit: 3,
});

const id = (prefix) => `${prefix}_v2${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const key = () => `pk-${crypto.randomBytes(24).toString('base64url')}`;
const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
let principalId;
let deviceId;
let keyId;
let lowKeyId;
let createdKeyId;
let bearer;
let lowBearer;
const postIds = [];
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

async function request(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function fixture() {
  const accounts = await db.query(
    `SELECT id FROM account WHERE deleted_at IS NULL ORDER BY id LIMIT 1`,
  );
  if (accounts.length === 0) throw new Error('erix has no active account');
  const accountId = String(accounts[0].id);
  principalId = id('prn');
  deviceId = principalId;
  keyId = id('key');
  lowKeyId = id('key');
  bearer = key();
  lowBearer = key();
  await db.query(
    `INSERT INTO principal (id, account_id, kind, name, created_at)
     VALUES (?, ?, 'host', ?, ?)`,
    [principalId, accountId, `rest-v2-${principalId}`, now()],
  );
  await db.query(
    `INSERT INTO device (principal_id, hostname, os, created_at)
     VALUES (?, 'rest-acceptance-v2', 'linux', ?)`,
    [deviceId, now()],
  );
  await db.query(
    `INSERT INTO api_key (id, principal_id, key_hash, label, scopes, created_at)
     VALUES (?, ?, ?, 'rest-v2-main', ?, ?)`,
    [keyId, principalId, hash(bearer), JSON.stringify([
      'post:read', 'post:write', 'task:read', 'task:write', 'task:claim',
      'task:submit', 'task:verdict', 'attachment:read', 'attachment:write', 'moderate',
      'key:manage',
    ]), now()],
  );
  await db.query(
    `INSERT INTO api_key (id, principal_id, key_hash, label, scopes, created_at)
     VALUES (?, ?, ?, 'rest-v2-low', ?, ?)`,
    [lowKeyId, principalId, hash(lowBearer), JSON.stringify(['task:read']), now()],
  );
  return accountId;
}

async function cleanup() {
  if (postIds.length > 0) {
    const placeholders = postIds.map(() => '?').join(', ');
    await db.query(`DELETE FROM post_summary WHERE root_id IN (${placeholders})`, postIds);
    await db.query(`DELETE FROM deliverable WHERE post_id IN (${placeholders})`, postIds);
    await db.query(`DELETE FROM post_verdict WHERE post_id IN (${placeholders})`, postIds);
    await db.query(`DELETE FROM post_task WHERE post_id IN (${placeholders})`, postIds);
    await db.query(`DELETE FROM post_target WHERE post_id IN (${placeholders})`, postIds);
    await db.query(`UPDATE post SET parent_id = NULL WHERE id IN (${placeholders})`, postIds);
    await db.query(`DELETE FROM post WHERE id IN (${placeholders})`, postIds);
  }
  if (keyId || lowKeyId || createdKeyId) {
    await db.query(
      `DELETE FROM api_key WHERE id IN (?, ?, ?)`,
      [keyId, lowKeyId, createdKeyId],
    );
  }
  if (deviceId) await db.query(`DELETE FROM device WHERE principal_id = ?`, [deviceId]);
  if (principalId) await db.query(`DELETE FROM principal WHERE id = ?`, [principalId]);
  await db.end();
}

try {
  const accountId = await fixture();
  console.log('== REST v2 write acceptance ==');
  const note = await request('POST', '/api/v2/posts', bearer, {
    kind: 'note',
    body: 'REST v2 note',
    visibility: 'account',
  });
  check('1. POST /posts creates a note', note.response.status === 201 && note.data.ok === true);
  if (note.data.post_id) postIds.push(note.data.post_id);

  const created = await request('POST', '/api/v2/tasks', bearer, {
    title: 'REST v2 task',
    body: 'REST write path',
    visibility: 'private',
    deliverable_spec: { items: ['result'] },
    targets: [{ principal_id: principalId, role: 'assignee' }],
  });
  const taskId = created.data.post_id;
  if (taskId) postIds.push(taskId);
  check('2. POST /tasks publishes an open task',
    created.response.status === 201 && created.data.status === 'open',
    JSON.stringify(created.data));

  const claim = await request('POST', `/api/v2/tasks/${taskId}/claim`, bearer);
  check('3. POST /tasks/:id/claim claims the task',
    claim.response.status === 200 && claim.data.assignee_principal_id === principalId,
    JSON.stringify(claim.data));
  const submit = await request('POST', `/api/v2/tasks/${taskId}/submit`, bearer, {
    deliverables: [{ name: 'result', note: 'done' }],
  });
  check('4. POST /tasks/:id/submit reaches submitted',
    submit.response.status === 200 && submit.data.ok === true && submit.data.task?.status === 'submitted',
    JSON.stringify(submit.data));
  const verdict = await request('POST', `/api/v2/tasks/${taskId}/verdict`, bearer, {
    decision: 'accept',
    opinion: 'accepted',
  });
  check('5. POST /tasks/:id/verdict reaches done',
    verdict.response.status === 200 && verdict.data.task?.status === 'done',
    JSON.stringify(verdict.data));
  if (verdict.data.verdict?.post_id) postIds.push(verdict.data.verdict.post_id);
  const reply = await request('POST', `/api/v2/posts/${taskId}/reply`, bearer, { body: 'REST reply' });
  check('6. POST /posts/:id/reply creates a thread reply', reply.response.status === 201);
  if (reply.data.post_id) postIds.push(reply.data.post_id);
  const detail = await request('GET', `/api/v2/posts/${taskId}`, bearer);
  check('7. GET /posts/:id returns the structured task detail',
    detail.response.status === 200 && detail.data.post?.id === taskId,
    JSON.stringify(detail.data));
  const events = await request('GET', `/api/v2/events?resource_id=${taskId}&limit=20`, bearer);
  check('8. GET /events is account-scoped and contains task events',
    events.response.status === 200
      && events.data.items?.some((event) => event.action === 'task.claimed'),
    JSON.stringify(events.data));
  const denied = await request('POST', `/api/v2/tasks/${taskId}/claim`, lowBearer);
  check('9. missing task:claim is hidden as 404', denied.response.status === 404);
  const wrongAccount = await request('POST', '/api/v2/tasks', lowBearer, {
    body: 'not allowed',
    visibility: 'public',
    deliverable_spec: { items: ['result'] },
  });
  check('10. missing task:write is hidden as 404', wrongAccount.response.status === 404);
  const empty = await request('POST', '/api/v2/tasks', bearer, {
    body: 'empty spec',
    visibility: 'public',
    deliverable_spec: {},
  });
  check('11. empty deliverable_spec is rejected', empty.response.status >= 400);
  const createdKey = await request('POST', '/api/v2/keys', bearer, {
    label: 'rest-v2-created',
    scopes: ['task:read'],
  });
  check('12. POST /keys creates a scoped key',
    createdKey.response.status === 201 && typeof createdKey.data.key === 'string',
    JSON.stringify(createdKey.data));
  const keyList = await request('GET', '/api/v2/keys', bearer);
  const createdKeyView = keyList.data.items?.find((item) => item.label === 'rest-v2-created');
  createdKeyId = createdKeyView?.id;
  check('13. GET /keys lists the created key without secret material',
    keyList.response.status === 200 && createdKeyView?.scopes?.includes('task:read')
      && !('key' in (createdKeyView ?? {})) && !('key_hash' in (createdKeyView ?? {})),
    JSON.stringify(keyList.data));
  const revoked = await request('DELETE', `/api/v2/keys/${createdKeyId}`, bearer);
  check('14. DELETE /keys/:id revokes the created key',
    revoked.response.status === 200 && revoked.data.ok === true,
    JSON.stringify(revoked.data));
} catch (error) {
  failed += 1;
  console.error(`  FAIL acceptance aborted — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanup().catch((error) => console.error('REST v2 cleanup failed:', error.message));
}

console.log(`REST v2 write acceptance: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
