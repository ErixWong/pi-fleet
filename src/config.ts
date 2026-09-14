export const config = {
  port: Number(process.env.PORT ?? 3000),
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'task_dispatch',
  },
  // 新模型只读派生配置：兼容 DB_NAME=erix 的既有单测，但绝不回落到老库。
  dbNew: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME_NEW
      ?? (process.env.DB_NAME && process.env.DB_NAME !== 'task_dispatch'
        ? process.env.DB_NAME
        : 'erix'),
  },
  newDbRequired: ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NEW_DB_REQUIRED ?? '').trim().toLowerCase(),
  ),
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-session-secret-change-me',
} as const;
