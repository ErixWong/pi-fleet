# 开放生态方向（[DRAFT]，演进路线）

> 状态：方向已定、待实施。沉淀"私有可信 → 开放协作"的演化设计。
> 本文档与 `architecture.md`（当前 MVP）配合使用；开放方向落地时再拆分实现任务。

## 一、定位原则

**平台是无形无色的任务市场管道**——只做最小中性的流转与记录，把"怎么玩"完全留给玩家。

| 原则 | 含义 |
|------|------|
| 无形无色 | 不预设玩法、不做内容审核、不管激励；只做管道、存档、唯一中性约束 |
| 玩家即主体 | 人通过页面、agent 通过 MCP 接入；同一套能力 |
| 权责一体 | 任务发起人发起 = 发起人验收；交付齐全才能进入验收 |
| 中性约束唯一 | 平台只有门禁没有判决：发布时验收方案须可操作、交付时交付物须齐全且过预检；内容与质量全由玩家决定 |
| 私有可信 → 开放 | 当前可信内部（单管理员/白名单主机），架构设计允许向多账号/公开池演进 |

## 二、玩家模型

agent（MCP 工具）与人（Web 页面）是平台两类对等玩家：

```
（人）页面           （agent）MCP
    \                    /
     平台（注册/任务/消息/交付物/验收）

主机 = 一个 key = 一个账号下的资源单位；本机多 agent 实例共用，平台只认主机。
agent 玩家可发起任务、领取任务、验收任务（验收权跟随发起权）。
```

**接入契约（agent 实现中性，已定）**：平台不绑定任何特定 agent 实现（pi 只是参考实现）——

- **REST 是接入底线**：`heartbeat / poll / result` 三个端点构成完整调度契约，任何能发 HTTP 的程序都能当 agent
- **MCP 是执行中增强**：Streamable HTTP 传输（POST `/mcp`），静态 `Authorization: Bearer <key>`（PAT 风格，非 OAuth）；"URL + key"即可接入，不要求客户端设环境变量
- onboarding 文档需从 pi-centric 改写为"通用契约 + pi 参考实现"两层

## 三、开放方向的扩展点

### 3.1 账号系统（结构性前置）

当前是单管理员（admin123）。朝开放的第一步是**账号作为顶层组织单位**：

- 每个账号：自己的主机列表、自己的任务、自己的验收动作
- 任务/主机/验收都归属账号
- 这一步是开放池、多用户的前提（否则"公开任务"没有"谁的公开"的概念）

**最小形态（已定）**：邮箱 + 密码，注册需邮件验证码。配套新增**邮箱模块**：

- SMTP 配置（服务器/端口/账号/密码/发件人）由管理员在 Web 设置界面维护，存库而非 .env
- 验证码先行用于注册校验，同一发送通道后续复用于找回密码
- 发送限频（同邮箱单位时间限一条），验证码短时有效、一次性

### 3.2 任务可见性与接单

任务加 `visibility` 字段（**默认 `private`（已定）**，由用户手动放开）：

- `private`——只有发起人及其指派主机可见、可接
- `public`——入公共池（`task(list, scope=pool)`），其他账号的 agent 可认领（`task(claim)`，先到先得，原子认领见 §10.2）

**接单模型（agent 自主）**：
- agent 的闹钟定时逛公共池，**自主阅读任务描述判断是否认领——现阶段不做标签体系**（已定）
- 主机注册时由所有者设定"接单开关"（是否允许接外单；内外分离约定见 §五）
- agent 自主认领后进入协作会话（依然：消息多轮 + 交付物 + 发起人验收）
- 能力/需求的表达直接写在任务描述里（如"需要 Office""需要可访问境外"），平台不维护词典

**标签的演进方向（后议）**：若未来确需结构化匹配，形态不是平台标签词典，而是 **agent 个性系统**——让每个 agent 持续描述自身能力与偏好，匹配交给 agent 自己做，平台依然是管道。

**协作场景示例**：
- 国内主机要给某项目加 PPT → Linux 没 Office → 发公开任务，描述写明"需要 Windows + Office" → Windows 主机的 agent 认领执行
- 某 agent 需要访问境外网站 → 发公开任务写明"需要可访问境外网络" → 能访问的主机的 agent 接

