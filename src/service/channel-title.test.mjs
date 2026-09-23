import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { autoNameChannelTitle } = await tsImport('./channels.ts', import.meta.url);

test('首条消息自动命名、仅命名一次、超长截断且空消息不命名', () => {
  const defaultTitle = '与测试主机';
  const body = '  这是首条 用户消息，应该被截断为摘要标题并保留省略号。 ';
  const compactBody = body.replace(/\s+/gu, '');
  const expectedTitle = `${Array.from(compactBody).slice(0, 24).join('')}…`;

  assert.equal(
    autoNameChannelTitle({
      currentTitle: defaultTitle,
      defaultTitle,
      isFirstUserMessage: true,
      body,
    }),
    expectedTitle,
  );
  assert.equal(
    autoNameChannelTitle({
      currentTitle: defaultTitle,
      defaultTitle,
      isFirstUserMessage: false,
      body: '后续消息不能覆盖已经生成的标题',
    }),
    null,
  );
  assert.equal(
    autoNameChannelTitle({
      currentTitle: defaultTitle,
      defaultTitle,
      isFirstUserMessage: true,
      body: ' \n\t',
    }),
    null,
  );
});
