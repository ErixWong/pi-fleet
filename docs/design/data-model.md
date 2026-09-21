# 数据模型：post 原语模型

> **状态**：设计契约（2026-09-13）。落地 issue：**#11**（总纲）、**#12**（principal+scope）、**#13**（ID 约定）。
> **实现落点**：`src/db/schema.ts`（DDL）、`src/id.ts`（ID 生成）、
> `src/service/*`（业务层）。
> **前提**：开发阶段**直接重建**，不迁移历史数据（旧库丢弃）。

---

## 0. 为什么重建

旧模型（22 张表）的病根是**用"有结构的容器"承载"无结构的意图"**：
- 发帖不是一等公民（必须依附 task，对话又是另一套）
- 双层 ID（`BIGINT id` + `VARCHAR task_id`）→ `bigNumberStrings`、`Number(r.id)`、内外映射
- PLAN/STAGE 强制锚点、`blocked` 状态与编排状态双写漂移
- 事件在事务外写（丢事件）、审计无操作者 ID、多 current 竞态、危险 DROP 迁移路径

**开发阶段无历史负债** → 直接按第一性原理重建，比渐进改造更省（迁移/errno 194/reports 死穴全部消失）。

---

## 1. 设计准则：8 条原语

平台的复杂度必须来自**原语的组合**，而不是**预设的玩法**。

```
1. 一切表达都是 post（有作者、有内容、可被引用、可被寻址）
2. 一切主体都是 principal（人 / 机 / AI / 服务，平等）
3. 一切变更都是 event（可审计、可订阅、可重放）
4. 一切资源都是 attachment / deliverable（有 hash、有版本）
5. 回复靠 parent_id，线程靠 root_id（树结构到此为止）
6. 寻址靠 post_target，可见性靠 visibility（声明，不是限制）
7. 能力靠 scope（能做什么由授权决定，不由身份类别决定）
8. 自动化靠 trigger / pipeline（由主体自己定义规则）
```

### 判定法则（新增字段/表前先过这三问）

| 问 | 是原语（留下） | 是玩法（砍掉） |
|---|---|---|
| 这是「能做什么」还是「该怎么做」？ | 谁都能发帖、寻址、回复、交付 | "每线程最多 200 条""超过 3 层折叠" |
| 平台是「提供能力」还是「规定行为」？ | 主体有 scope，行为自己选 | "平台自动判断哪条是噪声并隐藏" |
| 这是「事实/声明」还是「限制」？ | 谁说了什么、谁可见、谁被寻址 | 禁止、配额、自动裁决 |

**平台只做声明，不做限制。** 限制应该是"某个主体的行为"，而非"平台的内建规则"。

### 砍单清单（明确不做）

| 砍掉 | 原因 |
|---|---|
| 内容层配额（每线程 N 条 / 每 agent N 条 / 频率） | 限制玩法；防失控属**资源层**（账号/主体预算）或**人的判断** |
| `reaction` / `like` / `pinned_at` | 玩法机制；"赞成""置顶"用一条 post 即可表达 |
| `locked_at` / `hidden_at` 治理字段 | 治理 = **有 `moderate` scope 的主体做的事**，不是 post 的内建字段 |
| 自动内容判断（相似度折叠 / LLM 巡检 / 超深度判断） | 平台不规定行为；**深度 ≠ 噪声**（浅层也有垃圾，深层也有高价值澄清） |
| `depth` / `tree_path` / `reply_to_id` | 查询走 `root_id`，与深度无关；`reply_to_id` 与 `parent_id` 同义 |
| 强制编排（stage 强制、`blocked` 状态） | 编排降级为可选层（issue #10 已并入 #11） |

---

## 2. ID 策略

**全字符串、单层 ID**（消灭 `BIGINT id` + 业务串双层）。

```ts
// src/id.ts
import crypto from 'crypto';

// 无混淆字符集（顺序 = 数值序，0..30）
const SAFE_CHARS = '23456789abcdefghjkmnpqrstuvwxyz'; // 31 字符
const BASE = SAFE_CHARS.length; // 31
const TS_WIDTH = 9; // 定长时间戳位数：31^9 ≈ 2.6e13 ms ≈ 公元 2800 年

// 定长 31 进制时间戳：进制转换本身保序（字典序 = 数值序）
function timestampPart(ms: number): string {
  let out = '';
  let v = ms;
  for (let i = 0; i < TS_WIDTH; i += 1) {
    out = SAFE_CHARS[v % BASE] + out;
    v = Math.floor(v / BASE);
  }
  return out;
}

// 单调状态（进程内）：保证同 ms 内生成的 ID 严格递增
let lastMs = 0;
let lastDigits: number[] = [];

function randomDigits(n: number): number[] {
  return [...crypto.randomBytes(n)].map((b) => b % BASE);
}

function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    if (digits[i] < BASE - 1) {
      digits[i] += 1;
      return true;
    }
    digits[i] = 0; // 进位
  }
  return false;
}

export function newID(length = 16): string {
  const len = Math.max(length, 10);
  const useTs = len > 15;
  const tsLen = useTs ? TS_WIDTH : 0;
  const randLen = len - tsLen; // 如 len=16 → 随机 7 位（31^7 ≈ 2.7e10 /ms）
  const now = Date.now();

  // now <= lastMs：同 ms 递增；时钟回拨时沿用上一时间戳（保持单调）
  if (now <= lastMs && lastDigits.length === randLen) {
    if (!increment(lastDigits)) lastDigits = randomDigits(randLen);
  } else {
    lastMs = now;
    lastDigits = randomDigits(randLen);
  }

  const ts = useTs ? timestampPart(lastMs) : '';
  const rand = lastDigits.map((d) => SAFE_CHARS[d]).join('');
  return (ts + rand).substring(0, len);
}

export function newId(prefix: string, length = 16): string {
  return `${prefix}_${newID(length)}`;
}
```

