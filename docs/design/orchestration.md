# 编排体系（plan / stage / task 三层，[已落地]）

> 状态：**2026-08-15 重构定稿**（强制三层 + stage 双属性，已落地）；实现参照 `src/service/plans.ts`（闸门/克隆）+ `market.ts`（stage_id 落点/plan 上下文分级）+ `api.ts`（plans 路由/处置端点）+ `web/src/views/Plans.vue`（列表展开树）/`PlanDetail.vue`（树视图）。
> 验收覆盖：`scripts/mcp-acceptance.mjs` 第 9 节（闸门/blocked 排除/追加/周期克隆+重叠跳过+series 串接/plan 上下文分级/交付物可见性/failed 处置）+ `rest-acceptance.mjs`（定时 stage 周期生成/跳过防堆积）+ `web-acceptance.mjs`（树表单/树视图）；npm test 160 用例全绿。
> 与 `open-ecosystem.md` 配合使用：任务状态机、visibility、验收、工具收敛原则以该文为准（引用写作「生态 §x.x」），本文只定义其上的编排结构。

**命名**：编排容器定名 **plan**（弃用 project——生态 §9.4 已用"项目模式"指 workdir 工程，撞车会在 AGENTS.md 简报 / MCP 工具 / Web UI 三处制造歧义）。三层即 **plan（计划）→ stage（阶段）→ task（任务）**。

与生态 §六 三步走正交：编排是任务之上的可选组织结构，私有 MVP 阶段即可落地，不依赖账号系统。

## 一、模型与规则

- **强制三层**：任务必须从属 stage（`plan_id / stage_id` NOT NULL + FK），不再有独立任务；stage 有 plan 内序号 `seq`。task 保持现有状态机 / visibility / 验收语义不变。
- **stage 双属性（自由组合）**：`wait_prev`（1=等待前序完成，顺序闸门 / 0=并发，不等待）+ `recurrence`（none / daily / weekly:x / hourly，自动重复生成）。两个属性互不限制——定时 stage 的位置、数量随便放，平台不做其他限制（玩法是玩家的）。
- **顺序闸门**：plan 的"当前 stage" = seq 最小且未完成的 stage；`wait_prev=1` 的 stage 只有当前 stage 的任务可认领、可出现在 due/pool；`wait_prev=0` 的 stage 永远激活（并发，闸门不等待它）。闸门以显式 `blocked` 状态落地（见 §二），不靠查询过滤。
- **stage 完成判定**：全部任务 ∈ {done, cancelled}（空 stage 视为完成、跳过不卡闸门）。`failed` 卡住 stage——**谁发布谁处理**（发起人重开或取消；平台不做自动回收，stalled 经 Web plan 视图可见）。
- **cancelled = 跳过**：取消是发起人的显式判决（权责一体），不阻塞闸门；但放行事件回帖必须列出跳过清单，且下游任务的 plan 上下文（`task(detail)`）可见前序 stage 终态摘要——下游 agent 看到任务时就知道哪个上游被取消了。
- **任务原子化**：任务不携带任何 schedule 字段（`kind / schedule_cron / window / next_due_at` 已删列）；重复是 **stage 的属性**（recurrence），由 stage 生成器（runPeriodicClones）按期克隆新任务实例。
- **范围声明**：stage 是全量栅栏——本模型面向批量阶段、不面向 DAG；依赖复杂时 stage 可退化为单任务壳，这是接受的用法。
- `plan.status: active | paused | archived | done`：done = 一次性 plan 全部 stage 完成后的自动展示态；plan 只归档不删除（留痕优先）。

## 二、闸门与状态机约定（blocked）

- 任务过发布门禁后落点：所属 stage 是当前 stage（wait_prev=1 时）→ `active`；非当前 → `blocked`；wait_prev=0（并发）的 stage 永远激活、不落 blocked。
- `blocked → active`：前序 stage 完成时平台批量放行，回帖留痕（含本 stage 放行清单与前序跳过清单）。
- `blocked` 不出现在 due/pool、不可 claim；可被发起人 cancel（直接终态）。
- 结构变更时的落点：往当前 stage 加任务 → active；往未来 stage 加 → blocked；已完成 stage 不允许追加（空 stage 除外，见 §五）。

## 三、周期性：stage 级序列克隆模型（无模板）

