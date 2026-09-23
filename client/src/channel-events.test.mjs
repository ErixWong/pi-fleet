// channel-events.mjs 单测：pi --mode json 事件流桥接解析器。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelEventsParser } from './channel-events.mjs';

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

function assistantMessageEnd(...texts) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: texts.map((text) => ({ type: 'text', text })),
    },
  };
}

test('session 头与 message_update 事件被忽略', () => {
  const parser = createChannelEventsParser();
  parser.feed(line({ type: 'session', version: 3, id: 'u1', cwd: '/tmp' }));
  parser.feed(line({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', delta: '增量' } }));
  parser.feed(line({ type: 'agent_start' }));
  const result = parser.finalize();
  assert.equal(result.text, '');
  assert.equal(result.trace, '');
  assert.equal(result.lastAction, '');
});

test('assistant message_end 的 text 块拼接', () => {
  const parser = createChannelEventsParser();
  parser.feed(line({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '用户问题' }] } }));
  parser.feed(line(assistantMessageEnd('第一段', '第二段')));
  const result = parser.finalize();
  assert.equal(result.text, '第一段第二段');
  assert.equal(result.lastAction, '第一段第二段');
});

test('最终 assistant text 为空时回退到最后一个非空文本', () => {
  const parser = createChannelEventsParser();
  parser.feed(line(assistantMessageEnd('早前回答')));
  // 模拟 relay 故障：最终 assistant message_end 的 content 为空。
  parser.feed(line({ type: 'message_end', message: { role: 'assistant', content: [] } }));
  const result = parser.finalize();
  assert.equal(result.text, '早前回答');
});

test('工具调用生成 trace，isError 行尾标注（出错）', () => {
  const parser = createChannelEventsParser();
  parser.feed(line({
    type: 'tool_execution_start',
    toolCallId: 'c1',
    toolName: 'bash',
    args: { command: 'ls -la' },
  }));
  parser.feed(line({
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'bash',
    result: { ok: true },
    isError: false,
  }));
  parser.feed(line({
    type: 'tool_execution_start',
    toolCallId: 'c2',
    toolName: 'read',
    args: { path: '/a' },
  }));
  parser.feed(line({
    type: 'tool_execution_end',
    toolCallId: 'c2',
    toolName: 'read',
    result: null,
    isError: true,
  }));
  const result = parser.finalize();
  assert.equal(
    result.trace,
    '🔧 bash: {"command":"ls -la"}\n🔧 read: {"path":"/a"}（出错）',
  );
});

test('工具 args 摘要压空白并超长截断', () => {
  const parser = createChannelEventsParser();
  const longArgs = { command: `echo ${'x'.repeat(300)}` };
  parser.feed(line({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: longArgs }));
  parser.feed(line({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: false }));
  const result = parser.finalize();
  const traceLine = result.trace.split('\n')[0];
  assert.ok(traceLine.startsWith('🔧 bash: '));
  // 摘要压空白后超 ~120 字符截断，以省略号结尾。
  const summary = traceLine.slice('🔧 bash: '.length);
  assert.ok(summary.endsWith('…'));
  assert.equal(summary.length, 120);
});

test('未配对 tool_execution_start 的 lastAction 为正在执行（超时模拟）', () => {
  const parser = createChannelEventsParser();
  parser.feed(line(assistantMessageEnd('我先查一下')));
  parser.feed(line({
    type: 'tool_execution_start',
    toolCallId: 'c9',
    toolName: 'bash',
    args: { command: 'npm install' },
  }));
  const result = parser.finalize();
  assert.equal(result.lastAction, '正在执行 bash: {"command":"npm install"}');
  // 未完成的工具调用不出现在 trace 中。
  assert.equal(result.trace, '');
});

test('无进行中工具时 lastAction 取最近 assistant 文本尾部', () => {
  const parser = createChannelEventsParser();
  const longText = `${'前'.repeat(300)}尾部锚点`;
  parser.feed(line(assistantMessageEnd(longText)));
  const result = parser.finalize();
  assert.ok(result.lastAction.endsWith('尾部锚点'));
  assert.ok(result.lastAction.length <= 201);
});

test('坏 JSON 行容错且不阻断后续解析', () => {
  const parser = createChannelEventsParser();
  parser.feed('{"type":"session","broken"\n');
  parser.feed(line(assistantMessageEnd('正常输出')));
  parser.feed('not json at all\n');
  const result = parser.finalize();
  assert.equal(result.text, '正常输出');
});

test('chunk 切断行时按缓冲正确拼接', () => {
  const parser = createChannelEventsParser();
  const payload = JSON.stringify(assistantMessageEnd('跨 chunk 文本'));
  // 第一行被 chunk 边界切断：前半留在内部缓冲，后半到齐后整体解析。
  parser.feed(payload.slice(0, 20));
  parser.feed(payload.slice(20));
  parser.feed('\n');
  // 后续事件同样跨 chunk 切断，也能正确拼行。
  const toolPayload = JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: 'cx',
    toolName: 'write',
    args: { path: 'b' },
  });
  parser.feed(toolPayload.slice(0, 30));
  const mid = parser.finalize();
  assert.equal(mid.text, '跨 chunk 文本');
  assert.equal(mid.lastAction, '跨 chunk 文本');

  const parser2 = createChannelEventsParser();
  parser2.feed(payload.slice(0, 20));
  parser2.feed(`${payload.slice(20)}\n`);
  parser2.feed(toolPayload);
  const result = parser2.finalize();
  assert.equal(result.lastAction, '正在执行 write: {"path":"b"}');
});

test('onToolExecution 钩子每次工具调用触发一次', () => {
  const calls = [];
  const parser = createChannelEventsParser({
    onToolExecution: (toolName, summary) => calls.push([toolName, summary]),
  });
  parser.feed(line({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'pwd' } }));
  parser.feed(line({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: false }));
  assert.deepEqual(calls, [['bash', '{"command":"pwd"}']]);
});
