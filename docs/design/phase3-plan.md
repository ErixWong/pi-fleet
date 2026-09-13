# 期3 接入层 · 开发任务书（issue #11）

> 来源：issue #11 的三条任务书评论 + 交接说明，由 planner subagent 只读勘察产出（2026-09-13）。
> 本文件为**期3 实施的契约唯一来源**；与 `docs/design/data-model.md` 冲突时以数据模型文档为准（schema 层）。
> 分支：`feat-260913-03-access-layer`

**（第 1/3 部分）**

## 期3 接入层 · 开发任务书（planner 只读勘察产出，2026-09-13）

> **来源**：本计划由 planner subagent 只读勘察产出——读了 `docs/design/data-model.md` 全文、期2 服务层导出签名、#11/#12/#9 全文、旧 app 路由/工具清单，并实测两库行数。
> **执行方式**：按 `3a → 3b → 3c → 3d` 顺序落地；5 个可并行切片见 §2 Q1。
> **待决项**：§3 的 R1–R12 需拍板，**R1（老库含真实数据）与 R2（编排退役时点）为阻塞项**。
> **两个必修缺陷（已复核）**：`src/db/pool.ts:14` 新池默认落老库；`src/service/task-flow.ts:807` legacy `'active'` 状态。

---
# 开发计划：《pi-market 期3 接入层 —— 新模型接线 + 老模型退役》

## 0. 关键事实核实（本次只读勘察结论）

在拆批前，先钉死几个会直接影响批次划分的事实（均已实测/读码确认）：

| 事实 | 证据 | 影响 |
|---|---|---|
| 新旧 key 哈希算法**完全一致** | 老 `src/auth.ts:hashApiKey` = `sha256(key).hex`；新 `src/service/identity.ts:hashSecret` = `sha256(key,'utf8').hex` | **迁移可直接复制 `key_hash`，已接入 agent 无需换 key**（前缀 `pd-` vs 新 `pk_` 不影响校验，`verifyApiKey` 只比 hash） |
| 新池默认库名是**老库** | `src/db/pool.ts:14` → `process.env.DB_NAME ?? 'task_dispatch'` | 3a 必须先修，否则 `initSchema()` 会把 25 张新表建进 `task_dispatch` |
| 老库**有真实数据**（非纯测试数据） | 只读查询：`task_dispatch.agents=6`、`conversations=28`、`chat_messages=47`、`events=899`、`tasks=0`、`plans=0`；`erix.*=0` | #11 §8「旧库丢弃」的前提需用户重新确认 → **待决 R1** |
| 老库**任务/计划为空** | 同上 `tasks=0 / plans=0` | 内容域迁移面小得多；但**周期克隆/编排无数据可验** |
| `post(detail)` 数据层已就绪 | `src/service/posts.ts:561 getPostDetail()` 已返回 `{post,targets,task,channel,verdicts,deliverables,summary,recent,more}` 九键，与 #11 §7 一致（多一个 `channel`） | 3b 只需**包装出参 + 裁剪**，不重写查询 |
| **实际 bug（legacy 状态残留）** | `src/service/task-flow.ts:807` `listTasks` pool 视图写的是 `t.status IN ('open', 'active')`，而 `post_task.status` ENUM **无 `active`** | 直接违反 §九「无 legacy 状态」→ 必须修（3c） |
| 老的 events 写点分散且多 | `recordEvent` 被 `routes/api.ts`(12 处) / `scheduler.ts`(3) / `llm.ts`(4) / `market.ts`(9+) 调用，全部**事务外** | 3c 不能一次性全切（老模型无事务铁律基础）→ 采用「先只读收敛，写点随老码 3d 一起删」 |
| `/mcp` 是单端点 | `src/routes/mcp.ts` 挂 `POST /mcp` | 3b 切工具面会让老 `mcp-acceptance.mjs`(101 用例) 立即失败 → **必须用 `/mcp2` 过渡**（见 R7） |
| 前端 57 个 API 调用面 | `web/src/api.js`（78 行） | 期3 若改 HTTP 出参形状 → 前端必崩 → **期3 必须做 BFF adapter，前端零改动** |

---

## 1. 批次总览与依赖

```
3a 身份/鉴权地基（双库并存，零业务变更）
 ├─→ 3b 内容迁移 + MCP 读工具面 + post(detail) 形状
 │    └─→ 3c 写路径 + scope 门禁 + 事件收敛
 │         └─→ 3d 老模型退役 + 基线切换 + 前端收口
 └─→（3b 与 3a 可并行：不同文件）
```

**核心架构决策（贯穿全期）**：期3 = **后端换模型 + HTTP 出参形状冻结**。
新增的一切走 `/api/v2/*` 与 `/mcp2`；老的 `/api/*` 与 `/mcp` 在 3d 通过 **adapter** 换实现，**`web/src/` 前端零改动**（视觉层按 #11 协调备注 §3 全保留，改造留期5）。

---

### 阶段 3a：接入层身份/鉴权地基（双库并存，零业务行为变更）

#### 子任务 3a.1：双库配置 + 新池默认库名修正

- **描述**：为「老库不退役、新库并行接入」提供配置基础，并消除 `src/db/pool.ts` 默认落 `task_dispatch` 的危险行为。老链路（`src/db.ts`、`config.db`）**完全冻结不动**。
- **交付物**：
  - 改 `src/config.ts`：新增只读派生对象
    ```ts
    dbNew: {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? 'root',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_NAME_NEW ?? 'erix',
    }
    ```
  - 改 `src/db/pool.ts`：`getPool()` 改读 `config.dbNew`（不再读裸 `process.env.DB_NAME`）；`initSchema()` 首行加守卫：`if (config.dbNew.database === 'task_dispatch') throw new Error('refuse to init schema into legacy db')`
  - 改 `src/db/pool.ts`：`initSchema()` 返回 `{ created: string[] }`（供迁移/验收脚本断言）
- **验收方案**：
  ```
  npx tsc --noEmit                                   # 期望 0 error
  node -e "process.env.DB_NAME='task_dispatch';process.env.DB_NAME_NEW='erix';import('./src/db/pool.ts')" # 不可直接跑，改用 tsx:
  npx tsx -e "import {initSchema} from './src/db/pool.ts'; await initSchema()" # 期望不抛错且不落 task_dispatch
  # 断言 1：SHOW TABLES FROM task_dispatch 不含 post/principal/event
  # 断言 2：SHOW TABLES FROM erix = 25 张（与 db-verify EXPECTED_TABLES 一致）
  npx tsx -e "process.env.DB_NAME_NEW='task_dispatch'; import('./src/db/pool.ts').then(m=>m.initSchema())" # 期望抛错
  ```
- **依赖**：无

#### 子任务 3a.2：principal 鉴权中间件 + scope 门禁 + 主体上下文（ALS）

- **描述**：新建接入层鉴权，替代老 `src/auth.ts:mcpAuthMiddleware`（`agents.key_hash` 查询）。老中间件保留不动（3d 删）。
- **交付物**：新增 `src/auth-principal.ts`
  ```ts
  export interface PrincipalContext { principal: Principal; scopes: Scope[]; key_id: string; account_id: string }
  export const principalContext: AsyncLocalStorage<PrincipalContext>;
  export function currentPrincipal(): PrincipalContext | null;
  export function requirePrincipal(): PrincipalContext;                 // 未认证抛 401
  export function principalAuthMiddleware(): RequestHandler;             // Bearer → verifyApiKey → touchDevice → ALS.run
  export function requireScope(...required: Scope[]): RequestHandler;    // hasScope 失败 → 404（不泄漏存在性，#12 §五）
  export function hasScopes(...required: Scope[]): boolean;
  ```
  - `principalAuthMiddleware`：无 `Authorization: Bearer` → 401 `{error:'missing bearer token'}`；`verifyApiKey` 返回 null → 401 `{error:'invalid or revoked key'}`；命中后 `touchDevice(principal.id)`（kind=host 才 touch，失败静默）+ `principalContext.run(ctx, next)`
  - 新增 `src/util/time.ts`：把 `nowString()` 从 `src/scheduler.ts` 抽出（**新代码不得 import 老的 `scheduler.ts`**，否则 3d 删不掉）
