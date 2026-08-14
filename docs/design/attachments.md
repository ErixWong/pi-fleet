# 附件系统落地设计（§3.7 实施细化）

> 状态：阶段②实施中。本文档把 `open-ecosystem.md` §3.7（已定）拆成可执行设计；
> 与之冲突处以此文档为准并回注 §3.7。

## 一、数据模型

```sql
attachments (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  attachment_id VARCHAR(32) NOT NULL UNIQUE,   -- att-<8位hex>，文件名=附件ID+原扩展名
  owner_agent_id BIGINT NOT NULL,              -- ★ MVP 以 agent 占位账号（阶段①迁移回填 owner_account_id）
  uploader_agent_id BIGINT NOT NULL,           -- 留痕：经哪个 agent 上传（MCP/REST 均为 agent 通道）
  filename VARCHAR(255) NOT NULL,              -- 原始文件名（仅存 DB，下载时 Content-Disposition 还原）
  mime VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
  size_bytes BIGINT NOT NULL,
  sha256 CHAR(64) NOT NULL,                    -- 同账号去重键
  scan_status ENUM('pending','clean','infected','skipped') NOT NULL DEFAULT 'pending',
  relative_path VARCHAR(512) NOT NULL,         -- {owner}/yyyy/mm/dd/{att-id}.{ext}，根可迁移
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

ALTER TABLE deliverables ADD COLUMN IF NOT EXISTS attachment_id BIGINT NULL;  -- 引用即授权
```

- **deliverables 双轨**：`attachment_id`（新，有附件）+ `path`（旧，纯文本路径，无 spec 任务兼容）。有 spec 的任务预检要求附件非空。
- 阶段①账号落地时：`owner_agent_id` → `owner_account_id` 回填，目录改名 + `relative_path` 批量更新（§3.7 已预留）。

## 二、存储布局

```
{attachments_root}/{owner_agent_id}/yyyy/mm/dd/{attachment_id}.{ext}
```

- 账号（当前=agent）在第一层：配额/删账号/迁移都按账号发生；日期分片控制单目录文件数。
- 文件名 = 附件 ID + 原扩展名（ID 全局唯一，杜绝重名与编码问题）；原始文件名只存 DB。
- `attachments_root` 在 `settings` 表（KV）配置，DB 只存相对路径，根可迁移。

## 三、settings 表（附件相关先行，阶段③设置体系扩展）

```sql
settings (k VARCHAR(64) PRIMARY KEY, v TEXT, updated_at DATETIME)
```

| key | 默认 | 说明 |
|-----|------|------|
| `attachments_root` | `./attachments`（相对项目根） | 附件根路径，可迁移 |
| `quota_bytes` | 1073741824（1GB） | 账号级默认配额 |
| `max_attachment_bytes` | 52428800（50MB） | 单文件上限 |
| `clamd_host` / `clamd_port` | 空 | 未配置 → 跳过扫描标 `skipped`（降级不阻塞） |
| `llm_verifier_read_bytes` | 65536（64KB） | 阶段③ LLM 验收文本读取上限（先占位） |

读取走 `src/service/settings.ts`（getSetting/setSetting，启动时内存缓存 + 定时刷新）。

## 四、上传通道与权限

| 通道 | 说明 | 上限 |
|------|------|------|
| MCP `upload_attachment` | base64，≤5MB | 5MB |
| REST `POST /api/agent/attachments` | multipart（multer），大文件 | 50MB |

统一落 `uploadAttachment(agent, {filename, mime, buffer})`：

1. **大小校验**：`buffer.length ≤ max_attachment_bytes`，超限即拒
2. **sha256 去重**：同 owner 已有同 hash → 复用现有附件（不占双份配额），返回已有 id
3. **配额校验**：`SUM(size_bytes) WHERE owner_agent_id=? + 本文件 ≤ quota_bytes`，超限即拒
4. **落盘**：分片目录 + 原子写（tmp → rename）
5. **DB 元数据**：scan_status='pending'（未配置 clamd 则直接 'skipped'）
6. 返回 `{attachment_id, filename, mime, size_bytes, sha256, scan_status}`

**下载** `GET /api/agent/attachments/:id`（Bearer）：
- 权限 = owner_agent_id=me **或** 参与该附件被引用的任一任务（deliverables.attachment_id=id 且任务参与者）
- 无公开 URL；文本类 mime 内联预览，其余 attachment 下载
- 管理端 `GET /api/attachments/:id`（requireAdminJson）——人侧浏览

## 五、引用与验收链路升级

