// 验证多机场景：指派给 vm-02 的任务，local-pi（vm-01）poll 领不到
const BASE = 'http://127.0.0.1:3000';
const PASSWORD = 'admin123';
let cookie = '';

async function api(method, path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  else if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, {
    method, headers, credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && !key) cookie = setCookie.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// 1. 注册电脑B（vm-02）
await api('POST', '/api/login', { password: PASSWORD });
const vm02 = await api('POST', '/api/agents', {
  name: 'vm-02', hostname: '192.168.1.102', tags: 'worker',
  system_prompt: '你是 vm-02 的 agent，负责该机器上的数据同步任务。',
});
console.log(`注册 vm-02: ${vm02.agent.agent_id} key=${vm02.key.slice(0, 10)}...`);

// 2. 创建任务指派给 vm-02
await api('POST', '/api/tasks', {
  kind: 'manual', title: 'vm-02 专属任务', assignee_id: vm02.agent.id,
  instruction: '在 vm-02 上列出 /srv/data 目录结构并汇报。',
});
console.log('已创建任务「vm-02 专属任务」，指派给 vm-02');

// 3. 隔离验证：local-pi（vm-01 的 key）poll —— 应领不到
const localPiKey = 'pd-4oWT316ZFqiFWb-HDM9Z6cxs1m-Xw6O9';
const p1 = await api('POST', '/api/agent/poll', {}, localPiKey);
console.log(`local-pi（vm-01）poll: ${p1.tasks.length} 个任务 → ${p1.tasks.length === 0 ? '✅ 领不到 vm-02 的任务（隔离正确）' : '❌ 异常'}`);

// 4. vm-02 的 key poll —— 应领到 1 个
const p2 = await api('POST', '/api/agent/poll', {}, vm02.key);
console.log(`vm-02 poll: ${p2.tasks.length} 个任务 → ${p2.tasks.map((t) => t.task_id).join(', ')}`);
console.log(`vm-02 领到专属任务: ${p2.tasks.some((t) => t.title === 'vm-02 专属任务') ? '✅' : '❌'}`);
