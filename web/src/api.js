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
  agents: () => req('GET', '/api/agents'),
  createAgent: (payload) => req('POST', '/api/agents', payload),
  agent: (id) => req('GET', `/api/agents/${id}`),
  toggleAgent: (id) => req('POST', `/api/agents/${id}/toggle`),
  toggleAgentAccept: (id) => req('POST', `/api/agents/${id}/accept-toggle`),
  resetAgentKey: (id) => req('POST', `/api/agents/${id}/reset-key`),
  tasks: (params = {}) => req('GET', `/api/tasks?${new URLSearchParams(params)}`),
  createTask: (payload) => req('POST', '/api/tasks', payload),
  task: (id) => req('GET', `/api/tasks/${id}`),
  cancelTask: (id) => req('POST', `/api/tasks/${id}/cancel`),
  taskReply: (id, content) => req('POST', `/api/tasks/${id}/reply`, { content }),
  taskResolve: (id, final_result) => req('POST', `/api/tasks/${id}/resolve`, { final_result: final_result || undefined }),
  taskReject: (id, opinion) => req('POST', `/api/tasks/${id}/reject`, { opinion }),
  activity: () => req('GET', '/api/activity'),
  settings: () => req('GET', '/api/settings'),
  saveSettings: (payload) => req('PUT', '/api/settings', payload),
  testLlm: (model_id) => req('POST', '/api/settings/llm-test', { model_id }),
  llmScan: () => req('POST', '/api/settings/llm-scan'),
  settingsHistory: () => req('GET', '/api/settings/history'),
  llmModels: () => req('GET', '/api/settings/llm-models'),
  saveLlmModel: (payload) => req('PUT', '/api/settings/llm-models', payload),
  deleteLlmModel: (id) => req('DELETE', `/api/settings/llm-models/${id}`),
  llmCalls: () => req('GET', '/api/settings/llm-calls'),
};
