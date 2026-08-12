import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { query } from './db.js';

/** 当前请求上下文中已认证的 agent 身份 */
export interface AgentIdentity {
  id: number;
  agentId: string;
  name: string;
  hostname: string;
  tags: string;
  systemPrompt: string | null;
}

export const agentContext = new AsyncLocalStorage<AgentIdentity>();

/** 当前请求的 agent（MCP 工具内调用），未认证时返回 null */
export function currentAgent(): AgentIdentity | null {
  return agentContext.getStore() ?? null;
}

/** 生成 agent api-key：pd- 前缀（可识别）+ 32 字符 base64url（192bit 熵，安全），仅展示一次 */
export function generateApiKey(): string {
  return `pd-${randomBytes(24).toString('base64url')}`;
}

/** key 的 sha256 十六进制哈希（落库存哈希） */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** scrypt 口令哈希（管理员密码） */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64) as Buffer;
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** 校验口令是否匹配 */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = scryptSync(password, salt, expected.length) as Buffer;
  return timingSafeEqual(derived, expected);
}

/** 按 api-key 查询并返回 agent（未找到/已禁用返回 null） */
export async function findAgentByKey(key: string): Promise<AgentIdentity | null> {
  const hash = hashApiKey(key);
  const rows = await query(
    `SELECT id, agent_id, name, hostname, tags, system_prompt
       FROM agents WHERE key_hash = ? AND status = 'active' LIMIT 1`,
    [hash],
  );
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id: Number(r.id),
    agentId: String(r.agent_id),
    name: String(r.name),
    hostname: String(r.hostname ?? ''),
    tags: String(r.tags ?? ''),
    systemPrompt: (r.system_prompt as string | null) ?? null,
  };
}

/** 更新 agent 最后活跃时间 */
export async function touchAgent(agentId: number): Promise<void> {
  await query(`UPDATE agents SET last_seen_at = NOW() WHERE id = ?`, [agentId]);
}

/** MCP 路由的 Bearer key 校验中间件：通过后把 agent 身份写入 AsyncLocalStorage */
export async function mcpAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  const agent = await findAgentByKey(match[1].trim());
  if (!agent) {
    res.status(401).json({ error: 'invalid or disabled agent key' });
    return;
  }
  await touchAgent(agent.id);
  agentContext.run(agent, () => next());
}

/** Web 管理员登录守卫 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session && (req.session as { admin?: boolean }).admin) {
    next();
    return;
  }
  res.redirect('/login');
}
