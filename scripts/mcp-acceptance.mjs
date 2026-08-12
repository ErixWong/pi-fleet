// MCP 全流程验收脚本：管理员 API + MCP client 六工具闭环
import { createPool } from 'mariadb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

try {
  // 1. 管理员登录 + 创建 agent
  console.log('== 1. 管理员 API ==');
  await api('POST', '/api/login', { password: PASSWORD });
  console.log('== 2. 创建 agent ==');
  const { agent, key } = await api('POST', '/api/agents', {
    name: 'test-agent-01', hostname: '10.0.0.5', tags: 'test',
    system_prompt: '你是测试 agent，负责平台验收。',
  });
  check('agent 创建（返回 key）', !!agent && !!key);
  check('key 带 pd- 前缀', key.startsWith('pd-'), key.slice(0, 6));
  console.log(`   agent_id=${agent.agent_id} key=${key.slice(0, 10)}...`);

  // 3. 创建 manual + scheduled 任务
  console.log('== 3. 创建任务 ==');
  await api('POST', '/api/tasks', {
    kind: 'manual', title: '修复登录页 500', assignee_id: agent.id,
    workdir: '/home/dev/projects/prjxxx1',
    instruction: '检查 src/login.ts 的 500 错误并修复，说明根因。',
  });
  await api('POST', '/api/tasks', {
    kind: 'scheduled', title: '每日磁盘检查', assignee_id: agent.id,
    schedule_cron: 'daily', window_start: '23:00', window_end: '23:59',
    topic_name: 'disk-report',
    instruction: '检查 / 与 /var 分区磁盘使用率，投递报告到 disk-report 主题。',
  });
  const { tasks } = await api('GET', '/api/tasks');
  const manual = tasks.find((t) => t.title === '修复登录页 500');
  const sched = tasks.find((t) => t.title === '每日磁盘检查');
  check('manual 任务已建', manual?.status === 'pending');
  check('scheduled 任务已建', sched?.status === 'pending', JSON.stringify(sched));
  console.log(`   scheduled next_due_at=${sched?.next_due_at}`);

  // 4. MCP client 全流程
  console.log('== 4. MCP 客户端 ==');
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'acceptance', version: '1.0.0' });
  await client.connect(transport);

  const who = await client.callTool({ name: 'whoami', arguments: {} });
  const whoText = JSON.parse(who.content[0].text);
  check('whoami 身份正确', whoText.agent_id === agent.agent_id, JSON.stringify(whoText));

  const list = await client.callTool({ name: 'list_my_tasks', arguments: {} });
  const listData = JSON.parse(list.content[0].text);
  check('list_my_tasks 看到 2 个任务', listData.tasks.length === 2, JSON.stringify(listData));

  const fetchRes = await client.callTool({ name: 'fetch_task', arguments: { task_id: manual.task_id } });
  const fetchData = JSON.parse(fetchRes.content[0].text);
  check('fetch_task 拉到指令', fetchData.instruction?.includes('500'), String(fetchData.instruction));
  check('fetch_task 返回 workdir', fetchData.workdir === '/home/dev/projects/prjxxx1', String(fetchData.workdir));

  // 把定时任务 next_due_at 改到过去，验证 check_due_tasks 放行 + 推进
  const pool = createPool({
    host: '127.0.0.1', port: 3306, user: 'root', password: 'erixPwd', database: 'task_dispatch',
  });
  await pool.query(`UPDATE tasks SET next_due_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE task_id = ?`, [sched.task_id]);
  const oldDue = sched.next_due_at;
  const due = await client.callTool({ name: 'check_due_tasks', arguments: {} });
  const dueData = JSON.parse(due.content[0].text);
  check('check_due_tasks 领取 manual + 放行 scheduled', dueData.due_tasks.length === 2, JSON.stringify(dueData));
  check('manual 被领取（running）', dueData.due_tasks.some((t) => t.task_id === manual.task_id && t.kind === 'manual'), JSON.stringify(dueData.due_tasks));
  check('scheduled 被放行（running）', dueData.due_tasks.some((t) => t.task_id === sched.task_id && t.kind === 'scheduled'), JSON.stringify(dueData.due_tasks));

  // report_progress 续期（长任务防误杀核心）
  const prog = await client.callTool({
    name: 'report_progress',
    arguments: { task_id: sched.task_id, progress: '正在检查磁盘，已 50%' },
  });
  const progData = JSON.parse(prog.content[0].text);
  check('report_progress 续期成功', progData.renewed === true, JSON.stringify(progData));
  const act = await pool.query(`SELECT last_activity_at FROM tasks WHERE task_id = ?`, [sched.task_id]);
  check('last_activity_at 已记录', !!act[0]?.last_activity_at, JSON.stringify(act[0]));

  const submit = await client.callTool({
    name: 'submit_result',
    arguments: { task_id: manual.task_id, status: 'success', result: '已修复：500 源于空指针异常，已加空值判断并补充单测。' },
  });
  check('submit_result 汇报成功', JSON.parse(submit.content[0].text).ok === true);

  const pub = await client.callTool({
    name: 'publish_report',
    arguments: { topic: 'disk-report', content: '磁盘使用率正常：/ 42%，/var 55%', task_id: sched.task_id },
  });
  console.log('   publish_report 原始返回:', JSON.stringify(pub));
  const pubData = JSON.parse(pub.content[0].text);
  check('publish_report 投递成功', pubData.ok === true, JSON.stringify(pubData));

  await client.close();
  await pool.end();

  // 5. 结果验证（管理员视角）
  console.log('== 5. 结果验证 ==');
  const mt = await api('GET', `/api/tasks/${manual.task_id}`);
  check('manual 任务状态 done', mt.task.status === 'done', mt.task.status);
  check('manual 结果已记录', mt.task.result?.includes('空指针'));
  const topic = await api('GET', '/api/topics/disk-report');
  check('主题下报告存在', topic.reports.length >= 1, JSON.stringify(topic.reports));
  const st = await api('GET', `/api/tasks/${sched.task_id}`);
  check('scheduled 放行后 running', st.task.status === 'running', st.task.status);
  // next_due_at 是窗口内随机值，断言"推进到了未来"而非"比旧值大"
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const nowLocal = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  check('scheduled next_due_at 已推进到未来', st.task.next_due_at > nowLocal, `${nowLocal} -> ${st.task.next_due_at}`);

  // 6. key 重置：新 key 生效、旧 key 失效
  console.log('== 6. key 重置 ==');
  const reset = await api('POST', `/api/agents/${agent.id}/reset-key`);
  check('重置返回新 key（pd- 前缀）', !!reset.key && reset.key.startsWith('pd-'));
  // 旧 key 连接 MCP 应失败
  let oldKeyRejected = false;
  try {
    const oldTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    });
    const oldClient = new Client({ name: 'acceptance-old', version: '1.0.0' });
    await oldClient.connect(oldTransport);
    await oldClient.callTool({ name: 'whoami', arguments: {} });
    await oldClient.close();
  } catch {
    oldKeyRejected = true;
  }
  check('旧 key 已被拒绝', oldKeyRejected);
  // 新 key 可正常连接
  const newTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${reset.key}` } },
  });
  const newClient = new Client({ name: 'acceptance-new', version: '1.0.0' });
  await newClient.connect(newTransport);
  const newWho = await newClient.callTool({ name: 'whoami', arguments: {} });
  check('新 key 身份正确', JSON.parse(newWho.content[0].text).agent_id === agent.agent_id);
  await newClient.close();

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
} catch (e) {
  console.error('\n验收异常:', e.message);
  process.exit(1);
}