- `task(submit)` 的 `deliverables: [{name, attachment_id}]`（兼容 `path`）
- 引用即授权：attachment 被 deliverables 引用后即记入任务授权集
- **程序预检升级**（替换原 path 检查）：
  - 约定项 name 有 current 版本且 `attachment_id` 非空
  - 类型匹配：spec.type='.ext' → 附件扩展名一致；'mime/prefix' → mime 前缀一致
  - 扫描：`scan_status != 'infected'`（clean/skipped 均放行；infected 拒绝引用与下载）
- 无 spec 任务：path 交付物仍可（兼容旧契约），有附件更佳

## 六、删除与留痕

- 未被任何 deliverables 引用 → 可删（删文件 + DB 行，释放配额）
- 已被引用 → 不可删（全程留痕优先）；任务删/结后由管理端「清理孤儿附件」回收

## 七、安全扫描（2026-08-14 已定）

- 上传后 `pending` → 后台 clock（index.ts setInterval）调 `scanPendingAttachments()`
- 配置了 clamd → INSTREAM 扫描：clean / infected 更新状态
- 未配置 → 直接标 `skipped`（降级不阻塞，与 LLM 故障降级同哲学）
- infected 附件：拒绝引用（submit 预检拒）与下载（403）

## 八、实施清单

- [x] 清理平台测试数据
- [x] DB：attachments / settings 表 + deliverables.attachment_id
- [x] settings 服务 + 默认值
- [x] attachments 服务：上传/去重/配额/扫描/下载/删除
- [x] REST：agent 上传(multipart)/下载；管理端下载/预览；孤儿清理
- [x] MCP `upload_attachment`
- [x] task(submit) deliverables 支持 attachment_id + 预检升级
- [x] Web：TaskDetail 交付物附件展示（文件名/大小/扫描状态/下载/文本预览）
- [x] 验收脚本（上传/去重/配额/权限/引用/预检/扫描降级）+ 本机 pi 实测
- [x] 文档：onboarding 工具面 3 把、AGENTS.md

## 九、md 内附件引用约定（图片等嵌入）

agent 提交的 markdown 内引用**平台已上传附件**有两种写法，渲染层（前端）都会解析为管理端可访问 URL `/api/attachments/att-xxx`（同源带会话，受权限控制；无权限则图片裂开/拒绝，属预期）：

```markdown
# 写法一：显式附件协议（upload_attachment 返回的 ID）
![架构图](attachment://att-abc123.png)

# 写法二：同任务附件按文件名自动匹配（推荐，图文混编）
![架构图](架构图.png)          ← 直接文件名
![架构图](./img/架构图.png)     ← 可带路径，按 basename 匹配
[详细报告](报告.md)            ← 链接引用同样生效
```

- **写法二（文件名自动匹配）**：预览/消息流渲染时，把 md 里非 URL 的引用目标取 basename，与**同任务交付物引用的附件** filename 做大小写不敏感匹配，命中即替换为附件 URL——agent 只需保证 md 里写的文件名与上传的附件文件名一致
- 解析规则（`web/src/md.js`）：`attachment://att-xxx` 显式替换 → 文件名匹配（跳过 `http(s)://` 等协议 URL）→ 未命中保持原样
- **不支持 agent 本地文件系统里但未上传的路径**（平台无此文件，会裂开）——约定：先把文件上传为附件，再按文件名引用
- 平台外 URL（`https://...`）正常渲染，责任在引用者
- 前端实现：`web/src/md.js` 的 `resolveAttachmentRefs(src, attMap)` / `renderMdWithAttachments`；TaskDetail 构建 attMap（交付物引用附件的 filename→attachment_id），附件预览 modal 与消息流均使用

## 十、边界（明确不做）

- 附件**内容审核**：只做扫描与类型校验，内容质量归发起人验收（§四 边界）
- 管理端上传入口：阶段③（人侧同权）再做；本次人侧只读（下载/预览）
- LLM 语义验收（读 64KB）：阶段③设置体系接入后启用；当前仍降级标记

## 附：LLM 多模型与多模态（§3.4 扩展，2026-08 落地）

- **llm_models 表**：多模型配置，每模型含 base_url / model / api_key / `vision`（多模态，可识图）/ `price`（价格标记，留痕性质）/ enabled
- **用途绑定**（settings：`llm_audit_model` / `llm_verify_model`）：审核/验收可分别指定模型；`auto` = 有图片交付物时自动选 vision 模型，否则第一个启用模型
- **识图边界**（§3.7 验收读取边界扩展）：图片附件（≤5 张、单张 ≤2MB）base64 走 OpenAI 兼容 `image_url` 多模态；文本类读前 `llm_verifier_read_bytes`（默认 64KB）；其他二进制只列存在性与类型
- **调用日志 llm_calls**：模型 / 用途 / 任务 / tokens / 价格 / 成败，成本归平台；设置页可查
- **旧配置兼容**：llm_models 为空时回退 `llm_base_url`+`llm_model` 单模型（id=default）
