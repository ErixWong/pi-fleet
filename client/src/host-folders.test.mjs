import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanHomeFolders } from './host-folders.mjs';

test('扫描 home 一级目录时跳过隐藏目录和 node_modules', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'pi-agent-folders-'));
  try {
    for (const name of ['projects', 'notes', '.secret', 'node_modules', '.cache']) {
      mkdirSync(path.join(home, name));
    }
    assert.deepEqual(scanHomeFolders({ home, warn: () => {} }), [
      path.join(home, 'notes'),
      path.join(home, 'projects'),
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
