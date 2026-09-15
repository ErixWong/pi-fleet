# 用 Portainer 部署 pi（多主机测试环境）

> 本文档：把 pi 多主机测试环境（3 个容器模拟 3 台远端主机）从 `docker compose CLI` 改为 **Portainer stack** 统一管理——与 `pi-market_playwright` 等容器一致，可用 **portainer MCP** 完成全生命周期操作（创建/启停/更新/删除/看日志）。
>
> - 平台约定：见 `~/projects/AGENTS.md` §2.1（Portainer MCP）/ §3.3（容器发布规矩）
> - 原环境说明：`AGENTS.md`「docker 多主机测试环境」一节（`/docker/pi-hosts`，本地基础设施，不进仓库）

---

## 1. 架构一览

| 项 | 值 |
|---|---|
| stack 名 | `pi-hosts`（endpointId = **2**，本机） |
| 容器 | `pi-host-1` / `pi-host-2` / `pi-host-3` |
| 镜像 | `node:22-slim`（node 官方镜像，**不 build 自定义镜像**；pi/sshd/sudo 由挂载的初始化脚本首次启动自动安装） |
| 端口 | `2201 / 2202 / 2203 → 22`（SSH 登录用） |
| 每容器内容 | node + pi CLI + agent-daemon 常驻 + sshd（任务执行，entrypoint 自动初始化） |

**bind mount（统一 `/docker/<名称>/` 约定，数据持久化）：**

| 宿主机 | 容器内 | 说明 |
|---|---|---|
| `/docker/pi-hosts/host-{N}/projects` | `/home/app/projects` | 各主机 `~/projects`（持久化，agent 工作目录） |
| `/docker/pi-hosts/conf` | `/conf:ro` | pi 模型配置（`models.json` + `settings.json`，含 relay key） |
| `/home/eric/projects/pi-market` | `/opt/pi-market:ro` | npm 客户端 `client/src/agent-daemon.mjs` + node_modules（改代码即生效） |
| `/docker/pi-hosts/build/entrypoint.sh` | `/opt/entrypoint.sh:ro` | 初始化脚本（apt 装 sshd/sudo → npm 装 pi → 拷 pi 配置 → sshd → agent-daemon；改脚本 `docker restart` 即生效） |

**环境变量（每个容器一份）：**

| 变量 | 值 | 说明 |
|---|---|---|
| `PI_AGENT_KEY_{N}` | 平台注册所得 | agent 鉴权 key（**走 stack Env 注入，不入 compose**） |
| `PLATFORM_URL` | `http://172.17.0.1:3200` | 平台地址（docker bridge 网关访问宿主机；按平台实际端口调整） |
| `HOST_NAME` | `pi-host-{N}` | agent 名 |
| `HOST_HOSTNAME` | `pi-host-{N}` | 主机名 |
| `SSH_PASSWORD` | 自定义 | root/app 的 SSH 密码（默认 `pi-host`） |
| `BRIDGE_SCRIPT` | `/opt/pi-market/client/src/agent-daemon.mjs` | agent-daemon 入口（挂载自宿主机） |

---

## 2. 前置准备（一次性）

> **镜像策略**：直接用 node 官方镜像 `node:22-slim`，**不需要构建自定义镜像**。容器首次启动（重建后）由挂载的 `/opt/entrypoint.sh`（宿主机 `/docker/pi-hosts/build/entrypoint.sh`）自动完成：`apt` 装 openssh-server/sudo/git → `npm install -g @earendil-works/pi-coding-agent@0.84.2` → 建 `app`/`pi-agent` 用户 + sudoers。
> 依赖安装仅在**容器重建**后执行一次（约 1-2 分钟）；`docker restart` 不重建文件系统，直接跳过。

### 2.1 确认脚本与镜像

```bash
ls -l /docker/pi-hosts/build/entrypoint.sh        # 初始化脚本（宿主机，compose 挂载）
docker image inspect node:22-slim >/dev/null && echo 'node:22-slim 已就绪'   # 无则 docker pull node:22-slim
```

改 `entrypoint.sh` 无需重建容器，`docker restart pi-host-N` 即生效（ro 挂载实时读取）。

### 2.2 平台侧注册 agent

1. 平台 Web/API v2 注册 3 台主机（如 `docker主机-1/2/3`），各拿一个 host key
2. 把 key 填进 `/docker/pi-hosts/.env`（**600 权限，不入仓库**）：