**没有"模板"实体**。带 `recurrence` 的 stage 内的任务就是普通任务；`next_due_at` 到点时，平台从**该 stage 上一实例克隆定义字段**（title / instruction / deliverable_spec / visibility / assignee / window）生成新实例行：

- `series_id`（= 首实例 id）串起整条序列，"查这条流水的全部周期历史"即 `WHERE series_id=?`；修改当前实例的定义字段，下一棒克隆新定义。
- **重叠策略（已定）**：到点时上一实例未终结 → 跳过本轮 + 回帖记录，`next_due_at` 照常推进（防堆积）。
- **审核继承**：实例就是普通任务，可以过审核——
  - private：不经门禁（自己给自己的例行，生态 §3.4 哲学原样保留）；
  - public：首实例过 LLM 审核；后续实例定义字段 content hash 未变 → 继承审核结论（标记"继承审核"），有变更 → 重新审核。
- **编辑与重审**：只有修改**最新实例**的定义字段才影响下一棒克隆（序列级编辑入口后议）；content hash 覆盖 title / instruction / deliverable_spec；**visibility 变更（尤其 private→public）强制重审，不走继承**。
- **实例允许 public**：周期任务可进公共池被认领（验收链照走，执行者是陌生人）；玩家若坚持用自己 agent 经 LLM 手动周期发布，平台不阻拦——玩法是玩家的，不违反平台规则即可。
- **周期 stage 禁止手动追加任务**（防污染克隆源：克隆源 = stage 内最新任务）。
- `plan.status` 非 active 不克隆（paused 可恢复）；状态全集见 §一。

**"归拢"不由 stage 承担**：周期 stage 每轮克隆一条实例，序列本身经 `series_id` 归拢可查（`WHERE series_id=?` 即全部历史）；需要"每周汇总"这类动作时，做法是另建一个**周频周期 stage**，其任务读取日频序列的交付物做汇总——组合交给玩家。典型用例：日频采集设备健康数据（规范格式交付物）+ 周频汇总分析。

**为什么周期性归 stage（重构定稿，2026-08-15）**：

- 早期结论（2026-08-14）把周期绑在 plan 且限单 stage（"plan 的周期 ≡ 唯一 stage 的周期"）；用户拍板**放宽**：重复是 stage 的属性，`wait_prev × recurrence` 自由组合——定时 stage 可以在任何位置（前/中/后）、数量不限。
- 组合语义自然涌现：`wait_prev=0 + recurrence` = 常开流水线（不等待、定期补货）；`wait_prev=1 + recurrence` = 周期性阶段门禁（每轮完成才放行下一轮）。

## 四、kind 退役：行为由 visibility × origin 推导

`tasks.kind`（manual / scheduled）已**删列**（2026-08-15 重建），`origin: manual | periodic`（+ `series_id`）纯留痕字段。提交与门禁行为由 **visibility × origin** 矩阵推导：

| 路径 | 发布门禁 | submit 分流 |
|------|----------|-------------|
| private + manual | LLM 审核（现状不变） | 验收链（现状不变） |
| private + periodic | 跳过（生态 §3.4 哲学） | 直接记录（自己验收自己无意义） |
| public + manual | LLM 审核 | 验收链 |
| public + periodic | 首实例审核 + 变更重审（§三） | 验收链（执行者是认领者） |

原则：**验收链存在的理由是"执行者 ≠ 发起人"**；自己给自己的例行任务走验收链是纯仪式。

## 五、plan 的创建与工具面

- **plan 由人创建**（Web / REST）：stages + tasks 在 Web 表单一次性定义。**agent 明确不能创建 plan**（不放开：防 plan / task 无限创建），只能 `task(create, stage_id)` 往已有 stage 加任务，且**限 plan 参与人**（在该 plan 任一 stage 发起或执行过任务；2026-08-14 审查后补充——否则任何 agent 可借追加成为 creator 拿到全量 plan 上下文，绕过下方内外分离分级）。**空 plan 例外（2026-08-15 修正）**：plan 尚无任何任务时允许任意 agent 追加首个任务（空 plan 无上下文可泄露；否则 agent 永远无法给空 stage 填第一个任务，鸡生蛋）。有任务后恢复参与人校验。已完成 stage 不允许追加（§二）；周期 stage 禁止追加（§三）。
- **MCP 不新增工具**（维持生态 §3.6 三把收敛）：plan 上下文经 `task(detail)` 暴露，且**按参与者身份分级**——己方（发起人 creator **或执行方 assignee**，含公共池认领后的执行方）见全量（plan 名称、stage 位置（第几 / 共几）、兄弟任务状态、前序 stage 终态摘要（含跳过清单））；其余外部浏览者（未认领的池中浏览）只见最小事实（前序 stage 已完成、含 N 个跳过），对齐内外分离哲学（生态 §五）。
  > 口径说明（2026-08-14 审计后确认）：管理员建的 plan（creator_id=NULL）无「发起人」视角，执行方（assignee=me）是唯一需要完整上下文的参与者，故 assignee 视同己方；外部最小事实同时**不含 plan 名称**（元信息不泄露）。
