import {
  accessSync,
  constants,
  readdirSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOST_FOLDER_LIMIT = 200;
export const HOST_FOLDER_TOTAL_LIMIT = 500;
export const SKIPPED_HOST_FOLDER_NAMES = new Set([
  'node_modules',
  '.cache',
  '.npm',
  '.pi',
  '.pnpm-store',
  '.yarn',
  '.gradle',
  '.cargo',
  '__pycache__',
]);

function isHomeChild(candidate, home) {
  return candidate !== home && candidate.startsWith(`${home}${path.sep}`);
}

/**
 * 列出 home 直接子目录（一层、限 HOST_FOLDER_LIMIT 个）。
 * 逐项容错：不可读/不可执行的目录跳过并告警，不影响其余目录。
 */
export function listHomeSubfolders({
  home = os.homedir(),
  target = home,
  limit = HOST_FOLDER_LIMIT,
  warn = (message) => console.log(message),
} = {}) {
  const homeResolved = path.resolve(home);
  const targetResolved = path.resolve(target);
  if (!isHomeChild(targetResolved, homeResolved) && targetResolved !== homeResolved) {
    throw new Error(`目标目录不在 home 下：${targetResolved}`);
  }

  let entries;
  try {
    entries = readdirSync(targetResolved, { withFileTypes: true });
  } catch (error) {
    throw new Error(`读取目录失败：${targetResolved}：${error.message}`);
  }

  const folders = [];
  for (const entry of entries) {
    const name = entry?.name;
    if (
      !name
      || name.startsWith('.')
      || SKIPPED_HOST_FOLDER_NAMES.has(name)
    ) {
      continue;
    }

    const candidate = path.join(targetResolved, name);
    try {
      if (!statSync(candidate).isDirectory()) continue;
      accessSync(candidate, constants.R_OK | constants.X_OK);
      folders.push(candidate);
    } catch (error) {
      warn(`[daemon] 跳过目录 ${candidate}：${error.message}`);
    }
  }

  return folders
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit);
}

/**
 * 深度优先递归扫描 home 目录树（默认深度 ≤3），作为平台目录树底图。
 * 跳过隐藏目录、node_modules 和常见缓存目录；节点总数超限截断并打标 truncated。
 * 逐项容错：单个目录读取失败仅告警，不影响其余分支。
 */
export function scanHomeFolders({
  home = os.homedir(),
  maxDepth = 3,
  limit = HOST_FOLDER_TOTAL_LIMIT,
  warn = (message) => console.log(message),
} = {}) {
  const homeResolved = path.resolve(home);
  const skipped = new Set([homeResolved]);
  const folders = [];
  let truncated = false;

  const visit = (dir, depth) => {
    if (folders.length >= limit) {
      truncated = true;
      return;
    }
    if (!skipped.has(dir)) {
      folders.push(dir);
    }
    if (depth >= maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      warn(`[daemon] 扫描目录失败 ${dir}：${error.message}`);
      return;
    }
    for (const entry of entries) {
      const name = entry?.name;
      if (
        !name
        || name.startsWith('.')
        || SKIPPED_HOST_FOLDER_NAMES.has(name)
        || !entry.isDirectory()
      ) {
        continue;
      }
      const candidate = path.join(dir, name);
      if (!isHomeChild(candidate, homeResolved)) continue;
      try {
        accessSync(candidate, constants.R_OK | constants.X_OK);
      } catch (error) {
        warn(`[daemon] 跳过目录 ${candidate}：${error.message}`);
        continue;
      }
      visit(candidate, depth + 1);
      if (folders.length >= limit) {
        truncated = true;
        return;
      }
    }
  };

  visit(homeResolved, 0);
  folders.sort((left, right) => left.localeCompare(right));
  return { folders, truncated };
}