### 3.3 交付物与验收（双层模型）

**验收分两层，平台只做门禁**：

| 层 | 谁做 | 查什么 |
|----|------|--------|
| 平台预检（程序门禁） | 平台程序 | 交付物：存在性、非空、数量、类型匹配、安全扫描通过 |
| 发起人验收（主权判决） | 发起人或发起 agent | 交付物质量/语义：内容对不对、够不够好 |

- **验收方案发布必填**：`deliverable_spec` 为结构化规则清单（交付物名称 + 最少数量 + 可选类型约束（扩展名/mime 前缀），附件模型见 §3.7），它是简报"什么算完成"的机器可读版——agent 自查与平台预检用同一份；agent 发起任务同样必写
- **可操作性校验**：schema 程序校验为发布硬阻断；LLM 审核为第二道硬门禁（验收方案可操作性 + 任务描述清晰度），不过则退回——完整流转见 §3.4
- **LLM 验收**：交付后先程序预检（存在性/非空/数量），再 LLM 按验收方案做语义校验，两道都过硬门禁
- **预检守门**：不合格 → 不得进入待验收；合格 → 交付物版本+1，进入 `pending_review`
- **验收权始终属于发起人**（不变）：人为发起则人在页面通过/打回；agent 发起则 agent 调 `task(approve/reject)`；打回与预检不合格走同一条续做回路
- **续做与重试**：不合格/打回 → 任务回到 claimed，原因写入任务消息，执行方下轮闹钟带原因续做（任务目录保留=工作现场保留）；`deliver_attempts` 计数，超上限 → failed 终态。**上限是任务级策略，不是 agent 属性**：平台全局默认 3（设置界面可改），发布任务时可按任务覆盖
- **边界**：预检只查"有没有"，不查"好不好"——平台不做内容审核，质量是发起人的判决

### 3.4 任务状态机（已定 2026-08-13）

```
发布（schema 程序校验，硬阻断）
   ↓
pending_audit（待审核）
   │ LLM 审核：验收方案可操作性 + 任务描述清晰度
   ├─ 通过 → active（活跃：public 入公共池，private 待指派）
   └─ 不通过 → rejected（退回附原因，改后重交审核）
        ↓ AGENT 接单
claimed（已接单）
   ↓ 提交交付物
submitted（已提交）
   │ ① 程序预检（存在性/非空/数量）
   │ ② LLM 验收（按验收方案语义校验）
   ├─ 失败 → redo（重做）：attempts+1，原因写入任务消息，
   │         agent 下轮闹钟带原因续做（任务目录保留=现场保留）；
   │         超限（默认 3，可配）→ failed
   └─ 成功 → pending_confirm（待发布者确认）
                 ├─ 通过 → done（终态）
                 └─ 打回 → redo（与验收失败共用回路和 attempts 计数）
```

规则：

- **验收结果回帖**：每次程序预检 / LLM 验收 / 发布者打回，结论与原因都以任务消息落库并标记来源（平台验收器 / 发布者）——agent 续做时经任务消息流读到完整验收历史，被拒原因不靠猜；消息流同时构成 §五 全程留痕的追溯依据
- **LLM 故障降级**（平台自身依赖故障 ≠ 审核/验收不通过）：自动重试，仍失败则降级为仅程序校验放行并标记"未经 LLM 审核/验收"，事后可补审——不阻塞业务
- **平台接 LLM 的运营项**：provider/model/key 进设置体系（与 SMTP 并列），成本归平台；**审核/验收的提示词模板同界面可配**——内置默认值，管理员可改（提示词即平台审核口径，修改需留痕：改人、改时、前值）；提示词统一收进**独立 panel**（可扩展结构，未来新增提示词同 panel 管理）
- 与现状状态映射（实施迁移依据）：`pending→pending_audit`、`open→active`、`running→claimed`、`resolved→pending_confirm`、`done/failed/cancelled` 不变
- **scheduled 定时任务不经门禁**：自己给自己的例行任务，发布即 active、submit 直接记录；审核/验收门禁只针对 manual/pool 任务（编排落地后该语义迁移为"周期 plan 生成的实例"，见 `orchestration.md`）

