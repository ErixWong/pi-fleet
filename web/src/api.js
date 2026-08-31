async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    if (!url.endsWith('/me') && !url.endsWith('/login')) {
      window.location.href = '/login';
    }
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const api = {
  me: () => req('GET', '/api/me'),
  login: (password) => req('POST', '/api/login', { password }),
  logout: () => req('POST', '/api/logout'),
  stats: () => req('GET', '/api/stats'),
  events: (params = {}) => req('GET', `/api/events?${new URLSearchParams(params)}`),
  agents: (page = 1, pageSize = 10, tag = '') => req('GET', `/api/agents?page=${page}&page_size=${pageSize}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`),
  agentsAll: () => req('GET', '/api/agents?all=1'),
  tags: () => req('GET', '/api/tags'),
  setAgentTags: (id, tags) => req('POST', `/api/agents/${id}/tags`, { tags }),
  setTaskTags: (id, tags) => req('POST', `/api/tasks/${id}/tags`, { tags }),
  createAgent: (payload) => req('POST', '/api/agents', payload),
  agent: (id, params = {}) => req('GET', `/api/agents/${id}?${new URLSearchParams(params)}`),
  toggleAgent: (id) => req('POST', `/api/agents/${id}/toggle`),
  updateAgent: (id, payload) => req('PUT', `/api/agents/${id}`, payload),
  toggleAgentAccept: (id) => req('POST', `/api/agents/${id}/accept-toggle`),
  resetAgentKey: (id) => req('POST', `/api/agents/${id}/reset-key`),
  deleteAgent: (id) => req('POST', `/api/agents/${id}/delete`),
  tasks: (params = {}) => req('GET', `/api/tasks?${new URLSearchParams(params)}`),
  createTask: (payload) => req('POST', '/api/tasks', payload),
  task: (id, params = {}) => req('GET', `/api/tasks/${id}?${new URLSearchParams(params)}`),
  cancelTask: (id) => req('POST', `/api/tasks/${id}/cancel`),
  taskReply: (id, content) => req('POST', `/api/tasks/${id}/reply`, { content }),
  taskResolve: (id, final_result) => req('POST', `/api/tasks/${id}/resolve`, { final_result: final_result || undefined }),
  taskReject: (id, opinion) => req('POST', `/api/tasks/${id}/reject`, { opinion }),
  taskReopen: (id) => req('POST', `/api/tasks/${id}/reopen`),
  taskReassign: (id, assignee_agent_id) => req('POST', `/api/tasks/${id}/reassign`, { assignee_agent_id }),
  taskDeliverableVisibility: (id, value) => req('POST', `/api/tasks/${id}/deliverable-visibility`, { value }),
  activity: (page = 1, pageSize = 10) => req('GET', `/api/activity?page=${page}&page_size=${pageSize}`),
  plans: (page = 1, pageSize = 10) => req('GET', `/api/plans?page=${page}&page_size=${pageSize}`),
  createPlan: (payload) => req('POST', '/api/plans', payload),
  plan: (id) => req('GET', `/api/plans/${id}`),
  settings: () => req('GET', '/api/settings'),
  saveSettings: (payload) => req('PUT', '/api/settings', payload),
  testLlm: (opts) => req('POST', '/api/settings/llm-test', opts || {}),
  llmScan: () => req('POST', '/api/settings/llm-scan'),
  settingsHistory: (page = 1, pageSize = 10) => req('GET', `/api/settings/history?page=${page}&page_size=${pageSize}`),
  llmProviders: () => req('GET', '/api/settings/llm-providers'),
  saveLlmProvider: (payload) => req('PUT', '/api/settings/llm-providers', payload),
  deleteLlmProvider: (id) => req('DELETE', `/api/settings/llm-providers/${id}`),
  llmModels: () => req('GET', '/api/settings/llm-models'),
  saveLlmModel: (payload) => req('PUT', '/api/settings/llm-models', payload),
  deleteLlmModel: (id) => req('DELETE', `/api/settings/llm-models/${id}`),
  llmCalls: (page = 1, pageSize = 10) => req('GET', `/api/settings/llm-calls?page=${page}&page_size=${pageSize}`),
  // 对话通道（管理员 ↔ agent 独立对话；多会话：主机会话可新建/重命名/设运行用户，目录从主机 projects 列表选择）
  conversations: (page = 1, pageSize = 10) => req('GET', `/api/conversations?page=${page}&page_size=${pageSize}`),
  createConversation: (payload) => req('POST', '/api/conversations', payload),
  conversation: (id) => req('GET', `/api/conversations/${id}`),
  agentConversations: (id, page = 1, pageSize = 20) => req('GET', `/api/agents/${id}/conversations?page=${page}&page_size=${pageSize}`),
  agentProjects: (id) => req('GET', `/api/agents/${id}/projects`),
  rescanAgentProjects: (id) => req('POST', `/api/agents/${id}/projects-rescan`),
  renameConversation: (id, name) => req('POST', `/api/conversations/${id}/rename`, { name }),
  setConversationRunUser: (id, runUser) => req('POST', `/api/conversations/${id}/run-user`, { run_user: runUser }),
  conversationMessages: (id, page = 1, pageSize = 20) => req('GET', `/api/conversations/${id}/messages?page=${page}&page_size=${pageSize}`),
  conversationSince: (id, sinceId) => req('GET', `/api/conversations/${id}/messages/since?since_id=${sinceId}`),
  sendChatMessage: (id, content) => req('POST', `/api/conversations/${id}/messages`, { content }),
  archiveConversation: (id) => req('POST', `/api/conversations/${id}/archive`),
};