- **验收方案**：
  ```
  DB_NAME_NEW=erix node --test src/auth-principal.test.mjs    # 见 3a.5 用例
  ```
- **依赖**：3a.1

#### 子任务 3a.3：身份域迁移脚本（agents → account/principal/device/device_executor/api_key）

- **描述**：一次性、幂等、**只读老库**地把老身份域映射进新库。
- **交付物**：新增 `scripts/migrate-identity.mjs`（用法 `--from task_dispatch --to erix [--force]`）
  - 映射：
    - `account`：单行 `acc_*`，名 `process.env.PM_ACCOUNT_NAME ?? 'default'`
    - `agents` → `principal{kind:'host', name, account_id, host_principal_id:null}`（一台机器一个 host 主体）
    - `agents.run_user/agent_cli` → `device.run_user` + `device_executor{cli, enabled:1, selected: agent_cli===cli?1:...}`
    - `agents.last_seen_at` → `device.last_seen_at`
    - `agents.key_hash` → `api_key{key_hash: 原值直拷, scopes: 默认全量, label:'migrated'}`
    - `agents.status='disabled'` → `principal.deleted_at`（或 `api_key.revoked_at`）
    - `admin` 表 → `principal{kind:'user', password_hash}`（口令哈希 `scrypt:` 格式直接搬，`src/auth.ts:verifyPassword` 兼容）
  - 默认 scopes（host）：`["post:read","post:write","task:read","task:write","task:claim","task:submit","task:verdict","attachment:read","attachment:write","device:execute","key:manage"]`
  - 幂等：`--force` 先清空 5 张目标表；非 force 遇已存在 `principal.name` 则 skip 并打印
  - **不写老库**（只 `SELECT`）
- **验收方案**：
  ```
  node scripts/migrate-identity.mjs --from task_dispatch --to erix --force   # 期望 stdout 汇总各表行数
  node scripts/migrate-identity.mjs --from task_dispatch --to erix           # 期望幂等：0 inserted
  node scripts/migrate-verify.mjs --database erix --phase identity
  #   断言 1：SELECT COUNT(*) FROM erix.principal WHERE kind='host'  ==  SELECT COUNT(*) FROM task_dispatch.agents
  #   断言 2：erix.api_key.key_hash 集合 == task_dispatch.agents.key_hash 集合（EXCEPT 双向为空）
  #   断言 3：每个 kind='host' principal 有 device 行（LEFT JOIN IS NULL 计数 = 0）
  #   断言 4：老库行数在迁移前后不变
  ```
- **依赖**：3a.1

#### 子任务 3a.4：v2 路由骨架 + 启动接线（只挂 `/api/v2/whoami`）

- **描述**：给 3b/3c 一个**只新增、不改老文件**的落点，使批次间文件级不重叠。
- **交付物**：
  - 新增 `src/routes/v2/index.ts`：`export const v2Router = Router()`；`v2Router.use(express.json())`；`v2Router.get('/whoami', principalAuthMiddleware(), handler)` → `{ principal:{id,kind,name,account_id}, scopes, key_id }`
  - 改 `src/index.ts`：**仅两行** —— `app.use('/api/v2', v2Router)`（放在老 `apiRouter` 之后）；`await initSchema()` 放在 `initDb()` 之后。**此后 3a–3c 冻结 `src/index.ts`**（3c 例外：加 outbox worker 启动 1 行）
- **验收方案**：
  ```
  DB_NAME=task_dispatch DB_NAME_NEW=erix PORT=3210 npx tsx src/index.ts &
  KEY=$(npx tsx -e "import {createApiKey,listPrincipals} from './src/service/identity.ts'; ...") # 或迁移后用库内 principal+新签 key
  curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:3210/api/v2/whoami | jq .
  #   期望 {principal:{kind:"host"},scopes:[...≥11 项],key_id:"key_*"}
  curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3210/api/v2/whoami          # 期望 401
  curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer bogus" ...          # 期望 401
  BASE=http://127.0.0.1:3210 npm test                                                    # 期望 166/166 不回归
  ```
- **依赖**：3a.2

#### 子任务 3a.5：3a 单测与验收脚本

- **交付物**：
  - 新增 `src/auth-principal.test.mjs`（库 `erix`）
  - 新增 `src/util/time.test.mjs`
  - 新增 `scripts/migrate-verify.mjs`（纯 `SELECT` 断言，支持 `--phase identity|content|all`）
- **验收方案**：`DB_NAME_NEW=erix node --test src/auth-principal.test.mjs src/util/time.test.mjs`
- **依赖**：3a.2、3a.3

#### 3a 测试用例增量（对应 §九 / #12）

| 用例 | 断言 | 对应条目 |
|---|---|---|
| 无 Authorization | 401 | #12 §五 权限边界 |
| 无效 hash | 401 | #12 §五 |
| `revoked_at` 非空 | 401 | #12 §五「吊销后拒绝」 |
| `expires_at` 已过 | 401 | #12 §五 |
| principal 软删 | 401 | 同上 |
| `last_used_at` 刷新 | 命中后非空 | #12「细粒度审计可观测」 |
| scope 命中 1 个 | 200 | #12 §五「scope 校验」 |
| scope 缺失 | **404** | #12 §五「不泄漏存在性」 |
| 多 scope AND 语义 | 少一个即 404 | #12 §五 |
| 迁移 key_hash 集合相等 | 双向 EXCEPT 为空 | §九「principal 统一操作者」 |

#### 3a 依赖与并行

- 前置：无。**3a.1 → 3a.2 → 3a.4 串行**（config → 中间件 → 骨架）；**3a.3 可与 3a.2 并行**（脚本 vs 中间件，文件不重叠）

---

### 阶段 3b：内容域迁移 + MCP 读工具面 + `post(detail)` 上下文形状

#### 子任务 3b.1：内容域迁移脚本（tasks/conversations/chat_messages/attachments/deliverables → post 树）

- **交付物**：新增 `scripts/migrate-content.mjs`（`--from task_dispatch --to erix [--force]`），**全部 id 用 `newId('pst'|'att'|'dlv')` 生成，禁止自造**
  - `tasks` → `post{kind:'task'}` + `post_task`
    - `title/instruction` → `title/body`；`visibility` 直映射（private/public，缺 `account` 档）
    - `deliverable_spec`：老库可能为 NULL → **写 `'{}'` 或 `'{"items":[]}'`**（`)deliverable_spec` NOT NULL 硬约束）→ 但 §九#6 要求空方案无法进入发布链路 ⇒ **迁移时对空 spec 的老任务标 `post_task.status='rejected'` 并在 body 追加说明**（决策见 R5）
    - status 映射表：
      | 老 | 新 |
      |---|---|
      | `pending` / `pending_audit` | `pending_audit` |
      | `rejected` | `rejected` |
      | `active` / `open` | `open` |
      | `claimed` / `running` | `claimed` |
      | `submitted` | `submitted` |
      | `pending_confirm` | `pending_confirm` |
      | `done` / `resolved` | `done` |
      | `failed` | `failed` |
      | `cancelled` | `cancelled` |
      | `blocked` | `claimed` + `is_ready=0`（无 blocked 状态） |
    - `assignee_id` → `post_task.assignee_principal_id` + 同时插 `post_target{role:'assignee'}`（意图与事实都要有）
    - `creator_id` → `post.author_principal_id`
    - `claimed_at/result_at` → `claimed_at/closed_at`
    - `plan_id/stage_id` → **不映射**（**待决 R2**）
  - `task_messages` → `post{kind:'message', root_id: task_post_id, parent_id: task_post_id}`（老消息无 parent → 全挂根，扁平）
    - `type: verdict` 的行 → **跳过**（由 `post_verdict` 承载；见下）
    - `sender_role='platform'` → 需要 `principal{kind:'service',name:'platform'}`（迁移脚本先确保存在）
  - `tasks.result_status='success'` 且有 `pending_confirm/done` → 生成 `post{kind:'verdict',decision:'accept'}` + `post_verdict`（`source:'human'`），`attempt_no = deliver_attempts`
  - `conversations` → `post{kind:'channel'}` + `post_channel{host_principal_id: 该 agent 的 host principal, workdir, run_user, name, status}`
  - `chat_messages` → `post{kind:'message', root_id: channel_post_id}`
    - `role/sender_id` → `author_principal_id`（agent → host principal；admin → user principal）
  - `attachments` → `attachment`（`sha256`/`size_bytes`/`filename`/`mime` 直拷；`relative_path` 按新命名 `{owner}/{yyyy}/{mm}/{dd}/{id}.{ext}` **重算**并把实体文件 `mv`（或保留老路径 + 记录待决 R6））
  - `deliverables` → `deliverable`：同名多版本按 `created_at` 排序取最大 version 为 `current=1`（老库有多 current 竞态，新库生成列唯一约束会拒绝 → 脚本必须先纠正）
  - 未读：老库无 read 字段 → `post_target.read_at = NULL`（全未读）
