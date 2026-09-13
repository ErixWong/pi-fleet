import { query } from '../db.js';

export type EventActor = 'agent' | 'admin' | 'system';

export interface RecordEventInput {
  actor: EventActor;
  ref_task?: string | number | null;
  ref_plan?: string | number | null;
  summary: string;
}

export interface EventFilter {
  type?: string;
  refTask?: string;
  refPlan?: string;
}

export interface EventView {
  id: string;
  type: string;
  actor: EventActor;
  ref_task: string | null;
  ref_plan: string | null;
  summary: string;
  created_at: string;
  agent_name: string | null;
  task_id: string | null;
  task_title: string | null;
  task_summary: string | null;
  plan_id: string | null;
  plan_name: string | null;
}

type EventExecutor = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
};

const defaultExecutor: EventExecutor = { query };

/**
 * Record a timeline event. Business task/plan IDs are accepted so callers do not
 * need to repeat the internal ID lookup at every state transition.
 */
export async function recordEvent(
  type: string,
  input: RecordEventInput,
  executor: EventExecutor = defaultExecutor,
): Promise<void> {
  const refTask = await resolveReference(executor, input.ref_task, 'task');
  const refPlan = await resolveReference(executor, input.ref_plan, 'plan');
  await executor.query(
    `INSERT INTO events (type, actor, ref_task, ref_plan, summary) VALUES (?, ?, ?, ?, ?)`,
    [type.slice(0, 64), input.actor, refTask, refPlan, input.summary.slice(0, 500)],
  );
}

async function resolveReference(
  executor: EventExecutor,
  value: string | number | null | undefined,
  kind: 'task' | 'plan',
): Promise<string | number | null> {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) return Number(value);
  const table = kind === 'task' ? 'tasks' : 'plans';
  const column = kind === 'task' ? 'task_id' : 'plan_id';
  const rows = (await executor.query(`SELECT id FROM ${table} WHERE ${column} = ? LIMIT 1`, [String(value)])) as Array<
    Record<string, unknown>
  >;
  return rows.length > 0 ? Number(rows[0].id) : null;
}

/** Paginated activity stream with task/plan context for the command center. */
export async function listEvents(
  page = 1,
  pageSize = 20,
  filter: EventFilter = {},
): Promise<{ items: EventView[]; total: number; page: number; page_size: number }> {
  const pageNum = Math.max(1, Math.floor(page) || 1);
  const size = Math.min(200, Math.max(1, Math.floor(pageSize) || 20));
  const params: unknown[] = [];
  const where: string[] = ['1=1'];
  if (filter.type?.trim()) {
    where.push('e.type = ?');
    params.push(filter.type.trim().slice(0, 64));
  }
  if (filter.refTask?.trim()) {
    if (/^\d+$/.test(filter.refTask.trim())) {
      where.push('e.ref_task = ?');
      params.push(Number(filter.refTask));
    } else {
      where.push('t.task_id = ?');
      params.push(filter.refTask.trim());
    }
  }
  if (filter.refPlan?.trim()) {
    if (/^\d+$/.test(filter.refPlan.trim())) {
      where.push('e.ref_plan = ?');
      params.push(Number(filter.refPlan));
    } else {
      where.push('p.plan_id = ?');
      params.push(filter.refPlan.trim());
    }
  }
  const joins = `
    FROM events e
    LEFT JOIN tasks t ON t.id = e.ref_task
    LEFT JOIN plans p ON p.id = e.ref_plan
    LEFT JOIN agents ta ON ta.id = t.assignee_id
    LEFT JOIN agents tc ON tc.id = t.creator_id`;
  const predicate = ` WHERE ${where.join(' AND ')}`;
  const totalRows = (await query(`SELECT COUNT(*) AS c ${joins}${predicate}`, params)) as Array<Record<string, unknown>>;
  const total = Number(totalRows[0]?.c ?? 0);
  const rows = (await query(
    `SELECT e.id, e.type, e.actor, e.ref_task, e.ref_plan, e.summary, e.created_at,
            COALESCE(ta.name, tc.name) AS agent_name,
            t.task_id, t.title AS task_title, LEFT(t.instruction, 240) AS task_summary,
            p.plan_id, p.name AS plan_name
       ${joins}${predicate}
      ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...params, size, (pageNum - 1) * size],
  )) as Array<Record<string, unknown>>;
  const items = rows.map((r) => ({
    id: String(r.id),
    type: String(r.type),
    actor: String(r.actor) as EventActor,
    ref_task: r.ref_task === null || r.ref_task === undefined ? null : String(r.ref_task),
    ref_plan: r.ref_plan === null || r.ref_plan === undefined ? null : String(r.ref_plan),
    summary: String(r.summary ?? ''),
    created_at: String(r.created_at),
    agent_name: (r.agent_name as string | null) ?? null,
    task_id: (r.task_id as string | null) ?? null,
    task_title: (r.task_title as string | null) ?? null,
    task_summary: (r.task_summary as string | null) ?? null,
    plan_id: (r.plan_id as string | null) ?? null,
    plan_name: (r.plan_name as string | null) ?? null,
  }));
  return { items, total, page: pageNum, page_size: size };
}
