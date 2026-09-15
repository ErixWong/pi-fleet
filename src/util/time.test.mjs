import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { nowString } = await tsImport('./time.ts', import.meta.url);

test('nowString 返回本地 DATETIME 字符串', () => {
  assert.match(nowString(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
