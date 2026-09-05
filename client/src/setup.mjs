import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

export const AGENT_CONFIG_DIR = path.join(os.homedir(), '.config', 'pi-agent');
export const AGENT_CONFIG_PATH = path.join(AGENT_CONFIG_DIR, 'config.json');
const PI_AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');
const PI_MCP_PATH = path.join(PI_AGENT_DIR, 'mcp.json');
const PI_MCP_BACKUP_PATH = path.join(PI_AGENT_DIR, 'mcp.json.bak-pi-agent');
const SUPPORTED_CLIS = new Set(['pi', 'copilot', 'claude', 'codex', 'auto']);

/** 执行器代装命令（平台相关；LLM 订阅/models.json 仍用户自理） */
function installCommandFor(cli) {
  const isWin = process.platform === 'win32';
  switch (cli) {
    case 'pi': return isWin ? 'powershell -c "irm https://pi.dev/install.ps1 | iex"' : 'curl -fsSL https://pi.dev/install.sh | sh';
    case 'copilot': return 'npm install -g @github/copilot';
    case 'claude': return 'npm install -g @anthropic-ai/claude-code';
    case 'codex': return 'npm install -g @openai/codex';
    default: return '';
  }
}

/** 常见 npm/本地 bin 目录（systemd/非登录 shell 的 PATH 常缺 npm 全局目录） */
function extraBinDirs() {
  const dirs = [];
  if (process.platform === 'win32' && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  const home = os.homedir();
  dirs.push(path.join(home, '.npm-global', 'bin'), path.join(home, '.local', 'bin'), path.join(home, 'bin'));
  if (process.env.NVM_BIN) dirs.push(process.env.NVM_BIN);
  return [...new Set(dirs)];
}

/** 探测指定 CLI 是否已安装（PATH + 常见 bin 目录兑底） */
export function hasCli(cli) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [cli], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status === 0) return true;
  for (const dir of extraBinDirs()) {
    const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, cli + ext))) return true;
      } catch { /* 忽略 */ }
    }
  }
  return false;
}

/** 已安装的候选执行器（auto 时选第一个） */
export function detectClis() {
  return [...SUPPORTED_CLIS].filter((cli) => cli !== 'auto' && hasCli(cli));
}

/** 提示 + 可选代装缺失的执行器；拒绝代装只 warn 不阻断（用户可事后自装） */
async function ensureCliInstalled(cli) {
  if (cli === 'auto') {
    const found = detectClis();
    if (found.length === 0) {
      console.log('未检测到任何执行器（pi/copilot/claude/codex）。建议先安装一个，例如：');
      console.log(`  ${INSTALL_HINTS.pi}`);
      console.log('auto 模式下将回退 pi（若之后安装，重启 pi-agent run 即生效）。');
    } else {
      console.log(`已检测到执行器：${found.join('、')}（auto 将优先用 ${found[0]}）`);
    }
    return;
  }
  if (hasCli(cli)) return;
  const installCmd = installCommandFor(cli);
  console.log(`未检测到执行器 ${cli}。安装命令：`);
  console.log(`  ${installCmd || `请参考 ${cli} 官方安装方式`}`);
  if (!installCmd) {
    console.log(`暂不支持自动安装 ${cli}，请手动安装。`);
    return;
  }
  const ans = await ask('是否现在代装？', 'y');
  if (!/^y/i.test(ans)) {
    console.log(`跳过代装。安装 ${cli} 后重新运行 pi-agent setup 或直接 pi-agent run（未安装时任务会兜底报错）。`);
    return;
  }
  console.log(`执行：${installCmd}`);
  const r = spawnSync(installCmd, { stdio: 'inherit', shell: true, cwd: os.homedir() });
  if (r.status !== 0) {
    console.log(`代装失败（exit=${r.status}），请手动安装 ${cli} 后重试。`);
    return;
  }
  console.log(hasCli(cli) ? `✓ ${cli} 已就绪` : `代装完成但未探测到 ${cli}（可能不在 PATH，新开终端/重启 daemon 即生效）。`);
}

