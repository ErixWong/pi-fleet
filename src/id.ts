import crypto from 'crypto';

// 无混淆字符集：去掉 0/o、1/i/l（LLM 抄写 ID 时看错是真实故障源）
const SAFE_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';
const BASE = SAFE_CHARS.length;
const TS_WIDTH = 9;

function timestampPart(ms: number): string {
  let out = '';
  let value = ms;
  for (let i = 0; i < TS_WIDTH; i += 1) {
    out = SAFE_CHARS[value % BASE] + out;
    value = Math.floor(value / BASE);
  }
  return out;
}

let lastMs = 0;
let lastDigits: number[] = [];

function randomDigits(length: number): number[] {
  return [...crypto.randomBytes(length)].map((b) => b % BASE);
}

function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    if (digits[i] < BASE - 1) {
      digits[i] += 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

export function newID(length = 16): string {
  const len = Math.max(length, 10);
  const tsLen = len > 15 ? TS_WIDTH : 0;
  const randLen = len - tsLen;
  const now = Date.now();

  if (now <= lastMs && lastDigits.length === randLen) {
    if (!increment(lastDigits)) lastDigits = randomDigits(randLen);
  } else {
    lastMs = now;
    lastDigits = randomDigits(randLen);
  }

  const rand = lastDigits.map((digit) => SAFE_CHARS[digit]).join('');
  if (tsLen === 0) return rand.substring(0, len);
  return (timestampPart(lastMs) + rand).substring(0, len);
}

export function newId(prefix: string, length = 16): string {
  return `${prefix}_${newID(length)}`;
}