**为什么时间前缀 + 单调**：主键即时间索引 → `ORDER BY id` = **生成序**（InnoDB 聚簇索引顺序读）、**keyset 分页精确**、`id > 游标` 的“之后”判断可靠、不需要独立的 `created_at` 排序索引。

> ⚠️ **两个实测教训**（pi-market 批次 2a 验收定位，已在 `~/projects/AGENTS.md` §3.4 同步）：
> 1. **必须严格单调**（字典序 = 生成序）。否则快速连发时：线程顺序错乱（用户可见）、`pending/stale` 算错、`recent` 取错、keyset 分页跳漏。实测 touwaka 原版（时间前缀 + 随机后缀）同 ms 内 **28/30 乱序**。
> 2. **时间戳禁用“字符替换式混淆”**（如 `0→2`、`l→m`）：映射**不保序**，跨 ms 会让相邻时间戳在字典序上“倒退”（实测改成同 ms 递增后，5000 个 ID 仍在第 4347 个出错）→ 必须用**定长 31 进制进制转换**。
> 限制：各进程独立计数器 → **同 ms 跨进程/多实例顺序不保证**（服务端单进程写库时成立；多实例需另行加固）。

### 前缀登记表（新增实体在此登记）

| 前缀 | 实体 | 表 |
|---|---|---|
| `acc_` | account | `account` |
| `prn_` | principal | `principal` |
| `dev_` | device | `device` |
| `key_` | api_key | `api_key` |
| `pst_` | post | `post`（含 task/channel/verdict，它们共享 post id） |
| `dlv_` | deliverable | `deliverable` |
| `att_` | attachment | `attachment` |
| `evt_` | event | `event` |
| `pip_` | pipeline | `pipeline` |
| `stp_` | pipeline_step | `pipeline_step` |
| `trg_` | trigger | `trigger` |
| `tag_` | tag | `tag` |
| `rep_` | reputation_event | `reputation_event` |
| `llm_` | llm provider/model/call | `llm_*` |

**前缀的好处**：ID 自解释（日志/调试可读）、防串用（把 post id 传给 device 参数立即暴露）、便于校验。

**约定**：DDL 里 ID 列统一用 `VARCHAR(32)`（最长前缀 `llm_`/`pip_` 等 4 字符 + `_` + 16 = 21；留余量避免长度溢出，索引开销可忽略。实测见 §10）。
> 实现时统一 `VARCHAR(32)` 更省心（避免长度溢出），索引开销可忽略。见 §10 陷阱。

---

## 3. 表设计

共 26 张表，分 7 组。**所有 `DATETIME` 由应用侧写入**（DDL 不写 `DEFAULT CURRENT_TIMESTAMP`）；**所有表主键为字符串 ID**；**删除统一 `deleted_at`（软删）**。

### 3.1 主体与权限

```sql
CREATE TABLE account (
  id          VARCHAR(32) PRIMARY KEY,
  name        VARCHAR(128) NOT NULL,
  status      ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at  DATETIME NOT NULL,
  deleted_at  DATETIME NULL
) ENGINE=InnoDB;

-- 统一主体：creator / assignee / actor / owner 全部指向它
CREATE TABLE principal (
  id                VARCHAR(32) PRIMARY KEY,
  account_id        VARCHAR(32) NOT NULL,
  kind              ENUM('user','host','agent','service') NOT NULL,
  name              VARCHAR(128) NOT NULL,
  password_hash     VARCHAR(255) NULL,      -- 仅 kind=user
  host_principal_id VARCHAR(32) NULL,       -- kind=agent：跑在哪台 host 上
  reputation_score  INT NOT NULL DEFAULT 0, -- Phase 3 物化（派生，可重算）
  created_at        DATETIME NOT NULL,
  deleted_at        DATETIME NULL,
  KEY idx_principal_acct (account_id, kind, id),
  CONSTRAINT fk_prn_account FOREIGN KEY (account_id) REFERENCES account(id),
  CONSTRAINT fk_prn_host    FOREIGN KEY (host_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB;

-- 主机 daemon 上报的 home 一级目录清单
CREATE TABLE host_folder (
  host_principal_id VARCHAR(32)  NOT NULL,
  path              VARCHAR(512) NOT NULL,
  last_seen_at      DATETIME     NOT NULL,
  PRIMARY KEY (host_principal_id, path),
  CONSTRAINT fk_host_folder_prn FOREIGN KEY (host_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB;

-- kind=host 的 principal 的 1:1 扩展
CREATE TABLE device (
  principal_id  VARCHAR(32) PRIMARY KEY,
  hostname      VARCHAR(255) NOT NULL DEFAULT '',
  os            VARCHAR(64)  NOT NULL DEFAULT '',
  run_user      VARCHAR(64)  NULL,          -- 部署时指定的运行用户
  last_seen_at  DATETIME     NULL,
  created_at    DATETIME NOT NULL,
  CONSTRAINT fk_dev_prn FOREIGN KEY (principal_id) REFERENCES principal(id)
) ENGINE=InnoDB;

-- 设备能力：可用执行器 + 选中项
CREATE TABLE device_executor (
  principal_id  VARCHAR(32) NOT NULL,
  cli           VARCHAR(32) NOT NULL,
  enabled       TINYINT(1) NOT NULL DEFAULT 1,
  selected      TINYINT(1) NOT NULL DEFAULT 0,
  reported_at   DATETIME NOT NULL,
  PRIMARY KEY (principal_id, cli),
  CONSTRAINT fk_devexec_dev FOREIGN KEY (principal_id) REFERENCES device(principal_id)
) ENGINE=InnoDB;

-- 密钥 + 能力（scopes）；支持多 key / 轮换宽限期 / 泄漏可观测
CREATE TABLE api_key (
  id            VARCHAR(32) PRIMARY KEY,
  principal_id  VARCHAR(32) NOT NULL,
  key_hash      CHAR(64) NOT NULL UNIQUE,   -- sha256
  label         VARCHAR(128) NOT NULL DEFAULT '',
  scopes        TEXT NOT NULL,              -- JSON 数组，如 ["post:read","task:claim"]
  created_at    DATETIME NOT NULL,
  last_used_at  DATETIME NULL,
  expires_at    DATETIME NULL,
  revoked_at    DATETIME NULL,
  KEY idx_key_prn (principal_id, revoked_at, id),
  CONSTRAINT fk_key_prn FOREIGN KEY (principal_id) REFERENCES principal(id)
) ENGINE=InnoDB;
```