- **验收方案**：
  ```
  node scripts/db-rebuild.mjs --database erix --force
  node scripts/migrate-identity.mjs --from task_dispatch --to erix
  node scripts/migrate-content.mjs  --from task_dispatch --to erix
  node scripts/migrate-verify.mjs --database erix --phase content
  # 断言（贴 SQL 进 verify 脚本）：
  #  A. SELECT COUNT(*) FROM post WHERE parent_id IS NULL AND root_id <> id;        -- 必须 0（§10 陷阱）
  #  B. SELECT COUNT(*) FROM post p WHERE p.kind IN ('task','channel','verdict')
  #       AND NOT EXISTS (扩展表行);                                                 -- 必须 0
  #  C. SELECT COUNT(*) FROM post p WHERE NOT EXISTS (SELECT 1 FROM post p2 WHERE p2.id=p.root_id); -- 必须 0（root 悬空）
  #  D. SHA2 集合：attachment.sha256 双向 EXCEPT 与老库相等
  #  E. 多 current：SELECT post_id,name FROM deliverable WHERE current=1 GROUP BY 1,2 HAVING COUNT(*)>1; -- 必须 0 行
  #  F. SELECT COUNT(*) FROM post WHERE CHAR_LENGTH(id)>32 OR id NOT REGEXP '^(pst|att|dlv)_[23456789abcdefghjkmnpqrstuvwxyz]+$'; -- 必须 0
  #  G. 老库行数迁移前后不变（只读证明）
  ```
- **依赖**：3a.1、3a.3

#### 子任务 3b.2：MCP 工具面原语化（**读路径**）——新增 `src/mcp/` 文件集，挂 `/mcp2`

- **描述**：按 #11 §6 建新工具面。**本批只注册读 action**；写 action 在 3c 补齐。老 `src/mcp/tools.ts` 与 `/mcp` 端点**完全不动**。
- **交付物**（全部新增/重写为新文件）：
  - 新增 `src/mcp/context.ts`：
    ```ts
    export function mcpPrincipal(): PrincipalContext;         // = requirePrincipal()
    export function toolOk(payload: unknown): ToolResult;     // {content:[{type:'text',text:JSON.stringify(payload,null,2)}]}
    export function toolErr(message: string): ToolResult;
    export function guardScope(...s: Scope[]): void;          // 抛 ScopeDenied
    export class ScopeDenied extends Error { constructor(scope: string) }
    ```
  - 新增 `src/mcp/post-tools.ts`：注册 `post`（本批只 `detail`/`list`；3c 补 `create/reply/edit/delete/target/summary`）
  - 新增 `src/mcp/task-tools.ts`：注册 `task`（本批只 `list`；3c 补 `claim/submit/verdict/reopen`）
  - 新增 `src/mcp/resource-tools.ts`：注册 `attachment`（本批只 `read`；3c 补 `upload`）
  - 新增 `src/mcp/identity-tools.ts`：注册 `whoami()`（返回 principal + scopes，**替代老 whoami 的 agent_id/accept_external**）
  - 新增 `src/mcp/index.ts`：`export function createMcpServerV2(): McpServer`（聚合上述 4 个注册器）
  - 改 `src/routes/mcp.ts`：**新增** `mcpRouter.post('/mcp2', principalAuthMiddleware(), ...)` 使用 `createMcpServerV2()`；**老 `/mcp` 分支一行不改**
- **接口契约**：

  ```
  whoami() → {
    principal: { id, kind, name, account_id },
    scopes: string[],
    key_id: string
  }
  ```

  ```
  post(detail, { id, recent_limit?=5, include_recent?=true }) → PostDetail
  ```
  **`post(detail)` 结构化返回（期3 最高杠杆项，逐字定契约）**：
  ```jsonc
  {
    "post": {
      "id": "pst_…", "kind": "task|note|message|verdict|channel", "subtype": "",
      "title": "", "body": "",
      "visibility": "private|account|public",
      "author_principal_id": "prn_…",
      "author": { "id": "prn_…", "kind": "host|user|agent|service", "name": "" },
      "root_id": "pst_…", "parent_id": null,
      "revision": 0, "reply_count": 0,
      "created_at": "…", "edited_at": null
    },
    "targets": [ { "principal": { "id","kind","name" }, "role": "assignee|mention|watcher", "read_at": null } ],
    "task": null | {
      "status": "pending_audit|rejected|open|claimed|submitted|pending_confirm|done|failed|cancelled",
      "is_ready": true, "deliverable_spec": "{}",
      "attempts": 0, "max_attempts": 3,
      "executor": null, "workdir": null,
      "assignee_principal_id": null,
      "claimed_at": null, "closed_at": null
    },
    "channel": null | { "host_principal_id","workdir","run_user","name","status" },
    "deliverables": [ {
      "name": "", "version": 1, "current": true, "note": "",
      "attachment": null | { "id":"att_…","filename":"","mime":"","size_bytes":0,"sha256":"","scan_status":"pending" }
    } ],
    "verdicts": [ { "post_id":"pst_…","decision":"accept|reject","opinion":"","attempt_no":0,"source":"llm|human" } ],
    "summary": null | { "text":"","up_to_post_id":"pst_…","revision":1,"stale":false,"pending":0 },
    "recent": [ /* ≤5 条；仅 { id, parent_id, subtype, author:{id,name}, created_at, body(≤500 字符, 超长加 '…') } */ ],
    "more": { "count": 37, "hint": "post(list, root_id='pst_…', after='pst_…')" }
  }
  ```
  **硬约束（写进单测）**：① `recent.length <= recent_limit` 且默认 5；② `recent[].body` 截断 500；③ **不返回** `deleted_at`、`account_id`、`streaming`、key/审计字段；④ `task`/`channel` 按 kind 互斥（两者不会同时非 null）；⑤ **永不返回全线程消息流**。

  ```
  post(list, { kind?, root_id?, parent_id?|null, author_principal_id?, visibility?,
               target_principal_id?, page?, page_size?=20, after?, limit? }) → {
    items: Post[], total: number,
    next_after: string | null   // items 最后一条 id，供 keyset 续页
  }
  ```
  ```
  task(list, { view: 'due'|'mine'|'pool', status?, page?, page_size?=20 }) → {
    view, items: Array<Post & { task: PostTask }>, total: number
  }
  ```
  ```
  attachment(read, { attachment_id }) → {
    attachment: { id, filename, mime, size_bytes, sha256, scan_status, created_at },
    download_hint: "GET /api/v2/attachments/att_… (Bearer)"
  }
  ```
