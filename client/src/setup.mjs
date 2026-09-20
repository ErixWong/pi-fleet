import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const AGENT_CONFIG_DIR = path.join(os.homedir(), '.config', 'pi-agent');
export const AGENT_CONFIG_PATH = path.join(AGENT_CONFIG_DIR, 'config.json');
const PI_AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');
const PI_MCP_PATH = path.join(PI_AGENT_DIR, 'mcp.json');
const PI_MCP_BACKUP_PATH = path.join(PI_AGENT_DIR, 'mcp.json.bak-pi-agent');

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

let sharedRl = null;
const pendingAsks = new Set();

function getRl() {
  if (sharedRl) return sharedRl;
  sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  sharedRl.on('close', () => {
    for (const handler of [...pendingAsks]) handler('');
    pendingAsks.clear();
  });
  return sharedRl;
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
          if (char === '\u007f') value = value.slice(0, -1);
          else if (char >= ' ') value += char;
        }
      };
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', onData);
    });
  }
  if (sharedRl?.closed) return defaultValue;
  const rl = getRl();
  return new Promise((resolve) => {
    const handler = (raw) => {
      pendingAsks.delete(handler);
      resolve(raw || defaultValue);
    };
    pendingAsks.add(handler);
    rl.question(`${question}${suffix}：`, handler);
  });
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

export function loadAgentConfig(home = os.homedir()) {
  const configPath = path.join(home, '.config', 'pi-agent', 'config.json');
  if (!fs.existsSync(configPath)) return null;
  const config = readObject(configPath);
  if (!config.url || !config.key) return null;
  return {
    url: normalizeUrl(config.url),
    key: String(config.key),
  };
}

/**
 * Configure the key issued by a platform administrator.
 * Registration and principal creation happen on the platform, not on the client.
 */
export async function runSetup(options = {}) {
  const url = normalizeUrl(
    options.url ?? await ask('平台地址', process.env.PLATFORM_URL || 'http://127.0.0.1:3000'),
  );
  const key = String(options.key ?? await ask('Agent key（不回显）')).trim();
  if (!key) throw new Error('agent key 不能为空');
  if (/[\r\n]/.test(key)) throw new Error('agent key 不能包含换行符');

  fs.mkdirSync(PI_AGENT_DIR, { recursive: true, mode: 0o700 });
  let mcp = {};
  if (fs.existsSync(PI_MCP_PATH)) {
    fs.copyFileSync(PI_MCP_PATH, PI_MCP_BACKUP_PATH);
    fs.chmodSync(PI_MCP_BACKUP_PATH, 0o600);
    mcp = readObject(PI_MCP_PATH);
  }
  if (!mcp.mcpServers) mcp.mcpServers = {};
  if (
    typeof mcp.mcpServers !== 'object'
    || Array.isArray(mcp.mcpServers)
  ) {
    throw new Error('已有 mcp.json 的 mcpServers 不是对象');
  }
  const oldServer = mcp.mcpServers['task-dispatch'];
  mcp.mcpServers['task-dispatch'] = {
    ...(oldServer && typeof oldServer === 'object' && !Array.isArray(oldServer) ? oldServer : {}),
    type: 'http',
    url: `${url}/mcp2`,
    auth: 'bearer',
    bearerToken: key,
    lifecycle: 'eager',
  };
  writeJsonAtomic(PI_MCP_PATH, mcp);
  console.log(`已写入 ${PI_MCP_PATH}`);

  fs.mkdirSync(AGENT_CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeJsonAtomic(AGENT_CONFIG_PATH, { url, key });
  console.log(`已写入 ${AGENT_CONFIG_PATH}`);
}