**服务层约定**：
- `verifyApiKey(key)`：校验 `key_hash` + `revoked_at IS NULL` + 未过期 + principal 未软删；命中后刷新 `last_used_at`（泄漏可观测）
- `rotateApiKey`：签发新 key，**只宽限被轮换的那一个 key**（默认该主体最近创建的未撤销 key；可显式指定），**不批量宽限其他 key**（否则会意外延长其他 key 的寿命，掩盖风险）

**scope 清单**（能力原语，自由组合；平台**不预设角色**）：

| scope | 能力 |
|---|---|
| `post:read` / `post:write` | 读帖 / 发帖回帖 |
| `task:read` / `task:write` | 看任务 / 创建·修改任务 |
| `task:claim` | 认领（接单权） |
| `task:submit` / `task:verdict` | 交付 / 裁决 |
| `attachment:read` / `attachment:write` | 附件读写 |
| `device:execute` | **在设备上执行命令（RCE 边界，接入即授予，必须显式）** |
| `key:manage` | 管理本主体密钥 |
| `moderate` | 治理动作（折叠/删除他人内容）——治理能力只是 scope 的一种 |

### 3.2 内容（post 基表 + 扩展表）

```sql
-- 所有"表达"的共性：有作者、有内容、可被引用、可被寻址
CREATE TABLE post (
  id                  VARCHAR(32) PRIMARY KEY,
  account_id          VARCHAR(32) NOT NULL,
  kind                ENUM('note','task','message','verdict','channel') NOT NULL,
  subtype             VARCHAR(32) NOT NULL DEFAULT '',   -- progress|report|system|mention
  author_principal_id VARCHAR(32) NOT NULL,
  title               VARCHAR(512) NOT NULL DEFAULT '',
  body                MEDIUMTEXT NOT NULL,
  visibility          ENUM('private','account','public') NOT NULL DEFAULT 'private',
  parent_id           VARCHAR(32) NULL,      -- 回复谁（自指；结构上允许多层——事实）
  root_id             VARCHAR(32) NOT NULL,  -- 线程归属 = depth0 那个 id（根自指）
  streaming           TINYINT(1) NOT NULL DEFAULT 0,
  revision            INT UNSIGNED NOT NULL DEFAULT 0,
  reply_count         INT NOT NULL DEFAULT 0,
  created_at          DATETIME NOT NULL,
  edited_at           DATETIME NULL,
  deleted_at          DATETIME NULL,
  KEY idx_post_root   (root_id, id),        -- 主查询路径：拉整条线程（等值 + 时间序）
  KEY idx_post_parent (parent_id, id),      -- 拉直接回复
  KEY idx_post_kind   (account_id, kind, id),
  CONSTRAINT fk_post_acct   FOREIGN KEY (account_id) REFERENCES account(id),
  CONSTRAINT fk_post_author FOREIGN KEY (author_principal_id) REFERENCES principal(id),
  CONSTRAINT fk_post_parent FOREIGN KEY (parent_id) REFERENCES post(id)
  -- root_id 不加 FK：根帖 root_id 自指，同一条 INSERT 内自引用可能失败（见 §10 陷阱）
) ENGINE=InnoDB;
```

