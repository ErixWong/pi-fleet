import crypto from 'crypto';

// 无混淆字符集：去掉 0/o、1/i/l（LLM 抄写 ID 时看错是真实故障源）
const SAFE_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';
const CONFUSABLE_MAP: Record<string, string> = {
  '0': '2',
  o: 'p',
  '1': '3',
  i: 'j',
  l: 'm',
};

function toSafeChars(s: string): string {
  let out = '';
  for (const ch of s) out += CONFUSABLE_MAP[ch] || ch;
  return out;
}

export function newID(length = 16): string {
  const len = Math.max(length, 10);
  let value = [...crypto.randomBytes(len)]
    .map((b) => SAFE_CHARS[b % SAFE_CHARS.length])
    .join('');
  if (len > 15) value = toSafeChars(Date.now().toString(36)) + value;
  return value.substring(0, len);
}

export function newId(prefix: string, length = 16): string {
  return `${prefix}_${newID(length)}`;
}