```bash
PI_AGENT_KEY_1=xxx
PI_AGENT_KEY_2=xxx
PI_AGENT_KEY_3=xxx
SSH_PASSWORD=pi-host
```

### 2.3 pi 模型配置

`/docker/pi-hosts/conf/` 下放 `models.json` + `settings.json`（含 relay key，从本机 `~/.pi/agent/` 拷出）。容器 entrypoint 启动时自动拷到 `app` / `pi-agent` 用户的 `~/.pi/agent/`。

---

## 3. 用 Portainer MCP 部署

### 3.1 compose 内容（Portainer 版）

直接基于 node 官方镜像 `node:22-slim`（无 build），初始化脚本挂载自宿主机。与 `/docker/pi-hosts/docker-compose.yml` 一致，可直接复制。`${VAR}` 由 Portainer stack 的 Env 渲染。

```yaml
services:
  host-1:
    image: node:22-slim
    entrypoint: ["/bin/bash", "/opt/entrypoint.sh"]
    container_name: pi-host-1
    hostname: pi-host-1
    ports:
      - "2201:22"
    volumes:
      - /docker/pi-hosts/host-1/projects:/home/app/projects
      - /docker/pi-hosts/build/entrypoint.sh:/opt/entrypoint.sh:ro
      - /docker/pi-hosts/conf:/conf:ro
      - /home/eric/projects/pi-market:/opt/pi-market:ro
    environment:
      - PI_AGENT_KEY=${PI_AGENT_KEY_1}
      - PLATFORM_URL=http://172.17.0.1:3200
      - HOST_NAME=pi-host-1
      - HOST_HOSTNAME=pi-host-1
      - SSH_PASSWORD=${SSH_PASSWORD:-pi-host}
      - BRIDGE_SCRIPT=/opt/pi-market/client/src/agent-daemon.mjs
    restart: unless-stopped

  host-2:
    image: node:22-slim
    entrypoint: ["/bin/bash", "/opt/entrypoint.sh"]
    container_name: pi-host-2
    hostname: pi-host-2
    ports:
      - "2202:22"
    volumes:
      - /docker/pi-hosts/host-2/projects:/home/app/projects
      - /docker/pi-hosts/build/entrypoint.sh:/opt/entrypoint.sh:ro
      - /docker/pi-hosts/conf:/conf:ro
      - /home/eric/projects/pi-market:/opt/pi-market:ro
    environment:
      - PI_AGENT_KEY=${PI_AGENT_KEY_2}
      - PLATFORM_URL=http://172.17.0.1:3200
      - HOST_NAME=pi-host-2
      - HOST_HOSTNAME=pi-host-2
      - SSH_PASSWORD=${SSH_PASSWORD:-pi-host}
      - BRIDGE_SCRIPT=/opt/pi-market/client/src/agent-daemon.mjs
    restart: unless-stopped

  host-3:
    image: node:22-slim
    entrypoint: ["/bin/bash", "/opt/entrypoint.sh"]
    container_name: pi-host-3
    hostname: pi-host-3
    ports:
      - "2203:22"
    volumes:
      - /docker/pi-hosts/host-3/projects:/home/app/projects
      - /docker/pi-hosts/build/entrypoint.sh:/opt/entrypoint.sh:ro
      - /docker/pi-hosts/conf:/conf:ro
      - /home/eric/projects/pi-market:/opt/pi-market:ro
    environment:
      - PI_AGENT_KEY=${PI_AGENT_KEY_3}
      - PLATFORM_URL=http://172.17.0.1:3200
      - HOST_NAME=pi-host-3
      - HOST_HOSTNAME=pi-host-3
      - SSH_PASSWORD=${SSH_PASSWORD:-pi-host}
      - BRIDGE_SCRIPT=/opt/pi-market/client/src/agent-daemon.mjs
    restart: unless-stopped
```

### 3.2 创建 stack（MCP 单次调用）

```js
mcp({
  tool: "portainer_StackCreateDockerStandaloneString",
  args: {
    endpointId: 2,                      // 本机 endpoint
    Name: "pi-hosts",
    StackFileContent: "…上面的 compose 全文…",
    Env: [                              // 渲染 compose 里的 ${VAR}，key 不写进 compose 明文
      { name: "PI_AGENT_KEY_1", value: "…key1…" },
      { name: "PI_AGENT_KEY_2", value: "…key2…" },
      { name: "PI_AGENT_KEY_3", value: "…key3…" },
      { name: "SSH_PASSWORD", value: "pi-host" }
    ]
  }
})
```