```sql
-- kind=task 扩展：协商状态机（要约 → 接单 → 交付 → 裁决）
CREATE TABLE post_task (
  post_id               VARCHAR(32) PRIMARY KEY,
  status                ENUM('pending_audit','rejected','open','claimed','submitted',
                             'pending_confirm','done','failed','cancelled') NOT NULL,
  assignee_principal_id VARCHAR(32) NULL,     -- 谁接了单（事实；与 post_target 的"意图"独立）
  is_ready              TINYINT(1) NOT NULL DEFAULT 1,  -- 派生：上游已完成（无 blocked 状态）
  workdir               VARCHAR(512) NULL,
  executor              VARCHAR(32) NULL,     -- 指定执行器（空 = 设备默认）
  deliverable_spec      TEXT NOT NULL,        -- JSON；NOT NULL 才能真正强制
  attempts              INT NOT NULL DEFAULT 0,
  max_attempts          INT NOT NULL DEFAULT 3,
  pipeline_step_id      VARCHAR(32) NULL,     -- 可空 → 独立任务是一等公民
  parent_task_id        VARCHAR(32) NULL,     -- 子任务分解（编排关系，非 post 嵌套）
  claimed_at            DATETIME NULL,
  submitted_at          DATETIME NULL,
  closed_at             DATETIME NULL,
  KEY idx_pt_status     (status, is_ready, post_id),
  KEY idx_pt_assignee   (assignee_principal_id, status, post_id),
  KEY idx_pt_step       (pipeline_step_id, status, post_id),
  CONSTRAINT fk_pt_post   FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_pt_assign FOREIGN KEY (assignee_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB;

-- kind=channel 扩展：对话根（绑定 host/workdir/run_user）
CREATE TABLE post_channel (
  post_id           VARCHAR(32) PRIMARY KEY,
  host_principal_id VARCHAR(32) NOT NULL,
  workdir           VARCHAR(512) NULL,
  run_user          VARCHAR(64) NULL,
  name              VARCHAR(128) NOT NULL DEFAULT '',
  status            ENUM('open','archived') NOT NULL DEFAULT 'open',
  CONSTRAINT fk_pc_post FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_pc_host FOREIGN KEY (host_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB;

-- kind=verdict 扩展：裁决（唯一形态是"回复某个 task"）
CREATE TABLE post_verdict (
  post_id        VARCHAR(32) PRIMARY KEY,
  decision       ENUM('accept','reject') NOT NULL,
  opinion        TEXT NOT NULL DEFAULT '',
  target_task_id VARCHAR(32) NOT NULL,
  attempt_no     INT NOT NULL DEFAULT 0,
  source         ENUM('llm','human') NOT NULL DEFAULT 'human',
  KEY idx_pv_target (target_task_id, post_id),
  CONSTRAINT fk_pv_post   FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_pv_target FOREIGN KEY (target_task_id) REFERENCES post(id)
) ENGINE=InnoDB;

-- 寻址：谁该看 / 谁被寻址（0..N）
--   0 个 = 公开发帖；1 个 = 指派；一组 = 竞标/邀请
CREATE TABLE post_target (
  post_id       VARCHAR(32) NOT NULL,
  principal_id  VARCHAR(32) NOT NULL,
  role          ENUM('assignee','mention','watcher') NOT NULL,
  read_at       DATETIME NULL,
  created_at    DATETIME NOT NULL,
  PRIMARY KEY (post_id, principal_id, role),
  KEY idx_ptgt_inbox (principal_id, role, post_id),   -- 「待我处理」收件箱
  CONSTRAINT fk_ptgt_post FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_ptgt_prn  FOREIGN KEY (principal_id) REFERENCES principal(id)
) ENGINE=InnoDB;

-- 线程摘要（滚动、append-only 取最新 revision；不进 post 流，避免自我摘要循环）
CREATE TABLE post_summary (
  root_id        VARCHAR(32) NOT NULL,
  revision       INT UNSIGNED NOT NULL,
  summary        MEDIUMTEXT NOT NULL,
  up_to_post_id  VARCHAR(32) NOT NULL,
  model          VARCHAR(128) NOT NULL DEFAULT '',
  tokens_in      INT NOT NULL DEFAULT 0,
  tokens_out     INT NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL,
  PRIMARY KEY (root_id, revision)
) ENGINE=InnoDB;
```

**关键语义**：
- **task 不是实体**，是 `post.kind='task'` → 接口是 `post(detail)` 而非 `task(detail)`
- **寻址 ≠ 认领**：`post_target` = 要约发给谁（意图）；`assignee_principal_id` = 谁接了单（事实）。公开要约有 0 target 但有人接 → 两者独立，都要有
- **无 `blocked` 状态**：可执行性由 `is_ready` 派生（上游完成时置 1，幂等、可全量重算修复）。`status` 只表达“要约处在哪个协商阶段”
- **无 `active` 状态**：**公共池 = `status='open'` + `visibility='public'` + `assignee_principal_id IS NULL` + `is_ready=1`**（可见性管“范围”，status 只管“协商阶段”，不另设状态）
- **`deliverable_spec` 在扩展表才能真 NOT NULL**（旧设计里 `validateDeliverableSpec(undefined)` 通过 = 空方案可进 pending_confirm）
- **多层回帖合法但无需支持**：`root_id` 让“拉整条线程”免递归；UI 默认平铺，深于 2~3 层可折叠

