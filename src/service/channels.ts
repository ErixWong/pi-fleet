import type { PoolConnection } from 'mariadb';
import { getPool, withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../util/errors.js';
import { normalizeHomeWorkdir } from '../util/workdir.js';
import { recordEvent } from './event-outbox.js';
import { getSettingInt } from './new-settings.js';
import {
  createPost,
  replyPost,
  type Post,
} from './posts.js';

interface DbRow {
  [key: string]: unknown;
}

export interface ChannelMessage {
  id: string;
  author_principal_id: string;
  author: { id: string; name: string } | null;
  body: string;
  created_at: string;
}

export interface ChannelSummary {
  id: string;
  title: string;
  workdir: string | null;
  revision: number;
  last_activity_at: string;
  host: {
    id: string;
    name: string;
    online: boolean;
  };
  last_message: ChannelMessage | null;
  message_count: number;
}

export interface ChannelMessagesResult {
  items: ChannelMessage[];
  next_after: string | null;
  has_more: boolean;
}

function rows(result: unknown): DbRow[] {
  return Array.isArray(result) ? result as DbRow[] : [];
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

function nowString(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function online(lastSeen: string | null, offlineAfterMin: number): boolean {
  if (!lastSeen) return false;
  const seen = new Date(lastSeen).getTime();
  return Number.isFinite(seen) && Date.now() - seen <= offlineAfterMin * 60 * 1000;
}

function messageFromRow(row: DbRow, prefix = ''): ChannelMessage {
  const authorId = row[`${prefix}author_id`] ?? row.author_id;
  return {
    id: stringValue(row[`${prefix}id`] ?? row.id),
    author_principal_id: stringValue(row[`${prefix}author_principal_id`] ?? row.author_principal_id),
    author: authorId === null || authorId === undefined
      ? null
      : {
          id: stringValue(authorId),
          name: stringValue(row[`${prefix}author_name`] ?? row.author_name),
        },
    body: stringValue(row[`${prefix}body`] ?? row.body),
    created_at: stringValue(row[`${prefix}created_at`] ?? row.created_at),
  };
}

function channelFromRow(row: DbRow, offlineAfterMin: number): ChannelSummary {
  const lastMessage = row.last_message_id === null || row.last_message_id === undefined
    ? null
    : messageFromRow({
        id: row.last_message_id,
        author_principal_id: row.last_message_author_principal_id,
        author_id: row.last_message_author_id,
        author_name: row.last_message_author_name,
        body: row.last_message_body,
        created_at: row.last_message_created_at,
      });
  return {
    id: stringValue(row.id),
    title: stringValue(row.title),
    workdir: nullableString(row.workdir),
    revision: numberValue(row.revision),
    last_activity_at: stringValue(row.last_activity_at ?? row.created_at),
    host: {
      id: stringValue(row.host_id),
      name: stringValue(row.host_name),
      online: online(nullableString(row.host_last_seen_at), offlineAfterMin),
    },
    last_message: lastMessage,
    message_count: numberValue(row.message_count),
  };
}

async function channelRow(
  conn: PoolConnection,
  accountId: string,
  principalId: string,
  channelId: string,
  forUpdate = false,
): Promise<DbRow | null> {
  const result = await conn.query(
    `SELECT c.id, c.account_id, c.title, c.author_principal_id, c.revision,
            ch.host_principal_id, ch.status,
            ch.workdir,
            hp.name AS host_name
       FROM post c
       JOIN post_channel ch ON ch.post_id = c.id
       JOIN principal hp ON hp.id = ch.host_principal_id
      WHERE c.id = ?
        AND c.account_id = ?
        AND c.kind = 'channel'
        AND c.visibility = 'private'
        AND c.deleted_at IS NULL
        AND hp.deleted_at IS NULL
        AND ch.status = 'open'
        AND (c.author_principal_id = ? OR ch.host_principal_id = ?)
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [channelId, accountId, principalId, principalId],
  );
  return rows(result)[0] ?? null;
}

async function channelSummaryById(
  channelId: string,
  accountId: string,
  principalId: string,
): Promise<ChannelSummary | null> {
  const pool = getPool();
  const offlineAfterMin = getSettingInt('agent_offline_after_min', 30);
  const result = await pool.query(
    `SELECT c.id, c.title, c.created_at, c.revision, ch.workdir,
            hp.id AS host_id, hp.name AS host_name, d.last_seen_at AS host_last_seen_at,
            lm.id AS last_message_id,
            lm.author_principal_id AS last_message_author_principal_id,
            lp.id AS last_message_author_id,
            lp.name AS last_message_author_name,
            lm.body AS last_message_body,
            lm.created_at AS last_message_created_at,
            COALESCE(lm.created_at, c.created_at) AS last_activity_at,
            (
              SELECT COUNT(*)
                FROM post m
               WHERE m.parent_id = c.id
                 AND m.root_id = c.id
                 AND m.kind = 'message'
                 AND m.deleted_at IS NULL
            ) AS message_count
       FROM post c
       JOIN post_channel ch ON ch.post_id = c.id
       JOIN principal hp ON hp.id = ch.host_principal_id AND hp.deleted_at IS NULL
       LEFT JOIN device d ON d.principal_id = hp.id
       LEFT JOIN post lm
         ON lm.id = (
           SELECT m2.id
             FROM post m2
            WHERE m2.parent_id = c.id
              AND m2.root_id = c.id
              AND m2.kind = 'message'
              AND m2.deleted_at IS NULL
            ORDER BY m2.id DESC
            LIMIT 1
         )
       LEFT JOIN principal lp ON lp.id = lm.author_principal_id
      WHERE c.id = ?
        AND c.account_id = ?
        AND c.kind = 'channel'
        AND c.visibility = 'private'
        AND c.deleted_at IS NULL
        AND ch.status = 'open'
        AND (c.author_principal_id = ? OR ch.host_principal_id = ?)
      LIMIT 1`,
    [channelId, accountId, principalId, principalId],
  );
  const row = rows(result)[0];
  return row ? channelFromRow(row, offlineAfterMin) : null;
}

export async function createOrGetChannel(input: {
  account_id: string;
  principal_id: string;
  host_principal_id: string;
  workdir: string;
  title?: string;
}): Promise<ChannelSummary> {
  const workdir = normalizeHomeWorkdir(input.workdir);
  if (!workdir) throw badRequest('workdir is required and must be under ~');

  const channelId = await withTransaction(async (conn) => {
    const hostResult = await conn.query(
      `SELECT id, name
         FROM principal
        WHERE id = ? AND account_id = ? AND kind = 'host' AND deleted_at IS NULL
        LIMIT 1
        FOR UPDATE`,
      [input.host_principal_id, input.account_id],
    );
    const host = rows(hostResult)[0];
    if (!host) throw notFound('host not found');

    const title = input.title?.trim() || `与 ${stringValue(host.name)}`;
    if (title.length > 512) throw badRequest('title must be at most 512 characters');
    const post = await createPost(conn, {
      account_id: input.account_id,
      kind: 'channel',
      author_principal_id: input.principal_id,
      title,
      body: '',
      visibility: 'private',
      channel: { host_principal_id: input.host_principal_id, workdir },
    });
    return post.id;
  });

  const channel = await channelSummaryById(channelId, input.account_id, input.principal_id);
  if (!channel) throw new Error(`Channel was not created: ${channelId}`);
  return channel;
}

export async function listChannels(
  accountId: string,
  principalId: string,
): Promise<ChannelSummary[]> {
  const result = await getPool().query(
    `SELECT c.id, c.title, c.created_at, c.revision, ch.workdir,
            hp.id AS host_id, hp.name AS host_name, d.last_seen_at AS host_last_seen_at,
            lm.id AS last_message_id,
            lm.author_principal_id AS last_message_author_principal_id,
            lp.id AS last_message_author_id,
            lp.name AS last_message_author_name,
            lm.body AS last_message_body,
            lm.created_at AS last_message_created_at,
            COALESCE(lm.created_at, c.created_at) AS last_activity_at,
            (
              SELECT COUNT(*)
                FROM post m
               WHERE m.parent_id = c.id
                 AND m.root_id = c.id
                 AND m.kind = 'message'
                 AND m.deleted_at IS NULL
            ) AS message_count
       FROM post c
       JOIN post_channel ch ON ch.post_id = c.id
       JOIN principal hp ON hp.id = ch.host_principal_id AND hp.deleted_at IS NULL
       LEFT JOIN device d ON d.principal_id = hp.id
       LEFT JOIN post lm
         ON lm.id = (
           SELECT m2.id
             FROM post m2
            WHERE m2.parent_id = c.id
              AND m2.root_id = c.id
              AND m2.kind = 'message'
              AND m2.deleted_at IS NULL
            ORDER BY m2.id DESC
            LIMIT 1
         )
       LEFT JOIN principal lp ON lp.id = lm.author_principal_id
      WHERE c.account_id = ?
        AND c.kind = 'channel'
        AND c.visibility = 'private'
        AND c.deleted_at IS NULL
        AND ch.status = 'open'
        AND (c.author_principal_id = ? OR ch.host_principal_id = ?)
      ORDER BY COALESCE(lm.id, c.id) DESC, c.id DESC`,
    [accountId, principalId, principalId],
  );
  const offlineAfterMin = getSettingInt('agent_offline_after_min', 30);
  return rows(result).map((row) => channelFromRow(row, offlineAfterMin));
}

export async function getChannel(
  accountId: string,
  principalId: string,
  channelId: string,
): Promise<ChannelSummary | null> {
  return channelSummaryById(channelId, accountId, principalId);
}

export async function resetChannelSession(input: {
  account_id: string;
  principal_id: string;
  channel_id: string;
}): Promise<ChannelSummary> {
  await withTransaction(async (conn) => {
    const channel = await channelRow(
      conn,
      input.account_id,
      input.principal_id,
      input.channel_id,
      true,
    );
    if (!channel) throw notFound('channel not found');
    const editedAt = nowString();
    await conn.query(
      `UPDATE post
          SET revision = revision + 1, edited_at = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [editedAt, input.channel_id],
    );
    await recordEvent(conn, {
      account_id: input.account_id,
      actor_principal_id: input.principal_id,
      action: 'channel.session_reset',
      resource_type: 'post',
      resource_id: input.channel_id,
      after_state: { edited_at: editedAt },
    });
  });

  const channel = await channelSummaryById(
    input.channel_id,
    input.account_id,
    input.principal_id,
  );
  if (!channel) throw new Error(`Channel was not found after reset: ${input.channel_id}`);
  return channel;
}

export async function listChannelMessages(input: {
  account_id: string;
  principal_id: string;
  channel_id: string;
  after?: string;
  limit?: number;
}): Promise<ChannelMessagesResult> {
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 100)));
  if (!Number.isInteger(limit)) throw badRequest('limit must be an integer');
  const channel = await getPool().query(
    `SELECT c.id
       FROM post c
       JOIN post_channel ch ON ch.post_id = c.id
       JOIN principal hp ON hp.id = ch.host_principal_id AND hp.deleted_at IS NULL
      WHERE c.id = ?
        AND c.account_id = ?
        AND c.kind = 'channel'
        AND c.visibility = 'private'
        AND c.deleted_at IS NULL
        AND ch.status = 'open'
        AND (c.author_principal_id = ? OR ch.host_principal_id = ?)
      LIMIT 1`,
    [input.channel_id, input.account_id, input.principal_id, input.principal_id],
  );
  if (rows(channel).length === 0) throw notFound('channel not found');

  const params: unknown[] = [input.channel_id, input.channel_id];
  let pagination: string;
  if (input.after) {
    pagination = ' AND m.id > ? ORDER BY m.id ASC LIMIT ?';
    params.push(input.after, limit + 1);
  } else {
    pagination = ' ORDER BY m.id DESC LIMIT ?';
    params.push(limit);
  }
  const result = await getPool().query(
    `SELECT m.id, m.author_principal_id, m.body, m.created_at,
            p.id AS author_id, p.name AS author_name
       FROM post m
       JOIN principal p ON p.id = m.author_principal_id
      WHERE m.parent_id = ?
        AND m.root_id = ?
        AND m.kind = 'message'
        AND m.deleted_at IS NULL${pagination}`,
    params,
  );
  let messageRows = rows(result);
  const hasMore = Boolean(input.after && messageRows.length > limit);
  if (!input.after) messageRows = messageRows.reverse();
  if (hasMore) messageRows = messageRows.slice(0, limit);
  const items = messageRows.map((row) => messageFromRow(row));
  return {
    items,
    next_after: items.length > 0 ? items[items.length - 1].id : input.after ?? null,
    has_more: hasMore,
  };
}

export async function sendChannelMessage(input: {
  account_id: string;
  principal_id: string;
  channel_id: string;
  body: string;
}): Promise<Post> {
  if (!input.body.trim()) throw badRequest('body must not be empty');
  return withTransaction(async (conn) => {
    const channel = await channelRow(
      conn,
      input.account_id,
      input.principal_id,
      input.channel_id,
      true,
    );
    if (!channel) throw notFound('channel not found');
    return replyPost(conn, {
      parent_id: input.channel_id,
      author_principal_id: input.principal_id,
      body: input.body,
    });
  });
}

export async function canAccessChannel(
  accountId: string,
  principalId: string,
  channelId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT c.id
       FROM post c
       JOIN post_channel ch ON ch.post_id = c.id
       JOIN principal hp ON hp.id = ch.host_principal_id AND hp.deleted_at IS NULL
      WHERE c.id = ?
        AND c.account_id = ?
        AND c.kind = 'channel'
        AND c.visibility = 'private'
        AND c.deleted_at IS NULL
        AND ch.status = 'open'
        AND (c.author_principal_id = ? OR ch.host_principal_id = ?)
      LIMIT 1`,
    [channelId, accountId, principalId, principalId],
  );
  return rows(result).length > 0;
}