function readObject(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${filePath} 顶层结构不是 JSON 对象`);
  }
  return value;
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

async function ask(question, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  if (question.includes('key') && process.stdin.isTTY && process.stdout.isTTY) {
    process.stdout.write(`${question}${suffix}：`);
    return new Promise((resolve, reject) => {
      let value = '';
      const onData = (chunk) => {
        for (const char of String(chunk)) {
          if (char === '\u0003') {
            process.stdin.setRawMode?.(false);
            process.stdin.off('data', onData);
            process.stdin.pause();
            reject(new Error('已取消'));
            return;
          }
          if (char === '\r' || char === '\n') {
            process.stdin.setRawMode?.(false);
            process.stdin.off('data', onData);
            process.stdin.pause();
            process.stdout.write('\n');
            resolve(value || defaultValue);
            return;
          }
          if (char === '\u007f') {
            value = value.slice(0, -1);
          } else if (char >= ' ') {
            value += char;
          }
        }
      };
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', onData);
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(`${question}${suffix}：`, resolve));
  } finally {
    rl.close();
  }
}

function normalizeUrl(value) {
  const url = String(value ?? '').trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('平台地址必须是有效的 http:// 或 https:// 地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('平台地址必须以 http:// 或 https:// 开头');
  }
  return url;
}

function normalizeCli(value) {
  const cli = String(value ?? '').trim().toLowerCase();
  if (!SUPPORTED_CLIS.has(cli)) throw new Error(`执行器必须是 ${[...SUPPORTED_CLIS].join('|')}`);
  return cli;
}

export function loadAgentConfig(home = os.homedir()) {
  const configPath = path.join(home, '.config', 'pi-agent', 'config.json');
  if (!fs.existsSync(configPath)) return null;
  const config = readObject(configPath);
  if (!config.url || !config.key) return null;
  return {
    ...config,
    url: normalizeUrl(config.url),
    key: String(config.key),
    name: String(config.name ?? os.hostname()),
    cli: normalizeCli(config.cli || 'auto'),
  };
}

export async function runSetup(options = {}) {
  const existing = fs.existsSync(AGENT_CONFIG_PATH) ? readObject(AGENT_CONFIG_PATH) : {};
  const url = normalizeUrl(options.url ?? await ask('平台地址', 'http://127.0.0.1:3200'));
  const key = String(options.key ?? await ask('Agent key（不回显）')).trim();
  const name = String(options.name ?? await ask('主机名', os.hostname())).trim() || os.hostname();
  const cli = normalizeCli(options.cli ?? await ask('执行器（pi|copilot|claude|codex|auto）', 'auto'));
  if (!key) throw new Error('agent key 不能为空');
  if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(key)) throw new Error('主机名和 agent key 不能包含换行符');

  // 执行器缺失检测 + 代装提示（不阻断：拒绝代装可后续自装）
  await ensureCliInstalled(cli);

  fs.mkdirSync(PI_AGENT_DIR, { recursive: true, mode: 0o700 });
  let mcp = {};
  if (fs.existsSync(PI_MCP_PATH)) {
    fs.copyFileSync(PI_MCP_PATH, PI_MCP_BACKUP_PATH);
    fs.chmodSync(PI_MCP_BACKUP_PATH, 0o600);
    mcp = readObject(PI_MCP_PATH);
  }
  if (!mcp.mcpServers) mcp.mcpServers = {};
  if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object' || Array.isArray(mcp.mcpServers)) {
    throw new Error('已有 mcp.json 的 mcpServers 不是对象');
  }
  const oldServer = mcp.mcpServers['task-dispatch'];
  mcp.mcpServers['task-dispatch'] = {
    ...(oldServer && typeof oldServer === 'object' && !Array.isArray(oldServer) ? oldServer : {}),
    url: `${url}/mcp`,
    auth: 'bearer',
    bearerToken: key,
    lifecycle: 'lazy',
  };
  writeJsonAtomic(PI_MCP_PATH, mcp);
  console.log(`已写入 ${PI_MCP_PATH}`);
  fs.mkdirSync(AGENT_CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeJsonAtomic(AGENT_CONFIG_PATH, { ...existing, url, key, name, cli });
  console.log(`已写入 ${AGENT_CONFIG_PATH}`);

  const modelsPath = path.join(os.homedir(), '.pi', 'agent', 'models.json');
  if (!fs.existsSync(modelsPath)) {
    console.log('LLM provider 用户自理：请自行配置 ~/.pi/agent/models.json');
  }
}