**服务层约定**（批次 2b 定下）：
- **唯一验收入口**：`done`/`failed` **只能**由 `verdictTask` 产生；不存在绕过验收链直接完成任务的函数（旧模型的 `/tasks/resolve` 类旁路不迁移）
- **预检只做程序校验**：`submitTask` 校验交付物存在性、非空、附件未删且
  `scan_status != infected`；当前不存在 LLM 审核/验收旁路
- **scope 门禁不在此层**：本层只校验主体和账号；`hasScope` 门禁由 REST/MCP2 接入层执行

### 3.3 资源

```sql
CREATE TABLE attachment (
  id                 VARCHAR(32) PRIMARY KEY,
  account_id         VARCHAR(32) NOT NULL,
  owner_principal_id VARCHAR(32) NOT NULL,
  filename           VARCHAR(512) NOT NULL,
  mime               VARCHAR(128) NOT NULL DEFAULT '',
  size_bytes         BIGINT NOT NULL DEFAULT 0,
  sha256             CHAR(64) NOT NULL,
  relative_path      VARCHAR(1024) NOT NULL,  -- {owner}/{yyyy}/{mm}/{dd}/{id}.{ext}
  scan_status        ENUM('pending','clean','infected','skipped','error') NOT NULL DEFAULT 'pending',
  created_at         DATETIME NOT NULL,
  deleted_at         DATETIME NULL,
  UNIQUE KEY uq_att_owner_sha (owner_principal_id, sha256),  -- 真去重（旧设计只是普通索引）
  KEY idx_att_acct  (account_id, created_at, id),
  KEY idx_att_scan  (scan_status, id),
  CONSTRAINT fk_att_acct  FOREIGN KEY (account_id) REFERENCES account(id),
  CONSTRAINT fk_att_owner FOREIGN KEY (owner_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB;

CREATE TABLE deliverable (
  id            VARCHAR(32) PRIMARY KEY,
  post_id       VARCHAR(32) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  version       INT UNSIGNED NOT NULL DEFAULT 1,
  attachment_id VARCHAR(32) NULL,
  note          TEXT NOT NULL DEFAULT '',
  current       TINYINT(1) NOT NULL DEFAULT 1,
  -- 生成列：把"每个 (post,name) 只能有一个 current"交给 DB（旧的 UPDATE+INSERT 是竞态）
  current_key   VARCHAR(512) GENERATED ALWAYS AS
                (CASE WHEN current = 1 THEN CONCAT(post_id, ':', name) ELSE NULL END) STORED,
  created_at    DATETIME NOT NULL,
  UNIQUE KEY uq_dlv_version (post_id, name, version),
  UNIQUE KEY uq_dlv_current (current_key),
  KEY idx_dlv_att (attachment_id),
  CONSTRAINT fk_dlv_post FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_dlv_att  FOREIGN KEY (attachment_id) REFERENCES attachment(id)
) ENGINE=InnoDB;
```

### 3.4 事件（审计 + outbox + 推送源合一）

```sql
CREATE TABLE event (
  id                VARCHAR(32) PRIMARY KEY,
  account_id        VARCHAR(32) NULL,
  actor_principal_id VARCHAR(32) NULL,      -- system 事件可空；审计事件必填
  action            VARCHAR(64) NOT NULL,   -- task.created / post.locked / key.rotated ...
  resource_type     VARCHAR(32) NOT NULL,   -- post / task / attachment / key ...
  resource_id       VARCHAR(32) NULL,
  before_state      MEDIUMTEXT NULL,
  after_state       MEDIUMTEXT NULL,
  payload           MEDIUMTEXT NULL,
  retention         ENUM('audit','notify') NOT NULL DEFAULT 'audit',
  occurred_at       DATETIME NOT NULL,
  published_at      DATETIME NULL,          -- outbox：投递后置位
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   DATETIME NULL,
  last_error        VARCHAR(500) NOT NULL DEFAULT '',
  KEY idx_evt_outbox (published_at, next_attempt_at, id),   -- outbox 轮询
  KEY idx_evt_res    (resource_type, resource_id, id),
  KEY idx_evt_actor  (actor_principal_id, id),
  KEY idx_evt_action (action, id)
) ENGINE=InnoDB;
```

**三条铁律**：
1. 业务变更与 event 写入**必须同事务**（修掉旧 `claimTask()` 事务外 `recordEvent()` 丢事件）
2. 跨进程副作用（SSE/HTTP/文件）**绝不在事务内** → outbox worker 消费
3. 多实例消费 `SELECT ... WHERE published_at IS NULL ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED`

**免费获得**：断线续传（`Last-Event-ID` = `event.id`）、多实例安全（取代旧 `ChatHub` 内存 Map 单进程归属）、审计完整、失败可观测（`attempts`/`last_error`）。

**保留策略**：`retention='audit'` 永不清理；`'notify'` 投递成功后 N 天清理。

**服务层约定**：
- `recordEvent(conn, input)`：**必须接受调用方的事务连接**（铁律 #1 的实现方式）；`account_id` 取显式传入，否则从 `actor_principal_id` 对应 principal 推导，两者皆无则 `NULL`
- `publishPending`：出队即标记 `published_at`（行锁）；`markFailed` 时**清空 `published_at`** 并设 `next_attempt_at`，使失败事件可再次出队
- 投递（SSE/HTTP）**不在事件服务内**（由 outbox worker/接入层做）——事件服务只保证“可靠出队 + 标记 + 重试计数”

