// REST 端点验收：heartbeat / info / poll / tasks/result / renew / reports（Bearer key）
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
  return { status: res.status, data };
}

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
};

// 管理员创建 agent 拿 key
await api('POST', '/api/login', { password: PASSWORD });
const created = await api('POST', '/api/agents', { name: 'rest-test', hostname: 't1' });
const KEY = created.data.key;
check('agent 创建', !!KEY);

// heartbeat（无 key 拒绝；有 key 通过）
const noKey = await api('POST', '/api/agent/heartbeat', {});
check('heartbeat 无 key 401', noKey.status === 401);
const hb = await api('POST', '/api/agent/heartbeat', {}, KEY);
check('heartbeat 通过', hb.data.ok === true, JSON.stringify(hb.data));
check('heartbeat 返回 agent_id', hb.data.agent_id === created.data.agent.agent_id);

// info
const info = await api('POST', '/api/agent/info', {}, KEY);
check('info 身份', info.data.name === 'rest-test');

// 创建 manual + scheduled 任务
const manual = await api('POST', '/api/tasks', {
  kind: 'manual', title: 'REST 测试任务', assignee_id: created.data.agent.id,
  instruction: '测试 REST 回传', workdir: '/tmp/proj',
});
check('manual 创建', manual.status === 201);
await api('POST', '/api/tasks', {
  kind: 'scheduled', title: 'REST 定时任务', assignee_id: created.data.agent.id,
  schedule_cron: 'daily', window_start: '00:00', window_end: '23:59',
  instruction: '测试 poll 放行',
});
const list = await api('GET', '/api/tasks');
const mTask = list.data.tasks.find((t) => t.title === 'REST 测试任务');
const sTask = list.data.tasks.find((t) => t.title === 'REST 定时任务');

// poll 前：把定时任务改为到期，然后 poll
const { createPool } = await import('mariadb');
const pool = createPool({ host: '127.0.0.1', port: 3306, user: 'root', password: 'erixPwd', database: 'task_dispatch' });
await pool.query(`UPDATE tasks SET next_due_at = DATE_SUB(NOW(), INTERVAL 30 MINUTE) WHERE task_id = ?`, [sTask.task_id]);

const poll = await api('POST', '/api/agent/poll', {}, KEY);
check('poll 领取 manual + 放行 scheduled', poll.data.tasks.length === 2, JSON.stringify(poll.data));
check('poll 含 manual 任务', poll.data.tasks.some((t) => t.task_id === mTask.task_id && t.kind === 'manual'), JSON.stringify(poll.data.tasks));
check('poll 含 scheduled 任务', poll.data.tasks.some((t) => t.task_id === sTask.task_id && t.kind === 'scheduled'), JSON.stringify(poll.data.tasks));
check('poll 返回 workdir（scheduled 无）', poll.data.tasks.find((t) => t.task_id === sTask.task_id)?.workdir === null);

// renew 续期（scheduled 放行后 running）
const renew = await api('POST', '/api/agent/tasks/renew', { task_id: sTask.task_id }, KEY);
check('renew 续期成功', renew.data.ok === true, JSON.stringify(renew.data));

// manual 协作会话：reply 回复 + resolve 关闭
const reply = await api('POST', '/api/agent/tasks/reply', {
  task_id: mTask.task_id, content: 'REST 已处理完毕',
}, KEY);
check('reply 回复成功', reply.data.ok === true, JSON.stringify(reply.data));
const resolve = await api('POST', '/api/agent/tasks/resolve', {
  task_id: mTask.task_id, final_result: 'REST 协作完成',
}, KEY);
check('resolve 关闭任务', resolve.data.ok === true, JSON.stringify(resolve.data));
const wrongReply = await api('POST', '/api/agent/tasks/reply', {
  task_id: mTask.task_id, content: '关闭后回复',
}, KEY);
check('关闭后回复被拒', wrongReply.status === 400, JSON.stringify(wrongReply.data));

// workdir 写回
const wd = await api('POST', '/api/agent/tasks/workdir', {
  task_id: sTask.task_id, workdir: '/opt/work/tasks/' + sTask.task_id,
}, KEY);
check('workdir 写回成功', wd.data.ok === true, JSON.stringify(wd.data));

// result 回传（scheduled）
const result = await api('POST', '/api/agent/tasks/result', {
  task_id: sTask.task_id, status: 'success', result: 'REST 定时任务完成',
}, KEY);
check('result 回传成功', result.data.ok === true, JSON.stringify(result.data));
const wrong = await api('POST', '/api/agent/tasks/result', {
  task_id: sTask.task_id, status: 'success', result: '重复提交',  // 已 done，应拒绝
}, KEY);
check('重复提交被拒', wrong.status === 400, JSON.stringify(wrong.data));

// 报告归档到任务
const rep = await api('POST', '/api/agent/tasks/report', {
  task_id: sTask.task_id, content: 'REST 报告内容',
}, KEY);
check('报告归档成功', rep.data.ok === true, JSON.stringify(rep.data));
const detail = await api('GET', `/api/tasks/${sTask.task_id}`);
check('任务详情含报告', detail.data.reports.length >= 1, JSON.stringify(detail.data.reports));

await pool.end();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
