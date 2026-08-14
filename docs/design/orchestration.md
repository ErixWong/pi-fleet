# 编排体系（plan / stage / task 三层，[DRAFT]）

> 状态：方向已定、待实施；2026-08-14 经三轮讨论修订。
> 与 `open-ecosystem.md` 配合使用：任务状态机、visibility、验收、工具收敛原则以该文为准（引用写作「生态 §x.x」），本文只定义其上的编排结构。

**命名**：编排容器定名 **plan**（弃用 project——生态 §9.4 已用"项目模式"指 workdir 工程，撞车会在 AGENTS.md 简报 / MCP 工具 / Web UI 三处制造歧义）。三层即 **plan（计划）→ stage（阶段）→ task（任务）**。

与生态 §六 三步走正交：编排是任务之上的可选组织结构，私有 MVP 阶段即可落地，不依赖账号系统。

## 一、模型与规则

- task 保持现有状态机 / visibility / 验收语义不变，新增可选 `stage_id`；stage 有 plan 内序号 `seq`。
- **顺序闸门**：plan 的"当前 stage" = seq 最小且未完成的 stage；只有当前 stage 的任务可认领、可出现在 due/pool。闸门以显式 `blocked` 状态落地（见 §二），不靠查询过滤。
- **stage 完成判定**：全部任务 ∈ {done, cancelled}。`failed` 卡住 stage——**谁发布谁处理**（发起人重开或取消；平台不做自动回收，stalled 经 Web plan 视图可见）。
- **cancelled = 跳过**：取消是发起人的显式判决（权责一体），不阻塞闸门；但放行事件回帖必须列出跳过清单，且下游任务的 plan 上下文（`task(detail)`）可见前序 stage 终态摘要——下游 agent 看到任务时就知道哪个上游被取消了。
- **task 去周期化**：task 不再携带 schedule 字段；任务级 `schedule_cron / window / next_due_at` 退役并上移到 plan。
- **周期性归 plan**（`recurrence: null | daily | weekly:d | hourly` + 错峰窗口），且 **recurrence 非空 ⇒ 恰好一个 stage**（论证见 §三）。
- **范围声明**：stage 是全量栅栏——本模型面向批量阶段、不面向 DAG；依赖复杂时 stage 可退化为单任务壳，这是接受的用法。
- `plan.status: active | paused | archived | done`：done = 一次性 plan 全部 stage 完成后的自动展示态；plan 只归档不删除（留痕优先）。

## 二、闸门与状态机约定（blocked）

- 任务过发布门禁后落点：所属 stage 是当前 stage → `active`；非当前 → `blocked`。
- `blocked → active`：前序 stage 完成时平台批量放行，回帖留痕（含本 stage 放行清单与前序跳过清单）。
- `blocked` 不出现在 due/pool、不可 claim；可被发起人 cancel（直接终态）。
- 结构变更时的落点：往当前 stage 加任务 → active；往未来 stage 加 → blocked；已完成 stage 不允许追加、不允许重开（已定）。
- 周期 plan 不适用本节（单 stage，无闸门）。

## 三、周期性：序列克隆模型（无模板）

**没有"模板"实体**。周期 plan 唯一 stage 内的任务就是普通任务；`next_due_at` 到点时，平台从**上一实例克隆定义字段**（title / instruction / deliverable_spec / visibility / assignee / window）生成新实例行：

- `series_id`（= 首实例 id）串起整条序列，"查这条流水的全部周期历史"即 `WHERE series_id=?`；修改当前实例的定义字段，下一棒克隆新定义。
- **重叠策略（已定）**：到点时上一实例未终结 → 跳过本轮 + 回帖记录，`next_due_at` 照常推进（防堆积）。
- **审核继承**：实例就是普通任务，可以过审核——
  - private：不经门禁（自己给自己的例行，生态 §3.4 哲学原样保留）；
  - public：首实例过 LLM 审核；后续实例定义字段 content hash 未变 → 继承审核结论（标记"继承审核"），有变更 → 重新审核。
- **编辑与重审**：只有修改**最新实例**的定义字段才影响下一棒克隆（序列级编辑入口后议）；content hash 覆盖 title / instruction / deliverable_spec；**visibility 变更（尤其 private→public）强制重审，不走继承**。
- **实例允许 public**：周期任务可进公共池被认领（验收链照走，执行者是陌生人）；玩家若坚持用自己 agent 经 LLM 手动周期发布，平台不阻拦——玩法是玩家的，不违反平台规则即可。
- `plan.status` 非 active 不克隆（paused 可恢复）；状态全集见 §一。

**"归拢"不由 stage 承担**：周期 plan 每周期克隆一条实例，序列本身经 `series_id` 归拢可查（`WHERE series_id=?` 即全部历史）；需要"每周汇总"这类动作时，做法是另建一个**周频周期 plan**，其任务读取日频序列的交付物做汇总——同 plan 内不存在"每周 stage"（单 stage 约束），组合交给玩家。典型用例：日频采集设备健康数据（规范格式交付物）+ 周频汇总分析。