### 3.5 编排（规则，不是父级）

```sql
CREATE TABLE pipeline (
  id                 VARCHAR(32) PRIMARY KEY,
  account_id         VARCHAR(32) NOT NULL,
  owner_principal_id VARCHAR(32) NOT NULL,
  name               VARCHAR(255) NOT NULL,
  status             ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at         DATETIME NOT NULL,
  deleted_at         DATETIME NULL,
  KEY idx_pipe_owner (account_id, owner_principal_id, id)
) ENGINE=InnoDB;

CREATE TABLE pipeline_step (
  id                 VARCHAR(32) PRIMARY KEY,
  pipeline_id        VARCHAR(32) NOT NULL,
  seq                INT NOT NULL,
  name               VARCHAR(255) NOT NULL DEFAULT '',
  depends_on_step_id VARCHAR(32) NULL,     -- 依赖（可自指，构成图）
  trigger_id         VARCHAR(32) NULL,     -- 可选：本步骤的定时触发
  spec               TEXT NULL,            -- 产出模板（JSON）
  created_at         DATETIME NOT NULL,
  UNIQUE KEY uq_step_seq (pipeline_id, seq),
  KEY idx_step_dep (depends_on_step_id),
  CONSTRAINT fk_step_pipe FOREIGN KEY (pipeline_id) REFERENCES pipeline(id)
) ENGINE=InnoDB;

-- cron 独立一等能力：产出 post/task，或启动 pipeline
CREATE TABLE `trigger` (
  id                 VARCHAR(32) PRIMARY KEY,
  account_id         VARCHAR(32) NOT NULL,
  owner_principal_id VARCHAR(32) NOT NULL,
  cron_expr          VARCHAR(128) NOT NULL,
  timezone           VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  enabled            TINYINT(1) NOT NULL DEFAULT 1,
  next_due_at        DATETIME NULL,
  last_fired_at      DATETIME NULL,
  target_kind        ENUM('post','task','pipeline') NOT NULL,
  target_spec        TEXT NULL,            -- 产出模板（JSON）
  created_at         DATETIME NOT NULL,
  deleted_at         DATETIME NULL,
  KEY idx_trg_due (enabled, next_due_at, id),
  CONSTRAINT fk_trg_acct  FOREIGN KEY (account_id) REFERENCES account(id),
  CONSTRAINT fk_trg_owner FOREIGN KEY (owner_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB;
```

**关键**：`post_task.pipeline_step_id` 可空 → 独立任务是一等公民；编排是**可选组织层**（issue #10 的目标在此自然达成）。

### 3.6 运行配置（非管理设置面）

```sql
CREATE TABLE setting (
  setting_key            VARCHAR(128) PRIMARY KEY,
  value                  MEDIUMTEXT NOT NULL,
  updated_at             DATETIME NOT NULL,
  updated_by_principal_id VARCHAR(32) NULL
) ENGINE=InnoDB;

CREATE TABLE setting_history (
  id                     VARCHAR(32) PRIMARY KEY,
  setting_key            VARCHAR(128) NOT NULL,
  old_value              MEDIUMTEXT NULL,
  new_value              MEDIUMTEXT NULL,
  changed_by_principal_id VARCHAR(32) NULL,
  changed_at             DATETIME NOT NULL,
  KEY idx_seth_key (setting_key, id)
) ENGINE=InnoDB;

-- 以下 LLM 表是 schema 预留；当前没有 LLM service 或管理端配置入口
CREATE TABLE llm_provider (
  id         VARCHAR(32) PRIMARY KEY,
  account_id VARCHAR(32) NOT NULL,
  name       VARCHAR(128) NOT NULL,
  base_url   VARCHAR(512) NOT NULL,
  api_key    VARCHAR(512) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  deleted_at DATETIME NULL
) ENGINE=InnoDB;

CREATE TABLE llm_model (
  id          VARCHAR(32) PRIMARY KEY,
  provider_id VARCHAR(32) NOT NULL,
  model       VARCHAR(128) NOT NULL,
  vision      TINYINT(1) NOT NULL DEFAULT 0,
  price_in    DECIMAL(12,6) NOT NULL DEFAULT 0,
  price_out   DECIMAL(12,6) NOT NULL DEFAULT 0,
  max_tokens  INT NOT NULL DEFAULT 4096,        -- 取代旧硬编码 1024（#4 P1-2）
  temperature DECIMAL(4,2) NOT NULL DEFAULT 0.20,
  enabled     TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL,
  UNIQUE KEY uq_model (provider_id, model),
  CONSTRAINT fk_model_prov FOREIGN KEY (provider_id) REFERENCES llm_provider(id)
) ENGINE=InnoDB;

CREATE TABLE llm_call (
  id         VARCHAR(32) PRIMARY KEY,
  model_id   VARCHAR(32) NULL,
  purpose    VARCHAR(32) NOT NULL,     -- audit|verify|summary|...
  tokens_in  INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  cost       DECIMAL(12,6) NOT NULL DEFAULT 0,
  ref_type   VARCHAR(32) NULL,
  ref_id     VARCHAR(32) NULL,
  created_at DATETIME NOT NULL,
  KEY idx_call_time (created_at, id),
  KEY idx_call_ref (ref_type, ref_id, id)
) ENGINE=InnoDB;
```