- **failed 处置操作**（先仅 Web，agent 侧后议）：重开 = attempts 清零，按落点回 open（private+assignee）/ active（public）；改派 assignee 后**直接落 open/active**（attempts 清零，留痕回帖，无需 reopen 两步）；取消 = 跳过（§一）。取消白名单含 `failed` 与 `blocked`（管理端与 MCP `task(cancel)` 一致；blocked 取消为闸门死锁兜底，2026-08-14 审查后补齐）。
- Web：`/plans` 列表页（plan 行点击展开 stage→task 树，plan 名链接进 `/plans/:planId` 树视图）——树视图当前 stage 高亮、后续 stage 置灰；stalled（failed 卡住）在视图中可见。
- 结构修订（add_stage / 调序 / 中途插入）后议；周期 stage 禁止追加任务（§三）。

## 六、plan 可选性（已废止）

> 2026-08-15 重构：~~plan 是可选的上层组织方式，不是准入门槛；独立 task（无 `stage_id`）行为与现状完全一致~~。**强制三层**已落地——任务必须从属 plan 的 stage（`tasks.plan_id / stage_id` NOT NULL + FK，表已重建），不存在独立任务；`POST /api/tasks` 只需 `stage_id`（stage 唯一确定 plan）。

## 七、跨账号协作形态（已定调）

- 一个 stage 允许多 task 并行，全部完成才放行下一 stage。
- task 的 visibility 各自独立 → "我的 stage 1 + 陌生人认领的 stage 2"会自然发生，这是**接受的涌现形态**，平台不特判。
- 任务间上下文 / 交付物的访问由可见性设置控制（交付物可见性三档，见 §八）——暴露多少是玩家的设置问题，不是平台问题。
- 极端组合（N 个公开零碎任务 + 私有汇聚）理论上成立，属玩家行为边界：平台中性、不做内容审核、全程留痕（生态 §四 / §五哲学）。

## 八、归属与账号演进

- plan / task / 附件的归属一律存 `creator_agent_id`（谁创建归谁）；阶段①账号系统落地后，账号归属经 agent→account 映射**派生**，无需迁移回填。
- 附件沿用生态 §3.7 模型：附件先属创建者，提交到任务后归属任务；可见范围跟随任务的**交付物可见性开关**（已定）：`participants（默认）| account | public` 三档，发布时设定、可改，改档留痕回帖（改档会回溯改变存量交付物暴露面）；account 档依赖阶段①账号系统。

## 九、与现状的映射（实施迁移依据）

| 现状 | 编排模型（已落地） |
|------|----------|
| `kind='scheduled'` + schedule_cron/window/next_due_at | **已删列**（2026-08-15 表重建）；重复由 stage 的 `recurrence` 属性负责，stage 生成器按期克隆 |
| `kind='manual'` 独立任务 | 任务必须从属 plan 的 stage（`plan_id/stage_id` NOT NULL）；一次性任务 = 单 stage plan 内的任务 |
| 生态 §3.4 "scheduled 不经门禁" | 语义迁移：private 周期实例不经门禁（§四矩阵） |
| 超时回收 / 生命周期策略（生态 §10.2） | 不变，作用于实例 task；plan/stage 无自动回收（failed 谁发布谁处理） |

> **迁移口径（2026-08-15 定稿）**：legacy `kind='scheduled'` 旧入口（tasks.ts 原地推进 next_due_at、无 plan 归属）已随表重建**移除**；编排表（plans / plan_stages / tasks）清空重建，旧数据不保留。

## 十、决策记录

### 已确认（2026-08-14 一轮）

