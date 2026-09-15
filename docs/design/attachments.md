# v2 附件系统

附件属于新模型 `attachment`，交付物通过 `deliverable.attachment_id` 引用。REST
和 MCP2 共用 `src/service/resources.ts` 的元数据、去重、引用和权限逻辑；扫描由
`src/service/attachment-worker.ts` 负责。

## 通道

| 通道 | 入口 | 限制 |
| --- | --- | --- |
| REST | `POST /api/v2/attachments`，multipart `file` | 单文件 5 MiB |
| MCP2 | `attachment(action="upload")`，base64 | 单文件 5 MiB |
| 下载 | `GET /api/v2/attachments/:id`，Bearer | owner 或任务参与者 |

上传按 owner 和 SHA-256 去重，文件存放在
`ATTACHMENTS_ROOT/{owner}/yyyy/mm/dd/{sha256}.{ext}`，数据库只保存相对路径和元数据。
上传后的 `pending` 记录由 worker 交给 clamd；未配置 clamd 时标为 `skipped`，感染
文件不能引用或下载。

下载没有公开 URL。文本 MIME 使用 UTF-8 inline 预览，其他类型使用安全的
`Content-Disposition: attachment`；文件名经过路径和字符过滤。附件被交付物引用后，
其任务参与者获得读取权限。

运行参数来自新模型 `setting` 表和 `src/service/new-settings.ts`：

- `attachments_root`
- `quota_bytes`
- `max_attachment_bytes`
- `clamd_host` / `clamd_port`
- `agent_offline_after_min`

旧 `attachments` 表、旧 `/api/agent/attachments`、旧 settings service 和旧管理员
session 鉴权均已删除。
