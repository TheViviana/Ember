/**
 * ULID 生成：26 字符 Crockford Base32。
 * 前 10 字符 = 48 位毫秒时间戳，后 16 字符 = 80 位随机数。
 * 同毫秒内随机位单调递增，保证同一毫秒创建的文档仍按创建顺序排序。
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom = '';

const encodeTime = (time: number): string => {
  let remaining = time;
  let out = '';
  for (let i = 0; i < TIME_LEN; i += 1) {
    const mod = remaining % 32;
    out = ENCODING.charAt(mod) + out;
    remaining = (remaining - mod) / 32;
  }
  return out;
};

const decodeTime = (encoded: string): number => {
  let time = 0;
  for (let i = 0; i < TIME_LEN; i += 1) {
    const digit = ENCODING.indexOf(encoded.charAt(i));
    if (digit < 0) return Number.NaN;
    time = time * 32 + digit;
  }
  return time;
};

const randomChars = (length: number): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ENCODING.charAt(byte % 32);
  return out;
};

/** 自右向左 +1，溢出返回 null */
const increment = (chars: string): string | null => {
  const digits = chars.split('');
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const digit = ENCODING.indexOf(digits[i] ?? '');
    if (digit < 0) return null;
    if (digit < 31) {
      digits[i] = ENCODING.charAt(digit + 1);
      return digits.join('');
    }
    digits[i] = '0';
  }
  return null;
};

export const isUlid = (value: string): boolean => ULID_PATTERN.test(value);

/** 生成 ULID；now 参数仅为测试可控，生产不传 */
export const createUlid = (now: number = Date.now()): string => {
  const time = Math.max(Math.trunc(now), lastTime);
  if (time === lastTime && lastRandom !== '') {
    const next = increment(lastRandom);
    if (next !== null) {
      lastRandom = next;
      return encodeTime(time) + next;
    }
    // 同毫秒随机位耗尽：借用下一毫秒，仍然单调
    lastTime = time + 1;
    lastRandom = randomChars(RANDOM_LEN);
    return encodeTime(lastTime) + lastRandom;
  }
  lastTime = time;
  lastRandom = randomChars(RANDOM_LEN);
  return encodeTime(time) + lastRandom;
};

/** ULID 内嵌的毫秒时间戳 */
export const ulidTime = (ulid: string): number => (isUlid(ulid) ? decodeTime(ulid) : Number.NaN);
