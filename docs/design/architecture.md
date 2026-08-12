# 架构设计（任务分发平台）

> 长期有效的架构决策记录。任务流水见 docs/tasks/，本文件只沉淀跨任务结论。

## 定位

人类在 Web 上注册 agent、发布任务（指派/定时），多台 Linux 设备上的 pi-agent
通过 REST/MCP 接入平台：领任务、执行、汇报结果、投递报告。

## 核心原则

1. **程序的事交给程序，智能的事交给 LLM**
   - 调度层（systemd 闹钟脚本）做心跳/轮询/回传——纯程序，零 token，永不打断
   - LLM（pi）只在有任务时存在，干完销毁；无常驻 LLM = 零 token 浪费
2. **两通道独立，共用同一 agent key**
   - REST `/api/agent/*`（Bearer key）：调度脚本的程序通道
   - MCP `/mcp`（Bearer key）：pi 的 LLM 工具通道
   - 两通道共享同一业务层 `src/service/tasks.ts`，防止双套实现漂移
3. **单任务单进程**：每个 pi 进程只干一个任务，任务身份在拉起时绑定
   （进程命名 exec-T-xxx + AGENTS.md 简报 + 工作目录）

## 任务模型

- **指派任务（manual）**：管理员写自然语言指令，assign 给指定 agent，状态 pending → done/failed
- **定时任务（scheduled）**：周期（daily/weekly/hourly）+ 时间窗口（错峰）+ 报告主题
- **状态机**：pending → running（放行/认领）→ done / failed / cancelled
- **workdir（可选）**：有则原地模式（cwd=项目目录），无则沙箱（cwd=tasks/{id}/）

## 关键决策

### 错峰调度（next_due_at = 窗口内随机时刻）
定时任务不固定准点，`next_due_at` 取「下一周期窗口内的随机时刻」，各家 agent
到期时刻散布在整个窗口 → 天然错峰，避免 provider 压力。放行只判断
`next_due_at <= now`，窗口语义已编码进随机时刻；放行即推进下一周期。

### 超时回收 + 长任务续期
- 平台每小时回收「认领后 2h 无活动」的 running 任务 → failed（防卡死/离线僵尸）
- 长任务（>1h）通过 `report_progress`/`renew` 刷新 `last_activity_at` 续期，避免误杀
- 超时判定基于 last_activity_at（最后活跃），而非 claimed_at（认领）

### 同 workdir 防并发
poll/check_due_tasks 放行时，排除「同 agent 同 workdir 已有 running」的任务，
防止多个 pi 同时改同一项目目录。项目内并发靠 git 分支隔离（建议）。

### 时间处理
所有时间由 Node 侧生成本地字符串（YYYY-MM-DD HH:MM:SS），数据库只存不判断
（窗口判断不依赖 DB NOW()），避免容器 UTC 与宿主时区错位。

### 安全
- agent key：`pd-` 前缀 + 32 字符 base64url（192bit 熵）；库存 sha256，只展示一次，支持重置
- 越权隔离：所有任务查询按 assignee_id 过滤
- agent 侧：pi 以专用低权限用户运行，特权走 sudoers 白名单

## 演进储备（未做）

- MCP 官方 Tasks 规范（2025-11）异步任务——协议标准化方向
- 附件上传（结果文件由 agent 本地保留，平台只记文本/路径）
- 任务依赖/跨机编排
- 向量检索（见 db-mariadb.md）
