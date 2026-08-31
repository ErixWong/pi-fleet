// REST 端点验收：heartbeat / info / poll / tasks/result / renew / reports（Bearer key）
import 'dotenv/config';

const BASE = process.env.TEST_BASE ?? 'http://127.0.0.1:3000';
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

// 验收假设 LLM 未配置（门禁降级路径）：临时禁用真实 provider，跑完恢复
const savedProviders = [];
{
  const { providers } = await api('GET', '/api/settings/llm-providers');
  for (const p of providers ?? []) {
    if (p.enabled) {
      savedProviders.push(p.id);
      await api('PUT', '/api/settings/llm-providers', { ...p, api_key: undefined, enabled: false });
    }
  }
}
const restoreLlm = async () => {
  for (const id of savedProviders) {
    const { providers } = await api('GET', '/api/settings/llm-providers');
    const p = (providers ?? []).find((x) => x.id === id);
    if (p) await api('PUT', '/api/settings/llm-providers', { ...p, api_key: undefined, enabled: true });
  }
};

const { createPool } = await import('mariadb');
const pool = createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'task_dispatch',
});

let exitCode = 0;
try {
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

// 新模型基建：创建验收 plan（一个顺序 stage）——任务必须从属 stage
async function createTestPlan(name) {
  const r = await api('POST', '/api/plans', {
    name, stages: [{ name: '阶段1', wait_prev: 1, recurrence: 'none', tasks: [] }],
  });
  const tree = await api('GET', `/api/plans/${r.data.plan_id}`);
  return { plan_id: r.data.plan_id, stage_id: tree.data.plan.stages[0].id };
}
const plan = await createTestPlan('REST 验收计划');

// 创建任务（强制挂 stage）+ 无 stage 拒绝
const noStage = await api('POST', '/api/tasks', {
  title: '无 stage 任务', assignee_id: created.data.agent.id, instruction: 'x',
});
check('任务必须从属 stage（缺 stage 拒绝）', noStage.status === 400, JSON.stringify(noStage.data));
const manual = await api('POST', '/api/tasks', {
  title: 'REST 测试任务', plan_id: plan.plan_id, stage_id: plan.stage_id,
  assignee_id: created.data.agent.id, instruction: '测试 REST 回传', workdir: `~/projects/rest-test-${Date.now()}`,  // 唯一 workdir 防同目录互踩
});
check('任务创建（挂 stage）', manual.status === 201, JSON.stringify(manual.data));
const list = await api('GET', '/api/tasks');
const mTask = list.data.tasks.find((t) => t.title === 'REST 测试任务');
check('列表含新任务', !!mTask, JSON.stringify(list.data.tasks));

// poll 领取（协作回合）
const poll = await api('POST', '/api/agent/poll', {}, KEY);
check('poll 领取 manual 任务', poll.data.tasks.some((t) => t.task_id === mTask.task_id), JSON.stringify(poll.data));
check('poll 返回 workdir', poll.data.tasks.find((t) => t.task_id === mTask.task_id)?.workdir?.startsWith('~/projects/rest-test-'));

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

// 第二个任务：workdir 写回 + result 回传 + 报告归档（协作闭环）
const t2 = await api('POST', '/api/tasks', {
  title: 'REST 结果任务', plan_id: plan.plan_id, stage_id: plan.stage_id,
  assignee_id: created.data.agent.id, instruction: '测试 result 回传',
});
check('第二任务创建', t2.status === 201, JSON.stringify(t2.data));
const list2 = await api('GET', '/api/tasks');
const sTask = list2.data.tasks.find((t) => t.title === 'REST 结果任务');
await api('POST', '/api/agent/claim', { task_id: sTask.task_id }, KEY);

// workdir 写回
const wd = await api('POST', '/api/agent/tasks/workdir', {
  task_id: sTask.task_id, workdir: '/opt/work/tasks/' + sTask.task_id,
}, KEY);
check('workdir 写回成功', wd.data.ok === true, JSON.stringify(wd.data));

// result 回传
const result = await api('POST', '/api/agent/tasks/result', {
  task_id: sTask.task_id, status: 'success', result: 'REST 任务完成',
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

// 定时 stage（stage 级周期生成）：创建带定时 stage 的 plan → 触发扫描 → 生成 periodic 任务
console.log('== 定时 stage（周期生成） ==');
const schedPlan = await api('POST', '/api/plans', {
  name: 'REST 定时 stage 计划',
  stages: [{
    name: '每日巡检', wait_prev: 1, recurrence: 'daily', window_start: '00:00', window_end: '23:59',
    tasks: [{ title: '巡检模板', instruction: '检查并报告', assignee: created.data.agent.agent_id, visibility: 'private' }],
  }],
});
check('定时 stage plan 创建', schedPlan.status === 201, JSON.stringify(schedPlan.data));
// 提前 next_due + 首实例置 done（模拟完成）→ llm-scan 驱动周期生成（LLM 已禁用，扫描快速）
await pool.query(`UPDATE plan_stages SET next_due_at = DATE_SUB(NOW(), INTERVAL 30 MINUTE) WHERE plan_id = (SELECT id FROM plans WHERE plan_id = ?)`, [schedPlan.data.plan_id]);
await pool.query(`UPDATE tasks SET status='done', result='首轮完成', result_status='success' WHERE stage_id = (SELECT id FROM plan_stages WHERE plan_id = (SELECT id FROM plans WHERE plan_id = ?)) AND origin='periodic'`, [schedPlan.data.plan_id]);
await api('POST', '/api/settings/llm-scan', {}, undefined);
const schedTree = await api('GET', `/api/plans/${schedPlan.data.plan_id}`);
const schedTasks = schedTree.data.plan.stages[0].tasks;
check('定时 stage 周期生成（首实例 done → 本轮生成）', schedTasks.length >= 2, JSON.stringify(schedTasks.map((t) => ({ id: t.task_id, origin: t.origin, status: t.status }))));
check('生成任务 origin=periodic', schedTasks.every((t) => t.origin === 'periodic'), JSON.stringify(schedTasks.map((t) => t.origin)));
// 再扫：最新实例未完成 → 跳过本轮（防堆积）
await api('POST', '/api/settings/llm-scan', {}, undefined);
const schedTree2 = await api('GET', `/api/plans/${schedPlan.data.plan_id}`);
const schedTasks2 = schedTree2.data.plan.stages[0].tasks;
check('未完成实例跳过本轮（防堆积）', schedTasks2.length === schedTasks.length, JSON.stringify(schedTasks2.map((t) => t.status)));

// 定时 stage 手动追加拒绝
const appendReject = await api('POST', '/api/tasks', {
  title: '追加到定时 stage', plan_id: schedPlan.data.plan_id, stage_id: schedTree.data.plan.stages[0].id,
  assignee_id: created.data.agent.id, instruction: 'x',
});
check('定时 stage 手动追加拒绝', appendReject.status === 400, JSON.stringify(appendReject.data));

// 开放生态：公共池 REST（§8）：二段式程序扫描 + 认领
console.log('== 开放生态：公共池 REST ==');
const pubTask = await api('POST', '/api/tasks', {
  title: 'REST 公共池任务', plan_id: plan.plan_id, stage_id: plan.stage_id, visibility: 'public',
  instruction: '公开任务：需要整理 CSV 数据',
  deliverable_spec: [{ name: '数据文件', min_count: 1, type: '.csv' }],
});
check('管理员创建公开任务', pubTask.status === 201, JSON.stringify(pubTask.data));
const poolAll = await api('POST', '/api/agent/pool', {}, KEY);
const mine = poolAll.data.pool.find((t) => t.title === 'REST 公共池任务');
check('pool 列表可见（程序扫描，零 token）', !!mine, JSON.stringify(poolAll.data.pool));
check('pool 带完整指令与验收方案', mine?.instruction.includes('CSV') && mine?.deliverable_spec?.[0]?.type === '.csv', JSON.stringify(mine));

// 未开接单开关（rest-test 默认关）认领应被拒
const noOpen = await api('POST', '/api/agent/claim', { task_id: mine.task_id }, KEY);
check('未开接单开关认领被拒', noOpen.status === 400 && noOpen.data.error.includes('接单开关'), JSON.stringify(noOpen.data));

// 开启接单开关后认领成功
await api('POST', `/api/agents/${created.data.agent.id}/accept-toggle`, {}, undefined);
const okClaim = await api('POST', '/api/agent/claim', { task_id: mine.task_id }, KEY);
check('开启接单开关后认领成功（mode=pool）', okClaim.data.ok === true && okClaim.data.mode === 'pool', JSON.stringify(okClaim.data));
const again = await api('POST', '/api/agent/claim', { task_id: mine.task_id }, KEY);
check('重复认领被拒', again.status === 400, JSON.stringify(again.data));
const detail2 = await api('GET', `/api/tasks/${mine.task_id}`);
check('认领后状态 claimed、可见性 public', detail2.data.task.status === 'claimed' && detail2.data.task.visibility === 'public', JSON.stringify(detail2.data.task));

// 附件系统 REST：multipart 上传（大文件通道）+ 下载 + 管理端浏览 + 孤儿清理
console.log('== 附件系统 REST ==');
const fd = new FormData();
fd.append('file', new Blob(['rest 附件内容：磁盘报告'], { type: 'text/plain' }), 'rest-report.txt');
const upRes = await fetch(`${BASE}/api/agent/attachments`, {
  method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: fd,
});
const upData = await upRes.json();
check('multipart 上传附件 201', upRes.status === 201 && !!upData.attachment_id?.startsWith('att-'), JSON.stringify(upData));
const attId = upData.attachment_id;

const dlRes = await fetch(`${BASE}/api/agent/attachments/${attId}`, { headers: { authorization: `Bearer ${KEY}` } });
const dlBody = await dlRes.text();
check('附件下载 200 且内容正确', dlRes.status === 200 && dlBody.includes('磁盘报告'), `${dlRes.status} ${dlBody}`);
check('下载含原始文件名（Content-Disposition）', (dlRes.headers.get('content-disposition') || '').includes('rest-report.txt'), dlRes.headers.get('content-disposition'));

const dlNoKey = await fetch(`${BASE}/api/agent/attachments/${attId}`);
check('下载无 key 401', dlNoKey.status === 401, String(dlNoKey.status));

// 管理端浏览（cookie 会话）
const adminDl = await fetch(`${BASE}/api/attachments/${attId}`, { headers: { cookie } });
check('管理端下载附件 200', adminDl.status === 200, String(adminDl.status));
// 文本类 mime → inline（可预览）
check('文本类附件 inline 预览', (adminDl.headers.get('content-disposition') || '').startsWith('inline'), adminDl.headers.get('content-disposition'));

// 孤儿清理：新上传未引用的附件可被清理
const orphan = await api('POST', '/api/attachments/cleanup', {}, undefined);
check('孤儿附件清理 ≥1', orphan.data.cleaned >= 1, JSON.stringify(orphan.data));

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error('\n验收异常:', e.message);
  exitCode = 1;
} finally {
  await pool.end();
  await restoreLlm();
}
process.exit(exitCode);