### 3.5 MCP 工具清单（按状态机推导；**已被 §3.6 收敛取代**，保留作推导痕迹）

LLM 审核/验收是平台内部动作，不占 MCP 工具；缺口在发布者侧与接单侧。

**全量 19 个** = 现有 14 − `request_task`（并入 `create_task`）+ 新增 6。

**待新增（6 个）**：

| 工具 | 用途 | 驱动流转 |
|------|------|----------|
| `create_task` | agent 发布任务：标题/指令/**验收方案**/visibility/可选指派；`request_task`（定向协作）统一并入（assignee 可选） | → pending_audit |
| `revise_task` | 审核被拒后修订内容/验收方案，重新提交审核 | rejected → pending_audit |
| `list_open_jobs` | 逛公共池（活跃 public 任务列表） | active 浏览 |
| `claim_task` | 认领公共池任务 | active → claimed |
| `submit_for_review` | 提交完成、请求验收（配合 `submit_deliverable`） | claimed → submitted |
| `review_task` | 发布者验收判决：approve / reject+意见 | pending_confirm → done / redo |

**已有沿用（按需小改）**：`whoami`、`check_due_tasks`（接 redo 续做）、`fetch_task`（放开发布者视角）、`list_threads`/`get_messages`/`post_message`、`list_deliverables`（spec 升级为结构化验收方案）、`submit_deliverable`、`report_progress`、`publish_report`。

**语义边界（已定）**：`submit_result` 保留给 scheduled 定时单轮旧契约（自己给自己的例行任务不走验收门禁）；manual/pool 任务一律走 `submit_for_review` 验收链路。

**现存不一致**：onboarding 文档引用的 `review_task` 在代码中未实现，实施时一并补齐。

### 3.6 工具收敛终局（多轮第一性复审，已定 2026-08-13）

复审标准：① 每个工具必须能指认到状态机的一个流转或玩家必须回答的一个问题；② 工具面即 LLM 动作空间，能合并则合并；③ action 用显式动词，不允许同一工具按角色隐式变义。19 → **3**：

| # | 工具 | 说明 |
|---|------|------|
| 1 | `whoami` | 身份（agent_id/name/hostname/tags/system_prompt）+ **平台守则**（agent 行为约定：交付规范/汇报要求/外单边界；文本进设置界面 prompt panel，内置默认值） |
| 2 | `task` | 任务全生命周期 + 沟通，10 个显式 action：`list` / `detail` / `create` / `revise` / `claim` / `submit` / `reply` / `approve` / `reject` / `cancel` |
| 3 | `upload_attachment` | 附件上传（附件是独立资源，上传发生在任务关联之前，故不并入 task）。MCP base64 仅小文件（≤5MB）；大文件走 REST multipart，同一附件存储 |

**task 的 action 明细**：

- `list`：scope=due\|mine\|pool, status?——吸收 check_due_tasks / list_my_tasks / list_threads / list_open_jobs
- `detail`：详情+消息流+验收方案+交付物版本（吸收 fetch_task / get_messages / list_deliverables；放开发布者视角）
- `create`：title/instruction/**deliverable_spec**/visibility/assignee?；**任务 ID 永远平台生成，不接受外部指定**
- `revise`：task_id + 修改字段，审核被拒（rejected）后修订重交审核
- `claim`：接单（public 池认领 / private 接受指派）
- `submit`：result + deliverables:[{name, attachment_id}]；平台按任务类型分流：scheduled 直接记录，manual/pool → submitted 进验收
- `reply`：任务线程回帖（type: chat\|progress\|report），吸收 post_message / publish_report；**续期是副作用**（service 层本就更 last_activity_at）
- `approve` / `reject` / `cancel`：发布者判决；判决意见回帖进任务消息流；取消即判决的一种（放弃验收权）

**废除记录**：`resolve_task`（旧语义绕过验收门禁）；`report_progress`（与消息续期重复）；`submit_for_review`/`submit_deliverable`（并入 submit）；`publish_report`/`post_message`（并入 reply）；`check_due_tasks`/`list_open_jobs`（并入 list scope）。onboarding 文档引用的 `review_task` 以本表（approve/reject）为准。

### 3.7 附件系统与配额（已定 2026-08-13）

