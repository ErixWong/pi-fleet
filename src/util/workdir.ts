import os from 'node:os';
import path from 'node:path';

/**
 * 仅接受当前用户 home 目录下的工作目录，保留调用方传入的显示形式。
 */
export function normalizeHomeWorkdir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const home = path.resolve(os.homedir());
  const candidate = raw === '~'
    ? home
    : raw.startsWith('~/')
      ? path.join(home, raw.slice(2))
      : raw;
  if (!path.isAbsolute(candidate)) return null;

  const resolved = path.resolve(candidate);
  if (resolved !== home && !resolved.startsWith(`${home}${path.sep}`)) return null;
  return raw;
}

/**
 * 平台没有主机用户的真实 home，只接受 Linux home 根下且规范化后不逃逸的路径。
 */
export function normalizeReportedHomeFolder(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw.startsWith('/home/')) return null;

  const resolved = path.posix.resolve(raw);
  if (!resolved.startsWith('/home/')) return null;
  return resolved;
}
