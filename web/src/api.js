const API_ROOT = '/api/v2';

function queryString(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

function authHeaders() {
  const key = localStorage.getItem('pm_key');
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function parseResponse(res) {
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) return res.json().catch(() => ({}));
  return res.text().catch(() => '');
}

async function req(method, path, body) {
  const headers = { ...authHeaders() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    localStorage.removeItem('pm_key');
    if (path !== '/login') window.location.replace('/login');
    const err = new Error('登录已过期，请重新登录');
    err.status = 401;
    throw err;
  }
  const data = await parseResponse(res);
  if (!res.ok) {
    const message = data && typeof data === 'object' ? data.error : '';
    throw new Error(message || res.statusText || `请求失败（${res.status}）`);
  }
  return data;
}

async function attachmentRequest(id) {
  const res = await fetch(attachmentUrl(id), { headers: authHeaders() });
  if (res.status === 401) {
    localStorage.removeItem('pm_key');
    window.location.replace('/login');
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) {
    const data = await parseResponse(res);
    const message = data && typeof data === 'object' ? data.error : '';
    throw new Error(message || res.statusText || `附件请求失败（${res.status}）`);
  }
  return {
    blob: await res.blob(),
    filename: res.headers.get('content-disposition') || '',
  };
}

function attachmentUrl(id) {
  return `${API_ROOT}/attachments/${encodeURIComponent(id)}`;
}

export const api = {
  login: (username, password) => req('POST', '/login', { username, password }),
  whoami: () => req('GET', '/whoami'),
  logout() {
    localStorage.removeItem('pm_key');
  },

  hosts: () => req('GET', '/hosts'),
  createHost: (payload) => req('POST', '/hosts', payload),
  updateHost: (id, payload) => req('PATCH', `/hosts/${encodeURIComponent(id)}`, payload),
  deleteHost: (id) => req('DELETE', `/hosts/${encodeURIComponent(id)}`),
  rotateHostKey: (id) => req('POST', `/hosts/${encodeURIComponent(id)}/keys/rotate`),

  tasks: (params = {}) => req('GET', `/tasks${queryString(params)}`),
  post: (id) => req('GET', `/posts/${encodeURIComponent(id)}`),
  postList: (params = {}) => req('GET', `/posts${queryString(params)}`),
  createTask: (payload) => req('POST', '/tasks', payload),
  claimTask: (id) => req('POST', `/tasks/${encodeURIComponent(id)}/claim`),
  submitTask: (id, payload) => req('POST', `/tasks/${encodeURIComponent(id)}/submit`, payload),
  verdictTask: (id, payload) => req('POST', `/tasks/${encodeURIComponent(id)}/verdict`, payload),
  reopenTask: (id, payload = {}) => req('POST', `/tasks/${encodeURIComponent(id)}/reopen`, payload),
  replyPost: (id, payload) => req('POST', `/posts/${encodeURIComponent(id)}/reply`, payload),

  events: (params = {}) => req('GET', `/events${queryString(params)}`),
  attachmentUrl,
  attachmentBlob: attachmentRequest,
};