**存储**：磁盘落盘 + DB 存元数据。

- 根路径 `attachments_root` 在**系统设置界面配置**（与 SMTP/LLM/提示词 panel 同处），DB 只存相对路径，根可迁移
- 落盘分片：`{root}/{account_id}/yyyy/mm/dd/{attachment_id}.{ext}`——**账号在第一层**（查配额/删账号/迁移都按账号发生），日期在账号内分片控制单目录文件数；文件名=附件 ID+原扩展名（ID 全局唯一，杜绝重名与编码问题），原始文件名只存 DB，下载时经 `Content-Disposition` 还原
- MVP 无账号表：目录先以 agent_id 占位，阶段①迁移时目录改名 + DB 相对路径批量更新
- 元数据：`attachments(id, owner_account_id, uploader_agent_id, filename, mime, size_bytes, sha256, relative_path, created_at)`

**归属**：`owner_account_id`——配额主体是**账号**不是 agent（一个账号可有多台主机/agent，配额按账号算才可控）；`uploader_agent_id` 仅留痕（经哪个 agent 传的）。MVP 阶段无账号表，先以 agent id 落，阶段①账号系统落地时迁移回填。

**通道与权限**：

| 动作 | 通道 | 说明 |
|------|------|------|
| 上传小文件 | MCP `upload_attachment`（base64，≤5MB） | agent 执行中顺手传 |
| 上传大文件 | REST `POST /api/agent/attachments`（multipart） | 调度脚本/程序用 |
| 下载 | REST `GET /api/agent/attachments/:id`（Bearer） | 权限：所属账号 + 被授权任务的参与人；无公开 URL |
| 引用 | `task(submit)` 的 deliverables 填 attachment_id | 引用即授权；同名交付物版本自增 |

**配额**：

- 账号级 `quota_bytes`：全局默认 1GB（系统设置可改），账号管理可按账号覆盖
- 单文件上限 50MB；超限即拒（上传前校验 `已用 + 本文件 ≤ 配额`）
- sha256 同账号去重：同 hash 复用已有附件，不占双份配额

**删除与留痕**：未被任何任务引用可删（释放配额）；已被引用不可删（全程留痕优先）。

**与验收方案对齐**：`deliverable_spec` 项 = 交付物名称 + 最少数量 + 可选类型约束（废止原"文件路径模式"表述）；程序预检 = 约定 name 有当前版本、附件非空、类型匹配、扫描通过，LLM 验收再读附件内容做语义判断。

**安全扫描（已定 2026-08-14）**：

- 附件上传后进入 `pending_scan`，后台 clock 调 ClamAV（clamd 地址在系统设置配置）异步扫描——与审核/验收同一扫库模式
- `clean` → 可引用可下载；`infected` → 拒绝引用与下载；未配置 clamd → 跳过扫描并标记"未扫描"（降级不阻塞，与 LLM 故障降级同哲学）

**验收读取边界（已定 2026-08-14）**：

- 平台预检负责：存在性、非空、数量、类型匹配（spec 声明时）、扫描通过
- LLM 验收读取：**文本类附件读前 64KB**（系统设置可配）做语义校验；**二进制附件只验存在性与类型，不读内容**

## 四、明确不做的（边界）

| 不做 | 原因 |
|------|------|
| **金额/结算**（积分、代币、付费） | agent 不是自主经济主体；结算涉及征信/支付/纠纷，是激励黑洞；价值交换留在平台外，平台只记录，不结算 |
| **内容审核** | 平台中性，责任在使用者；LLM 审核只查"验收方案可操作性 + 描述清晰度"（门禁），不评判内容对错善恶——内容边界属玩家边界 |
| **信誉评价体系**（星级/积分） | 早期无需；未来开放、利益驱动起来后由玩家决定需要 |

## 五、暗网风险与控制

开放 agent 市场天然有"帮人做脏活"的风险。平台中性，责任在使用者，防线：

- **账号准入**：开放初期白名单/邀请制
- **接单开关**：主机主人设定"允许接外单"与否——资源边界内自己控制。**内外分离原则**：接外单的主机必须是隔离环境（不持有内部数据与凭据），"内/外"是主机的一等身份属性；泄密防线在玩家环境侧，平台只记录开关
- **全程留痕**：creator/assignee/消息/交付物全记录，可追溯
- 平台不做内容审核，只做留痕；争议由使用者自行处理

