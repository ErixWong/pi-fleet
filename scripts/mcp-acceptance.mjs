// MCP 会话模型验收：协作会话（多轮）+ 定时任务（单轮）+ key 管理
import { createPool } from 'mariadb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:3000';
const PASSWORD = 'admin123';
let cookie = '';

async function api(method, path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  else if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && !key) cookie = setCookie.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function mcpClient(key) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'acceptance', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
}

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

try {
  // 1. 管理员登录 + 创建两个 agent（A 执行方 / B 发起方）
  console.log('== 1. 管理员 API ==');
  await api('POST', '/api/login', { password: PASSWORD });
  const agentA = await api('POST', '/api/agents', { name: 'sess-A', hostname: '10.0.0.1' });
  const agentB = await api('POST', '/api/agents', { name: 'sess-B', hostname: '10.0.0.2' });
  check('创建 agent A/B（key 带 pd- 前缀）', !!agentA.key?.startsWith('pd-') && !!agentB.key?.startsWith('pd-'));
  const clientA = await mcpClient(agentA.key);
  const clientB = await mcpClient(agentB.key);

  // 2. 协作会话：B 发起任务派给 A
  console.log('== 2. 协作会话（B → A，多轮） ==');
  const req = await call(clientB, 'request_task', {
    assignee: agentA.agent.agent_id,
    title: '帮忙开启代理',
    instruction: '请开启代理服务供我下载，地址告诉我。',
  });
  check('B request_task 发起成功', req.ok === true && !!req.task_id, JSON.stringify(req));
  const collabTaskId = req.task_id;

  // A poll 领取（B 发起的，A 是 assignee，最后消息=B → 待 A 回复）
  const dueA = await call(clientA, 'check_due_tasks', {});
  const collab = dueA.due_tasks.find((t) => t.task_id === collabTaskId);
  check('A 领到协作回合', !!collab && collab.kind === 'manual', JSON.stringify(dueA.due_tasks));
  check('回合附完整消息流', collab?.messages?.length === 1 && collab.messages[0].sender_role === 'agent', JSON.stringify(collab?.messages));

  // A 回复（第一轮）
  const reply1 = await call(clientA, 'post_message', { task_id: collabTaskId, content: '代理已开启 http://vps:7890' });
  check('A 回复成功', reply1.ok === true, JSON.stringify(reply1));

  // B poll 看到 A 回复（B 是 creator，最后消息 sender=A ≠ B → 待 B 回复）
  const dueB = await call(clientB, 'check_due_tasks', {});
  check('B 领到协作回合（A 回复后）', dueB.due_tasks.some((t) => t.task_id === collabTaskId), JSON.stringify(dueB.due_tasks));
  const msgs2 = await call(clientB, 'get_messages', { task_id: collabTaskId });
  check('B 看到消息流（2 条）', msgs2.messages.length === 2, JSON.stringify(msgs2.messages));

  // B 回复（第二轮）+ 关闭
  await call(clientB, 'post_message', { task_id: collabTaskId, content: '下载完成，可以关闭了' });
  const done = await call(clientB, 'resolve_task', { task_id: collabTaskId, final_result: '已关闭代理，协作完成' });
  check('B resolve 关闭任务', done.ok === true && done.status === 'resolved', JSON.stringify(done));

  // 关闭后不能回复
  const replyClosed = await call(clientA, 'post_message', { task_id: collabTaskId, content: '还想回复' });
  check('关闭后回复被拒', replyClosed.error?.includes('resolved'), JSON.stringify(replyClosed));

  // A 的 list_threads 看到任务已 resolved
  const threads = await call(clientA, 'list_threads', {});
  const t = threads.threads.find((x) => x.task_id === collabTaskId);
  check('list_threads 显示 resolved', t?.status === 'resolved', JSON.stringify(threads.threads));

  // 3. workdir 写回（沙箱任务第一回合）
  console.log('== 3. workdir 写回 ==');
  await api('POST', '/api/agent/tasks/workdir', { task_id: collabTaskId, workdir: '/opt/pi-agent/work/tasks/' + collabTaskId }, agentA.key);
  const detailA = await api('GET', `/api/tasks/${collabTaskId}`);
  check('workdir 已写回任务', detailA.task.workdir === '/opt/pi-agent/work/tasks/' + collabTaskId, JSON.stringify(detailA.task.workdir));

  // 3.5 交付物：约定 + 版本
  console.log('== 3.5 交付物（约定 + 版本） ==');
  await api('POST', '/api/tasks', {
    kind: 'manual', title: '交付物测试任务', assignee_id: agentA.agent.id,
    instruction: '实现登录模块',
    deliverable_spec: [
      { name: '代码变更', path: 'src/login.ts', criteria: '通过单测' },
      { name: '变更说明', path: 'docs/changelog.md' },
    ],
  });
  const dlList = await api('GET', '/api/tasks');
  const dlTask = dlList.tasks.find((t) => t.title === '交付物测试任务');
  check('创建任务带交付物约定', !!dlTask);

  const dlInfo = await call(clientA, 'list_deliverables', { task_id: dlTask.task_id });
  check('list_deliverables 返回约定', dlInfo.spec.length === 2, JSON.stringify(dlInfo.spec));
  check('约定含验收标准', dlInfo.spec[0].criteria === '通过单测', JSON.stringify(dlInfo.spec[0]));

  const sub1 = await call(clientA, 'submit_deliverable', {
    task_id: dlTask.task_id, name: '代码变更', path: 'src/login.ts', message: '初版实现',
  });
  check('提交交付物 v1', sub1.ok === true && sub1.version === 'v1', JSON.stringify(sub1));
  const sub2 = await call(clientA, 'submit_deliverable', {
    task_id: dlTask.task_id, name: '代码变更', path: 'src/login.ts', message: '修复 lint',
  });
  check('再次提交 v2（版本自增）', sub2.ok === true && sub2.version === 'v2', JSON.stringify(sub2));
  const subBad = await call(clientA, 'submit_deliverable', {
    task_id: dlTask.task_id, name: '不在约定', path: 'x.txt',
  });
  check('未约定交付物被拒', subBad.error?.includes('不在任务约定中'), JSON.stringify(subBad));

  const dlInfo2 = await call(clientA, 'list_deliverables', { task_id: dlTask.task_id });
  check('版本历史 2 条', dlInfo2.versions.length === 2, JSON.stringify(dlInfo2.versions));
  check('v2 为当前版本', dlInfo2.versions.find((v) => v.version === 'v2')?.current === true, JSON.stringify(dlInfo2.versions));
  const dlDetail = await api('GET', `/api/tasks/${dlTask.task_id}`);
  check('任务交付版本快照 v2', dlDetail.task.deliverable_version === 'v2', JSON.stringify(dlDetail.task.deliverable_version));
  check('详情含约定与版本', dlDetail.deliverables.spec.length === 2 && dlDetail.deliverables.versions.length === 2);

  // 4. 定时任务单轮（scheduled 走 submit_result）
  console.log('== 4. 定时任务（单轮） ==');
  await api('POST', '/api/tasks', {
    kind: 'scheduled', title: '磁盘检查单轮', assignee_id: agentA.agent.id,
    schedule_cron: 'daily', window_start: '00:00', window_end: '23:59', topic_name: 'sess-topic',
    instruction: '检查磁盘并投递报告',
  });
  const list = await api('GET', '/api/tasks');
  const sched = list.tasks.find((t) => t.title === '磁盘检查单轮');
  check('scheduled 已建', sched?.status === 'pending');

  const pool = createPool({ host: '127.0.0.1', port: 3306, user: 'root', password: 'erixPwd', database: 'task_dispatch' });
  await pool.query(`UPDATE tasks SET next_due_at = DATE_SUB(NOW(), INTERVAL 30 MINUTE) WHERE task_id = ?`, [sched.task_id]);
  const dueA2 = await call(clientA, 'check_due_tasks', {});
  const schedDue = dueA2.due_tasks.find((t) => t.task_id === sched.task_id);
  check('scheduled 放行（running）', schedDue?.kind === 'scheduled', JSON.stringify(dueA2.due_tasks));

  const prog = await call(clientA, 'report_progress', { task_id: sched.task_id, progress: '50%' });
  check('report_progress 续期', prog.renewed === true, JSON.stringify(prog));
  const sub = await call(clientA, 'submit_result', { task_id: sched.task_id, status: 'success', result: '磁盘正常，/ 42%' });
  check('submit_result 汇报', sub.ok === true, JSON.stringify(sub));
  const pub = await call(clientA, 'publish_report', { task_id: sched.task_id, content: '磁盘正常' });
  check('publish_report 归档到任务', pub.ok === true, JSON.stringify(pub));
  const schedDetail = await api('GET', `/api/tasks/${sched.task_id}`);
  check('任务详情含报告', schedDetail.reports.length >= 1, JSON.stringify(schedDetail.reports));

  // 5. key 重置（A 的 key 重置后旧 key 失效）
  console.log('== 5. key 管理 ==');
  const reset = await api('POST', `/api/agents/${agentA.agent.id}/reset-key`);
  check('重置返回新 key', !!reset.key?.startsWith('pd-'));
  let oldRejected = false;
  try {
    const oldClient = await mcpClient(agentA.key);
    await call(oldClient, 'whoami', {});
  } catch { oldRejected = true; }
  check('旧 key 被拒', oldRejected);

  await pool.end();
  await clientA.close();
  await clientB.close();

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
} catch (e) {
  console.error('\n验收异常:', e.message);
  process.exit(1);
}