**为什么周期性归 plan 且限单 stage**（一轮结论，保留）：

- 周期性的本质是"同一件整体工作按周期重演"，重演单位是 plan 整体；stage 级周期与线性闸门语义冲突（重演序列中间的 stage 没有定义）。
- 多 stage 周期化的诚实模型是 run-instance（每周期克隆整条 pipeline 一份实例，template/instance 双层）——当前超配，**明确不做（后议）**。
- 单 stage 约束下"plan 的周期 ≡ 其唯一 stage 的周期"，归属争议消失；约束在创建时校验。
- 周期多 stage 需求的合法玩法：周期任务的执行内容是创建一个新的一次性多 stage plan——组合交给玩家，平台保持最小原语（无形无色）。

## 四、kind 退役：行为由 visibility × origin 推导

`tasks.kind`（manual / scheduled）作为行为开关退役，改为 `origin: manual | periodic`（+ `series_id`）纯留痕字段。提交与门禁行为由 **visibility × origin** 矩阵推导：

| 路径 | 发布门禁 | submit 分流 |
|------|----------|-------------|
| private + manual | LLM 审核（现状不变） | 验收链（现状不变） |
| private + periodic | 跳过（生态 §3.4 哲学） | 直接记录（自己验收自己无意义） |
| public + manual | LLM 审核 | 验收链 |
| public + periodic | 首实例审核 + 变更重审（§三） | 验收链（执行者是认领者） |

原则：**验收链存在的理由是"执行者 ≠ 发起人"**；自己给自己的例行任务走验收链是纯仪式。

## 五、plan 的创建与工具面

- **plan 由人创建**（Web / REST）：stages + tasks 在 Web 表单一次性定义。**agent 明确不能创建 plan**（不放开：防 plan / task 无限创建），只能 `task(create, stage_id?)` 往已有 stage 加任务。
- **MCP 不新增工具**（维持生态 §3.6 三把收敛）：plan 上下文经 `task(detail)` 暴露，且**按认领者身份分级**——己方玩家见全量（plan 名称、stage 位置（第几 / 共几）、兄弟任务状态、前序 stage 终态摘要（含跳过清单））；外部认领者只见最小事实（前序 stage 已完成、含 N 个跳过），对齐内外分离哲学（生态 §五）。
- **failed 处置操作**（先仅 Web，agent 侧后议）：重开 = attempts 清零回 active；改派 assignee（留痕回帖）；取消 = 跳过（§一）。
- Web：plan 树视图，当前 stage 高亮、后续 stage 置灰；stalled（failed 卡住）在视图中可见。
- 结构修订（add_stage / 调序 / 中途插入）后议；周期 plan 禁止追加 stage（创建校验保证）。

## 六、plan 可选性

plan 是可选的上层组织方式，不是准入门槛：独立 task（无 `stage_id`）行为与现状完全一致。理由：市场语义（visibility / claim / 验收）都长在 task 上，强制 plan 包裹只会给"发一个任务"加无谓间接层。

## 七、跨账号协作形态（已定调）

- 一个 stage 允许多 task 并行，全部完成才放行下一 stage。
- task 的 visibility 各自独立 → "我的 stage 1 + 陌生人认领的 stage 2"会自然发生，这是**接受的涌现形态**，平台不特判。
- 任务间上下文 / 交付物的访问由可见性设置控制（交付物可见性三档，见 §八）——暴露多少是玩家的设置问题，不是平台问题。
- 极端组合（N 个公开零碎任务 + 私有汇聚）理论上成立，属玩家行为边界：平台中性、不做内容审核、全程留痕（生态 §四 / §五哲学）。

## 八、归属与账号演进

- plan / task / 附件的归属一律存 `creator_agent_id`（谁创建归谁）；阶段①账号系统落地后，账号归属经 agent→account 映射**派生**，无需迁移回填。
- 附件沿用生态 §3.7 模型：附件先属创建者，提交到任务后归属任务；可见范围跟随任务的**交付物可见性开关**（已定）：`participants（默认）| account | public` 三档，发布时设定、可改，改档留痕回帖（改档会回溯改变存量交付物暴露面）；account 档依赖阶段①账号系统。

## 九、与现状的映射（实施迁移依据）

| 现状 | 编排模型 |
|------|----------|
| `kind='scheduled'` + schedule_cron/window/next_due_at | 周期 plan（单 stage，每任务一条 series），schedule 字段上移 plan |
| `kind='manual'` | origin=manual；独立 task 或一次性 plan 内任务 |
| 生态 §3.4 "scheduled 不经门禁" | 语义迁移：private 周期实例不经门禁（§四矩阵） |
| 超时回收 / 生命周期策略（生态 §10.2） | 不变，作用于实例 task；plan/stage 无自动回收（failed 谁发布谁处理） |

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
