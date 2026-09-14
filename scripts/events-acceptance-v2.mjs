import 'dotenv/config';
import crypto from 'node:crypto';
import { createPool } from 'mariadb';
import { tsImport } from 'tsx/esm/api';

const base = process.env.TEST_BASE ?? 'http://127.0.0.1:3000';
const dbOptions = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  dateStrings: true,
};
const db = createPool({ ...dbOptions, database: process.env.DB_NAME_NEW ?? 'erix', connectionLimit: 3 });
const legacyDb = createPool({ ...dbOptions, database: process.env.DB_NAME ?? 'task_dispatch', connectionLimit: 1 });
const id = (prefix) => `${prefix}_evt${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const key = () => `pk-${crypto.randomBytes(24).toString('base64url')}`;
const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const closePool = (pool) => Promise.race([pool.end(), wait(3000)]);
let principalId;
let keyId;
let bearer;
const eventIds = [];
let passed = 0;
let failed = 0;
let legacyEventCount;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function apiEvents() {
  const response = await fetch(`${base}/api/v2/events?limit=20`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  return { response, data: await response.json().catch(() => ({})) };
}

async function createFixture() {
  const accounts = await db.query(`SELECT id FROM account WHERE deleted_at IS NULL ORDER BY id LIMIT 1`);
  if (accounts.length === 0) throw new Error('erix has no active account');
  principalId = id('prn');
  keyId = id('key');
  bearer = key();
  await db.query(
    `INSERT INTO principal (id, account_id, kind, name, created_at)
     VALUES (?, ?, 'service', ?, ?)`,
    [principalId, accounts[0].id, `event-v2-${principalId}`, now()],
  );
  await db.query(
    `INSERT INTO api_key (id, principal_id, key_hash, label, scopes, created_at)
     VALUES (?, ?, ?, 'event-v2', ?, ?)`,
    [keyId, principalId, hash(bearer), JSON.stringify(['post:read']), now()],
  );
  return String(accounts[0].id);
}

async function cleanup() {
  if (eventIds.length > 0) {
    await db.query(`DELETE FROM event WHERE id IN (${eventIds.map(() => '?').join(', ')})`, eventIds);
  }
  if (keyId) await db.query(`DELETE FROM api_key WHERE id = ?`, [keyId]);
  if (principalId) await db.query(`DELETE FROM principal WHERE id = ?`, [principalId]);
  await closePool(db);
  await closePool(legacyDb);
  await closePool(eventOutbox.getPool());
}

const eventOutbox = await tsImport('../src/service/event-outbox.ts', import.meta.url);
const worker = await tsImport('../src/service/outbox-worker.ts', import.meta.url);
const { getPool, initSchema, recordEvent, publishPending, markFailed } = eventOutbox;
const { runOnce } = worker;

try {
  const accountId = await createFixture();
  await initSchema();
  legacyEventCount = Number((await legacyDb.query(`SELECT COUNT(*) AS count FROM events`))[0]?.count ?? 0);
  const prefix = `acceptance.events.${Date.now().toString(36)}`;
  const createEvent = async (suffix, resourceType = `acceptance-${suffix}`) => {
    const eventId = await eventOutbox.withTransaction((conn) => recordEvent(conn, {
      account_id: accountId,
      actor_principal_id: principalId,
      action: `${prefix}.${suffix}`,
      resource_type: resourceType,
      resource_id: id('res'),
      payload: { suffix },
    }));
    eventIds.push(eventId);
    return eventId;
  };

  console.log('== event log and outbox acceptance ==');
  await createEvent('log', 'acceptance-log');
  const listed = await apiEvents();
  check('1. GET /api/v2/events returns the new event shape',
    listed.response.status === 200 && Array.isArray(listed.data.items)
      && listed.data.items.every((event) => 'action' in event && 'occurred_at' in event),
    JSON.stringify(listed.data));

  const crashId = await createEvent('crash');
  const firstLease = await publishPending({ actionPrefix: prefix, resourceType: 'acceptance-crash', limit: 1, leaseMs: 5000 });
  const crashEvent = firstLease.find((event) => event.id === crashId);
  const leasedRow = await getPool().query(
    `SELECT published_at, attempts, next_attempt_at FROM event WHERE id = ?`,
    [crashId],
  );
  check('2. publishPending claims with a lease without publishing',
    Boolean(crashEvent) && leasedRow[0].published_at === null
      && Number(leasedRow[0].attempts) === 1 && leasedRow[0].next_attempt_at !== null,
    JSON.stringify(leasedRow[0]));
  await wait(100);
  await db.query(`UPDATE event SET next_attempt_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?`, [crashId]);
  const secondLease = await publishPending({ actionPrefix: prefix, resourceType: 'acceptance-crash', limit: 1, leaseMs: 5000 });
  check('3. an expired lease can be claimed by another worker',
    secondLease.some((event) => event.id === crashId),
    JSON.stringify(secondLease.map((event) => event.id)));
  const crashLease = secondLease.find((event) => event.id === crashId);
  if (crashLease) {
    await markFailed(
      crashId,
      'simulated crashed worker recovered',
      now(),
      { attempts: crashLease.attempts, next_attempt_at: crashLease.next_attempt_at },
    );
  }

  const successId = await createEvent('success');
  let delivered = 0;
  const successCount = await runOnce({
    actionPrefix: prefix,
    resourceType: 'acceptance-success',
    batch: 1,
    leaseMs: 5000,
    deliver: async (event) => {
      if (event.id === successId) delivered += 1;
      return { ok: true };
    },
  });
  const successRow = await getPool().query(
    `SELECT published_at, next_attempt_at FROM event WHERE id = ?`,
    [successId],
  );
  check('4. successful worker delivery sets published_at',
    successCount === 1 && delivered === 1 && successRow[0].published_at !== null
      && successRow[0].next_attempt_at === null,
    JSON.stringify(successRow[0]));

  const failureId = await createEvent('failure');
  await runOnce({
    actionPrefix: prefix,
    resourceType: 'acceptance-failure',
    batch: 1,
    leaseMs: 5000,
    deliver: async () => ({ ok: false, error: 'injected failure' }),
  });
  const failureRow = await getPool().query(
    `SELECT published_at, attempts, next_attempt_at, last_error FROM event WHERE id = ?`,
    [failureId],
  );
  check('5. failed worker delivery is retryable and conditional',
    failureRow[0].published_at === null && Number(failureRow[0].attempts) === 1
      && failureRow[0].next_attempt_at !== null && failureRow[0].last_error === 'injected failure',
    JSON.stringify(failureRow[0]));
  const legacyAfter = Number((await legacyDb.query(`SELECT COUNT(*) AS count FROM events`))[0]?.count ?? 0);
  check('6. v2 writes do not append to the legacy events table', legacyAfter === legacyEventCount);
  console.log(`event log/outbox acceptance: ${passed} passed, ${failed} failed`);
} catch (error) {
  failed += 1;
  console.error(`  FAIL acceptance aborted — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanup().catch((error) => console.error('events v2 cleanup failed:', error.message));
}

process.exit(failed > 0 ? 1 : 0);