- **验收方案**：
  ```
  node scripts/db-rebuild.mjs --database erix --force && node scripts/migrate-*.mjs
  DB_NAME=task_dispatch DB_NAME_NEW=erix PORT=3210 npx tsx src/index.ts &
  node scripts/mcp-acceptance-v2.mjs --phase read --base http://127.0.0.1:3210 --mcp-path /mcp2
  # 断言清单：
  #  1. whoami 返回 principal.kind + scopes.length>=11
  #  2. post(detail) 恰好含 post/targets/task/channel/deliverables/verdicts/summary/recent/more 九键
  #  3. post(detail).recent.length <= 5；body 长度 <= 501
  #  4. post(detail) 无 deleted_at / account_id / streaming 键（deep key scan）
  #  5. post(list, root_id=X) 两页 after 游标不重不漏（第二页 id 全部 < 第一页最小 id）
  #  6. task(list, view) 三视图各自 200 且 total 类型为 number
  #  7. scope 负例：scope 不含 post:read 的 key → MCP 返回 error 且 **不泄漏**（错误文案不含 "not found" 之外的资源信息）
  #  8. 老 /mcp 端点仍返回老工具面（whoami 含 agent_id）→ 老基线不破
  BASE=http://127.0.0.1:3210 npm test   # 期望 166/166（老 /mcp 未动）
  DB_NAME_NEW=erix node --test src/mcp/post-tools.test.mjs src/mcp/task-tools.test.mjs
  ```
- **依赖**：3a.2、3a.4、3b.1

#### 子任务 3b.3：v2 读路由（HTTP，供期5 前端与 e2e 用）

- **交付物**：
  - 新增 `src/routes/v2/posts.ts`：`GET /api/v2/posts`（list）、`GET /api/v2/posts/:id`（detail，出参与 MCP `post(detail)` **完全同构**）
  - 新增 `src/routes/v2/tasks.ts`（本批只 `GET /api/v2/tasks?view=`）
  - 新增 `src/routes/v2/attachments.ts`：`GET /api/v2/attachments/:id`（`attachment:read`，405 若 `scan_status='infected'`）
  - 改 `src/routes/v2/index.ts`：挂载上述子路由（`src/routes/v2/index.ts` 是本批次唯一"共享文件"，由 3b.3 独占写）
- **验收方案**：
  ```
  curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:3210/api/v2/posts?kind=task&page_size=5" | jq '.items|length,.total'
  curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:3210/api/v2/posts/$TASK_POST_ID" | jq 'keys'
  #   期望与 MCP post(detail) 的键集合 diff 为空
  curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $NOREAD" ".../api/v2/posts"   # 期望 404
  ```
- **依赖**：3a.2、3b.1

#### 3b 测试用例增量

| 用例 | 对应 §九 |
|---|---|
| 无 task 语义帖子（kind=note）create→detail→list（本批用 service 直插 fixture，3c 走工具） | #3 |
| 独立任务（无 pipeline）读路径：pool/mine/due 三视图 | #5（读半） |
| 0/1/N target 三形态 detail.targets 形状 | #9（读半） |
| `post(detail)` 九键 + recent≤5 + body 截断 + 无内部字段 | **#12** |
| 迁移一致性 A–G 七条断言 | #1/#10/#11（不退化证明） |

---

---

**（第 2/3 部分）**

### 阶段 3c：写路径 + scope 门禁 + 事件模型收敛

#### 子任务 3c.1：MCP 写工具（`post` 写 action + `task` 动作 + `attachment(upload)`）

- **交付物**：扩展 3b 的 4 个文件（**不新增文件**，3c.1 独占 `src/mcp/*.ts`）
  - `post-tools.ts` 增：`create` / `reply` / `edit` / `delete` / `target` / `summary`
  - `task-tools.ts` 增：`claim` / `submit` / `verdict` / `reopen`
  - `resource-tools.ts` 增：`upload`
- **接口契约（入参/出参）**：

  | action | 入参 | 承接 service | 必需 scope | 出参 |
  |---|---|---|---|---|
  | `post(create)` `kind=task` | `{title?,body,visibility,deliverable_spec,targets?,workdir?,executor?,max_attempts?,is_ready?}` | `publishTask` | `task:write` | `{ok,post_id,status}` |
  | `post(create)` 其它 kind | `{kind:'note'\|'channel',title?,body,visibility,parent_id?,targets?,channel?}` | `createPost` | `post:write` | `{ok,post_id,root_id}` |
  | `post(reply)` | `{parent_id,body,subtype?,targets?}` | `replyPost` | `post:write` | `{ok,post_id,root_id}` |
  | `post(edit)` | `{id,title?,body?}` | `editPost` | `post:write`（他人 → `moderate`） | `{ok,revision}` |
  | `post(delete)` | `{id}` | `deletePost` | `post:write` / `moderate` | `{ok}` |
  | `post(target)` | `{id,add?:[{principal_id,role}],remove?:[{principal_id,role}]}` | `addTarget`/`removeTarget` | `post:write` | `{ok,targets}` |
  | `post(summary)` | `{root_id,refresh?:true}` | `getSummary` /（refresh 无 worker 时返回 `pending:true` + 旧摘要） | `post:read` | `SummaryView & {pending_worker:boolean}` |
  | `task(claim)` | `{task_id}` | `claimTask` | **`task:claim`** | `{ok,status,assignee_principal_id}` |
  | `task(submit)` | `{task_id,deliverables:[{name,attachment_id?,note?}],message?}` | `submitTask`（`verifier: undefined`） | **`task:submit`** | `{ok,precheck:{ok,issues},task}` |
  | `task(verdict)` | `{task_id,decision:'accept'\|'reject',opinion?}` | `verdictTask` | **`task:verdict`** | `{ok,task,verdict}` |
  | `task(reopen)` | `{task_id,reason?}` | `reopenTask` | **`task:verdict`** | `{ok,task}` |
  | `attachment(upload)` | `{filename,mime?,data_base64}(≤5MB)` | `createAttachment` | **`attachment:write`** | `{ok,attachment_id,reused}` |

  **明确删除的 action（旁路收敛，§九#7）**：老的 `task(approve|reject|resolve|revise|cancel)` **一律不实现**；`cancel` 归 `post(edit)`+`verdict(reject)`？→ 不，`cancelTask` 是独立语义但**不在 §6 工具面** ⇒ 3c 只通过 HTTP v2 `POST /api/v2/tasks/:id/cancel` 暴露给 admin（**待决 R8**），MCP 不暴露，保证任务终止只有一条链：`verdict`。

#### 子任务 3c.2：v2 写路由

- **交付物**：扩展 `src/routes/v2/tasks.ts`、`src/routes/v2/posts.ts`；新增 `src/routes/v2/events.ts`、`src/routes/v2/identities.ts`（密钥管理：`GET/POST/DELETE /api/v2/keys`，`key:manage` scope）
  - `POST /api/v2/tasks` → publish
  - `POST /api/v2/tasks/:id/claim|submit|verdict|reopen`
  - `POST /api/v2/posts`、`POST /api/v2/posts/:id/reply|target|summary`
  - `POST /api/v2/attachments`（multipart）
  - `GET /api/v2/events?action=&resource_type=&resource_id=&actor_principal_id=&after=&limit=`
- **验收方案**：见 3c.4

#### 子任务 3c.3：事件模型收敛（新 `event` + outbox worker 上线；老 events 通路只读收敛）