- 三层模型与顺序闸门；plan 可选，独立 task 行为不变
- 周期性归 plan 且限单 stage；run-instance 明确不做（后议）
- 周期实例取代"同一行原地推进 next_due_at"形态，clock 扫库生成

### 已确认（2026-08-14 二轮，批评回应）

- **命名 plan**，弃用 project（与 workdir"项目模式"撞车）
- **blocked 显式状态**落地闸门，不做查询过滤影子状态（§二）
- **cancelled = 跳过**：放行回帖 + 下游 plan 上下文携带跳过清单（§一）
- **failed 卡 stage = 发起人责任**，平台不做自动回收（§一）
- **模板概念退役**：序列克隆模型，series_id + content hash 审核继承（§三）
- **周期实例允许 public**；玩家用 LLM 手动周期发布不阻拦（§三）
- **kind 退役**：行为由 visibility × origin 矩阵推导（§四）
- **plan 人建、agent 不建**；MCP 不新增工具，plan 上下文走 task(detail)（§五）
- **跨账号 pipeline 为接受的涌现形态**，平台不特判（§七）
- **归属存 creator_agent_id**，账号归属阶段①派生，无迁移回填（§八）

### 已确认（2026-08-14 三轮，13 项待讨论集中拍板）

- **已完成 stage 禁止重开**（§二）；add_stage / 调序 / 中途插入维持后议
- **交付物可见性三档**：participants（默认）/ account（依赖阶段①）/ public；可改、改档留痕回帖（§八）
- **周期重叠策略**：上一实例未终结 → 跳过本轮 + 回帖（§三）
- **agent 明确不能创建 plan**：必须用户自己创建，防 plan / task 无限创建（§五）
- **plan 上下文暴露分级**：外部认领者只见最小事实（前序完成 / 含 N 跳过），己方玩家见全量（§五）

### 已确认（2026-08-15 重构定稿）

- **强制三层**：任务必须从属 plan 的 stage（`plan_id/stage_id` NOT NULL + FK），独立任务不复存在；`POST /api/tasks` 只需 stage_id
- **stage 双属性自由组合**：`wait_prev`（顺序闸门 / 并发）× `recurrence`（none/daily/weekly:x/hourly）互不限制，定时 stage 位置/数量随便放（推翻 08-14 单 stage 限制）
- **任务原子化**：task 不自我重复；重复是 stage 属性，stage 生成器按期克隆（series_id / 防堆积 / 审核继承沿用）
- **空 plan 可追加首个任务**：无任务时任意 agent 可 append（无上下文可泄露），有任务后恢复参与人校验（§五修正）
- **legacy scheduled 移除**：旧入口与 `kind/schedule_cron/next_due_at` 列随表重建删除，旧数据不保留（§九）
- **页面合并**：`/plans` 列表展开 stage→task 树，plan 名链接进 `/plans/:planId` 树视图
- **failed 处置**：重开 = attempts 清零回 active；改派 assignee 允许 + 留痕回帖；操作面先仅 Web（§五）
- **一次性 plan 全 stage 完成自动置 done；plan 只归档不删除**（§一）
- **序列编辑与重审**：改最新实例才影响下一棒；hash 覆盖 title / instruction / deliverable_spec；visibility 变更强制重审（§三）
- **周期"归拢"语义**：series_id 查询归拢；周频汇总 = 另建周频 plan（§三）
- **周期终止条件不做**（手动 paused / archived）；**历史保留暂不设窗口**（列已知风险）
- **范围声明写入 §一**：面向批量阶段、不面向 DAG
- **复审节点（执行项）**：生态 §10.1 块 1–4 落地后按实现校准复审本文

### 留待后续讨论

1. **plan 结构修订余量**：add_stage / 调序 / 中途插入的门槛（已完成 stage 禁止重开已定）
2. **run-instance / template 想法（留到下一轮）**：多 stage 周期化的 template/instance 双层；用例已记录——周期采集设备健康数据、规范化交付物格式（日频采集 + 周频汇总）
3. **序列级编辑入口**：当前规则是改最新实例生效，专用入口后议
4. **agent 侧 failed 处置操作面**：当前仅 Web
5. **agent task 创建防护**：plan 已禁 agent 创建；task 无限创建的频率 / 配额防护面待定
6. **周期序列历史保留**（已知风险观察项）：实例 / 消息无限增长，附件有配额兜底、任务行暂无；存储压力出现时再议
