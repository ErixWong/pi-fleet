import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { initDb, query } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

/**
 * 初始化管理员密码（scrypt 哈希入库）。
 * 用法: npm run init-admin              # 交互输入
 *       npm run init-admin -- --password=xxx
 */
async function main(): Promise<void> {
  const arg = process.argv[2] ?? '';
  const inline = arg.startsWith('--password=') ? arg.slice('--password='.length) : '';

  await initDb();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const password = inline || (await rl.question('请输入管理员密码: '));
  const confirm = inline || (await rl.question('再次输入确认: '));
  rl.close();

  if (password !== confirm) {
    console.error('✗ 两次输入不一致');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('✗ 密码至少 6 位');
    process.exit(1);
  }

  await query(
    `INSERT INTO admin (id, password_hash) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [hashPassword(password)],
  );
  console.log('✓ 管理员密码已设置');
  await (await import('../src/db.js')).getPool().end(); // 关闭连接池，让进程正常退出
}

main().catch((err) => {
  console.error('初始化失败:', err);
  process.exit(1);
});
