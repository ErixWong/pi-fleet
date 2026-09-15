import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hasScopes } from '../auth-principal.js';
import {
  addTarget,
  createPost,
  deletePost,
  editPost,
  getSummary,
  getPostDetail,
  listPosts,
  removeTarget,
  replyPost,
  type ListPostsFilter,
  type Post,
  type PostDetail,
  type PostTask,
} from '../service/posts.js';
import { publishTask } from '../service/task-flow.js';
import { canReadAttachment, type Attachment } from '../service/resources.js';
import {
  mcpPrincipal,
  guardScope,
  ScopeDenied,
  toolFailure,
  toolOk,
  toolErr,
  type ToolResult,
} from './context.js';

const POST_KINDS = ['note', 'task', 'message', 'verdict', 'channel'] as const;
const VISIBILITIES = ['private', 'account', 'public'] as const;
const TARGET_ROLES = ['assignee', 'mention', 'watcher'] as const;

export interface PublicPrincipal {
  id: string;
  kind: string;
  name: string;
}

export interface PublicPost {
  id: string;
  kind: Post['kind'];
  subtype: string;
  title: string;
  body: string;
  visibility: Post['visibility'];
  author_principal_id: string;
  author: PublicPrincipal | null;
  root_id: string;
  parent_id: string | null;
  revision: number;
  reply_count: number;
  created_at: string;
  edited_at: string | null;
}

export interface PublicTask {
  status: PostTask['status'];
  is_ready: boolean;
  deliverable_spec: string;
  attempts: number;
  max_attempts: number;
  executor: string | null;
  workdir: string | null;
  assignee_principal_id: string | null;
  claimed_at: string | null;
  closed_at: string | null;
}

function publicPrincipal(value: {
  id: string;
  kind: string;
  name: string;
} | null | undefined): PublicPrincipal | null {
  if (!value) return null;
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
  };
}

export function publicPost(post: Post): PublicPost {
  return {
    id: post.id,
    kind: post.kind,
    subtype: post.subtype,
    title: post.title,
    body: post.body,
    visibility: post.visibility,
    author_principal_id: post.author_principal_id,
    author: publicPrincipal(post.author),
    root_id: post.root_id,
    parent_id: post.parent_id,
    revision: post.revision,
    reply_count: post.reply_count,
    created_at: post.created_at,
    edited_at: post.edited_at,
  };
}

export function publicTask(task: PostTask): PublicTask {
  return {
    status: task.status,
    is_ready: task.is_ready,
    deliverable_spec: task.deliverable_spec,
    attempts: task.attempts,
    max_attempts: task.max_attempts,
    executor: task.executor,
    workdir: task.workdir,
    assignee_principal_id: task.assignee_principal_id,
    claimed_at: task.claimed_at,
    closed_at: task.closed_at,
  };
}

export function publicTarget(target: PostDetail['targets'][number]): Record<string, unknown> {
  return {
    principal: publicPrincipal(target.principal),
    role: target.role,
    read_at: target.read_at,
  };
}

function publicDeliverable(deliverable: Record<string, unknown>): Record<string, unknown> {
  const attachment = deliverable.attachment;
  const attachmentView = attachment && typeof attachment === 'object'
    ? attachment as Record<string, unknown>
    : null;
  return {
    name: String(deliverable.name ?? ''),
    version: Number(deliverable.version ?? 0),
    current: Boolean(deliverable.current),
    note: String(deliverable.note ?? ''),
    attachment: attachmentView
      ? {
          id: String(attachmentView.id ?? ''),
          filename: String(attachmentView.filename ?? ''),
          mime: String(attachmentView.mime ?? ''),
          size_bytes: Number(attachmentView.size_bytes ?? 0),
          sha256: String(attachmentView.sha256 ?? ''),
          scan_status: String(attachmentView.scan_status ?? ''),
        }
      : null,
  };
}

function truncateBody(body: string): string {
  return body.length > 500 ? `${body.slice(0, 499)}…` : body;
}

function publicRecent(post: Post): Record<string, unknown> {
  return {
    id: post.id,
    parent_id: post.parent_id,
    subtype: post.subtype,
    author: post.author
      ? { id: post.author.id, name: post.author.name }
      : null,
    created_at: post.created_at,
    body: truncateBody(post.body),
  };
}

