import type { PoolConnection } from 'mariadb';
import { getPool, withTransaction } from '../db/pool.js';
import { newId } from '../id.js';
import { recordEvent } from './event-outbox.js';

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'skipped' | 'error';

export interface Attachment {
  id: string;
  account_id: string;
  owner_principal_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  relative_path: string;
  scan_status: ScanStatus;
  created_at: string;
  deleted_at: string | null;
}

export interface CreateAttachmentInput {
  account_id: string;
  owner_principal_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  relative_path: string;
}

export interface Deliverable {
  id: string;
  post_id: string;
  name: string;
  version: number;
  attachment_id: string | null;
  note: string;
  current: boolean;
  created_at: string;
  attachment: Attachment | null;
}

interface DbRow {
  [key: string]: unknown;
}

function nowString(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function rows(result: unknown): DbRow[] {
  return Array.isArray(result) ? (result as DbRow[]) : [];
}

function stringValue(value: unknown): string {
  return String(value ?? '');
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

function booleanValue(value: unknown): boolean {
  return Number(value) === 1;
}

function attachmentFromRow(row: DbRow, prefix = ''): Attachment {
  return {
    id: stringValue(row[`${prefix}id`]),
    account_id: stringValue(row[`${prefix}account_id`]),
    owner_principal_id: stringValue(row[`${prefix}owner_principal_id`]),
    filename: stringValue(row[`${prefix}filename`]),
    mime: stringValue(row[`${prefix}mime`]),
    size_bytes: numberValue(row[`${prefix}size_bytes`]),
    sha256: stringValue(row[`${prefix}sha256`]),
    relative_path: stringValue(row[`${prefix}relative_path`]),
    scan_status: stringValue(row[`${prefix}scan_status`]) as ScanStatus,
    created_at: stringValue(row[`${prefix}created_at`]),
    deleted_at: nullableString(row[`${prefix}deleted_at`]),
  };
}

function deliverableFromRow(row: DbRow): Deliverable {
  return {
    id: stringValue(row.id),
    post_id: stringValue(row.post_id),
    name: stringValue(row.name),
    version: numberValue(row.version),
    attachment_id: nullableString(row.attachment_id),
    note: stringValue(row.note),
    current: booleanValue(row.current),
    created_at: stringValue(row.created_at),
    attachment: row.att_id === null || row.att_id === undefined
      ? null
      : attachmentFromRow(row, 'att_'),
  };
}

function attachmentSelect(): string {
  return `SELECT id, account_id, owner_principal_id, filename, mime, size_bytes,
                 sha256, relative_path, scan_status, created_at, deleted_at
            FROM attachment`;
}

async function attachmentByIdWithConnection(
  conn: PoolConnection,
  id: string,
  forUpdate = false,
): Promise<Attachment | null> {
  const result = await conn.query(
    `${attachmentSelect()} WHERE id = ? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows(result)[0];
  return row ? attachmentFromRow(row) : null;
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === 'ER_DUP_ENTRY' || Number(candidate.errno) === 1062;
}

export async function createAttachment(
  input: CreateAttachmentInput,
): Promise<{ attachment: Attachment; deduped: boolean }> {
  if (!input.account_id || !input.owner_principal_id) throw new Error('attachment owner is required');
  if (!input.filename) throw new Error('attachment filename is required');
  if (!Number.isFinite(input.size_bytes) || input.size_bytes < 0) {
    throw new Error('attachment size_bytes must be a non-negative number');
  }
  if (!input.sha256) throw new Error('attachment sha256 is required');
  return withTransaction(async (conn) => {
    const ownerRows = rows(await conn.query(
      `SELECT account_id
         FROM principal
        WHERE id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [input.owner_principal_id],
    ));
    if (!ownerRows[0]) throw new Error(`attachment owner not found: ${input.owner_principal_id}`);
    if (stringValue(ownerRows[0].account_id) !== input.account_id) {
      throw new Error('attachment owner belongs to another account');
    }

    const existingResult = await conn.query(
      `${attachmentSelect()}
        WHERE owner_principal_id = ? AND sha256 = ?
        LIMIT 1
        FOR UPDATE`,
      [input.owner_principal_id, input.sha256],
    );
    const existing = rows(existingResult)[0];
    if (existing) return { attachment: attachmentFromRow(existing), deduped: true };

    const id = newId('att');
    const createdAt = nowString();
    try {
      await conn.query(
        `INSERT INTO attachment
           (id, account_id, owner_principal_id, filename, mime, size_bytes,
            sha256, relative_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.account_id,
          input.owner_principal_id,
          input.filename,
          input.mime ?? '',
          input.size_bytes,
          input.sha256,
          input.relative_path,
          createdAt,
        ],
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const duplicateResult = await conn.query(
        `${attachmentSelect()}
          WHERE owner_principal_id = ? AND sha256 = ?
          LIMIT 1`,
        [input.owner_principal_id, input.sha256],
      );
      const duplicate = rows(duplicateResult)[0];
      if (!duplicate) throw error;
      return { attachment: attachmentFromRow(duplicate), deduped: true };
    }

    const attachment = await attachmentByIdWithConnection(conn, id);
    if (!attachment) throw new Error(`Attachment was not created: ${id}`);
    await recordEvent(conn, {
      account_id: input.account_id,
      actor_principal_id: input.owner_principal_id,
      action: 'attachment.created',
      resource_type: 'attachment',
      resource_id: id,
      after_state: {
        filename: input.filename,
        size_bytes: input.size_bytes,
        sha256: input.sha256,
      },
    });
    return { attachment, deduped: false };
  });
}

export async function getAttachment(id: string): Promise<Attachment | null> {
  const result = await getPool().query(`${attachmentSelect()} WHERE id = ? LIMIT 1`, [id]);
  const row = rows(result)[0];
  return row ? attachmentFromRow(row) : null;
}

export async function canReadAttachment(
  attachment: Attachment,
  principalId: string,
): Promise<boolean> {
  if (attachment.owner_principal_id === principalId) return true;
  const result = await getPool().query(
    `SELECT 1
       FROM deliverable d
       JOIN post p ON p.id = d.post_id
       LEFT JOIN post_task t ON t.post_id = p.id
      WHERE d.attachment_id = ?
        AND p.account_id = ?
        AND p.deleted_at IS NULL
        AND (
          p.author_principal_id = ?
          OR t.assignee_principal_id = ?
          OR EXISTS (
            SELECT 1
              FROM post_target pt
             WHERE pt.post_id = p.id
               AND pt.principal_id = ?
          )
        )
      LIMIT 1`,
    [
      attachment.id,
      attachment.account_id,
      principalId,
      principalId,
      principalId,
    ],
  );
  return rows(result).length > 0;
}

export async function listAttachments(input: {
  owner_principal_id?: string;
  page?: number;
  page_size?: number;
} = {}): Promise<{ items: Attachment[]; total: number; page: number; page_size: number }> {
  const page = Math.max(1, Math.floor(input.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.floor(input.page_size ?? 20) || 20));
  const predicates = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (input.owner_principal_id) {
    predicates.push('owner_principal_id = ?');
    params.push(input.owner_principal_id);
  }
  const where = ` WHERE ${predicates.join(' AND ')}`;
  const countResult = await getPool().query(`SELECT COUNT(*) AS total FROM attachment${where}`, params);
  const result = await getPool().query(
    `${attachmentSelect()}${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return {
    items: rows(result).map((row) => attachmentFromRow(row)),
    total: numberValue(rows(countResult)[0]?.total),
    page,
    page_size: pageSize,
  };
}

export async function quotaUsage(ownerPrincipalId: string): Promise<{ bytes: number; count: number }> {
  const result = await getPool().query(
    `SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS count
       FROM attachment
      WHERE owner_principal_id = ? AND deleted_at IS NULL`,
    [ownerPrincipalId],
  );
  const row = rows(result)[0];
  return {
    bytes: numberValue(row?.bytes),
    count: numberValue(row?.count),
  };
}

export async function markScanStatus(
  id: string,
  status: ScanStatus,
  expectedStatus?: ScanStatus,
): Promise<Attachment> {
  if (!['pending', 'clean', 'infected', 'skipped', 'error'].includes(status)) {
    throw new Error(`Unknown scan status: ${status}`);
  }
  return withTransaction(async (conn) => {
    const before = await attachmentByIdWithConnection(conn, id, true);
    if (!before) throw new Error(`Attachment not found: ${id}`);
    const update = expectedStatus === undefined
      ? await conn.query(
        `UPDATE attachment
            SET scan_status = ?
          WHERE id = ? AND deleted_at IS NULL`,
        [status, id],
      )
      : await conn.query(
        `UPDATE attachment
            SET scan_status = ?
          WHERE id = ? AND scan_status = ? AND deleted_at IS NULL`,
        [status, id, expectedStatus],
      );
    if (Number((update as { affectedRows?: number }).affectedRows ?? 0) === 0) {
      return before;
    }
    await recordEvent(conn, {
      account_id: before.account_id,
      actor_principal_id: before.owner_principal_id,
      action: 'attachment.scan_status_changed',
      resource_type: 'attachment',
      resource_id: id,
      before_state: { scan_status: before.scan_status },
      after_state: { scan_status: status },
    });
    const attachment = await attachmentByIdWithConnection(conn, id);
    if (!attachment) throw new Error(`Attachment not found after scan update: ${id}`);
    return attachment;
  });
}

export async function softDeleteAttachment(id: string): Promise<void> {
  await withTransaction(async (conn) => {
    const before = await attachmentByIdWithConnection(conn, id, true);
    if (!before) throw new Error(`Attachment not found: ${id}`);
    if (before.deleted_at) return;
    const deletedAt = nowString();
    await conn.query(`UPDATE attachment SET deleted_at = ? WHERE id = ?`, [deletedAt, id]);
    await recordEvent(conn, {
      account_id: before.account_id,
      actor_principal_id: before.owner_principal_id,
      action: 'attachment.deleted',
      resource_type: 'attachment',
      resource_id: id,
      before_state: { deleted_at: null },
      after_state: { deleted_at: deletedAt },
    });
  });
}

async function deliverableRows(
  conn: PoolConnection | null,
  postId: string,
  name?: string,
): Promise<Deliverable[]> {
  const sql = `SELECT d.id, d.post_id, d.name, d.version, d.attachment_id, d.note,
                      d.current, d.created_at,
                      a.id AS att_id, a.account_id AS att_account_id,
                      a.owner_principal_id AS att_owner_principal_id,
                      a.filename AS att_filename, a.mime AS att_mime,
                      a.size_bytes AS att_size_bytes, a.sha256 AS att_sha256,
                      a.relative_path AS att_relative_path,
                      a.scan_status AS att_scan_status, a.created_at AS att_created_at,
                      a.deleted_at AS att_deleted_at
                 FROM deliverable d
                 LEFT JOIN attachment a ON a.id = d.attachment_id AND a.deleted_at IS NULL
                WHERE d.post_id = ?${name === undefined ? '' : ' AND d.name = ?'}
                ORDER BY d.name, d.version`;
  const params = name === undefined ? [postId] : [postId, name];
  const result = conn ? await conn.query(sql, params) : await getPool().query(sql, params);
  return rows(result).map(deliverableFromRow);
}

interface CreateDeliverableInput {
  post_id: string;
  name: string;
  attachment_id?: string | null;
  note?: string;
}

async function createDeliverableWithConnection(
  conn: PoolConnection,
  input: CreateDeliverableInput,
): Promise<Deliverable> {
  if (!input.post_id || !input.name) throw new Error('deliverable post_id and name are required');
  const postResult = await conn.query(
    `SELECT account_id, author_principal_id
       FROM post
      WHERE id = ?
      LIMIT 1
      FOR UPDATE`,
    [input.post_id],
  );
  const post = rows(postResult)[0];
  if (!post) throw new Error(`Post not found: ${input.post_id}`);

  if (input.attachment_id) {
    const attachmentResult = await conn.query(
      `SELECT account_id, owner_principal_id, deleted_at
         FROM attachment
        WHERE id = ?
        LIMIT 1`,
      [input.attachment_id],
    );
    const attachment = rows(attachmentResult)[0];
    if (!attachment) throw new Error(`Attachment not found: ${input.attachment_id}`);
    if (attachment.deleted_at) throw new Error(`Attachment is deleted: ${input.attachment_id}`);
    if (stringValue(attachment.account_id) !== stringValue(post.account_id)) {
      throw new Error('deliverable attachment belongs to another account');
    }
    const ownerResult = await conn.query(
      `SELECT account_id
         FROM principal
        WHERE id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [attachment.owner_principal_id],
    );
    if (stringValue(rows(ownerResult)[0]?.account_id) !== stringValue(post.account_id)) {
      throw new Error('deliverable attachment owner belongs to another account');
    }
  }

  const versionResult = await conn.query(
    `SELECT COALESCE(MAX(version), 0) AS version
       FROM deliverable
      WHERE post_id = ? AND name = ?
      FOR UPDATE`,
    [input.post_id, input.name],
  );
  const version = numberValue(rows(versionResult)[0]?.version) + 1;
  await conn.query(
    `UPDATE deliverable
        SET current = 0
      WHERE post_id = ? AND name = ? AND current = 1`,
    [input.post_id, input.name],
  );
  const id = newId('dlv');
  await conn.query(
    `INSERT INTO deliverable
       (id, post_id, name, version, attachment_id, note, current, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      id,
      input.post_id,
      input.name,
      version,
      input.attachment_id ?? null,
      input.note ?? '',
      nowString(),
    ],
  );
  await recordEvent(conn, {
    account_id: stringValue(post.account_id),
    actor_principal_id: stringValue(post.author_principal_id),
    action: 'deliverable.created',
    resource_type: 'deliverable',
    resource_id: id,
    after_state: { post_id: input.post_id, name: input.name, version },
  });
  const deliverables = await deliverableRows(conn, input.post_id, input.name);
  const deliverable = deliverables.find((item) => item.id === id);
  if (!deliverable) throw new Error(`Deliverable was not created: ${id}`);
  return deliverable;
}

export function createDeliverable(input: CreateDeliverableInput): Promise<Deliverable>;
export function createDeliverable(conn: PoolConnection, input: CreateDeliverableInput): Promise<Deliverable>;
export async function createDeliverable(
  connOrInput: PoolConnection | CreateDeliverableInput,
  maybeInput?: CreateDeliverableInput,
): Promise<Deliverable> {
  if (maybeInput) {
    return createDeliverableWithConnection(connOrInput as PoolConnection, maybeInput);
  }
  return withTransaction((conn) =>
    createDeliverableWithConnection(conn, connOrInput as CreateDeliverableInput));
}

export async function listDeliverables(postId: string): Promise<Deliverable[]> {
  return deliverableRows(null, postId);
}

export async function getCurrentDeliverable(
  postId: string,
  name: string,
): Promise<Deliverable | null> {
  const deliverables = await deliverableRows(null, postId, name);
  return deliverables.find((deliverable) => deliverable.current) ?? null;
}

export { getPool };