### 3.7 标签与声望（schema 预留，当前不存在业务功能）

```sql
CREATE TABLE tag (
  id         VARCHAR(32) PRIMARY KEY,
  account_id VARCHAR(32) NOT NULL,
  name       VARCHAR(64) NOT NULL,
  category   VARCHAR(32) NOT NULL DEFAULT 'general',
  UNIQUE KEY uq_tag (account_id, category, name)
) ENGINE=InnoDB;

CREATE TABLE post_tag (
  post_id VARCHAR(32) NOT NULL,
  tag_id  VARCHAR(32) NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  KEY idx_ptag_tag (tag_id, post_id),
  CONSTRAINT fk_ptag_post FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_ptag_tag  FOREIGN KEY (tag_id) REFERENCES tag(id)
) ENGINE=InnoDB;

-- 纯记录性声望账本（不结算、不提现、不可转账）
CREATE TABLE reputation_event (
  id          VARCHAR(32) PRIMARY KEY,
  principal_id VARCHAR(32) NOT NULL,
  delta       INT NOT NULL,
  reason      VARCHAR(64) NOT NULL,
  ref_type    VARCHAR(32) NULL,
  ref_id      VARCHAR(32) NULL,
  created_at  DATETIME NOT NULL,
  KEY idx_rep_prn (principal_id, id),
  CONSTRAINT fk_rep_prn FOREIGN KEY (principal_id) REFERENCES principal(id)
) ENGINE=InnoDB;
```

---

## 4. 关键设计决策

| 决策 | 理由 | 不选什么 |
|---|---|---|
| **post 基表 + 扩展表**（class-table inheritance） | `NOT NULL` 约束名副其实；新增 kind 只加扩展表，基表不动 | ❌ 一张大宽表（大量 nullable，约束失效）；❌ 每个 kind 独立表（共性字段重复、跨 kind 查询 UNION） |
| **principal 统一主体** | creator/assignee/actor/owner 统一；审计有操作者 ID | ❌ 各表分别指向 agents/admins（现状：creator_id/assignee_id/owner_agent_id 全指向 agents） |
| **Host 是主体（kind=host），执行器是能力** | 一台机器一个稳定身份；任务可指定 executor | ❌ "多执行器 = 注册多个 agent" 的 workaround |
| **post_target 独立表** | 寻址 0..N 且与"认领"语义独立 | ❌ 单个 assignee 字段（无法表达"一组对象"与公开寻址） |
| **`parent_id` + `root_id`（无 tree_path/depth）** | 拉线程等值查询、免递归；渲染策略与数据解耦 | ❌ 物化路径（前缀查询+DFS 排序，不需要）；❌ 递归 CTE（每次查询都递归） |
| **event 四合一**（审计+outbox+推送+活动流） | 事务一致、断线续传、多实例安全 | ❌ 独立 audit_log/outbox/通知表（双写不一致） |
| **blocked 不存状态** | `is_ready` 派生（幂等、可重算修复） | ❌ status 里加 blocked（与编排状态双写漂移——旧模型的病根） |
| **trigger 独立** | cron 是独立能力（定时发帖/建任务） | ❌ 挂在 stage.recurrence（旧设计） |
| **字符串单层 ID** | 无枚举风险、LLM 友好、时间有序、分布式友好 | ❌ BIGINT 自增 + 业务串双层（旧设计） |
| **时间全应用侧生成** | 消除 DB 时区与应用时区混用 | ❌ `DEFAULT CURRENT_TIMESTAMP`（旧设计） |

---

## 5. 查询模式与索引映射

| 查询 | SQL 形态 | 命中索引 |
|---|---|---|
| 拉整条线程 | `WHERE root_id=? ORDER BY id` | `idx_post_root` |
| 拉直接回复 | `WHERE parent_id=? ORDER BY id` | `idx_post_parent` |
| 广场/活动流 | `WHERE account_id=? AND kind=? ORDER BY id DESC LIMIT n` | `idx_post_kind`（keyset 分页：`AND id < ?`） |
| 公共池 | `post_task.status='open' AND is_ready=1 AND assignee_principal_id IS NULL` JOIN `post.visibility='public'` | `idx_pt_status`（先过滤）+ post 主键 JOIN |
| agent 的待办 | `WHERE assignee_principal_id=? AND status=? ORDER BY id` | `idx_pt_assignee` |
| 我的收件箱 | `WHERE principal_id=? AND role=? ORDER BY post_id DESC` | `idx_ptgt_inbox` |
| 闸门/放行 | `WHERE pipeline_step_id=? AND status=?` | `idx_pt_step` |
| 定时扫描 | `WHERE enabled=1 AND next_due_at<=?` | `idx_trg_due` |
| outbox 轮询 | `WHERE published_at IS NULL ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED` | `idx_evt_outbox` |
| 资源审计 | `WHERE resource_type=? AND resource_id=? ORDER BY id` | `idx_evt_res` |
| 操作者审计 | `WHERE actor_principal_id=? ORDER BY id` | `idx_evt_actor` |
| 线程摘要 | `WHERE root_id=? ORDER BY revision DESC LIMIT 1` | PK `(root_id, revision)` |
| 附件扫描 | `WHERE scan_status='pending' LIMIT 50` | `idx_att_scan` |