说明：

- **Env 是 key 的注入通道**：compose 里 `PI_AGENT_KEY=${PI_AGENT_KEY_1}` 由 Portainer 用 stack Env 渲染；compose 与仓库均不出现 key 明文
- 备选：`portainer_StackCreateDockerStandaloneFile`（`file` 传本地 compose 文件内容），效果相同
- 若已有同名 stack / 容器冲突，先按 §5 处理再创建
- 镜像为 node 官方镜像（本机无则自动 pull，或先 `docker pull node:22-slim`）

### 3.3 验证部署

```js
mcp({ tool: "portainer_StackList" })                        // 出现 pi-hosts，Status=1（running）
mcp({ tool: "portainer_StackInspect", args: { id: <stackId>, endpointId: 2 } })
```

```bash
docker ps | grep pi-host            # pi-host-1/2/3 Up
docker logs pi-host-1 | tail -20    # 应看到 [init] pi 配置已就绪 / sshd 就绪 / agent-daemon 启动
ssh app@127.0.0.1 -p 2201           # SSH 可登录（密码 = SSH_PASSWORD）
```

平台侧：主机列表显示 3 台在线；任务执行通过 `/api/v2` 和 `/mcp2` 验证。

---

## 4. 日常运维（portainer MCP）

| 操作 | 工具 |
|---|---|
| 查 stack / 状态 / 文件 | `portainer_StackList` / `StackInspect` / `StackFileInspect` |
| 停止 / 启动 | `portainer_StackStop` / `StackStart`（`id` + `endpointId: 2`） |
| 看容器 | `portainer_dockerContainerList`（过滤 `pi-host`） |
| 更新 compose | `portainer_StackUpdate`（`StackFileContent` 传新内容 + `Prune: true`） |
| 删除 stack（连带删容器） | `portainer_StackDelete` |

**更新流程**：

1. 只改 compose（环境变量/挂载/端口）→ `StackUpdate` 直接生效
2. 改初始化脚本 `entrypoint.sh` / agent-daemon 脚本（`client/src/agent-daemon.mjs`）→ 无需重建：两者都是 ro 挂载，`docker restart pi-host-N` 即生效
3. 注意：stack 更新（`StackUpdate`）会**重建容器** → 首次启动重新执行 `entrypoint.sh` 的依赖安装（apt+npm 约 1-2 分钟）；只想重载脚本用 `docker restart` 避免重装

**改 key / 密码** → `StackUpdate` 传新的 `Env` 数组。

---

## 5. 从 docker compose CLI 迁移（现有环境接管）

当前 pi-host-1/2/3 是 `docker compose`（`/docker/pi-hosts/docker-compose.yml`，已基于 node:22-slim 官方镜像）直接创建的，**不在 Portainer 内**（labels：`com.docker.compose.project=pi-hosts`）。要接管需先释放容器名（避免与新建 stack 冲突）：

```bash
cd /docker/pi-hosts && docker compose down      # 停止并删除 compose 管理的 3 个容器（数据不动）
```

然后按 §3 创建 `pi-hosts` stack。数据无需迁移——bind mount 在 `/docker/pi-hosts/host-N/projects` 宿主机持久化，容器重建不受影响。

**回退**：`portainer_StackDelete` 删掉 stack 后，`cd /docker/pi-hosts && docker compose up -d` 即可回到 compose CLI 管理（原 compose 文件仍在）。

---

## 6. 安全与约定

- **key 不入仓库/镜像**：走 stack Env 注入（§3.2）；`.env`、`conf/models.json`（含 relay key）均 600 权限且不提交
- **数据持久化**：bind mount 一律 `/docker/<名称>/`（§1 表），不建匿名卷
- **初始化脚本**：`entrypoint.sh` 由宿主机 ro 挂载，改脚本 `docker restart` 即生效（无需重建镜像/容器）
- **重启策略**：`restart: unless-stopped`（已含）
- **健康检查**：本环境为测试用途，容器靠 entrypoint 串行初始化 + agent-daemon 常驻，未配 `healthcheck`；如需依赖编排再加
- 本环境不进仓库、无自定义镜像（node 官方镜像，无需 push registry）
