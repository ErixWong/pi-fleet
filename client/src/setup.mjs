import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const AGENT_CONFIG_DIR = path.join(os.homedir(), '.config', 'pi-agent');
export const AGENT_CONFIG_PATH = path.join(AGENT_CONFIG_DIR, 'config.json');
const PI_AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');
const PI_MCP_PATH = path.join(PI_AGENT_DIR, 'mcp.json');
const PI_MCP_BACKUP_PATH = path.join(PI_AGENT_DIR, 'mcp.json.bak-pi-agent');
const SUPPORTED_CLIS = new Set(['pi', 'copilot', 'claude', 'codex', 'auto']);

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
