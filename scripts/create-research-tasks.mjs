// 创建 3 个资料收集任务（指派给 local-pi，id=14）
const BASE = 'http://127.0.0.1:3000';
const PASSWORD = 'admin123';
let cookie = '';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

await api('POST', '/api/login', { password: PASSWORD });

const tasks = [
  {
    title: '调研 MariaDB 12 向量检索',
    instruction:
      '使用 unifuncs MCP server 的搜索工具调研 MariaDB 12.x 的向量检索能力（VECTOR 列类型、VEC_DISTANCE() 函数、ANN/HNSW 索引）。' +
      '必要时用网页抓取工具读 1-2 个权威页面。输出一份中文总结，包含：版本要求、建表示例、建向量索引、相似度查询示例。' +
      '完成后用 MCP task 工具的 task(submit, result=总结文本) 提交验收（scheduled 直接记录；manual 走程序预检+发起人验收）。',
  },
  {
    title: '抓取 pi.dev 总结 Pi 四种模式',
    instruction:
      '使用 unifuncs MCP server 的网页抓取工具，抓取 https://pi.dev 首页（可补充抓取 docs 页面），' +
      '总结 pi-coding-agent 的四种使用模式（interactive / print/JSON / RPC / SDK）及各自适用场景。' +
      '完成后用 MCP task 工具的 task(submit, result=总结文本) 提交验收。',
  },
  {
    title: '调研自托管 AI agent 编排框架',
    instruction:
      '使用 unifuncs MCP server 的搜索工具，调研 2026 年较活跃的自托管（self-hosted）AI agent 编排/任务分发开源框架，' +
      '筛选 2-3 个，对比特性（任务队列、多 agent 支持、Web UI、MCP 支持、活跃度），给出推荐。' +
      '完成后用 MCP task 工具的 task(submit, result=总结文本) 提交验收。',
  },
];

for (const t of tasks) {
  await api('POST', '/api/tasks', { kind: 'manual', assignee_id: 14, ...t });
  console.log(`已创建: ${t.title}`);
}

const { tasks: list } = await api('GET', '/api/tasks');
const mine = list.filter((t) => t.assignee === 'local-pi' && t.status === 'pending');
for (const t of mine) console.log(`  ${t.task_id} | ${t.title}`);
