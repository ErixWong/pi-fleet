import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadAgentConfig } from './setup.mjs';

const UNIT_PATH = '/etc/systemd/system/pi-agent.service';
const BIN_PATH = fileURLToPath(new URL('../bin/pi-agent.js', import.meta.url));

function systemctl(args) {
  return spawnSync('systemctl', args, { encoding: 'utf8', stdio: 'inherit' });
}

function systemdQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`').replace(/%/g, '%%')}"`;
}

function targetHome(user) {
  if (user === os.userInfo().username) return os.homedir();
  const result = spawnSync('getent', ['passwd', user], { encoding: 'utf8' });
  const home = String(result.stdout ?? '').trim().split(':')[5];
  return home || `/home/${user}`;
}

function ensureRootTarget() {
  if (process.getuid?.() !== 0) return os.userInfo().username;
  const user = 'pi-agent';
  if (spawnSync('id', [user], { stdio: 'ignore' }).status !== 0) {
    const result = spawnSync('useradd', ['-r', '-m', '-s', '/bin/bash', user], { encoding: 'utf8', stdio: 'inherit' });
    if (result.status !== 0) throw new Error('创建低权限 pi-agent 用户失败');
  }
  return user;
}

function unitContent(config, user, home) {
  return `[Unit]
Description=pi agent task-dispatch daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${systemdQuote(home)}
Environment=PLATFORM_URL=${systemdQuote(config.url)}
Environment=PI_AGENT_KEY=${systemdQuote(config.key)}
Environment=AGENT_CMD=${systemdQuote(config.cli || 'auto')}
ExecStart=/usr/bin/env node ${systemdQuote(BIN_PATH)} run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function loadServiceConfig() {
  if (process.env.SUDO_USER) {
    const callerConfig = loadAgentConfig(targetHome(process.env.SUDO_USER));
    if (callerConfig) return callerConfig;
  }
  return loadAgentConfig();
}

export async function installService(options = {}) {
  if (spawnSync('systemctl', ['--version'], { stdio: 'ignore' }).status !== 0) {
    console.log('未检测到 systemd，跳过服务安装；可使用 pi-agent run 前台运行。');
    return;
  }
  const config = loadServiceConfig();
  if (!config) {
    console.log('缺少客户端配置，请先运行 pi-agent setup');
    return;
  }
  if (process.getuid?.() !== 0) {
    console.log(`写入 ${UNIT_PATH} 需要 root，请使用 sudo pi-agent install-service${options.user ? ` --user ${options.user}` : ''}`);
    return;
  }
  try {
    const user = options.user || ensureRootTarget();
    if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) throw new Error('运行用户格式不合法');
    const home = targetHome(user);
    fs.writeFileSync(UNIT_PATH, unitContent(config, user, home), { mode: 0o600 });
    fs.chmodSync(UNIT_PATH, 0o600);
    const reload = systemctl(['daemon-reload']);
    if (reload.status !== 0) {
      console.log('systemctl daemon-reload 失败；unit 已写入，请手动重新加载。');
      return;
    }
    const enable = systemctl(['enable', '--now', 'pi-agent.service']);
    if (enable.status !== 0) {
      console.log('systemctl enable --now 失败；unit 已写入，请检查 systemd 日志。');
      return;
    }
    console.log(`已安装并启动 ${UNIT_PATH}（User=${user}）`);
  } catch (error) {
    console.log(`无法安装 systemd 服务：${error.message}`);
  }
}

export async function uninstallService() {
  if (spawnSync('systemctl', ['--version'], { stdio: 'ignore' }).status !== 0) {
    console.log('未检测到 systemd，跳过服务卸载。');
    return;
  }
  if (process.getuid?.() !== 0) {
    console.log(`删除 ${UNIT_PATH} 需要 root，请使用 sudo pi-agent uninstall-service`);
    return;
  }
  try {
    const disable = systemctl(['disable', '--now', 'pi-agent.service']);
    if (disable.status !== 0) console.log('systemctl disable --now 未成功，继续删除 unit。');
    fs.rmSync(UNIT_PATH, { force: true });
    const reload = systemctl(['daemon-reload']);
    if (reload.status !== 0) {
      console.log('unit 已删除，但 systemctl daemon-reload 失败；请手动重新加载。');
      return;
    }
    console.log(`已卸载 ${UNIT_PATH}`);
  } catch (error) {
    console.log(`无法卸载 systemd 服务：${error.message}`);
  }
}