- **描述**：把「当前唯一隐性风险」正面处理。策略：**新写点全部走新 event（同事务）；老写点冻死（不再新增行），读取路径 `/api/events` + Dashboard 切到新表 + adapter 保持出参形状**。
- **交付物**：
  - 新增 `src/service/event-log.ts`：
    ```ts
    export interface EventView { id, action, resource_type, resource_id, actor_principal_id, actor_name, account_id, summary, payload, retention, occurred_at, published_at, attempts, last_error }
    export function listEventLog(filter: { account_id?: string; action?: string; resource_type?: string; resource_id?: string; actor_principal_id?: string; after?: string; limit?: number }): Promise<{ items: EventView[]; next_after: string | null }>
    export function renderEventSummary(e: EventView): string   // 从 action+before/after+payload 生成人话
    ```
    （`recordEvent` 直接复用 `src/service/event-outbox.ts`，**不重复造**）
  - 新增 `src/service/outbox-worker.ts`：
    ```ts
    export interface DeliverResult { ok: boolean; error?: string }
    export function startOutboxWorker(opts: { intervalMs?: number; batch?: number; deliver: (e: EventRecord) => Promise<DeliverResult> }): () => void
    ```
    循环：`publishPending({batch})` → 逐条 `deliver` → `ok? markPublished(id) : markFailed(id, err)`；导出 `stop()`；导出 `runOnce()` 供测试同步调用
  - 新增 `src/service/outbox-worker.test-hooks.ts`（或把 `runOnce` 直接放 worker 文件）→ 便于单测不靠 `setInterval`
  - 改 `src/index.ts`：**1 行**（+import）`const stopWorker = startOutboxWorker({ deliver: async (e) => { if (e.retention==='notify') console.log('[outbox]', e.id, e.action); return {ok:true}; } })`
  - 新增 `src/routes/v2/events.ts`（同 3c.2）
  - 改 `src/routes/api.ts`：`GET /api/events` 的 handler 改调 `listEventLog` + **adapter**（唯一改动点，老前端零改）：
    ```
    老出参：{ items:[{ id, type, actor, ref_task, ref_plan, summary, created_at, agent_name, task_id, task_title, task_summary, plan_id, plan_name }], total, page, page_size }
    新映射：id←String(e.id)                        // evt_* 字符串（前端只用于 :key，安全）
            type←e.action
            actor← e.actor_kind==='user' ? 'admin' : (e.actor_kind in ('host','agent','service') ? 'agent' : 'system')
            summary←renderEventSummary(e)
            agent_name←e.actor_name
            task_id← e.resource_type==='post' && e.post_kind==='task' ? e.resource_id : null
            ref_task←null  ref_plan←null  task_title←e.resource_title  task_summary←null  plan_id←null  plan_name←null
            total← listEventLog 的 COUNT  （需在 event-log 里返回 total）
    ```
  - 新增 `scripts/events-acceptance-v2.mjs`
- **关键实现约束（§3.4 三条铁律）**：新写路径全部经 service 层（`task-flow`/`posts`/`resources` 已同事务写 event）；**禁止**在路由层补 `recordEvent`。
- **验收方案**：见 3c.4

#### 子任务 3c.4：3c 验收（e2e 三件套 + 事件专项）

- **交付物**：新增 `scripts/mcp-acceptance-v2.mjs`（`--phase read|write`，565 行量级）、`scripts/rest-acceptance-v2.mjs`、`scripts/events-acceptance-v2.mjs`
- **验收方案**：
  ```
  # 环境
  node scripts/db-rebuild.mjs --database erix --force
  node scripts/migrate-identity.mjs --from task_dispatch --to erix
  node scripts/migrate-content.mjs  --from task_dispatch --to erix
  node scripts/migrate-verify.mjs --database erix
  DB_NAME=task_dispatch DB_NAME_NEW=erix PORT=3210 npx tsx src/index.ts &
  B=http://127.0.0.1:3210

  # 1) MCP 写路径 + 验收链（§九#4/#5/#6/#7）
  node scripts/mcp-acceptance-v2.mjs --phase write --base $B --mcp-path /mcp2
  # 断言：
  #  a. private+assignee：publishTask(targets=[A]) → task(list,view=mine,A) 可见 → claim → submit(附件) → verdict=accept → done
  #  b. public：publishTask(visibility=public, targets=[]) → task(list,view=pool) 可见（open+is_ready+public+assignee NULL）→ claim → submit → verdict=reject(attempts=1, 回 claimed) → reopen → submit → verdict=accept
  #  c. deliverable_spec 空方案：post(create kind=task, deliverable_spec={}) → 必须被拒（error 非空，无 post 行落库）
  #  d. 唯一验收入口：callTool('task',{action:'approve'}) 与 {action:'resolve'} 均返回 unknown action；/api/v2/tasks/:id/resolve → 404
  #  e. target 三形态：0 个 / 1 个 / 3 个 都成功；assignee（claim 后）与 targets（发布时的意图）**同时存在且独立**
  #  f. scope 负例矩阵（逐行）：无 task:claim → claim 404；无 task:submit → submit 404；无 task:verdict → verdict 404；无 attachment:write → upload 404；无 post:read → detail 404
  #  g. 全量 legacy 状态审计：任一响应 JSON 不含 "assigned"/"running"/"resolved"/"blocked"（deep scan）

  # 2) HTTP 写路径
  node scripts/rest-acceptance-v2.mjs --base $B

  # 3) 事件收敛（§九#8）—— 本批硬指标
  node scripts/events-acceptance-v2.mjs --base $B
  # 断言：
  #  ① 同事务：claim 成功后 SELECT * FROM event WHERE action='task.claimed' AND resource_id=? 存在
  #  ② 出队标记：publishPending() 取出的行之后 published_at IS NOT NULL
  #  ③ 失败重试：注入 deliver 抛错 → attempts>0 且 next_attempt_at IS NOT NULL 且 published_at IS NULL（可再次出队）
  #  ④ audit 不清理：pruneNotified(0) 后 retention='audit' 行数不变；retention='notify' 且 published 的按策略减少
  #  ⑤ 老 events 表零新增：脚本前后 SELECT COUNT(*) FROM task_dispatch.events 相等
  #  ⑥ /api/events adapter：出参键集合 == 老九键；Dashboard 渲染字段非空

  # 4) 前端不回归（视觉层未动，仅数据源切换）
  node scripts/web-acceptance.mjs --base $B     # 期望 21/21
  BASE=$B npm test                              # 期望 166/166（老 /mcp + 老 REST + Web 全绿）
  ```
- **依赖**：3b

#### 3c 测试用例增量

| 用例 | 对应 §九 |
|---|---|
| 验收链 accept / reject+reopen 闭环 | #4、#5 |
| 空 `deliverable_spec` 所有入口被拒 | **#6** |
| `resolve`/`approve` 旁路不存在 | **#7** |
| 事件同事务 / outbox attempts / audit 不清理 | **#8** |
| target 0/1/N + assignee 与 target 独立 | **#9** |
| scope 负例矩阵（6 条） | #12 §五 |
| `listTasks` pool 视图 `'active'` 已移除 | **#14** |
| deep-scan 无 legacy 状态字符串 | **#14** |
| `/api/events` adapter 出参形状 | 前端不回归前提 |

#### 3c.3 附带必修缺陷（已定位）

`src/service/task-flow.ts:807`：`predicates.push(\`t.status IN ('open', 'active')\`)` —— `post_task.status` ENUM 无 `active`。
**修法**：改为 `predicates.push(\`t.status = 'open'\`)`，并补单测断言 pool 视图 SQL 不含 `active`。

---

### 阶段 3d：老模型退役 + 基线切换 + 前端收口

#### 子任务 3d.1：`/mcp` 与 `/api/*` 切换（adapter 保形状）

- **交付物**：
  - 改 `src/routes/mcp.ts`：`/mcp` 改挂 `createMcpServerV2()` + `principalAuthMiddleware`；保留 `/mcp2` 为别名（或反向）
  - 改 `src/routes/api.ts`（57 个 handler 分组替换，**每组的出参形状冻结**）：
    - **只读组**：`/stats`、`/agents`（→`listPrincipals({kind:'host'})`+`device`）、`/agents/:id`、`/tags`、`/tasks`（→`listTasks`）、`/tasks/:taskId`（→`getPostDetail` + adapter 出老形状 `{task,messages,deliverables,reports,plan_context}`）、`/activity`（→post 流）、`/events`（→已完成 3c）、`/conversations*`（→`post_channel`/`post`）、`/settings*`（→新 `setting`/`llm_*`；**可留 3d 后**，见 R9）
    - **写入组**：`POST /agents`（→`createAccount`? 不需要；→`createPrincipal(kind:'host')`+`registerDevice`+`createApiKey`，**明文 key 只在创建时返回**，行为与老一致）、`/agents/:id/reset-key`（→`rotateApiKey({grace_hours:24})`）、`/agents/:id/toggle`（→principal/device status）、`/tasks`（→`publishTask`）、`/tasks/:id/reply|reopen|reassign|cancel`、`/conversations`、`/conversations/:id/messages`
    - **删除组**：`/tasks/:taskId/resolve`、`/tasks/:taskId/deliverable-visibility`（§九#7）
  - 改 `src/routes/agent.ts`：`agentRouter.use(principalAuthMiddleware())`；18 端点逐组切；**删** `/tasks/resolve`、`/tasks/result`
  - 删除文件：`src/db.ts`、`src/service/tasks.ts`、`src/service/market.ts`、`src/service/events.ts`、`src/service/attachments.ts`、`src/service/tags.ts`、`src/service/settings.ts`（若已切新 `setting`）、`src/service/llm.ts`（若已切新 `llm_*`）
  - **保留不动**：`src/ws-server.ts` + `src/service/chat.ts`（**待决 R10**）
