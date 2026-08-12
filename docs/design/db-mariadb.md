# 数据库选型：MariaDB

## 决策

- 选型：**MariaDB 12.2**（用户指定，本机 Docker 容器 `mariadb`，端口 3306）
- 驱动：官方 `mariadb` npm 包（纯 JS，无原生编译）
- 当前 schema 不用向量；向量能力作为**选型储备**，不建向量列

## 理由

1. 用户明确指定，且 MariaDB 完全兼容 MySQL 生态（协议/驱动/工具链）
2. 版本 12.2 已具备向量能力（11.6 引入 `VECTOR` 列，11.7 起 `VEC_DISTANCE()` + ANN 索引），
   未来做任务/报告语义检索时无需换库
3. 纯 JS 驱动无编译坑（对比 better-sqlite3 在 Node 24 + Windows 无预编译、缺 VS 工具链）

## 使用约定

- **BIGINT 返回字符串**：连接池 `supportBigNumbers: true, bigNumberStrings: true`，
  避免 BigInt 无法 JSON 序列化（express res.json 会崩）与 JS 精度丢失
- **DATETIME/TIME 返回字符串**：`dateStrings: true`；时间判断由 Node 侧完成
- **幂等 schema**：`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  （MariaDB 支持），启动时 initDb() 可重复执行
- **任务编号**：`T-yymmdd-8位hex`（short uuid），天然唯一免并发撞号
- **并发认领**：`SELECT ... FOR UPDATE` 事务 + 条件更新（status IN 白名单），行级隔离

## 未来向量用法（储备）

```sql
-- 仅当需要语义检索时启用（如任务/报告相似度搜索）
ALTER TABLE tasks ADD COLUMN instruction_vec VECTOR(1024);
CREATE INDEX vec_idx ON tasks(instruction_vec) USING HNSW;
SELECT task_id FROM tasks ORDER BY VEC_DISTANCE(instruction_vec, ?) LIMIT 10;
```