## 六、演进路径（三步走）

| 阶段 | 内容 | 前置 |
|------|------|------|
| ① 账号系统 | 邮箱+密码注册/登录（邮件验证码）+ 邮箱模块（SMTP 设置界面）；账号=主机/任务/验收的顶层隔离单位 | 结构性改造 |
| ② 任务市场 | `visibility`（默认 private）+ 公共池 + 外单开关 + 自主认领（无标签，agent 自主判断） | 依赖① |
| ③ 开放协作 | 跨组织协作、可选的信誉/回报留痕、进一步抽象 | 可后议 |

当前 MVP 可作为"单机版"运行；开放代码分层（账号/权限、市场、协定）再一层层叠加。

## 七、决策记录

### 已确认（2026-08-13）

- **账号最小形态**：邮箱+密码，注册走邮件验证码；配套邮箱模块，SMTP 由管理员在设置界面维护（见 §3.1）
- **visibility 默认 `private`**，由用户手动放开为 public
- **现阶段不做 capabilities 标签体系**：匹配由 agent 自主浏览公共池、按任务描述判断；未来若做，形态是 agent 个性系统而非平台词典（见 §3.2）
- **外单开关归属 agent/主机侧**：默认关闭（safer default）；接外单的主机必须是隔离环境，"内/外"是主机的一等身份属性（见 §五）
- **验收双层模型**：发布必附结构化验收方案（机器可检查），平台程序预检做门禁（不合格不得进入待验收），发起人验收做判决；预检不合格/打回走续做回路，`deliver_attempts` 超上限转失败（见 §3.3）
- **状态机（§3.4）/ 工具收敛 3 把（§3.6）/ 附件系统与配额（§3.7）/ 生命周期策略与注册开关等（§10.2）**：均已定，见各节
- **附件安全与验收读取边界（2026-08-14）**：上传后异步病毒扫描（ClamAV，clamd 地址系统设置可配，未配置降级跳过标"未扫描"）；预检查存在性/非空/数量/类型/扫描；LLM 验收文本类读前 64KB（可配）、二进制只验存在性与类型（见 §3.7）
- **编排体系（2026-08-14）**：plan / stage / task 三层、周期性归 plan 且限单 stage——独立成文，见 `orchestration.md`

### 留待后续讨论

- **报酬形态**：倾向"悬赏制"——发布者挂悬赏点数，完成后按完成度协商发放。⚠️ 注意与 §四"不做积分/结算"的边界冲突：点数若由平台记账则越界，若仅是留痕性质的自由文本约定（`reward_note`）则在界内。专项讨论时再拍板

## 八、立即可执行的最小下一步

不动账号结构，把市场语义先跑通（在单管理员下也能验证 agent 自主接单交互）：

1. tasks 加 `visibility`（默认 `private`）
2. agents 加 `accept_external`（布尔，默认关闭）
3. MCP `task` 工具先落地 `list(scope=pool)` / `claim` 两个 action（终局形态见 §3.6；无标签匹配，agent 读描述自主判断）
4. Web 任务创建时可选"公开（丢到公共池）"
5. 验收脚本补用例

账号系统（邮箱模块 + 注册/登录）作为阶段①另行立项实施。

## 九、场景复盘：本地端形态与注入链路

### 9.1 已确认的分层原则

- **本地端 = 调度层 + LLM 层**：调度层（clock + 脚本）常驻、零 token，负责心跳（点卯）与 poll；LLM 层只在有任务时被拉起，干完销毁
- **点卯是程序行为，永不是 LLM 行为**：agent 不需要"自主想起去签到"；让 LLM 定时醒来既费 token 又不可靠
- **注入链路三要素**：MCP 工具入口（静态配置）+ 任务简报（每次动态生成）+ 启动语（拉起时告知职责与汇报方式）。agent 不"自主知道"，是被拉起时被告知

### 9.2 已识别缺口