- **验收方案**：见 3d.4 步骤 3–5

#### 子任务 3d.2：老库归档（`task_dispatch` 只读化）

- **交付物**：新增 `scripts/db-archive.mjs`
  - `mysqldump task_dispatch` → `backups/task_dispatch-<ts>.sql`（若 `mysqldump` 不可用则仅打印指引）
  - `ALTER DATABASE task_dispatch READ ONLY = 1`（MariaDB 支持）
  - 打印新库切换指引
- **验收方案**：
  ```
  node scripts/db-archive.mjs --database task_dispatch
  # 断言：SHOW CREATE DATABASE task_dispatch 含 READ ONLY=1；INSERT 到老库被拒
  # 断言：backups/*.sql 存在且行数 > 0
  ```
- **依赖**：3d.1（必须确认老代码已不再写老库）

#### 子任务 3d.3：测试双轨收敛

- **交付物**：
  - 改 `scripts/test-all.mjs`：三步改为 `mcp-acceptance-v2` / `rest-acceptance-v2` / `web-acceptance`；`cleanupTestData` 改新表（`post`/`post_task`/`post_channel`/`attachment`/`principal`）；LLM provider 禁用/恢复改为新 `llm_provider.enabled`
  - 改 `package.json`：
    ```
    "test": "node scripts/test-all.mjs",
    "test:unit": "node --test src/**/*.test.mjs",
    "test:legacy": "echo 'legacy suite retired at 期3 (see docs/design/data-model.md §9)' && exit 0"
    ```
  - 老脚本归档：`git mv scripts/mcp-acceptance.mjs scripts/legacy/mcp-acceptance-legacy.mjs`、同 `rest-acceptance.mjs`
  - 新增 `docs/design/data-model.md` §9 追加「测试基线」小节：**新模型为主**，老用例仅 Web e2e（21）保留，MCP/REST 断言集迁入 v2 脚本
- **基线声明（明确定义）**：
  | 套件 | 数量 | 库 | 期3 归属 |
  |---|---|---|---|
  | `src/**/*.test.mjs`（新单测） | 36 → ≥110 | `erix` | 主基线 |
  | `mcp-acceptance-v2.mjs` | ≥101 断言 | `erix` | 主基线（替代老 MCP 101） |
  | `rest-acceptance-v2.mjs` | ≥38 断言 | `erix` | 主基线（替代老 REST 38） |
  | `web-acceptance.mjs` | 21 | `erix` | 主基线（**视觉层复用，脚本仅改测试数据构造**） |
  | `*-acceptance-legacy.mjs` | 139 | `task_dispatch` | 归档，不跑 |

#### 子任务 3d.4：前端数据接线收口（最小改动）

- **交付物**（原则：**`web/src/` 只改"出参形状确实变了"的地方**）：
  - 若 adapter 完备 → `web/src/api.js`、`web/src/views/*.vue` **0 改动**（首选）
  - 若必须改，仅限：`web/src/api.js`（端点路径）、`web/src/views/Dashboard.vue`（活动流字段名）
  - **明确不动**：`App.vue`（双栏骨架）、`theme.js`（四主题）、`views/Login.vue`、`components/ChatPanel.vue`、`components/StatusBadge.vue`、`components/Pagination.vue`、`components/TagPicker.vue`、`style.css`、空状态/骨架屏
  - **期5 才做**：广场（新 `views/Plaza.vue`）、收件箱（`views/Inbox.vue`）、任务详情重写、对话重写、编排视图
- **验收方案**：
  ```
  cd web && npm run build           # 期望成功且 bundle hash 变化 < 若 0 改动则 hash 不变
  node scripts/web-acceptance.mjs --base http://127.0.0.1:3200   # 期望 21/21
  ```
- **依赖**：3d.1

#### 3d.4：全量终验（唯一端口 3200 / 唯一库 erix）

```
# 1) 重建 + 迁移 + 归档
node scripts/db-rebuild.mjs --database erix --force
node scripts/migrate-identity.mjs --from task_dispatch --to erix
node scripts/migrate-content.mjs  --from task_dispatch --to erix
node scripts/migrate-verify.mjs --database erix
node scripts/db-archive.mjs --database task_dispatch

# 2) 单库切换
#   .env: DB_NAME=erix          （删 DB_NAME_NEW 或保留为同值）
#   src/config.ts: 删 dbNew（或保留为 db 的别名）

# 3) 全量
npm run build
DB_NAME=erix PORT=3200 node dist/src/index.js &
BASE=http://127.0.0.1:3200 npm test
DB_NAME=erix node --test src/**/*.test.mjs
node scripts/db-verify.mjs --database erix            # 25 表 + 索引 + 陷阱全 PASS

# 4) legacy 静态审计（§九#14）
grep -rnE "\b(assigned|running|resolved|blocked)\b" src/ web/src/ --include='*.ts' --include='*.js' --include='*.vue'   # 期望 0
grep -rn "t.status IN ('open', 'active')" src/                                                                        # 期望 0
grep -rn "from '../service/events.js'\|from './service/events.js'" src/                                                # 期望 0

# 5) 老库零写入
# 跑 test 前后：SELECT COUNT(*) FROM task_dispatch.events 不变（899 → 899）
```

---

## 2. 明确回答三个问题

### Q1：期3 有可独立并行的切片吗？（文件级不重叠）

**有 5 个**。只要 `src/index.ts` 与 `src/routes/v2/index.ts` 按约定各自只被一个切片写（见下），3a–3c 期间 **`src/routes/api.ts`、`src/routes/agent.ts`、`src/db.ts`、`src/service/{tasks,market,plans,chat,attachments,tags,events}.ts` 全部冻结**，因此不冲突。

| 切片 | 独占文件（写） | 只读依赖 | 可并行对象 |
|---|---|---|---|
| **P1 鉴权/配置** | `src/config.ts`、`src/db/pool.ts`、`src/auth-principal.ts`、`src/util/time.ts`、`src/routes/v2/index.ts`、`src/index.ts`（3a 一次性） | `src/service/identity.ts` | P4 |
| **P2 迁移脚本** | `scripts/migrate-identity.mjs`、`scripts/migrate-content.mjs`、`scripts/migrate-verify.mjs`、`scripts/db-archive.mjs` | `src/db/schema.ts`、`src/id.ts` | P1、P3、P5 |
| **P3 MCP 工具面** | `src/mcp/context.ts`、`post-tools.ts`、`task-tools.ts`、`resource-tools.ts`、`identity-tools.ts`、`index.ts`、`src/routes/mcp.ts` | P1 的中间件、service 层 | P1（接口先定）、P5 |
| **P4 事件收敛** | `src/service/event-log.ts`、`src/service/outbox-worker.ts`、`src/routes/v2/events.ts`、`src/routes/api.ts` 的 `/api/events` handler（**唯一豁免**，只改这一个 handler，用 `// 3c: events convergence` 注释圈定） | `event-outbox.ts` | P1、P2 |
| **P5 v2 读/写路由 + e2e 脚本** | `src/routes/v2/{posts,tasks,attachments,identities}.ts`、`scripts/{mcp,rest,events}-acceptance-v2.mjs` | P1–P4 | P3 |

**不可并行（必须串行）**：`src/index.ts` 在 3c 加 outbox worker 启动（P4 独占）→ 与 P1 的 3a 改动错开时间；`src/routes/api.ts` 全量重写在 3d（独占）。

### Q2：§九 验收口径的期别归属

