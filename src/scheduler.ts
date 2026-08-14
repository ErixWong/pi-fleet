import { randomInt } from 'node:crypto';
import { query } from './db.js';

/**
 * 定时任务调度：周期 + 时间窗口（错峰）。
 *
 * 核心思路：next_due_at 始终是「下一周期窗口内的随机时刻」。
 * - 各家 agent 的任务到期时刻散布在整个窗口内 → 天然错峰，避免准点造成 provider 压力
 * - 放行只判断 next_due_at <= now，窗口语义已包含在随机时刻里
 *
 * 时区策略：所有时间由 Node 侧生成本地时间字符串（YYYY-MM-DD HH:MM:SS），
 * 数据库只做存储与展示，窗口判断不依赖数据库 NOW()，避免容器 UTC 与宿主时区错位。
 */

export type ScheduleKind = 'daily' | 'weekly' | 'hourly';

function parseHM(s: string | null): { h: number; m: number } {
  if (!s) return { h: 0, m: 0 };
  const m2 = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m2) return { h: 0, m: 0 };
  return { h: Number(m2[1]), m: Number(m2[2]) };
}

/** 在指定日期的 [start, end] 窗口内生成随机时刻 */
function randomInWindow(date: Date, start: string | null, end: string | null): Date {
  const ws = parseHM(start);
  const we = parseHM(end);
  const s = ws.h * 3600 + ws.m * 60;
  let e = we.h * 3600 + we.m * 60;
  if (e <= s) e = s + 3600; // 防御：窗口异常时保证至少 1 小时
  const sec = randomInt(s, e + 1); // randomInt(max) 为独占上界，+1 保证含 end
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setSeconds(sec);
  return d;
}

/**
 * 计算下一次到期时间（严格晚于 from）。
 * @param cron  周期：daily | weekly:<0-6> | hourly
 * @param windowStart 窗口起 HH:MM（hourly 忽略）
 * @param windowEnd   窗口止 HH:MM
 */
export function computeNextDue(
  cron: string | null,
  windowStart: string | null,
  windowEnd: string | null,
  from: Date = new Date(),
): Date {
  const base: ScheduleKind =
    cron === 'weekly' || (cron?.startsWith('weekly:') ?? false)
      ? 'weekly'
      : cron === 'hourly'
        ? 'hourly'
        : 'daily';

  if (base === 'hourly') {
    const d = new Date(from.getTime() + 3600_000);
    d.setMinutes(randomInt(0, 60), randomInt(0, 60), 0);
    return d;
  }

  const weeklyDay =
    base === 'weekly' && cron?.startsWith('weekly:')
      ? Number(cron.split(':')[1])
      : NaN;

  // 从 from 所在日期起，最多向后找 8 天（覆盖 weekly 的最坏情况）
  for (let i = 0; i < 8; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    if (base === 'weekly' && !Number.isNaN(weeklyDay) && d.getDay() !== weeklyDay) {
      continue;
    }
    const cand = randomInWindow(d, windowStart, windowEnd);
    if (cand.getTime() > from.getTime()) return cand;
  }
  // 理论上不会走到：兜底返回明天窗口随机
  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return randomInWindow(tomorrow, windowStart, windowEnd);
}

/** Date → 本地时间字符串 YYYY-MM-DD HH:MM:SS */
export function toLocalString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 当前时间字符串（与 toLocalString 同格式），用于数据库比较 */
export function nowString(): string {
  return toLocalString(new Date());
}

/**
 * 超时回收：认领后超过 timeoutHours 无任何活动（未续期/未汇报）的 running 任务
 * 标记为 failed。长任务通过 report_progress 续期（last_activity_at 刷新）避免被误杀。
 */
export async function recoverStaleRunningTasks(timeoutHours = 2): Promise<number> {
  const result = await query(
    `UPDATE tasks
        SET status = 'failed', result_status = 'failed',
            result = '[auto] 执行超时回收：认领后 ${timeoutHours} 小时无活动（未续期/未汇报）',
            result_at = ?
      WHERE status = 'running'
        AND last_activity_at IS NOT NULL
        AND last_activity_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [nowString(), timeoutHours],
  );
  return (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
}

/**
 * 认领回收（§10.2 生命周期）：claimed 超时无活动（公共池任务）→ 回 active 重新可认领。
 * 回帖记录、不计 attempts；仅针对公共池认领（private 指派任务不回流）。
 */
export async function recoverStaleClaimedTasks(timeoutHours = 2): Promise<number> {
  const rows = await query(
    `SELECT id, task_id FROM tasks
      WHERE status = 'claimed' AND visibility = 'public'
        AND last_activity_at IS NOT NULL
        AND last_activity_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [timeoutHours],
  );
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => (r as Record<string, unknown>).id);
  const placeholders = ids.map(() => '?').join(',');
  await query(
    `UPDATE tasks SET status='active', assignee_id=NULL, claimed_at=NULL, last_activity_at=? WHERE id IN (${placeholders})`,
    [nowString(), ...ids],
  );
  for (const r of rows) {
    const rr = r as Record<string, unknown>;
    await query(
      `INSERT INTO messages (task_id, sender_id, sender_role, type, content)
       VALUES (?, NULL, 'platform', 'system', ?)`,
      [rr.id, `[平台] 认领超时无活动，任务回到公共池重新可认领（不计交付尝试次数）`],
    );
  }
  return rows.length;
}

/**
 * 挂起确认回收（§10.2）：pending_confirm 挂起超 days 天（默认 7）→ 自动确认 done（发起人缺席不阻塞终态）。
 */
export async function autoConfirmPendingConfirm(days = 7): Promise<number> {
  const rows = await query(
    `SELECT id FROM tasks
      WHERE status = 'pending_confirm'
        AND last_activity_at IS NOT NULL
        AND last_activity_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days],
  );
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => (r as Record<string, unknown>).id);
  const placeholders = ids.map(() => '?').join(',');
  await query(
    `UPDATE tasks SET status='done', result_status='success', result='[auto] 待确认超 ${days} 天，自动确认通过', result_at=?, last_activity_at=? WHERE id IN (${placeholders})`,
    [nowString(), nowString(), ...ids],
  );
  for (const r of rows) {
    await query(
      `INSERT INTO messages (task_id, sender_id, sender_role, type, content)
       VALUES (?, NULL, 'platform', 'system', ?)`,
      [(r as Record<string, unknown>).id, `[平台] 待发起人确认超过 ${days} 天，自动确认通过`],
    );
  }
  return rows.length;
}