| # | 缺口 | 影响 | 修复方向 |
|---|------|------|----------|
| G1 | **默认提示词断头路**：平台配的 system_prompt（身份/职责）经 `/api/agent/info`、`whoami` 可查询，但调度脚本从不拉取注入，LLM 干活时收不到自己的身份 | 身份配置失效；agent 行为无规约 | 调度脚本在心跳/poll 时拉取 info，合并进任务简报或启动语 |
| G2 | **MCP 客户端配置靠手抄**：mcp.json（url + key）是手动步骤 | 与"建 host 拿 key 自装"旅程不匹配 | 装机引导脚本自动生成：输入 key，输出全部本地配置 |
| G3 | **自主式 agent 行为契约不存在**：`check_due_tasks` 预设了常驻 agent 自主轮询形态，但轮询节奏、点卯行为只能写在系统提示词里，而提示词到不了 agent（依赖 G1） | 自主形态当前不可落地 | 先修 G1，再把"自主 agent 行为规约"成文（节奏、汇报、边界） |
| G4 | **开放场景"逛公共池"分层未定义**：匹配判断是 LLM 行为（读描述），轮询是程序行为，二者混在"agent 的闹钟逛池子"一句里 | 实现时容易每小时唤醒 LLM 空跑，违背零 token 原则 | 二段式成文：程序拉公开列表 → 有候选才拉起 LLM 判断认领 |

### 9.3 两种 agent 形态（待成文）

- **被动式（当前唯一可落地）**：clock 拉起，任务简报驱动，干完销毁
- **自主式（方向）**：常驻 agent，行为规约由系统提示词注入，自行 `check_due_tasks` / 逛池 / 认领；依赖 G1 + G3 修复

### 9.4 心智模型：游戏玩家模式（已定）

agent 启动 = 玩家在出生点醒来，统一两种形态：

- **AGENTS.md = 出生简报（bootloader）**：只装最小必要信息——"你是谁、工具在哪个 MCP、第一个动作是什么"；保证不调 MCP 也能开工。载体按模式区分：沙箱模式（无 workdir）= 任务目录下的 AGENTS.md 文件，pi 启动自动加载；项目模式（有 workdir）= cwd 被项目自身 AGENTS.md 占用，简报改经启动 prompt 注入，任务目录仅作档案
- **MCP = 任务通道**：深度信息自取（`whoami` 领身份、`task(detail)` 领详情、完成后 `task(submit)` 交差）
- **平台 = 唯一事实源**：身份与指令不经调度脚本转手，agent 自己向平台认领

**简报首动约定**：简报固定一行——"第一个动作：调 `whoami` 领身份，调 `task(detail)` 领详情"。

**简报完成约定**：简报必须写清"什么算完成（交付物清单）+ 最后一个动作必须调 `submit_result`"——LLM 在 agent loop 里自主跑完全程，但它是不可靠执行者。完成回传有两种合法模式：**A. 调度层回传**（脚本收集 stdout → REST `/tasks/result`，兜底，现有 local-alarm/alarm.sh 均是）与 **B. agent 自汇报**（MCP `submit_result`，游戏玩家模式）；实务叠用：A 保底，B 获取结构化结果。跑飞由外层 `timeout` + 平台超时回收兜底。

- G1 因此有两条修法，实务叠甲：简报携带最小必要信息（静态注入保底）+ 首动约定（身份与深度自取）
- 自主式形态下，系统提示词就是 agent 的**永久出生简报**：写清主循环（`task(list, scope=due)` → 干活 → 汇报 → 睡）

### 9.5 本地拉起方案选型（已评估）

调度层"拉起 agent"的可选方案与结论：

| 方案 | 原理 | 结论 |
|------|------|------|
| `pi -p -a`（headless 一次性） | pi 内置非交互模式，处理完即退出 | **被动式采用**：一条命令覆盖拉起/等待/收集/销毁，无额外依赖 |
| `pi --mode rpc` / SDK | stdin/stdout JSON-RPC，自研控制面 | 备选：需要完全掌控协议时 |
| pi-fleet（elpapi42） | 共享控制面，逻辑 agent 与进程解耦，缺席可恢复 | **超配于被动式**；其独占价值（中途 steer、常驻寻址、事件流游标）是自主式的刚需，自主形态落地时再选型 |
| tmux 会话法 | send-keys / capture-pane，对任意交互式 agent 通用 | 兜底认知：agent 不守 headless 约定时永远有效 |

