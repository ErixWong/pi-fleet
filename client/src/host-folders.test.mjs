import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listHomeSubfolders, scanHomeFolders } from './host-folders.mjs';

test('扫描 home 一级目录时跳过隐藏目录和 node_modules', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'pi-agent-folders-'));
  try {
    for (const name of ['projects', 'notes', '.secret', 'node_modules', '.cache']) {
      mkdirSync(path.join(home, name));
    }
    const { folders, truncated } = scanHomeFolders({ home, warn: () => {} });
    assert.equal(truncated, false);
    assert.deepEqual(folders, [
      path.join(home, 'notes'),
      path.join(home, 'projects'),
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('深度扫描递归 ≤3 层并跳过缓存目录', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'pi-agent-deep-'));
  try {
    mkdirSync(path.join(home, 'projects', 'demo', 'src'), { recursive: true });
    mkdirSync(path.join(home, 'projects', 'demo', 'node_modules'));
    mkdirSync(path.join(home, 'projects', 'demo', '.git'));
    mkdirSync(path.join(home, 'projects', 'deep', 'l2', 'l3'), { recursive: true });
    mkdirSync(path.join(home, 'projects', 'shallow', 'a', 'b'), { recursive: true });
    mkdirSync(path.join(home, '.config', 'pi-agent'), { recursive: true });
    writeFileSync(path.join(home, 'projects', 'file.txt'), 'x');

    const { folders, truncated } = scanHomeFolders({ home, warn: () => {} });
    assert.equal(truncated, false);
    // 最深层为第 3 层（projects/x/y）；l3、b 位于第 4 层，超出默认 maxDepth=3，不进入底图。
    assert.deepEqual(folders, [
      path.join(home, 'projects'),
      path.join(home, 'projects', 'deep'),
      path.join(home, 'projects', 'deep', 'l2'),
      path.join(home, 'projects', 'demo'),
      path.join(home, 'projects', 'demo', 'src'),
      path.join(home, 'projects', 'shallow'),
      path.join(home, 'projects', 'shallow', 'a'),
    ]);
    assert.ok(!folders.some((folder) => folder.endsWith(`${path.sep}b`)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('深度扫描节点超限截断并打标 truncated', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'pi-agent-trunc-'));
  try {
    for (let index = 0; index < 8; index += 1) {
      mkdirSync(path.join(home, `dir-${index}`, 'a', 'b'), { recursive: true });
    }
    const { folders, truncated } = scanHomeFolders({
      home,
      limit: 5,
      warn: () => {},
    });
    assert.equal(truncated, true);
    assert.equal(folders.length, 5);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('listHomeSubfolders 只返回一层子目录并跳过黑名单', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'pi-agent-list-'));
  try {
    mkdirSync(path.join(home, 'projects', 'demo'), { recursive: true });
    mkdirSync(path.join(home, 'projects', 'node_modules'));
    mkdirSync(path.join(home, 'projects', '.git'));
    mkdirSync(path.join(home, 'node_modules'));
    writeFileSync(path.join(home, 'projects', 'file.txt'), 'x');

    const folders = listHomeSubfolders({ home, target: path.join(home, 'projects'), warn: () => {} });
    assert.deepEqual(folders, [path.join(home, 'projects', 'demo')]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('listHomeSubfolders 拒绝 home 之外的目录', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'pi-agent-list-'));
  try {
    assert.throws(
      () => listHomeSubfolders({ home, target: '/tmp', warn: () => {} }),
      /不在 home 下/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