| # | §九 条目 | 期3 只能 | 可留期4/期5 | 说明 |
|---|---|---|---|---|
| 1 | 新 schema 一把建起，8 原语对应，无玩法字段 | | ✅ 期1 已完成 | 期3 只做"不退化"断言（`db-verify`） |
| 2 | ID 全字符串/无混淆/前缀/时间有序 | | ✅ 期1 已完成 | 期3 断言新路由不引入手写 id（静态 `grep -E "'[a-z]{2,4}_' \+"`） |
| 3 | 无 task 语义帖子全链路（发布/回帖/可见性/寻址） | **✅ 只能期3** | | 期2 仅 service；接入层暴露 `post(create/reply/target)` 后才有全链路 |
| 4 | task=post 状态机/交付物/验收链/打回**不回退** | **✅ 只能期3**（验收链/打回/超时回收） | ⚠️ **周期克隆** 需拍板（见 R2） | "不回退" 是相对老模型的能力保持；周期克隆依赖 `trigger/pipeline` 服务**当前不存在** |
| 5 | 独立任务（无 pipeline）全链路：private+assignee / public 两路径 | **✅ 只能期3** | | 期3 一期一测 |
| 6 | `deliverable_spec` 硬强制（所有入口） | **✅ 只能期3** | | 期2 校验已有；期3 靠"删旁路 + 所有入口走 `publishTask`"达成 |
| 7 | 验收入口唯一（`/tasks/resolve` 类旁路消失） | **✅ 只能期3** | | 老 `routes/api.ts` + `routes/agent.ts` 的 resolve 必须删 |
| 8 | event 同事务 + outbox attempts/重试 + audit 不清理 | **✅ 只能期3** | | outbox worker 接线在此；老 `events` 下线在此 |
| 9 | 寻址 0/1/N + assignee≠target | **✅ 只能期3** | | |
| 10 | 时间全部应用侧写入 | | ✅ 期1（DDL 已保证） | 期3 断言新代码无 `DEFAULT CURRENT_TIMESTAMP` |
| 11 | 索引按查询模式建齐 | | ✅ 期1 已完成 | |
| 12 | MCP 工具原语化 + `post(detail)` 结构化 | **✅ 只能期3** | | 期3 的核心 |
| 13 | 摘要：debounce+串行+短线程门槛+显式刷新+失败降级**全部有测试** | ⚠️ **部分**：`post(summary)` 工具壳 + `refresh` 入口 + `stale/pending` 返回 = 期3 | ✅ **debounce/串行/门槛/降级测试 → 期4** | 期2 只有 `getSummary/saveSummary`；worker 是期4 |
| 14 | 无 legacy 状态（assigned/pending/running/resolved） | **✅ 只能期3** | | **已定位真实缺陷**：`task-flow.ts:807 'active'` 必修 |
| 15 | 前端 e2e（广场/收件箱/任务详情/对话/编排视图） | ⚠️ 期3 只保证**现有** e2e（Dashboard/Hosts/TaskDetail 老形状）不回归 | ✅ **广场/收件箱/新任务详情/新对话/编排视图 → 期5** | #11 协调备注 §3 已把视觉层改造划期5 |
| 16 | `npm test` 重写后全绿 | **✅ 只能期3** | | 基线切换在 3d.3 |

**结论**：期3 必须完成的唯一关键词 = #3/#4/#5/#6/#7/#8/#9/#12/#14/#16；#13 的 worker 部分与 #15 的新视图留期4/期5。

### Q3：`task_dispatch` 与 `erix` 如何切换/共存

**共存机制（3a–3c）**：
1. **两个独立连接池**：老 `src/db.ts`（`config.db.database` ← `DB_NAME`，默认 `task_dispatch`）与新 `src/db/pool.ts`（`DB_NAME_NEW`，默认 `erix`）。mariadb `createPool` 天然支持双池同进程。
2. **`initSchema()` 守卫**：目标库名 == `task_dispatch` 直接抛错（3a.1），彻底堵死"误建表到老库"。
3. **唯一桥梁 = 迁移脚本**（一次性 + 幂等）。**老库在 3a–3c 期间保持权威**；新库由脚本填充种子 + 3b/3c 的 e2e 写入。**不做双向同步**（老库有 6 agents 心跳 / 28 conversations / 47 chat_messages 的持续写入 → 双向同步成本远超收益）。
4. **切换点（3d）**：停写窗口 → `db-rebuild --database erix --force` → 重跑 identity+content 迁移 → `db-archive task_dispatch`（`READ ONLY=1`）→ `.env: DB_NAME=erix` → 删 `dbNew` → 重启。
5. **`db-rebuild.mjs` 默认拒绝 `task_dispatch`** 是既有保护（`scripts/db-rebuild.mjs:39`），**期3 保留且加强**：新增 `--from`/`--to` 参数校验，`--to task_dispatch` 在非 `--force` 时拒绝。
6. **回滚路径**：期3 期间老库完好 → 回滚 = 把新挂载（`/api/v2`、`/mcp2`、outbox worker）停掉，老路径原样可用。3d 后回滚需从 `backups/*.sql` 恢复 + `git revert`。

---

## 3. 风险与待决策（需要用户拍板）

| ID | 风险/决策点 | 事实依据 | 建议 | 阻塞批次 |
|---|---|---|---|---|
| **R1** | **老库数据是否可丢** | 实测 `agents=6, conversations=28, chat_messages=47, events=899, tasks=0, plans=0`（不是纯测试数据） | #11 §8 说可丢，但那是基于"测试数据"假设。建议：**身份域必须迁（agent key 直拷，零成本）；对话/事件按"可选迁"**（`migrate-content.mjs --skip-events`） | 3a.3、3b.1 |
| **R2** | **周期克隆 / plan-stage 编排在期3 是否必须等价迁移** | 老 `plans`/`plan_stages` 服务实现存在（`src/service/plans.ts` 514 行）；新 `pipeline`/`pipeline_step`/`trigger` **只有 schema，零服务实现** | 建议：**期3 保留 `plans`/`plan_stages` 表与通路不退役**（写入 `/api/plans` 仍走老实现），编排移交新模型留**期3.5/期4**。否则 §九#4「周期克隆不回退」无法满足 | 3b.1、3d.1 |
| **R3** | 老业务号（`T-260813-xxxx`、`agent-xxxxxx`、`plan_id`）是否保留为人类可读别名 | 老 ID 在 UI/URL/日志中大量出现；新 ID 是 `pst_*` | 建议：**保留为 `post.title` 前缀或在 `post` 增加只读 `extras`**；不新增列（违反最小 schema）→ 折中：**迁移脚本把老 `task_id` 写进 `post.title` 尾部 `[T-xxx]`，并在 `/api/tasks/:taskId` adapter 里做反查映射** | 3b.1、3d.1 |
| **R4** | 旧 API 是否有兼容期 | 前端 57 个调用面 + 已接入 client（`client/src/`、`scripts/chat-bridge.mjs`） | 建议：**HTTP 兼容期 = 期3 全期**（BFF adapter，前端零改）；**MCP 工具面无兼容期**（breaking change 立即生效，客户端 `setup.mjs` 需同步）| 3c、3d |
| **R5** | 空 `deliverable_spec` 的老任务如何迁移 | `post_task.deliverable_spec` 是 `NOT NULL`；老 `tasks.deliverable_spec` 可 NULL | 建议：空 → 迁移为 `status='rejected'` + body 追加 `[迁移：原任务无验收方案]`（**不造假 spec**，保持 §九#6 语义） | 3b.1 |
| **R6** | 附件实体文件路径是否重排 | 新 `relative_path` 格式 `{owner}/{yyyy}/{mm}/{dd}/{id}.{ext}`；老库 `attachments.relative_path` 是另一个格式 | 建议：**迁移时保留老相对路径不动**（`relative_path` 是 VARCHAR，格式无约束），只迁元数据；文件实体零移动 → 零风险 | 3b.1 |
| **R7** | MCP 工具面 breaking change 怎么过渡 | `/mcp` 是单端点；3b 一切换，老 `mcp-acceptance.mjs` 101 用例立即失败；已接入 agent 的 system_prompt 里写着老工具名 | 建议：**3b/3c 挂 `/mcp2`，`/mcp` 保持老工具面**（本计划已采用）→ 3a–3c 期间 `npm test` 仍 166 全绿；3d 切 `/mcp` 并**同步更新 `client/src/setup.mjs` 的 MCP 配置与提示词**。**需确认：已接入的 6 台 host 是否需要我们主动推送新提示词/重启 bridge** | 3b.2、3d.1 |
| **R8** | `task(cancel)` / `task(revise)` 是否保留在 MCP 面 | #11 §6 工具面只列 `claim|submit|verdict|reopen`，无 cancel/revise；但老模型有这两个动作，取消/修订是真实需求 | 建议：**MCP 不暴露**（保持工具数不随玩法增长）；仅 admin HTTP `POST /api/v2/tasks/:id/cancel` + `post(edit)` 修订。**需确认 agent 是否真的需要自主取消** | 3c.1 |
| **R9** | `settings` / `llm_*` 是否在期3 同期迁移 | 新 `setting`/`setting_history`/`llm_provider`/`llm_model`/`llm_call` 有 schema；老 `src/service/settings.ts` + `llm.ts` 有 ~810 行实现 | 建议：**期3 不迁**（保留老表通路），只在 `config.dbNew` 侧不动；settings 迁移留期4 与摘要 worker 同期（摘要要用 `llm_model`）。**需确认是否接受"新库无 settings、老库有"的双轨到 3d 之后** | 3d.1 |
| **R10** | WS 对话通道（`ws-server.ts` + `ChatHub`）是否期3 退役 | #9 说 SSE 取代 WS，但 #9 在期3 之后；`ChatHub` 依赖老 `agents.id`（内存 Map，单进程） | 建议：**期3 保留老 WS 不动**（若 `agents` 表退役则 WS 会坏 → 需把 `ChatHub` 的 key 改为 principal_id，属**必要小改**，~10 行）。**需确认期3 是否允许动 `ws-server.ts`** | 3d.1 |
| **R11** | `visibility` 是否在接入层做读取过滤 | §1「平台只做声明不做限制」vs #12「不泄漏存在性」 | 澄清：#12 的"不泄漏存在性"针对 **scope**（404），不是 visibility。建议：**接入层不过滤 visibility**（声明语义），过滤留给期5 前端与主体自觉。**需用户确认**（若要求强制过滤，则所有 list/detail 查询要加 `visibility` 谓词，改动面显著扩大） | 3b.2 |
| **R12** | 迁移是否需要"停写窗口" | 老库有持续写入（agent heartbeat / chat） | 建议：3a–3c **不需要**（只迁身份域一次，之后老库权威）；3d **需要 ~5 分钟停写窗口**（停止服务 → 重迁 → 归档 → 切换 → 启动） | 3d.2 |