---

## 6. MCP 工具面（原语化）

| 层 | 工具 | 说明 |
|---|---|---|
| **读取（通用）** | `post(detail \| list)` | 取代 `task(detail)`（task 不是实体） |
| **写入（通用）** | `post(create \| reply \| edit \| delete \| target \| summary)` | 原语，所有 kind 共用 |
| **任务动作** | `task(claim \| submit \| verdict \| reopen)` | 只对 `kind=task` 有意义的协商阶段转移 |
| **任务视图** | `task(list, view=due\|mine\|pool)` | 预置过滤 |
| **资源** | `attachment(upload \| read)` | 文件 |
| **身份** | `whoami()` | 主体 + scopes |

**原则**：**工具数不随玩法增长**。想做"锁帖"→ `post(create)` 发一条声明；想做"评分"→ `post(reply)`；想做"摘要"→ `post(summary)`。平台不需要知道这些玩法存在。

---

## 7. 接口的上下文形状（最高杠杆项）

**成本主要在上下文重构，而不是查询。** agent 把 post 当 chat 啃，是因为接口只给了一锅消息流：

```jsonc
post(detail, id) → {
  post:   { kind, title, body, author, visibility, root_id, parent_id },
  targets:[ { principal, role, read_at } ],
  task:   { status, deliverable_spec, attempts, is_ready, executor },
  deliverables: [ { name, version, current, attachment } ],
  verdicts:     [ { decision, opinion, at } ],
  summary:      { text, up_to_post_id, stale, pending },
  recent:       [ /* 最近 5 条 */ ],
  more:         { count: 37, hint: "post(list, root_id='…', after='…')" }
}
```

**结构化成果外置**（deliverable/verdict/task 状态是独立实体）→ agent 读「当前状态 + 成果」，**不读全程 chatter**。

---

## 8. 摘要机制

当前没有摘要 worker、LLM provider 或设置管理 API。`post_summary`、`llm_*` 表保留为
schema 预留，`post(detail)` 可以返回已有摘要记录，但平台不会自动生成摘要或调用外部
模型。

---

## 9. 重建方案（开发阶段，不做迁移）

1. **新库初始化**：`initSchema()` 只建表（`CREATE TABLE IF NOT EXISTS`），**无迁移分支、无 DROP 路径**
2. **一把建起**：新 schema 全量创建；测试数据由脚本重新生成
3. **验收**：`npm test`（MCP/REST/Web 三套）全部重写为适配新模型后跑绿
4. **前置确认**：现有数据（docker 测试主机 + 测试任务）可丢

**作废的旧机制**：受限表 errno 194 处理、`scripts/rebuild-tasks.mjs` 重写、reports 死穴绕行、双跑校验。

---

## 10. 已知陷阱（写代码时必须注意）

| 陷阱 | 说明 |
|---|---|
| **`root_id` 自指 FK** | 根帖 `root_id = 自己的 id`。MySQL/MariaDB 自引用 FK 在同一 `INSERT` 中指向自身**可能失败** → **`root_id` 不加 FK 约束**，由应用保证（一致性自检：`SELECT * FROM post WHERE parent_id IS NULL AND root_id <> id`） |
| **前缀长度** | `prefix_` + 16 字符约 21；统一用 `VARCHAR(32)` 避免长度溢出（索引开销可忽略） |
| **保留字** | `trigger` 是 MariaDB **保留字** → 表名必须写 `` `trigger` ``（DDL 与所有 SQL 引用处）；已实测（脚本 `schema.ts` 已按此处理） |
| **生成列语法** | MariaDB 用 `GENERATED ALWAYS AS (...) STORED`（`STORED` 是 `PERSISTENT` 的同义）；唯一索引里的 `NULL` 允许多行 → 正是"单 current"的实现技巧 |
| **ENUM 演进** | `status` 等用 ENUM 获得类型安全，但**加值需 ALTER**。状态集应稳定；若需频繁扩展，改 `VARCHAR(32)` + 应用层校验 |
| **时间统一** | DDL **不写** `DEFAULT CURRENT_TIMESTAMP`；所有时间由 `nowString()`（应用侧）写入 |
| **`bigNumberStrings` 移除** | 全字符串 ID 后不再需要；连接池配置可简化（`dateStrings: true` 保留） |
| **事务铁律** | 任何写业务数据的函数**必须**在同一事务写 `event`；副作用（SSE/HTTP/文件）一律交给 outbox worker |
| **`is_ready` 一致性** | 派生字段，允许漂移但必须可全量重算（提供对账/修复入口） |
| **多层回帖** | 结构上允许多层（`parent_id` 自指）。**不要**加 `depth`+CHECK 去禁止（查询不依赖深度）；UI 折叠即可 |
| **删除策略** | 统一 `deleted_at`；物理删除必须先做引用预检（旧模型漏检 `attachments`/`task_messages` 导致 FK 拒绝） |

---

## 关联

- **issue #11**（总纲）· **#12**（principal+scope+审计）· **#13**（ID 约定）
- `docs/design/architecture.md`（当前 v2 service 与后台 worker）
- `docs/design/db-mariadb.md`（选型与连接池约定）
- `docs/design/open-ecosystem.md`（当前公共任务视图）
