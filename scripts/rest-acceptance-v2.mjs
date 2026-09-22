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
let otherPrincipalId;
let keyId;
let lowKeyId;
let manageOnlyKeyId;
let otherReadKeyId;
let otherTaskKeyId;
let createdKeyId;
let bearer;
let lowBearer;
let manageOnlyBearer;
let otherReadBearer;
let otherTaskBearer;
let loginPrincipalId;
let loginPassword;
let loginBearer;
let createdHostId;
let createdHostBearer;
let otherAccountId;
let otherHostId;
let loginAccountName;
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

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
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

async function upload(filename, mime, content, token) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: mime }), filename);
  const response = await fetch(`${base}/api/v2/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function pollScanStatus(attachmentId) {
  const statuses = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rows = await db.query(
      `SELECT scan_status FROM attachment WHERE id = ? LIMIT 1`,
      [attachmentId],
    );
    const status = rows[0] ? String(rows[0].scan_status) : 'missing';
    if (statuses[statuses.length - 1] !== status) statuses.push(status);
    if (['clean', 'infected', 'skipped', 'error', 'missing'].includes(status)) {
      return { status, statuses };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { status: statuses.at(-1) ?? 'missing', statuses };
}

async function fixture() {
  const accounts = await db.query(
    `SELECT id, name FROM account WHERE deleted_at IS NULL ORDER BY id LIMIT 1`,
  );
  if (accounts.length === 0) throw new Error('erix has no active account');
  const accountId = String(accounts[0].id);
  loginAccountName = String(accounts[0].name);
  principalId = id('prn');
  deviceId = principalId;
  otherPrincipalId = id('prn');
  loginPrincipalId = id('prn');
  loginPassword = `rest-v2-password-${Date.now()}`;
  otherAccountId = id('acc');
  otherHostId = id('prn');
  keyId = id('key');
  lowKeyId = id('key');
  manageOnlyKeyId = id('key');
  otherReadKeyId = id('key');
  otherTaskKeyId = id('key');
  bearer = key();
  lowBearer = key();
  manageOnlyBearer = key();
  otherReadBearer = key();
  otherTaskBearer = key();
  await db.query(
    `INSERT INTO principal (id, account_id, kind, name, created_at)
     VALUES (?, ?, 'host', ?, ?)`,
    [principalId, accountId, `rest-v2-${principalId}`, now()],
  );
  await db.query(
    `INSERT INTO principal (id, account_id, kind, name, created_at)
     VALUES (?, ?, 'user', ?, ?)`,
    [otherPrincipalId, accountId, `rest-v2-other-${otherPrincipalId}`, now()],
  );
  await db.query(
    `INSERT INTO principal (id, account_id, kind, name, password_hash, created_at)
     VALUES (?, ?, 'user', ?, ?, ?)`,
    [loginPrincipalId, accountId, `rest-v2-login-${loginPrincipalId}`, passwordHash(loginPassword), now()],
  );
  await db.query(
    `INSERT INTO account (id, name, created_at) VALUES (?, ?, ?)`,
    [otherAccountId, `rest-v2-other-account-${otherAccountId}`, now()],
  );
  await db.query(
    `INSERT INTO principal (id, account_id, kind, name, created_at)
     VALUES (?, ?, 'host', ?, ?)`,
    [otherHostId, otherAccountId, `rest-v2-other-host-${otherHostId}`, now()],
  );
  await db.query(
    `INSERT INTO device (principal_id, hostname, os, created_at)
     VALUES (?, 'rest-v2-other-host', 'linux', ?)`,
    [otherHostId, now()],
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
  await db.query(
    `INSERT INTO api_key (id, principal_id, key_hash, label, scopes, created_at)
     VALUES (?, ?, ?, 'rest-v2-manage-only', ?, ?)`,
    [manageOnlyKeyId, principalId, hash(manageOnlyBearer), JSON.stringify(['key:manage']), now()],
  );
  await db.query(
    `INSERT INTO api_key (id, principal_id, key_hash, label, scopes, created_at)
     VALUES (?, ?, ?, 'rest-v2-other-read', ?, ?)`,
    [otherReadKeyId, otherPrincipalId, hash(otherReadBearer), JSON.stringify(['attachment:read']), now()],
  );
  await db.query(
    `INSERT INTO api_key (id, principal_id, key_hash, label, scopes, created_at)
     VALUES (?, ?, ?, 'rest-v2-other-task', ?, ?)`,
    [
      otherTaskKeyId,
      otherPrincipalId,
      hash(otherTaskBearer),
      JSON.stringify(['attachment:read', 'task:read', 'task:claim', 'task:submit']),
      now(),
    ],
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
  if (attachmentIds.length > 0) {
    const placeholders = attachmentIds.map(() => '?').join(', ');
    await db.query(`DELETE FROM attachment WHERE id IN (${placeholders})`, attachmentIds);
  }
  const keyIds = [keyId, lowKeyId, manageOnlyKeyId, otherReadKeyId, otherTaskKeyId, createdKeyId]
    .filter(Boolean);
  if (keyIds.length > 0) {
    const placeholders = keyIds.map(() => '?').join(', ');
    await db.query(
      `DELETE FROM api_key WHERE id IN (${placeholders})`,
      keyIds,
    );
  }
  const createdPrincipalIds = [principalId, otherPrincipalId, loginPrincipalId, createdHostId, otherHostId]
    .filter(Boolean);
  if (createdPrincipalIds.length > 0) {
    const principalPlaceholders = createdPrincipalIds.map(() => '?').join(', ');
    await db.query(`DELETE FROM api_key WHERE principal_id IN (${principalPlaceholders})`, createdPrincipalIds);
    await db.query(`DELETE FROM device_executor WHERE principal_id IN (${principalPlaceholders})`, createdPrincipalIds);
    await db.query(`DELETE FROM host_folder WHERE host_principal_id IN (${principalPlaceholders})`, createdPrincipalIds);
    await db.query(`DELETE FROM host_control_request WHERE host_principal_id IN (${principalPlaceholders})`, createdPrincipalIds);
    await db.query(`DELETE FROM device WHERE principal_id IN (${principalPlaceholders})`, createdPrincipalIds);
    await db.query(`DELETE FROM principal WHERE id IN (${principalPlaceholders})`, createdPrincipalIds);
  }
  if (otherAccountId) await db.query(`DELETE FROM account WHERE id = ?`, [otherAccountId]);
  await db.end();
}

try {
  const accountId = await fixture();
  console.log('== REST v2 write acceptance ==');
  const badPassword = await request('POST', '/api/v2/login', undefined, {
    username: `rest-v2-login-${loginPrincipalId}`,
    password: 'wrong-password',
    account_name: loginAccountName,
  });
  check('0a. login rejects a wrong password with 401', badPassword.response.status === 401);
  const missingUser = await request('POST', '/api/v2/login', undefined, {
    username: `rest-v2-missing-${Date.now()}`,
    password: loginPassword,
    account_name: loginAccountName,
  });
  check('0b. login rejects an unknown user with 401', missingUser.response.status === 401);
  const login = await request('POST', '/api/v2/login', undefined, {
    username: `rest-v2-login-${loginPrincipalId}`,
    password: loginPassword,
    account_name: loginAccountName,
  });
  loginBearer = login.data.key;
  check('0c. login returns a 12-hour key',
    login.response.status === 200
      && typeof loginBearer === 'string'
      && login.data.principal?.kind === 'user'
      && typeof login.data.expires_at === 'string');
  const loginWhoami = await request('GET', '/api/v2/whoami', loginBearer);
  check('0d. login key authenticates /whoami',
    loginWhoami.response.status === 200 && loginWhoami.data.principal?.kind === 'user');
  const hostCreated = await request('POST', '/api/v2/hosts', loginBearer, {
    name: `rest-v2-login-host-${Date.now()}`,
  });
  createdHostId = hostCreated.data.host?.id;
  createdHostBearer = hostCreated.data.key;
  check('0e. host registration returns 201 and a one-time key',
    hostCreated.response.status === 201
      && typeof createdHostId === 'string'
      && typeof createdHostBearer === 'string');
  const hostWhoami = await request('GET', '/api/v2/whoami', createdHostBearer);
  check('0f. host key authenticates as a host',
    hostWhoami.response.status === 200 && hostWhoami.data.principal?.kind === 'host');
  const reportedFolderPath = `/home/rest-v2-host-${Date.now()}/reported`;
  const reportedFolders = await request('POST', '/api/v2/hosts/folders', createdHostBearer, {
    folders: [reportedFolderPath, `${reportedFolderPath}/../reported`],
  });
  check('0f1. host key can report home folders',
    reportedFolders.response.status === 200
      && reportedFolders.data.folders?.some((folder) => folder.path === reportedFolderPath));
  const listedHosts = await request('GET', '/api/v2/hosts', loginBearer);
  const listedCreatedHost = listedHosts.data.items?.find((host) => host.id === createdHostId);
  check('0f2. host folders are included in the host list',
    listedHosts.response.status === 200
      && listedCreatedHost?.folders?.some((folder) => folder.path === reportedFolderPath));
  const userReportDenied = await request('POST', '/api/v2/hosts/folders', loginBearer, {
    host_principal_id: createdHostId,
    folders: [reportedFolderPath],
  });
  check('0f3. non-host callers cannot report for a host', userReportDenied.response.status === 404);
  const hostDenied = await request('GET', '/api/v2/hosts', createdHostBearer);
  check('0g. host key without host:manage is hidden as 404', hostDenied.response.status === 404);
  const browsePath = `/home/rest-v2-browse-${Date.now()}`;
  const browseCreated = await request('POST', `/api/v2/hosts/${createdHostId}/browse`, loginBearer, {
    path: browsePath,
  });
  check('0g1. browse creates a pending list_dir request', browseCreated.response.status === 202
    && browseCreated.data.request?.status === 'pending');
  const pendingControls = await request('GET', '/api/v2/hosts/controls', createdHostBearer);
  check('0g2. controls wire shape carries payload.path for daemon',
    pendingControls.response.status === 200
    && pendingControls.data.items?.some((item) => item.id === browseCreated.data.request_id
      && item.payload?.path === browsePath));
  const answered = await request('POST', `/api/v2/hosts/controls/${browseCreated.data.request_id}/results`,
    createdHostBearer, { entries: [{ path: `${browsePath}/sub` }] });
  check('0g3. daemon can answer list_dir with entries', answered.response.status === 200
    && answered.data.request?.status === 'answered'
    && answered.data.request?.result?.entries?.some((entry) => entry.path === `${browsePath}/sub`));
  const crossAccountPatch = await request('PATCH', `/api/v2/hosts/${otherHostId}`, loginBearer, {
    name: 'cross-account-update',
  });
  check('0h. cross-account host update is hidden as 404', crossAccountPatch.response.status === 404);
  const crossAccountDelete = await request('DELETE', `/api/v2/hosts/${otherHostId}`, loginBearer);
  check('0i. cross-account host delete is hidden as 404', crossAccountDelete.response.status === 404);
  const rotatedHost = await request('POST', `/api/v2/hosts/${createdHostId}/keys/rotate`, loginBearer);
  const rotatedHostBearer = rotatedHost.data.key;
  check('0j. host key rotation returns a new usable key',
    rotatedHost.response.status === 200 && typeof rotatedHostBearer === 'string');
  const rotatedWhoami = await request('GET', '/api/v2/whoami', rotatedHostBearer);
  check('0k. rotated host key authenticates',
    rotatedWhoami.response.status === 200 && rotatedWhoami.data.principal?.kind === 'host');
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
  const elevation = await request('POST', '/api/v2/keys', manageOnlyBearer, {
    label: 'rest-v2-elevation',
    scopes: ['moderate'],
  });
  console.log(`  attack privilege escalation: HTTP ${elevation.response.status}`);
  check('12. key:manage-only cannot mint moderate', elevation.response.status === 404);
  const createdKey = await request('POST', '/api/v2/keys', manageOnlyBearer, {
    label: 'rest-v2-created',
    scopes: ['key:manage'],
  });
  check('13. key:manage-only can mint a subset key',
    createdKey.response.status === 201 && typeof createdKey.data.key === 'string',
    JSON.stringify(createdKey.data));
  const otherPrincipalKey = await request('POST', '/api/v2/keys', manageOnlyBearer, {
    principal_id: otherPrincipalId,
    scopes: ['key:manage'],
  });
  console.log(`  attack issue-for-other-principal: HTTP ${otherPrincipalKey.response.status}`);
  check('14. issuing a key for another principal is hidden',
    otherPrincipalKey.response.status === 404,
    JSON.stringify(otherPrincipalKey.data));
  const otherList = await request(
    'GET',
    `/api/v2/keys?principal_id=${encodeURIComponent(otherPrincipalId)}`,
    manageOnlyBearer,
  );
  check('15. listing another principal keys is hidden', otherList.response.status === 404);
  const otherDelete = await request('DELETE', `/api/v2/keys/${otherReadKeyId}`, manageOnlyBearer);
  console.log(`  attack revoke-other-key: HTTP ${otherDelete.response.status}`);
  check('16. revoking another principal key is hidden', otherDelete.response.status === 404);
  const keyList = await request('GET', '/api/v2/keys', bearer);
  const createdKeyView = keyList.data.items?.find((item) => item.label === 'rest-v2-created');
  createdKeyId = createdKeyView?.id;
  check('17. GET /keys lists the created key without secret material',
    keyList.response.status === 200 && createdKeyView?.scopes?.includes('key:manage')
      && !('key' in (createdKeyView ?? {})) && !('key_hash' in (createdKeyView ?? {})),
    JSON.stringify(keyList.data));
  const revoked = await request('DELETE', `/api/v2/keys/${createdKeyId}`, manageOnlyBearer);
  check('18. DELETE /keys/:id revokes the created key',
    revoked.response.status === 200 && revoked.data.ok === true,
    JSON.stringify(revoked.data));
  const uploaded = await upload('rest-v2.txt', 'text/plain', 'rest v2 attachment', bearer);
  const attachmentId = uploaded.data.attachment_id;
  if (attachmentId) attachmentIds.push(attachmentId);
  check('19. POST /attachments uploads an attachment',
    uploaded.response.status === 201 && typeof attachmentId === 'string',
    JSON.stringify(uploaded.data));
  if (attachmentId) {
    const scan = await pollScanStatus(attachmentId);
    console.log(`  attachment scan transition: ${scan.statuses.join(' -> ')}`);
    check('20. uploaded attachment leaves pending scan state',
      scan.status === 'skipped',
      JSON.stringify(scan));
    const ownerDownload = await fetch(`${base}/api/v2/attachments/${attachmentId}`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    check('21. attachment owner can download', ownerDownload.status === 200);
    const unrelatedDownload = await fetch(`${base}/api/v2/attachments/${attachmentId}`, {
      headers: { authorization: `Bearer ${otherReadBearer}` },
    });
    console.log(`  attack non-owner unread attachment: HTTP ${unrelatedDownload.status}`);
    check('22. non-owner without a reference is hidden', unrelatedDownload.status === 404);

    const assigned = await request('POST', '/api/v2/tasks', bearer, {
      title: 'REST v2 attachment access task',
      body: 'assignee attachment access',
      visibility: 'private',
      deliverable_spec: { items: ['result'] },
      targets: [{ principal_id: otherPrincipalId, role: 'assignee' }],
    });
    const assignedTaskId = assigned.data.post_id;
    if (assignedTaskId) postIds.push(assignedTaskId);
    await request('POST', `/api/v2/tasks/${assignedTaskId}/claim`, otherTaskBearer);
    await request('POST', `/api/v2/tasks/${assignedTaskId}/submit`, otherTaskBearer, {
      deliverables: [{ name: 'result', attachment_id: attachmentId }],
    });
    const referencedDownload = await fetch(`${base}/api/v2/attachments/${attachmentId}`, {
      headers: { authorization: `Bearer ${otherReadBearer}` },
    });
    check('23. assignee can download a referenced deliverable', referencedDownload.status === 200);
  }
} catch (error) {
  failed += 1;
  console.error(`  FAIL acceptance aborted — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanup().catch((error) => console.error('REST v2 cleanup failed:', error.message));
}

console.log(`REST v2 write acceptance: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
