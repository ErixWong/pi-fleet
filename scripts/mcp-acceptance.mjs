// MCP 验收：终局工具面（whoami + task 10 action + upload_attachment）+ 附件系统（§3.7）+ key 管理
// 覆盖：协作会话 / 定时任务 / 交付物（附件引用+版本+预检）/ 开放生态（公共池+认领+验收）/ 附件权限
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

const task = (client, action, args = {}) => call(client, 'task', { action, ...args });
const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

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
  const req = await task(clientB, 'create', {
    title: '帮忙开启代理',
    instruction: '请开启代理服务供我下载，地址告诉我。',
    assignee: agentA.agent.agent_id,
  });
  check('task(create) 发起成功', req.ok === true && !!req.task_id, JSON.stringify(req));
  const collabTaskId = req.task_id;

  const dueA = await task(clientA, 'list', { scope: 'due' });
  const collab = dueA.due_tasks.find((t) => t.task_id === collabTaskId);
  check('A 领到协作回合', !!collab && collab.kind === 'manual', JSON.stringify(dueA.due_tasks));
  check('回合附完整消息流', collab?.messages?.length >= 1 && collab.messages[0].sender_role === 'agent', JSON.stringify(collab?.messages));

  const reply1 = await task(clientA, 'reply', { task_id: collabTaskId, content: '代理已开启 http://vps:7890' });
  check('A 回复成功', reply1.ok === true, JSON.stringify(reply1));

  const dueB = await task(clientB, 'list', { scope: 'due' });
  check('B 领到协作回合（A 回复后）', dueB.due_tasks.some((t) => t.task_id === collabTaskId), JSON.stringify(dueB.due_tasks));
  const msgs2 = await task(clientB, 'detail', { task_id: collabTaskId });
  check('B 看到消息流（请求 + 平台降级标记 + A 回复）', msgs2.messages.length === 3, JSON.stringify(msgs2.messages));

  await task(clientB, 'reply', { task_id: collabTaskId, content: '下载完成，可以关闭了' });
  const done = await task(clientB, 'approve', { task_id: collabTaskId, opinion: '已关闭代理，协作完成' });
  check('B 验收关闭任务 → done', done.ok === true && done.status === 'done', JSON.stringify(done));

  const replyClosed = await task(clientA, 'reply', { task_id: collabTaskId, content: '还想回复' });
  check('关闭后回复被拒', !!replyClosed.error?.includes('无法回复'), JSON.stringify(replyClosed));

  const threads = await task(clientA, 'list', { scope: 'mine' });
  const t = threads.threads.find((x) => x.task_id === collabTaskId);
  check('list(mine) 显示 done', t?.status === 'done', JSON.stringify(threads.threads));

  // 3. workdir 写回
  console.log('== 3. workdir 写回 ==');
  await api('POST', '/api/agent/tasks/workdir', { task_id: collabTaskId, workdir: '/opt/pi-agent/work/tasks/' + collabTaskId }, agentA.key);
  const detailA = await api('GET', `/api/tasks/${collabTaskId}`);
  check('workdir 已写回任务', detailA.task.workdir === '/opt/pi-agent/work/tasks/' + collabTaskId, JSON.stringify(detailA.task.workdir));

  // 3.5 附件系统：上传（MCP base64）/ 去重 / 下载权限 / 引用 submit / 预检
  console.log('== 3.5 附件系统（upload_attachment + 引用 + 权限） ==');
  const up1 = await call(clientA, 'upload_attachment', {
    filename: 'login.ts', mime: 'text/plain', data_base64: b64('export function login() { return true; }'),
  });
  check('MCP 上传附件', up1.ok === true && !!up1.attachment_id?.startsWith('att-'), JSON.stringify(up1));
  const attLogin = up1.attachment_id;
  // 去重：同内容再传 → 复用同一 attachment_id
  const up1dup = await call(clientA, 'upload_attachment', {
    filename: 'login-copy.ts', mime: 'text/plain', data_base64: b64('export function login() { return true; }'),
  });
  check('同内容去重复用（不占双份配额）', up1dup.ok === true && up1dup.reused === true && up1dup.attachment_id === attLogin, JSON.stringify(up1dup));
  const up2 = await call(clientA, 'upload_attachment', {
    filename: 'changelog.md', mime: 'text/markdown', data_base64: b64('# 变更\n- 登录模块完成'),
  });
  check('上传第二个附件', up2.ok === true && !!up2.attachment_id, JSON.stringify(up2));
  // MCP 5MB 上限
  const tooBig = await call(clientA, 'upload_attachment', {
    filename: 'big.bin', data_base64: b64('x'.repeat(5 * 1024 * 1024 + 1)),
  });
  check('MCP 超 5MB 被拒', !!tooBig.error?.includes('5MB'), JSON.stringify(tooBig));

  // 下载权限：A 是 owner → 200；B 未参与 → 403
  const dlOwner = await fetch(`${BASE}/api/agent/attachments/${attLogin}`, { headers: { authorization: `Bearer ${agentA.key}` } });
  check('owner 下载附件 200', dlOwner.status === 200, String(dlOwner.status));
  const dlDenied = await fetch(`${BASE}/api/agent/attachments/${attLogin}`, { headers: { authorization: `Bearer ${agentB.key}` } });
  check('未授权 agent 下载 403', dlDenied.status === 403, String(dlDenied.status));

  // 引用 submit：管理员建带 spec 任务派给 A，A 上传并引用提交
  await api('POST', '/api/tasks', {
    kind: 'manual', title: '交付物测试任务', assignee_id: agentA.agent.id,
    instruction: '实现登录模块',
    deliverable_spec: [
      { name: '代码变更', type: '.ts' },
      { name: '变更说明', type: 'text/' },
    ],
  });
  const dlList = await api('GET', '/api/tasks');
  const dlTask = dlList.tasks.find((t) => t.title === '交付物测试任务');
  check('创建任务带附件型验收方案', !!dlTask);

  // 首次只交一个 → 预检不合格（缺 变更说明）
  const sub1 = await task(clientA, 'submit', {
    task_id: dlTask.task_id, result: '初版实现',
    deliverables: [{ name: '代码变更', attachment_id: attLogin, message: '初版实现' }],
  });
  check('预检不合格 → 回 claimed 续做', sub1.ok === true && sub1.status === 'claimed', JSON.stringify(sub1));
  check('预检说明缺什么', sub1.reason?.includes('变更说明'), JSON.stringify(sub1.reason));

  // 未约定交付物被拒 + 引用不存在附件被拒
  const subBad = await task(clientA, 'submit', {
    task_id: dlTask.task_id, result: 'x', deliverables: [{ name: '不在约定', attachment_id: attLogin }],
  });
  check('未约定交付物被拒', !!subBad.error?.includes('不在任务约定中'), JSON.stringify(subBad));
  const subBadAtt = await task(clientA, 'submit', {
    task_id: dlTask.task_id, result: 'x', deliverables: [{ name: '代码变更', attachment_id: 'att-00000000' }],
  });
  check('引用不存在附件被拒', !!subBadAtt.error?.includes('不存在'), JSON.stringify(subBadAtt));

  // 补齐 → 预检通过 → pending_confirm；版本自增（代码变更 v1→v2）
  const sub2 = await task(clientA, 'submit', {
    task_id: dlTask.task_id, result: '完成',
    deliverables: [
      { name: '代码变更', attachment_id: attLogin, message: '修复 lint' },
      { name: '变更说明', attachment_id: up2.attachment_id },
    ],
  });
  check('补齐后预检通过 → pending_confirm', sub2.ok === true && sub2.status === 'pending_confirm', JSON.stringify(sub2));

  const dlInfo2 = await task(clientA, 'detail', { task_id: dlTask.task_id });
  const versions = dlInfo2.deliverables.versions;
  check('版本历史 3 条（代码变更 v1/v2 + 变更说明 v1）', versions.length === 3, JSON.stringify(versions));
  check('代码变更 v2 为当前版本', versions.find((v) => v.name === '代码变更' && v.version === 'v2')?.current === true, JSON.stringify(versions));
  const attInDetail = versions.find((v) => v.name === '变更说明')?.attachment;
  check('detail 含附件元数据（filename/mime/size）', !!attInDetail && attInDetail.filename === 'changelog.md' && attInDetail.size_bytes > 0, JSON.stringify(attInDetail));

  // 引用即授权：B 是任务 creator？否（管理员建的）。管理员建的任务 creator=NULL → B 仍无权。
  // 换 B 建私有任务派给 A，A 引用 attLogin 提交 → B 成为参与人 → B 可下载
  const privTask = await task(clientB, 'create', { title: '引用授权验证', instruction: '用我上传的文件', assignee: agentA.agent.agent_id });
  const subPriv = await task(clientA, 'submit', {
    task_id: privTask.task_id, result: '交付',
    deliverables: [{ name: '文件', attachment_id: attLogin }],
  });
  check('私有任务提交成功（无 spec）', subPriv.ok === true, JSON.stringify(subPriv));
  const dlGranted = await fetch(`${BASE}/api/agent/attachments/${attLogin}`, { headers: { authorization: `Bearer ${agentB.key}` } });
  check('引用即授权：参与任务后可下载 200', dlGranted.status === 200, String(dlGranted.status));
  // 发起人 B 验收关闭私有任务（验收权跟随发起权）
  const privDone = await task(clientB, 'approve', { task_id: privTask.task_id, opinion: 'ok' });
  check('私有任务验收通过 → done', privDone.ok === true && privDone.status === 'done', JSON.stringify(privDone));
  const pool = createPool({ host: '127.0.0.1', port: 3306, user: 'root', password: 'erixPwd', database: 'task_dispatch' });
  // 4. 定时任务单轮（scheduled 不经门禁）
  console.log('== 4. 定时任务（单轮） ==');
  await api('POST', '/api/tasks', {
    kind: 'scheduled', title: '磁盘检查单轮', assignee_id: agentA.agent.id,
    schedule_cron: 'daily', window_start: '00:00', window_end: '23:59', topic_name: 'sess-topic',
    instruction: '检查磁盘并投递报告',
  });
  const list = await api('GET', '/api/tasks');
  const sched = list.tasks.find((t) => t.title === '磁盘检查单轮');
  check('scheduled 已建', sched?.status === 'pending');

  await pool.query(`UPDATE tasks SET next_due_at = DATE_SUB(NOW(), INTERVAL 30 MINUTE) WHERE task_id = ?`, [sched.task_id]);
  const dueA2 = await task(clientA, 'list', { scope: 'due' });
  const schedDue = dueA2.due_tasks.find((t) => t.task_id === sched.task_id);
  check('scheduled 放行（running）', schedDue?.kind === 'scheduled', JSON.stringify(dueA2.due_tasks));

  const prog = await task(clientA, 'reply', { task_id: sched.task_id, content: '50%', type: 'progress' });
  check('reply(progress) 续期/记录', prog.ok === true, JSON.stringify(prog));
  const sub = await task(clientA, 'submit', { task_id: sched.task_id, result: '磁盘正常，/ 42%' });
  check('task(submit) scheduled 直接记录 → done', sub.ok === true && sub.status === 'done', JSON.stringify(sub));
  const subAgain = await task(clientA, 'submit', { task_id: sched.task_id, result: '重复' });
  check('重复提交被拒', !!subAgain.error, JSON.stringify(subAgain));
  const pub = await task(clientA, 'reply', { task_id: sched.task_id, content: '磁盘正常', type: 'report' });
  check('reply(report) 归档到任务', pub.ok === true, JSON.stringify(pub));
  const schedDetail = await api('GET', `/api/tasks/${sched.task_id}`);
  check('任务详情含报告消息（type=report）', schedDetail.messages.some((m) => m.type === 'report' && m.content === '磁盘正常'), JSON.stringify(schedDetail.messages));

  // 5. 开放生态：公共池 / 原子认领 / 验收链路（全部附件引用）
  console.log('== 5. 开放生态：公共池 + 认领 + 验收 ==');
  const agentC = await api('POST', '/api/agents', { name: 'sess-C', hostname: '10.0.0.3', accept_external: true });
  const clientC = await mcpClient(agentC.key);
  const whoC = await call(clientC, 'whoami', {});
  check('whoami 返回 accept_external', whoC.accept_external === true, JSON.stringify(whoC));

  const pubTask = await task(clientB, 'create', {
    title: '帮忙生成调研报告',
    instruction: '需要 Windows + Office，帮我把材料整理成 Markdown 报告。',
    visibility: 'public',
    deliverable_spec: [{ name: '报告', min_count: 1, type: '.md' }],
  });
  check('task(create) 公开任务入池（active）', pubTask.ok === true && pubTask.status === 'active', JSON.stringify(pubTask));
  const pubTaskId = pubTask.task_id;

  const poolList = await task(clientC, 'list', { scope: 'pool' });
  const inPool = poolList.pool.find((t) => t.task_id === pubTaskId);
  check('C 公共池看到任务（含完整指令与验收方案）',
    !!inPool && inPool.instruction.includes('Office') && inPool.deliverable_spec?.[0]?.type === '.md',
    JSON.stringify(poolList.pool));
  const poolB = await task(clientB, 'list', { scope: 'pool' });
  check('发起人不见自己的任务（不自认自领）', !poolB.pool.some((t) => t.task_id === pubTaskId), JSON.stringify(poolB.pool));

  const agentD = await api('POST', '/api/agents', { name: 'sess-D', hostname: '10.0.0.4' });
  const clientD = await mcpClient(agentD.key);
  const denyClaim = await task(clientD, 'claim', { task_id: pubTaskId });
  check('未开接单开关认领被拒', !!denyClaim.error?.includes('接单开关'), JSON.stringify(denyClaim));
  const stillActive = await task(clientC, 'list', { scope: 'pool' });
  check('被拒后任务仍留在池中', stillActive.pool.some((t) => t.task_id === pubTaskId), JSON.stringify(stillActive.pool));

  const claimPool = await task(clientC, 'claim', { task_id: pubTaskId });
  check('C 认领成功（mode=pool）', claimPool.ok === true && claimPool.mode === 'pool', JSON.stringify(claimPool));
  const claimAgain = await task(clientD, 'claim', { task_id: pubTaskId });
  check('重复认领被拒（先到先得）', !!claimAgain.error?.includes('已被'), JSON.stringify(claimAgain));

  // C 上传报告附件并提交
  const cAtt = await call(clientC, 'upload_attachment', {
    filename: 'report.md', mime: 'text/markdown', data_base64: b64('# 调研报告\n材料整理完成'),
  });
  const subReview = await task(clientC, 'submit', {
    task_id: pubTaskId, result: '已完成报告',
    deliverables: [{ name: '报告', attachment_id: cAtt.attachment_id, message: '初版' }],
  });
  check('提交验收：程序预检通过 → pending_confirm', subReview.ok === true && subReview.status === 'pending_confirm', JSON.stringify(subReview));
  const dueB2 = await task(clientB, 'list', { scope: 'due' });
  check('发起人 B 在 due 中看到待验收任务', dueB2.due_tasks.some((t) => t.task_id === pubTaskId), JSON.stringify(dueB2.due_tasks));
  // B 下载 C 交付的附件（引用即授权：B 是 creator）
  const dlB = await fetch(`${BASE}/api/agent/attachments/${cAtt.attachment_id}`, { headers: { authorization: `Bearer ${agentB.key}` } });
  check('发起人可下载执行方交付的附件 200', dlB.status === 200, String(dlB.status));
  const approveResult = await task(clientB, 'approve', { task_id: pubTaskId, opinion: '报告质量合格' });
  check('B 验收通过 → done', approveResult.ok === true && approveResult.status === 'done', JSON.stringify(approveResult));
  const doneDetail = await task(clientC, 'detail', { task_id: pubTaskId });
  const verdictMsg = doneDetail.messages?.some((m) => m.type === 'verdict' && m.content.includes('验收通过'));
  check('验收判决回帖进消息流（type=verdict）', verdictMsg === true, JSON.stringify(doneDetail.messages));

  // 5.7 预检不合格 → 续做回路；打回 → 续做；补齐 → 验收通过
  const poolTask2 = await task(clientB, 'create', {
    title: '缺交付物的任务', instruction: '需要两份交付物', visibility: 'public',
    deliverable_spec: [{ name: 'A', min_count: 1, type: '.md' }, { name: 'B', min_count: 1, type: '.md' }],
  });
  await task(clientC, 'claim', { task_id: poolTask2.task_id });
  const subBadReview = await task(clientC, 'submit', { task_id: poolTask2.task_id, result: '只做了 A' });
  check('预检不合格 → 回 claimed 续做（无附件）', subBadReview.ok === true && subBadReview.status === 'claimed', JSON.stringify(subBadReview));
  check('预检回帖说明缺什么', subBadReview.reason?.includes('B'), JSON.stringify(subBadReview.reason));
  const detailAfter = await task(clientC, 'detail', { task_id: poolTask2.task_id });
  check('deliver_attempts=1', Number(detailAfter.task?.deliver_attempts) === 1, JSON.stringify(detailAfter.task?.deliver_attempts));

  const rejectResult = await task(clientB, 'reject', { task_id: poolTask2.task_id, opinion: '内容不对，重写' });
  check('发起人打回 → 回 claimed 续做', rejectResult.ok === true && rejectResult.status === 'claimed', JSON.stringify(rejectResult));
  const detailAfterReject = await task(clientC, 'detail', { task_id: poolTask2.task_id });
  check('打回后 attempts=2', Number(detailAfterReject.task?.deliver_attempts) === 2, JSON.stringify(detailAfterReject.task?.deliver_attempts));
  check('打回意见进消息流', detailAfterReject.messages?.some((m) => m.type === 'verdict' && m.content.includes('重写')), JSON.stringify(detailAfterReject.messages));

  const cA = await call(clientC, 'upload_attachment', { filename: 'a.md', mime: 'text/markdown', data_base64: b64('A 内容') });
  const cB = await call(clientC, 'upload_attachment', { filename: 'b.md', mime: 'text/markdown', data_base64: b64('B 内容') });
  const subFinal = await task(clientC, 'submit', {
    task_id: poolTask2.task_id, result: '补齐重写',
    deliverables: [{ name: 'A', attachment_id: cA.attachment_id }, { name: 'B', attachment_id: cB.attachment_id }],
  });
  check('补齐后预检通过 → pending_confirm', subFinal.ok === true && subFinal.status === 'pending_confirm', JSON.stringify(subFinal));
  const approveFinal = await task(clientB, 'approve', { task_id: poolTask2.task_id, opinion: '这次可以了' });
  check('最终验收通过 → done', approveFinal.ok === true && approveFinal.status === 'done', JSON.stringify(approveFinal));

  // 6. key 重置
  console.log('== 6. key 管理 ==');
  const reset = await api('POST', `/api/agents/${agentA.agent.id}/reset-key`);
  check('重置返回新 key', !!reset.key?.startsWith('pd-'));
  let oldRejected = false;
  try {
    const oldClient = await mcpClient(agentA.key);
    await call(oldClient, 'whoami', {});
  } catch { oldRejected = true; }
  check('旧 key 被拒', oldRejected);

  // 7. 设置体系 + LLM 门禁（§3.4）：配置假 provider+模型 → 发布进 pending_audit → 扫描故障降级放行
  console.log('== 7. 设置体系 + LLM 审核门禁（降级路径） ==');
  await api('PUT', '/api/settings/llm-providers', { id: 'fake', name: '假 provider', base_url: 'http://127.0.0.1:1/v1', api_key: 'sk-test' });
  await api('PUT', '/api/settings/llm-models', { id: 'fake-model', provider_id: 'fake', name: '假模型', model: 'fake-model' });
  const s = await api('GET', '/api/settings/llm-providers');
  check('provider 可读写（api_key 掩码回显）', s.providers.some((p) => p.id === 'fake' && p.base_url === 'http://127.0.0.1:1/v1' && p.api_key === '******'), JSON.stringify(s.providers));
  const pendingTask = await task(clientB, 'create', {
    title: '审核队列测试', instruction: '需要一份 md 报告', visibility: 'public',
    deliverable_spec: [{ name: 'a', type: '.md' }],
  });
  check('配置 LLM 后发布 → pending_audit', pendingTask.ok === true && pendingTask.status === 'pending_audit', JSON.stringify(pendingTask));
  const scan = await api('POST', '/api/settings/llm-scan', {}, undefined);
  check('队列扫描处理审核任务', scan.audit.processed >= 1, JSON.stringify(scan));
  check('LLM 故障 → 降级放行（不阻塞）', scan.audit.degraded >= 1, JSON.stringify(scan));
  const auditDetail = await task(clientB, 'detail', { task_id: pendingTask.task_id });
  check('降级后任务进入公共池（active）', auditDetail.task.status === 'active', JSON.stringify(auditDetail.task));
  check('降级标记回帖（未经 LLM 审核）', auditDetail.messages?.some((m) => m.type === 'verdict' && m.content.includes('未经 LLM 审核')), JSON.stringify(auditDetail.messages));
  // 提示词修改留痕（记录旧值，测完还原，避免污染真实环境的审核口径）
  const prevAudit = (await api('GET', '/api/settings')).settings.prompt_audit;
  await api('PUT', '/api/settings', { prompt_audit: '自定义审核提示词测试' });
  const hist = await api('GET', '/api/settings/history');
  check('提示词修改留痕（改人/前值/新值）', hist.history.some((h) => h.k === 'prompt_audit' && h.changed_by === 'admin' && h.old_v && h.new_v === '自定义审核提示词测试'), JSON.stringify(hist.history));
  if (prevAudit) await api('PUT', '/api/settings', { prompt_audit: prevAudit });

  // 8. provider → 多 model / 多模态 / 价格标记 / 调用日志（§3.4 扩展）
  console.log('== 8. provider 对应多模型 + 多模态 + 价格 ==');
  // 8.1 同一 provider（fake）下挂 cheap（非多模态）+ vision（多模态，带价格），共享 base_url/api_key
  await api('PUT', '/api/settings/llm-models', { id: 'cheap', provider_id: 'fake', name: '快速便宜模型', model: 'fake-cheap', price: '¥0.5/1M tokens' });
  await api('PUT', '/api/settings/llm-models', { id: 'vision', provider_id: 'fake', name: '多模态模型', model: 'fake-vision', vision: true, price: '¥5/1M tokens', note: '识图' });
  const ms = await api('GET', '/api/settings/llm-models');
  const visionM = ms.models.find((m) => m.id === 'vision');
  const cheapM = ms.models.find((m) => m.id === 'cheap');
  check('provider 对应多模型（vision 标记 + 价格标记）', ms.models.length >= 2 && visionM?.provider_id === 'fake' && visionM?.vision === true && visionM?.price.includes('5') && cheapM?.price.includes('0.5'), JSON.stringify(ms.models));
  await api('PUT', '/api/settings', { llm_audit_model: 'cheap', llm_verify_model: 'auto' });

  // 8.2 含图片任务：发布 → 审核降级 → 认领 → 上传 png → submit → submitted → 验收（按图自动选 vision）→ 故障降级
  const imgTask = await task(clientB, 'create', {
    title: '识图验收测试', instruction: '交付一张图', visibility: 'public',
    deliverable_spec: [{ name: '图', type: '.png' }],
  });
  check('配置模型后发布 → pending_audit', imgTask.status === 'pending_audit', JSON.stringify(imgTask));
  await api('POST', '/api/settings/llm-scan', {}, undefined);
  const imgTaskDetail0 = await task(clientB, 'detail', { task_id: imgTask.task_id });
  check('审核故障降级 → active（可认领）', imgTaskDetail0.task.status === 'active', JSON.stringify(imgTaskDetail0.task));
  await task(clientC, 'claim', { task_id: imgTask.task_id });
  const pngUp = await call(clientC, 'upload_attachment', {
    filename: 'pic.png', mime: 'image/png',
    data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  });
  const subImg = await task(clientC, 'submit', {
    task_id: imgTask.task_id, result: '带图交付',
    deliverables: [{ name: '图', attachment_id: pngUp.attachment_id }],
  });
  check('预检通过 + 配置模型 → submitted（等 LLM 验收）', subImg.ok === true && subImg.status === 'submitted', JSON.stringify(subImg));
  await api('POST', '/api/settings/llm-scan', {}, undefined);
  const imgTaskDetail = await task(clientC, 'detail', { task_id: imgTask.task_id });
  check('验收（含图→vision 模型）故障降级 → pending_confirm', imgTaskDetail.task.status === 'pending_confirm', JSON.stringify(imgTaskDetail.task));
  const calls = await api('GET', '/api/settings/llm-calls');
  const visionCall = calls.calls.find((c) => c.model_id === 'vision' && c.purpose === 'verify');
  check('调用日志：识图验收走 vision 模型（含价格标记）', !!visionCall && visionCall.price.includes('5'), JSON.stringify(calls.calls.slice(0, 3)));
  check('调用日志：识图标记', visionCall?.vision === 1, JSON.stringify(visionCall));
  check('调用日志：provider 归因（冗余记录）', visionCall?.provider_id === 'fake', JSON.stringify(visionCall));

  // 8.3 清理模型 + provider，还原环境（真实环境可能有管理员配置的 LLM provider，只断言测试数据已清理）
  await api('DELETE', '/api/settings/llm-models/cheap', {}, undefined);
  await api('DELETE', '/api/settings/llm-models/vision', {}, undefined);
  await api('DELETE', '/api/settings/llm-models/fake-model', {}, undefined);
  await api('DELETE', '/api/settings/llm-providers/fake', {}, undefined);
  const after = await api('GET', '/api/settings/llm-models');
  check('测试模型已清理（cheap/vision/fake-model 不存在）', !after.models.some((m) => ['cheap', 'vision', 'fake-model'].includes(m.id)), JSON.stringify(after.models.map((m) => m.id)));
  const afterP = await api('GET', '/api/settings/llm-providers');
  check('测试 provider 已清理（fake 不存在）', !afterP.providers.some((p) => p.id === 'fake'), JSON.stringify(afterP.providers.map((p) => p.id)));

  // 9. 编排：plan / stage / task 三层 + 闸门 + 周期克隆（orchestration.md）
  console.log('== 9. 编排（plan / stage / 闸门 / 周期克隆） ==');
  // 管理员建的 plan：任务 creator=null，验收走管理端 resolve（§编排：plan 人建，验收权随发起人）
  const agentE = await api('POST', '/api/agents', { name: 'sess-E', hostname: '10.0.0.5', accept_external: true });
  const clientE = await mcpClient(agentE.key);
  // 9.1 创建 plan：stage1 两任务（当前）+ stage2 一任务（blocked）
  const pl = await api('POST', '/api/plans', {
    name: '测试流水线',
    stages: [
      { name: '准备', tasks: [
        { title: '准备数据', instruction: '整理输入数据', assignee: agentE.agent.agent_id, deliverable_spec: [{ name: '数据', type: '.csv' }] },
        { title: '生成清单', instruction: '输出清单', visibility: 'public' },
      ]},
      { name: '执行', tasks: [
        { title: '执行分析', instruction: '基于清单分析', assignee: agentE.agent.agent_id, deliverable_spec: [{ name: '报告', type: '.md' }] },
      ]},
    ],
  });
  check('创建 plan（人建）', pl.ok === true && !!pl.plan_id, JSON.stringify(pl));
  const tree = await api('GET', `/api/plans/${pl.plan_id}`);
  const s1 = tree.plan.stages[0];
  const s2 = tree.plan.stages[1];
  check('stage1 为当前 stage', s1.current === true, JSON.stringify(tree.plan.stages.map((st) => ({ seq: st.seq, current: st.current }))));
  check('stage1 任务已发布（未配 LLM 直通 open/active）',
    s1.tasks.some((t) => t.status === 'open') && s1.tasks.some((t) => t.status === 'active'), JSON.stringify(s1.tasks.map((t) => t.status)));
  check('stage2 任务 blocked（闸门）', s2.tasks.every((t) => t.status === 'blocked'), JSON.stringify(s2.tasks));
  const stage2Task = s2.tasks[0];
  const claimBlocked = await task(clientE, 'claim', { task_id: stage2Task.task_id });
  check('blocked 任务不可认领', !!claimBlocked.error?.includes('不可认领'), JSON.stringify(claimBlocked));
  const poolNoBlocked = await task(clientC, 'list', { scope: 'pool' });
  check('blocked 任务不在公共池', !poolNoBlocked.pool.some((t) => t.task_id === stage2Task.task_id), JSON.stringify(poolNoBlocked.pool));

  // 9.2 己方视角：agentE 往当前 stage(stage1) 追加任务（agent 可 task(create, stage_id)）→ creator=E → 己方全量
  const added = await task(clientE, 'create', {
    title: '追加任务', instruction: '补充校验', visibility: 'public', stage_id: Number(s1.id),
  });
  check('当前 stage 追加任务成功（己方视角）', added.ok === true, JSON.stringify(added));
  // 非 plan 参与人追加被拒（§编排五 内外分离：防借 creator 身份读取全量 plan 上下文）
  const strangerAdd = await task(clientC, 'create', {
    title: '越权追加', instruction: 'x', visibility: 'public', stage_id: Number(s1.id),
  });
  check('非参与人追加 stage 被拒', !strangerAdd.ok && String(strangerAdd.error).includes('参与人'), JSON.stringify(strangerAdd));
  // blocked 取消兜底：E 往未来 stage 追加（落 blocked）→ 管理端可取消（此前白名单缺 blocked 必报错）
  const futAdd = await task(clientE, 'create', {
    title: '未来追加', instruction: 'x', visibility: 'public', stage_id: Number(s2.id),
  });
  check('未来 stage 追加落 blocked', futAdd.ok === true, JSON.stringify(futAdd));
  const cancelBlocked = await api('POST', `/api/tasks/${futAdd.task_id}/cancel`, {});
  check('blocked 任务可取消（管理端兜底）', cancelBlocked.ok === true, JSON.stringify(cancelBlocked));
  const addedDetail = await task(clientE, 'detail', { task_id: added.task_id });
  check('plan 上下文（己方全量：stage_name/siblings/前序摘要）',
    addedDetail.plan_context?.stage === '1/2' && !!addedDetail.plan_context?.stage_name && Array.isArray(addedDetail.plan_context?.siblings),
    JSON.stringify(addedDetail.plan_context));
  // 完成 stage1 全部任务（含追加；管理端验收）→ 闸门放行 stage2
  const stage1Open = s1.tasks.find((t) => t.status === 'open');
  const stage1Active = s1.tasks.find((t) => t.status === 'active');
  // 外部认领者视角（P2-1/P2-2）：public 任务未认领时，第三方 agent 只见最小事实（无 plan_name / 无兄弟状态）
  const extView = await task(clientC, 'detail', { task_id: stage1Active.task_id });
  check('plan 上下文（外部最小事实：无 plan_name/无兄弟/位置+跳过数）',
    extView.plan_context?.stage === '1/2' && extView.plan_context?.plan_name === undefined && extView.plan_context?.siblings === undefined && extView.plan_context?.prev_skipped === 0,
    JSON.stringify(extView.plan_context));
  await task(clientE, 'claim', { task_id: stage1Open.task_id });
  const csvUp = await call(clientE, 'upload_attachment', { filename: 'data.csv', mime: 'text/csv', data_base64: b64('a,b\n1,2') });
  await task(clientE, 'submit', { task_id: stage1Open.task_id, result: '数据齐', deliverables: [{ name: '数据', attachment_id: csvUp.attachment_id }] });
  await api('POST', `/api/tasks/${stage1Open.task_id}/resolve`, { final_result: 'ok' });
  await task(clientE, 'claim', { task_id: stage1Active.task_id });
  await task(clientE, 'submit', { task_id: stage1Active.task_id, result: '清单出' });
  await api('POST', `/api/tasks/${stage1Active.task_id}/resolve`, { final_result: 'ok' });
  await task(clientE, 'claim', { task_id: added.task_id });
  await task(clientE, 'submit', { task_id: added.task_id, result: '校验过' });
  await api('POST', `/api/tasks/${added.task_id}/resolve`, { final_result: 'ok' });
  await api('POST', '/api/settings/llm-scan', {}, undefined);
  const tree2 = await api('GET', `/api/plans/${pl.plan_id}`);
  check('stage1 完成后闸门放行 stage2（blocked → open）',
    tree2.plan.stages[1].tasks.some((t) => t.status === 'open' && t.task_id === stage2Task.task_id), JSON.stringify(tree2.plan.stages[1].tasks));
  const stage2Detail = await task(clientE, 'detail', { task_id: stage2Task.task_id });
  check('闸门放行回帖进消息流', stage2Detail.messages?.some((m) => m.type === 'system' && m.content.includes('闸门放行')), JSON.stringify(stage2Detail.messages));
  // assignee = 执行方 = 己方（P2-2 口径）：全量视角（前序摘要 + 兄弟状态）
  check('plan 上下文（assignee=执行方 → 己方全量：前序摘要/兄弟）',
    stage2Detail.plan_context?.stage === '2/2' && Array.isArray(stage2Detail.plan_context?.prev_stages) && stage2Detail.plan_context?.prev_stages?.[0]?.all_done === true && stage2Detail.plan_context?.prev_skipped === 0,
    JSON.stringify(stage2Detail.plan_context));
  // 9.3 完成 stage2 → plan done
  await task(clientE, 'claim', { task_id: stage2Task.task_id });
  const mdUp = await call(clientE, 'upload_attachment', { filename: 'report.md', mime: 'text/markdown', data_base64: b64('# 报告') });
  await task(clientE, 'submit', { task_id: stage2Task.task_id, result: '完成', deliverables: [{ name: '报告', attachment_id: mdUp.attachment_id }] });
  await api('POST', `/api/tasks/${stage2Task.task_id}/resolve`, { final_result: 'ok' });
  await api('POST', '/api/settings/llm-scan', {}, undefined);
  const tree3 = await api('GET', `/api/plans/${pl.plan_id}`);
  check('全 stage 完成 → plan done', tree3.plan.status === 'done', JSON.stringify(tree3.plan));
  const denied = await task(clientE, 'create', {
    title: '晚到的追加', instruction: 'x', visibility: 'public', stage_id: Number(s1.id),
  });
  check('已完成 stage 追加被拒', !denied.ok && String(denied.error).includes('已完成'), JSON.stringify(denied));

  // 9.4 周期 plan：克隆 + series_id + 重叠跳过
  const per = await api('POST', '/api/plans', {
    name: '每日健康检查', recurrence: 'daily', window_start: '00:00', window_end: '23:59',
    stages: [{ name: '例行', tasks: [
      { title: '磁盘检查', instruction: '检查磁盘健康', assignee: agentE.agent.agent_id },
    ]}],
  });
  const perTree = await api('GET', `/api/plans/${per.plan_id}`);
  const firstInst = perTree.plan.stages[0].tasks[0];
  check('周期首实例发布（未配 LLM 直通 open）', firstInst.status === 'open', JSON.stringify(firstInst));
  // P1-1：首实例身份（origin=periodic / series_id=自身 id / 不经 pending_audit）
  const firstDetail0 = await task(clientE, 'detail', { task_id: firstInst.task_id });
  check('周期首实例 origin=periodic + series_id=自身 id（不经审核）',
    firstDetail0.task.origin === 'periodic' && String(firstDetail0.task.series_id) === String(firstDetail0.task.id),
    JSON.stringify({ origin: firstDetail0.task.origin, series_id: firstDetail0.task.series_id, id: firstDetail0.task.id }));
  // P1-2：周期 plan stage 禁止追加任务（防污染克隆源）
  const perAppend = await task(clientE, 'create', { title: '劫持序列', instruction: 'x', visibility: 'public', stage_id: Number(perTree.plan.stages[0].id) });
  check('周期 plan stage 追加被拒（防污染克隆源）', !perAppend.ok && String(perAppend.error).includes('周期'), JSON.stringify(perAppend));
  // 重叠：首实例未终结 → 到点扫描 → 跳过本轮 + 回帖
  await pool.query(`UPDATE plans SET next_due_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE plan_id = ?`, [per.plan_id]);
  await api('POST', '/api/settings/llm-scan', {}, undefined);
  const perTree2 = await api('GET', `/api/plans/${per.plan_id}`);
  check('上一实例未终结 → 跳过本轮（不克隆）', perTree2.plan.stages[0].tasks.length === 1, JSON.stringify(perTree2.plan.stages[0].tasks.length));
  const firstDetail = await task(clientE, 'detail', { task_id: firstInst.task_id });
  check('重叠跳过回帖', firstDetail.messages?.some((m) => m.type === 'system' && m.content.includes('跳过本轮')), JSON.stringify(firstDetail.messages));
  // 完成首实例（private periodic：claim → submit 直接记录 done，P0-1）→ 再次到点 → 克隆
  await task(clientE, 'claim', { task_id: firstInst.task_id });
  const firstSubmit = await task(clientE, 'submit', { task_id: firstInst.task_id, result: '磁盘正常' });
  check('周期首实例 claim → submit 直接记录 → done', firstSubmit.ok === true && firstSubmit.status === 'done', JSON.stringify(firstSubmit));
  await pool.query(`UPDATE plans SET next_due_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE plan_id = ?`, [per.plan_id]);
  await api('POST', '/api/settings/llm-scan', {}, undefined);
  const perTree3 = await api('GET', `/api/plans/${per.plan_id}`);
  const insts = perTree3.plan.stages[0].tasks;
  check('到点克隆出新实例（2 条）', insts.length === 2, JSON.stringify(insts.map((t) => ({ id: t.task_id, status: t.status }))));
  const clonedTask = insts.find((t) => t.task_id !== firstInst.task_id);
  const firstIdRow = await pool.query(`SELECT id FROM tasks WHERE task_id = ?`, [firstInst.task_id]);
  const clonedDetail = await task(clientE, 'detail', { task_id: clonedTask.task_id });
  check('克隆实例 series_id = 首实例 id（同系列串接）',
    String(clonedDetail.task.series_id) === String(firstIdRow[0].id), JSON.stringify({ series_id: clonedDetail.task.series_id, first_id: String(firstIdRow[0].id) }));
  // P0-1：克隆实例执行闭环（claim → submit → done），不再是死信；首条请求消息进消息流
  const clonedClaim = await task(clientE, 'claim', { task_id: clonedTask.task_id });
  check('克隆实例可认领（kind=manual + open → assigned）', clonedClaim.ok === true && clonedClaim.mode === 'assigned', JSON.stringify(clonedClaim));
  const clonedSubmit = await task(clientE, 'submit', { task_id: clonedTask.task_id, result: '例行完成' });
  check('克隆实例 claim → submit → done 闭环', clonedSubmit.ok === true && clonedSubmit.status === 'done', JSON.stringify(clonedSubmit));
  check('克隆实例首条请求消息进消息流', clonedDetail.messages?.some((m) => m.type === 'chat' && m.content.includes('检查磁盘健康')), JSON.stringify(clonedDetail.messages));

  // 9.5 交付物可见性改档 + failed 处置（API 级）
  await api('POST', `/api/tasks/${clonedTask.task_id}/deliverable-visibility`, { value: 'public' }, undefined);
  const dvDetail = await api('GET', `/api/tasks/${clonedTask.task_id}`);
  check('交付物可见性改档 public + 留痕回帖',
    dvDetail.task.deliverable_visibility === 'public' && dvDetail.messages.some((m) => m.type === 'verdict' && m.content.includes('交付物可见性')), JSON.stringify(dvDetail.messages));
  await pool.query(`UPDATE tasks SET status='failed', result='[test]' WHERE task_id = ?`, [clonedTask.task_id]);
  const reopenRes = await api('POST', `/api/tasks/${clonedTask.task_id}/reopen`, {}, undefined);
  const reopened = await api('GET', `/api/tasks/${clonedTask.task_id}`);
  check('failed 重开 → 按落点回 open（private+assignee）+ attempts 清零', reopenRes.status === 'open' && reopened.task.status === 'open' && reopened.task.deliver_attempts === 0, JSON.stringify(reopened.task));
  // P1-3：重开后闭环（open → claim → submit → done）
  await task(clientE, 'claim', { task_id: clonedTask.task_id });
  const reopenedSubmit = await task(clientE, 'submit', { task_id: clonedTask.task_id, result: '再完成' });
  check('重开后 claim → submit 闭环', reopenedSubmit.ok === true && reopenedSubmit.status === 'done', JSON.stringify(reopenedSubmit));
  // failed 取消 = 跳过（§编排五：不阻塞闸门；此前管理端白名单缺 failed 必报错）
  await pool.query(`UPDATE tasks SET status='failed' WHERE task_id = ?`, [clonedTask.task_id]);
  const cancelFailed = await api('POST', `/api/tasks/${clonedTask.task_id}/cancel`, {}, undefined);
  check('failed 任务可取消（取消=跳过）', cancelFailed.ok === true, JSON.stringify(cancelFailed));
  await clientE.close();

  await pool.end();
  await clientA.close();
  await clientB.close();
  await clientC.close();
  await clientD.close();

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
} catch (e) {
  console.error('\n验收异常:', e.message);
  process.exit(1);
}
