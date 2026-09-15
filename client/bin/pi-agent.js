#!/usr/bin/env node

import { loadAgentConfig } from '../src/setup.mjs';
import { runSetup } from '../src/setup.mjs';
import { installService, uninstallService } from '../src/service.mjs';

const HELP = `用法：pi-agent <子命令> [选项]

子命令：
  setup             写入平台签发的 Agent key 和 pi MCP 配置
  run               前台运行 agent daemon
  install-service   生成并启用 systemd 服务
  uninstall-service 停止并删除 systemd 服务

setup 选项：
  --url <平台地址>  默认 http://127.0.0.1:3000
  --key <agent key>

install-service 选项：
  --user <运行用户> 默认当前用户；root 默认创建/使用 pi-agent
`;

const VALUE_OPTIONS = new Set(['url', 'key', 'user']);

function parseArgs(argv) {
  const [command = '--help', ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    const equal = arg.indexOf('=');
    const name = equal >= 0 ? arg.slice(2, equal) : arg.slice(2);
    if (!VALUE_OPTIONS.has(name)) throw new Error(`未知选项：--${name}`);
    const value = equal >= 0 ? arg.slice(equal + 1) : rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} 缺少参数`);
    options[name] = value;
  }
  return { command, options };
}

async function run() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.help || command === '--help' || command === 'help') {
    console.log(HELP);
    return;
  }
  if (command === 'setup') {
    await runSetup(options);
    return;
  }
  if (command === 'run') {
    const config = loadAgentConfig();
    const url = config?.url || process.env.PLATFORM_URL;
    const key = config?.key || process.env.PI_AGENT_KEY;
    if (!url || !key) {
      console.error('缺少客户端配置，请先运行 pi-agent setup');
      process.exitCode = 1;
      return;
    }
    process.env.PLATFORM_URL ||= url;
    process.env.PI_AGENT_KEY ||= key;
    await import('../src/agent-daemon.mjs');
    return;
  }
  if (command === 'install-service') {
    await installService(options);
    return;
  }
  if (command === 'uninstall-service') {
    await uninstallService();
    return;
  }
  throw new Error(`未知子命令：${command}`);
}

run().catch((error) => {
  console.error(`执行失败：${error.message}`);
  process.exitCode = 1;
});
