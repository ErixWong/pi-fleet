import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { findAgentByKey } from './auth.js';
import { query } from './db.js';
import { appendStreaming, finalizeStreaming } from './service/chat.js';

/**
 * 对话实时通道（chat bridge ↔ 平台）：
 * - agent 桥接器连 /api/agent/chat-stream（Bearer 认证），平台推送 conv_new_message（管理员发消息）
 * - 桥接器回推 pi 流式事件：conv_stream_start / conv_stream / conv_stream_end（打字机）
 * - 管理端浏览器不连 WS：前端 300ms 轮询增量（chatMessagesSince）渲染打字机，避免 WS 认证复杂度
 */

class ChatHub {
  private agents = new Map<number, WebSocket>();

  registerAgent(agentId: number, ws: WebSocket): void {
    const old = this.agents.get(agentId);
    if (old && old.readyState === WebSocket.OPEN) old.close(4000, 'replaced');
    this.agents.set(agentId, ws);
    ws.on('close', () => {
      if (this.agents.get(agentId) === ws) this.agents.delete(agentId);
    });
    ws.on('error', () => {
      if (this.agents.get(agentId) === ws) this.agents.delete(agentId);
    });
  }

  /** 推消息给某 agent 的桥接器（管理员发消息时） */
  publishToAgent(agentId: number, event: unknown): void {
    const ws = this.agents.get(agentId);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  agentOnline(agentId: number): boolean {
    const ws = this.agents.get(agentId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }
}

export const chatHub = new ChatHub();

/** 桥接器回推的流式事件处理：写 chat_messages（streaming 中间态 → 最终落库） */
async function handleAgentEvent(agentId: number, evt: Record<string, unknown>): Promise<void> {
  const type = String(evt.type ?? '');
  const convId = String(evt.conversation_id ?? '');
  if (!type || !convId) return;
  try {
    // 归属校验：该对话必须属于当前 agent（防止越权写别的对话）
    const own = (await query(`SELECT id FROM conversations WHERE conversation_id = ? AND agent_id = ? AND status='open'`, [convId, agentId])) as Array<Record<string, unknown>>;
    console.log(`[ws] agent ${agentId} 事件 ${type} conv=${convId} own=${own.length}`);
    if (own.length === 0) return;
    if (type === 'conv_stream_start') {
      await appendStreaming(convId, '');
    } else if (type === 'conv_stream') {
      await appendStreaming(convId, String(evt.delta ?? ''));
    } else if (type === 'conv_stream_end') {
      const final = await finalizeStreaming(convId);
      // 有完整内容则覆盖最近一条 agent 消息（流式累积可能缺头/尾）
      if (evt.content && final) {
        await query(`UPDATE chat_messages SET content = ? WHERE id = ?`, [String(evt.content).slice(0, 60000), Number(final.id)]);
      }
    }
  } catch (e) {
    // 流式写入失败不影响主流程（前端下次轮询会看到最终落库）
    console.log(`[ws] 事件处理异常 ${type}: ${String(e)}`);
  }
}

/** 挂载 WS（需 http server；/api/agent/chat-stream，Bearer 认证） */
export function mountChatWs(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/api/agent/chat-stream' });
  wss.on('connection', async (ws, req) => {
    const auth = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const agent = m ? await findAgentByKey(m[1].trim()) : null;
    if (!agent) {
      ws.close(4001, 'unauthorized');
      return;
    }
    chatHub.registerAgent(agent.id, ws);
    console.log(`[ws] agent ${agent.id} (${agent.name}) 已连接`);
    ws.send(JSON.stringify({ type: 'ready', agent_id: agent.agentId }));
    ws.on('message', (raw) => {
      console.log(`[ws] 收到原始消息: ${String(raw).slice(0, 120)}`);
      try {
        void handleAgentEvent(agent.id, JSON.parse(String(raw)));
      } catch (e) {
        console.log(`[ws] 解析失败: ${String(e)}`);
      }
    });
  });
}