export function presentPostDetail(detail: PostDetail): Record<string, unknown> {
  const task = detail.post.kind === 'task' && detail.task
    ? publicTask(detail.task)
    : null;
  const channel = detail.post.kind === 'channel' && detail.channel
    ? {
        host_principal_id: detail.channel.host_principal_id,
        workdir: detail.channel.workdir,
        run_user: detail.channel.run_user,
        name: detail.channel.name,
        status: detail.channel.status,
      }
    : null;
  return {
    post: publicPost(detail.post),
    targets: detail.targets.map(publicTarget),
    task,
    channel,
    deliverables: detail.deliverables.map(publicDeliverable),
    verdicts: detail.verdicts.map((verdict) => ({
      post_id: verdict.post_id,
      decision: verdict.decision,
      opinion: verdict.opinion,
      target_task_id: verdict.target_task_id,
      attempt_no: verdict.attempt_no,
      source: verdict.source,
    })),
    summary: detail.summary
      ? {
          text: detail.summary.summary,
          up_to_post_id: detail.summary.up_to_post_id,
          revision: detail.summary.revision,
          stale: detail.summary.stale,
          pending: detail.summary.pending,
        }
      : null,
    recent: detail.recent.map(publicRecent),
    more: {
      count: detail.more.count,
      hint: detail.more.hint,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function applyRecentOptions(
  detail: Record<string, unknown>,
  options: { include_recent?: boolean; recent_limit?: number },
): void {
  if (!Array.isArray(detail.recent)) return;
  const originalLength = detail.recent.length;
  if (options.include_recent === false) {
    detail.recent = [];
  } else if (options.recent_limit !== undefined) {
    detail.recent = detail.recent.slice(0, options.recent_limit);
  }
  const visibleLength = Array.isArray(detail.recent) ? detail.recent.length : 0;
  const more = asRecord(detail.more);
  if (more && Number.isFinite(Number(more.count))) {
    detail.more = {
      ...more,
      count: Math.max(0, Number(more.count) + originalLength - visibleLength),
    };
  }
}

export async function readPostDetail(
  id: string,
  accountId: string,
  principalId: string,
): Promise<Record<string, unknown> | null> {
  const detail = await getPostDetail(id);
  if (!detail || detail.post.deleted_at || detail.post.account_id !== accountId) return null;
  const deliverables = await Promise.all(detail.deliverables.map(async (deliverable) => {
    const attachment = deliverable.attachment;
    if (!attachment || typeof attachment !== 'object') return deliverable;
    const readable = await canReadAttachment(attachment as Attachment, principalId);
    return readable ? deliverable : { ...deliverable, attachment: null };
  }));
  return presentPostDetail({ ...detail, deliverables });
}

export async function readPostList(
  filter: ListPostsFilter,
): Promise<{ items: PublicPost[]; total: number; next_after: string | null }> {
  const result = await listPosts(filter);
  const items = result.items.map(publicPost);
  return {
    items,
    total: result.total,
    next_after: items.length > 0 ? items[items.length - 1].id : null,
  };
}

export function presentTaskListItem(item: {
  post: Post;
  task: PostTask;
  targets?: PostDetail['targets'];
}): Record<string, unknown> {
  return {
    ...publicPost(item.post),
    task: publicTask(item.task),
    targets: (item.targets ?? []).map(publicTarget),
  };
}

export function registerPostTools(server: McpServer): void {
  server.tool(
    'post',
    'Read and write structured posts.',
    {
      action: z.string(),
      id: z.string().optional(),
      root_id: z.string().optional(),
      parent_id: z.string().nullable().optional(),
      body: z.string().optional(),
      title: z.string().optional(),
      subtype: z.string().optional(),
      kind: z.enum(POST_KINDS).optional(),
      visibility: z.enum(VISIBILITIES).optional(),
      deliverable_spec: z.unknown().optional(),
      workdir: z.string().nullable().optional(),
      executor: z.string().nullable().optional(),
      max_attempts: z.number().int().min(1).optional(),
      is_ready: z.boolean().optional(),
      channel: z.object({
        host_principal_id: z.string().min(1),
        workdir: z.string().nullable().optional(),
        run_user: z.string().nullable().optional(),
        name: z.string().optional(),
        status: z.enum(['open', 'archived']).optional(),
      }).optional(),
      targets: z.array(z.object({
        principal_id: z.string().min(1),
        role: z.enum(TARGET_ROLES).optional(),
      })).optional(),
      add: z.array(z.object({
        principal_id: z.string().min(1),
        role: z.enum(TARGET_ROLES),
      })).optional(),
      remove: z.array(z.object({
        principal_id: z.string().min(1),
        role: z.enum(TARGET_ROLES),
      })).optional(),
      recent_limit: z.number().int().min(0).max(200).optional(),
      include_recent: z.boolean().optional(),
      refresh: z.boolean().optional(),
      author_principal_id: z.string().optional(),
      target_principal_id: z.string().optional(),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(200).optional(),
      after: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args): Promise<ToolResult> => {
      try {
        const context = mcpPrincipal();
        if (args.action === 'create') {
          if (!args.kind || args.body === undefined || !args.visibility) {
            return toolErr('kind, body, and visibility are required');
          }
          if (args.kind === 'task') {
            guardScope('task:write');
            const published = await publishTask({
              account_id: context.account_id,
              author_principal_id: context.principal.id,
              title: args.title,
              body: args.body,
              visibility: args.visibility,
              subtype: args.subtype,
              deliverable_spec: args.deliverable_spec,
              targets: args.targets,
              task: {
                is_ready: args.is_ready,
                workdir: args.workdir,
                executor: args.executor,
                max_attempts: args.max_attempts,
              },
            });
            return toolOk({ ok: true, post_id: published.post.id, status: published.task.status });
          }
          guardScope('post:write');
          const post = await createPost({
            account_id: context.account_id,
            kind: args.kind,
            subtype: args.subtype,
            author_principal_id: context.principal.id,
            title: args.title,
            body: args.body,
            visibility: args.visibility,
            parent_id: args.parent_id,
            targets: args.targets?.map((target) => ({
              principal_id: target.principal_id,
              role: target.role ?? 'assignee',
            })),
            channel: args.channel,
          });
          return toolOk({ ok: true, post_id: post.id, root_id: post.root_id });
        }
        if (args.action === 'reply') {
          guardScope('post:write');
          if (!args.parent_id || args.body === undefined) return toolErr('parent_id and body are required');
          const post = await replyPost({
            parent_id: args.parent_id,
            author_principal_id: context.principal.id,
            body: args.body,
            subtype: args.subtype,
            targets: args.targets?.map((target) => ({
              principal_id: target.principal_id,
              role: target.role ?? 'assignee',
            })),
          });
          if (post.account_id !== context.account_id) return toolErr('not found');
          return toolOk({ ok: true, post_id: post.id, root_id: post.root_id });
        }
        if (args.action === 'edit' || args.action === 'delete' || args.action === 'target') {
          guardScope('post:write');
          if (!args.id) return toolErr('id is required');
          const detail = await getPostDetail(args.id);
          if (!detail || detail.post.deleted_at || detail.post.account_id !== context.account_id) {
            return toolErr('not found');
          }
          if (
            detail.post.author_principal_id !== context.principal.id
            && !hasScopes('moderate')
          ) {
            throw new ScopeDenied('moderate');
          }
          if (args.action === 'edit') {
            const post = await editPost(args.id, { title: args.title, body: args.body });
            return toolOk({ ok: true, revision: post.revision });
          }
          if (args.action === 'delete') {
            await deletePost(args.id);
            return toolOk({ ok: true });
          }
          for (const target of args.add ?? []) {
            await addTarget(args.id, target.principal_id, target.role);
          }
          for (const target of args.remove ?? []) {
            await removeTarget(args.id, target.principal_id, target.role);
          }
          const updated = await getPostDetail(args.id);
          return toolOk({
            ok: true,
            targets: updated?.targets.map((target) => ({
              principal_id: target.principal_id,
              role: target.role,
              read_at: target.read_at,
            })) ?? [],
          });
        }
        if (args.action === 'summary') {
          guardScope('post:read');
          const rootId = args.root_id ?? args.id;
          if (!rootId) return toolErr('root_id is required');
          const root = await getPostDetail(rootId);
          if (!root || root.post.account_id !== context.account_id) return toolErr('not found');
          const summary = await getSummary(root.post.root_id);
          return toolOk({
            ...(summary ?? { summary: null }),
            pending_worker: args.refresh === true,
          });
        }
        if (args.action !== 'detail' && args.action !== 'list') {
          return toolErr(`unknown action: ${args.action}`);
        }
        guardScope('post:read');
        if (args.action === 'detail') {
          if (!args.id) return toolErr('id is required');
          const detail = await readPostDetail(args.id, context.account_id, context.principal.id);
          if (!detail) return toolErr('not found');
          applyRecentOptions(detail, args);
          return toolOk(detail);
        }

        const pageSize = args.after === undefined
          ? args.page_size ?? args.limit
          : args.page_size;
        return toolOk(await readPostList({
          account_id: context.account_id,
          kind: args.kind,
          root_id: args.root_id,
          parent_id: args.parent_id,
          author_principal_id: args.author_principal_id,
          visibility: args.visibility,
          target_principal_id: args.target_principal_id,
          page: args.page,
          page_size: pageSize,
          after: args.after,
          limit: args.after === undefined ? undefined : args.limit ?? args.page_size,
        }));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
