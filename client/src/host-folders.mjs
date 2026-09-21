import {
  accessSync,
  constants,
  readdirSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOST_FOLDER_LIMIT = 200;
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

export function scanHomeFolders({
  home = os.homedir(),
  warn = (message) => console.log(message),
} = {}) {
  let entries;
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch (error) {
    warn(`[daemon] 扫描 home 目录失败：${error.message}`);
    return [];
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

    const candidate = path.join(home, name);
    try {
      if (!statSync(candidate).isDirectory()) continue;
      accessSync(candidate, constants.R_OK | constants.X_OK);
      folders.push(candidate);
    } catch (error) {
      warn(`[daemon] 跳过 home 目录 ${candidate}：${error.message}`);
    }
  }

  return folders
    .sort((left, right) => left.localeCompare(right))
    .slice(0, HOST_FOLDER_LIMIT);
}
