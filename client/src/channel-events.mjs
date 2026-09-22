// pi --mode json 事件流解析器（纯函数，可单测）。
//
// pi JSON 模式把全部会话事件按行输出到 stdout（见 pi 文档 docs/json.md）：
// 首行是 session 头，之后是 agent/turn/message/tool_execution 等事件，
// assistant 的最终文本以 message_end 中 content 的 text 块为准。
// daemon 用本模块把事件流桥接回「逐字无损的最终文本 + 工具调用轨迹 + 最后动作」，
// 让通道对话过程对用户可见，并在超时时能报告 pi 卡在哪一步。

const TOOL_SUMMARY_MAX = 120;
const LAST_ACTION_TEXT_TAIL = 200;

function summarizeArgs(args) {
  let serialized;
  try {
    serialized = JSON.stringify(args ?? null);
  } catch {
    serialized = String(args);
  }
  const flattened = serialized.replace(/\s+/g, ' ').trim();
  if (flattened.length <= TOOL_SUMMARY_MAX) return flattened;
  return `${flattened.slice(0, TOOL_SUMMARY_MAX - 1)}…`;
}

function extractAssistantText(message) {
  if (!message || typeof message !== 'object') return '';
  if (message.role !== 'assistant') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export function createChannelEventsParser(options = {}) {
  const onToolExecution = typeof options.onToolExecution === 'function'
    ? options.onToolExecution
    : null;

  let buffer = '';
  // 最后一个 assistant message_end 的 text（可能为空，如上游 relay 故障）。
  let lastAssistantText = '';
  // 最后一个非空 assistant text，用于最终文本为空时的回退（对齐旧 stdout 语义）。
  let lastNonEmptyAssistantText = '';
  // 每次工具调用一行轨迹。
  const traceLines = [];
  // start 未收到配对 end 的工具（toolCallId -> { toolName, summary }）。
  const pendingTools = new Map();

  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'session':
      case 'message_update':
        // 会话头与流式增量：message_end 才是权威消息，这里全部忽略。
        return;
      case 'message_end': {
        const text = extractAssistantText(event.message);
        lastAssistantText = text;
        if (text.trim()) lastNonEmptyAssistantText = text;
        return;
      }
      case 'tool_execution_start': {
        const toolName = String(event.toolName ?? 'unknown');
        const summary = summarizeArgs(event.args);
        pendingTools.set(String(event.toolCallId ?? ''), { toolName, summary });
        if (onToolExecution) onToolExecution(toolName, summary);
        return;
      }
      case 'tool_execution_end': {
        const toolCallId = String(event.toolCallId ?? '');
        const pending = pendingTools.get(toolCallId);
        pendingTools.delete(toolCallId);
        const toolName = pending?.toolName ?? String(event.toolName ?? 'unknown');
        const summary = pending?.summary ?? summarizeArgs(event.args);
        traceLines.push(
          `🔧 ${toolName}: ${summary}${event.isError ? '（出错）' : ''}`,
        );
        return;
      }
      default:
        // 其余事件（agent/turn 生命周期、auto_retry 等）不参与桥接。
        return;
    }
  }

  function processLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // 坏行容错：忽略无法解析的输出（如 pi 的告警行），不打断整体解析。
      return;
    }
    handleEvent(event);
  }

  return {
    // 喂入一段 stdout chunk；内部按 \n 缓冲切行，chunk 切断的行会留到下一块。
    feed(chunk) {
      buffer += String(chunk ?? '');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    },
    // 流结束时调用：冲刷缓冲区剩余内容并返回桥接结果。
    finalize() {
      if (buffer) {
        const rest = buffer;
        buffer = '';
        processLine(rest);
      }
      let lastAction = '';
      if (pendingTools.size > 0) {
        const pending = pendingTools.values().next().value;
        lastAction = `正在执行 ${pending.toolName}: ${pending.summary}`;
      } else if (lastNonEmptyAssistantText) {
        const tail = lastNonEmptyAssistantText.slice(-LAST_ACTION_TEXT_TAIL);
        lastAction = tail.length < lastNonEmptyAssistantText.length
          ? `…${tail}`
          : tail;
      }
      return {
        text: lastAssistantText !== '' ? lastAssistantText : lastNonEmptyAssistantText,
        trace: traceLines.join('\n'),
        lastAction,
      };
    },
  };
}