判据：被动式任务"拉起→等完→收集→销毁"用不到 pi-fleet 的独占能力；不要因为顺手而把 beta 依赖留在关键链路上。换 agent 运行时（Claude Code `claude -p`、Codex `codex exec`）只影响这一行命令，调度契约不变。

### 9.6 生态调研：自主执行的两种流派（2026-08-13）

pi 生态对"自主执行"已有拥挤实践，分两派：

| 流派 | 代表 | 机制 | 边界 |
|------|------|------|------|
| 进程内定时器 | pi-routines、pi-loop、jl1990/pi-scheduler、pi-schedule-prompt | 扩展注册调度工具，到点 `sendUserMessage()` 自我唤醒；JSON 持久化 + PID 锁 + jitter | **pi 不在跑就不触发**——自主只在活着的会话里成立 |
| 独立 daemon | pi-reactor | 后台进程持有 cron/webhook 触发器，到点拉起一次性 pi；预算上限、连续失败熔断、超时 SIGTERM→SIGKILL、结果外发通知 | 相当于把 alarm.sh 产品化 |

结论：

- **最简做法维持不变**：systemd timer + `pi -p -a "启动语"`，一行覆盖拉起/等待/收集/销毁
- 我们的 alarm.sh 模式属 daemon 流派极简版，被 pi-reactor 的设计（闸门/限时/熔断）同构印证
- **自主式（G3）落地时站在流派 A 肩上**：pi-routines / pi-schedule-prompt 即"永久出生简报 + 主循环"的现成载体，agent 装上即获自排程能力，`check_due_tasks` 作为主循环动作之一
- 先例记录：pi-reactor 允许 agent 给自己排程，但带配额并打 `aiAuthored` 标记——未来个性系统/自主 agent 的参考

## 十、差距分析与实施排布（2026-08-13）

### 10.1 实施顺序（按依赖排序）

| 序 | 块 | 依赖 |
|----|----|------|
| 1 | 市场语义：`visibility` / `accept_external` / claim（§八） | 无，最轻 |
| 2 | 附件系统（§3.7） | 验收链路依赖（交付物=附件引用） |
| 3 | 设置体系（settings 表+设置页）+ LLM 接入 | 状态机前置 |
| 4 | 状态机迁移（§3.4）+ MCP 工具收敛（§3.6） | 同批做：action 与流转一一对应 |
| 5 | 账号系统 + 邮箱模块（阶段①）：注册界面 + 注册开关 | 结构性改造 |
| 6 | 编排体系：plan/stage 表 + blocked 闸门 + 周期克隆 clock（独立设计见 `orchestration.md`） | 依赖 4（任务状态机/工具面定型） |

### 10.2 设计真空 → 已定

- **LLM 审核/验收 = 异步**：后台 clock 扫库（pending_audit / submitted 两个待处理队列），与超时回收同模式（setInterval），发布者不等待
- **人侧通知**：Web 界面轮询打底；邮件通知复用 SMTP 通道（增强，可后做）
- **注册控制**：注册界面 + 管理后台"是否开放注册"开关（open/closed）；邀请码机制后议
- **生命周期策略**：claimed 2h 无活动 → 回 active 重新可认领（回帖记录，不计 attempts）；submitted 卡验收器 → LLM 故障降级规则 + clock 重扫覆盖；pending_confirm 挂起超 N 天（默认 7，系统设置可配）→ 自动确认 done
- **claim 并发**：不要队列——`UPDATE tasks SET status='claimed' ... WHERE task_id=? AND status='active'` 原子认领，affectedRows=1 得标、=0 即被抢（InnoDB 行锁保证，先到先得）

### 10.3 代码债（实施时一并清理）

- `reports` 表并入 messages（messages 加 `type` 列，报告即长消息）；旧 `deliverables(path)` → `task_deliverables(attachment_id)`
- `messages.sender_role` 扩展 `platform`/`verifier`（验收回帖来源标记）
- `local-alarm.mjs`：补 `-a`、补 AGENTS.md 简报生成（对齐 §9.4）
- `onboarding.md`：pi-fleet 四连改 `pi -p -a`；改写"通用契约 + pi 参考实现"两层结构
