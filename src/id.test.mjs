import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { newID, newId } = await tsImport('./id.ts', import.meta.url);
const forbidden = /[0oi1l]/;

test('生成 ID 使用无混淆字符集', () => {
  for (let i = 0; i < 2000; i += 1) {
    assert.equal(forbidden.test(newID()), false);
  }
});

test('生成 ID 长度遵守默认值和下限', () => {
  assert.equal(newID(16).length, 16);
  assert.equal(newID().length, 16);
  assert.equal(newID(1).length, 10);
});

test('带前缀 ID 格式正确', () => {
  const id = newId('pst');
  assert.equal(id.startsWith('pst_'), true);
  assert.equal(id.length, 20);
});

test('同一毫秒内快速生成的 ID 全部唯一', () => {
  const ids = new Set();
  for (let i = 0; i < 10000; i += 1) ids.add(newID());
  assert.equal(ids.size, 10000);
});

test('同一毫秒内连续生成的 ID 严格按字典序递增', () => {
  const originalNow = Date.now;
  const fixedNow = originalNow();
  Date.now = () => fixedNow;
  try {
    let previous = newID();
    for (let i = 1; i < 5000; i += 1) {
      const current = newID();
      assert.equal(previous < current, true);
      previous = current;
    }
  } finally {
    Date.now = originalNow;
  }
});

test('跨多个真实毫秒生成的 ID 严格按字典序递增', () => {
  const ids = Array.from({ length: 20000 }, () => newID(16));
  for (let i = 1; i < ids.length; i += 1) {
    assert.equal(ids[i - 1] < ids[i], true, `第 ${i} 个 ID 未递增`);
  }
});

test('时钟回拨时生成的 ID 仍严格按字典序递增', () => {
  const originalNow = Date.now;
  const t0 = originalNow() + 1000;
  const times = [t0 + 100, t0];
  Date.now = () => times.shift() ?? t0;
  try {
    const first = newID();
    const second = newID();
    assert.equal(first < second, true);
  } finally {
    Date.now = originalNow;
  }
});

test('跨毫秒生成的 ID 按时间字典序递增', async () => {
  const first = newID();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = newID();
  assert.equal(first < second, true);
});
