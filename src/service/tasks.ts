import { query, withTransaction } from '../db.js';
import type { AgentIdentity } from '../auth.js';
import { computeNextDue, nowString, toLocalString } from '../scheduler.js';

/**
 * 共享业务层：REST（调度脚本）与 MCP（pi）共用同一套任务逻辑，避免双套实现漂移。
 */

export interface DueTask {
  task_id: string;
  title: string;
  instruction: string;
  topic: string | null;
  workdir: string | null;
}

/**
 * 认领该 agent 已到期的定时任务（放行）：
 * - 同 agent 同 workdir 已有 running 任务时不并发放行（防项目互踩）
 * - 放行即置 running + 记录认领/活跃时间 + 推进 next_due_at（窗口内随机，错峰）
 */
export async function claimDueTasks(agent: AgentIdentity): Promise<DueTask[]> {
  return withTransaction(async (conn) => {
    const rows = (await conn.query(
      `SELECT t.id, t.task_id, t.title, t.instruction, t.schedule_cron,
              t.window_start, t.window_end, t.topic_id, t.workdir, tp.topic AS topic,
              t.next_due_at
         FROM tasks t
         LEFT JOIN topics tp ON tp.id = t.topic_id
        WHERE t.assignee_id = ? AND t.kind = 'scheduled'
          AND t.status IN ('pending','done','failed')
          AND t.next_due_at IS NOT NULL
          AND t.next_due_at <= ?
          AND (
                t.workdir IS NULL
                OR t.workdir NOT IN (
                  SELECT workdir FROM tasks
                   WHERE assignee_id = ? AND status = 'running' AND workdir IS NOT NULL
                )
              )
        ORDER BY t.next_due_at ASC
        LIMIT 20
        FOR UPDATE`,
      [agent.id, nowString(), agent.id],
    )) as Array<Record<string, unknown>>;

    const dueTasks: DueTask[] = [];
    for (const r of rows) {
      const nextDue = computeNextDue(
        (r.schedule_cron as string | null) ?? 'daily',
        (r.window_start as string | null) ?? null,
        (r.window_end as string | null) ?? null,
        new Date(),
      );
      await conn.query(
        `UPDATE tasks
            SET status = 'running', claimed_at = ?, next_due_at = ?, last_activity_at = ?
          WHERE id = ?`,
        [nowString(), toLocalString(nextDue), nowString(), r.id],
      );
      dueTasks.push({
        task_id: String(r.task_id),
        title: String(r.title),
        instruction: String(r.instruction),
        topic: (r.topic as string | null) ?? null,
        workdir: (r.workdir as string | null) ?? null,
      });
    }
    return dueTasks;
  });
}

export type SubmitStatus = 'success' | 'failed';

/**
 * 汇报任务结果（任务必须属于该 agent 且状态允许：pending/assigned/running）
 * 返回 { ok: true } 或 { ok: false, error }
 */
export async function submitTaskResult(
  agent: AgentIdentity,
  taskId: string,
  status: SubmitStatus,
  result: string,
): Promise<{ ok: boolean; error?: string }> {
  const updated = await query(
    `UPDATE tasks
        SET status = ?, result = ?, result_status = ?, result_at = ?, last_activity_at = ?
      WHERE task_id = ? AND assignee_id = ?
        AND status IN ('pending','assigned','running')`,
    [status === 'success' ? 'done' : 'failed', result, status, nowString(), nowString(), taskId, agent.id],
  );
  const affected = (updated as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) {
    return {
      ok: false,
      error: `任务 ${taskId} 不存在、未指派给当前 agent，或状态不允许提交（可能已完成）`,
    };
  }
  return { ok: true };
}

/**
 * 任务执行中续期：刷新最后活跃时间，避免超时回收误杀长任务。
 */
export async function renewTaskActivity(
  agent: AgentIdentity,
  taskId: string,
): Promise<{ ok: boolean; error?: string }> {
  const updated = await query(
    `UPDATE tasks SET last_activity_at = ?
      WHERE task_id = ? AND assignee_id = ? AND status = 'running'`,
    [nowString(), taskId, agent.id],
  );
  const affected = (updated as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) {
    return { ok: false, error: `任务 ${taskId} 不存在、未指派给当前 agent，或不在运行中` };
  }
  return { ok: true };
}