---

**（第 3/3 部分）**

### 已知技术陷阱（实现时必须注意，来自 `docs/design/data-model.md` §10）

1. `root_id` 自指 FK 未加 → 一致性自检必做（3b.1 断言 A/C）
2. `` `trigger` `` 是 MariaDB 保留字 → 3d 若启用 `trigger` 服务，SQL 必须反引号
3. 生成列语法 `GENERATED ALWAYS AS (...) STORED` → `deliverable` 单 current 靠 `uq_dlv_current`
4. DDL **不写** `DEFAULT CURRENT_TIMESTAMP` → 老 `db.ts` 表大量使用，新库禁止
5. 事务铁律：**任何写业务数据的函数必须同事务写 event** → 3c 禁止路由层补 `recordEvent`
6. ID 长度统一 `VARCHAR(32)`；前缀登记表新增实体必须更新

---

## 4. 交付物清单（文件级汇总）

**新增（31 个）**
```
src/auth-principal.ts            src/auth-principal.test.mjs
src/util/time.ts                 src/util/time.test.mjs
src/mcp/index.ts                 src/mcp/context.ts
src/mcp/post-tools.ts            src/mcp/post-tools.test.mjs
src/mcp/task-tools.ts            src/mcp/task-tools.test.mjs
src/mcp/resource-tools.ts        src/mcp/identity-tools.ts
src/routes/v2/index.ts           src/routes/v2/posts.ts
src/routes/v2/tasks.ts           src/routes/v2/attachments.ts
src/routes/v2/events.ts          src/routes/v2/identities.ts
src/service/event-log.ts         src/service/event-log.test.mjs
src/service/outbox-worker.ts     src/service/outbox-worker.test.mjs
scripts/migrate-identity.mjs     scripts/migrate-content.mjs
scripts/migrate-verify.mjs       scripts/db-archive.mjs
scripts/mcp-acceptance-v2.mjs    scripts/rest-acceptance-v2.mjs
scripts/events-acceptance-v2.mjs
docs/design/phase3-wiring.md     （接线契约 + 基线声明）
```
**修改（8 个）**
```
src/config.ts          (dbNew)
src/db/pool.ts         (默认库名 + 守卫 + created 返回)
src/index.ts           (挂 /api/v2、initSchema、outbox worker)
src/routes/mcp.ts      (/mcp2 → createMcpServerV2；3d 切 /mcp)
src/routes/api.ts      (/api/events adapter；3d 全量重写)
src/routes/agent.ts    (3d 全量重写)
src/service/task-flow.ts  (修 'active' legacy bug，1 行)
scripts/test-all.mjs   (3d 基线切换)
package.json           (test:unit / test:legacy)
```
**删除（3d，9 个）**
```
src/db.ts
src/service/{tasks,market,events,attachments,tags,plans?,chat?,settings?,llm?}.ts   ← 按 R2/R9/R10 决定子集
scripts/{mcp,rest}-acceptance.mjs                                                   ← 归档到 scripts/legacy/
```

---

---

## 期3 交接说明（2026-09-13）

**期3 任务书已就位**（本 issue 上方 3 条评论，planner 只读勘察产出）：4 批次 / 14 子任务 / 5 个并行切片，含文件级交付物、接口契约（`post(detail)` 九键逐字）、可执行验收命令与断言。

**两个 blocker 已修复并合并**（PR #20，main `a29ad83`）：
1. `src/db/pool.ts` —— 新池不再回落老库 `task_dispatch`（`resolveNewDbName()`：`DB_NAME_NEW` → `DB_NAME`(非老库) → `erix`；`initSchema()` 加守卫直接抛错）
2. `src/service/task-flow.ts:807` —— pool 视图 `t.status IN ('open','active')` → `t.status = 'open'`（ENUM 无 `active`）

验证：typecheck ✅；新模型单测 **36/36** ✅；老用例 `npm test` **166/166** 无回归。

> 📌 计数更正：此前评论/PR 里写的「64 单测（task-flow 36）」是误把合并输出的总数当成单文件数，**实际 36 个**（id 8 / events 6 / identity 5 / posts 7 / resources 2 / task-flow 8），已就地更正。

**开工前需拍板（详见任务书 §3 的 R1–R12，关键 6 项）**：

| # | 决策点 | 建议 |
|---|---|---|
| R1 | 老库有**真实数据**（6 主机 / 28 会话 / 47 消息 / 899 事件；任务与计划为 0），与 §8「旧库可丢」不符 | 身份域必迁（**key_hash 可直拷**——新旧都是 sha256，已接入 agent 无需换 key）；会话/事件可选 |
| R2 | 老编排实现存在（`service/plans.ts` 514 行），新 `pipeline`/`trigger` **零服务实现** | 期3 保留老编排通路，移交新模型留期3.5/期4（否则周期克隆静默回退） |
| R7 | MCP 工具面 breaking change | `/mcp2` 挂新面、`/mcp` 保老面（期3 期间老用例不炸）；3d 切换并同步 `client/setup.mjs`；需定是否主动更新已接入 6 台主机 |
| R10 | WS 是否期3 退役 | 保留（#9 之后）；`ChatHub` 依赖 `agents.id`，退役前需 ~10 行改 `principal_id` |
| R11 | `visibility` 是否接入层强制过滤 | 不过滤（§1「只做声明」；404 是 scope 语义） |
| R12 | 3d 切换 | 需 ~5 分钟停写窗口 |

**执行归属**：期3 建议由持有期2 建模上下文的 session 承接（本 issue 的 3a→3d）。另一个方向（并行）请注意：**同一工作目录只能有一个 writer**；若需并行，请按任务书 §2 Q1 的 5 个切片分配文件（P1–P5 互不重叠），并分配不同端口（过渡期 3210 / 主力 3200）。
