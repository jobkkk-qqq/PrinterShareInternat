'use strict';
/*
 * 开发者发码工具（生成注册码）—— Ed25519 签名版
 *
 * 只有这个工具需要**私钥**：它从仓库之外读取，不随程序分发。
 * 主程序（license.js）里只有公钥，只能验签，所以即使程序被公开也造不出码。
 *
 * 注册码与 PDFconvertAdd 通用：同一把私钥 / 同一把公钥 / 同一种格式，
 * 两个项目都能验证通过（已用真实机器码交叉验证过）。
 *
 * 用法：
 *   node gen-license.js <机器码>               生成序列号 1 的注册码
 *   node gen-license.js <机器码> 3             生成序列号 3 的注册码
 *   node gen-license.js <机器码> --count 5     连续生成序列号 1..5（续期发码用）
 *   node gen-license.js                        交互模式（可直接粘贴机器码）
 *
 * 私钥查找顺序（第一个存在的即用）：
 *   1. 环境变量 LICENSE_PRIVATE_KEY 指定的文件
 *   2. <仓库根>/license-private-key.json
 *   3. <仓库根>/../license-keys/license-private-key.json
 *   4. ~/.license-keys/private-key.json
 * 密钥文件可以是 { "privateSeedHex": "..." } 形式的 JSON、含 privateKeyPem 的 JSON，
 * 也可以是一行 64 位十六进制的私钥种子。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { LICENSE_PREFIX, MACHINE_RE, LICENSE_LIMIT, TRIAL_LIMIT } = require('./license.js');

// 裸 32 字节私钥种子前面要补的 PKCS8(DER) 头
const PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// 容错：允许用户粘 "56BA91C4AD569ACA" 这种不带连字符的形式
function normalizeMachineCode(input) {
  const s = String(input || '').trim().toUpperCase();
  if (MACHINE_RE.test(s)) return s;
  const hex = s.replace(/[^0-9A-F]/g, '');
  if (hex.length === 16) {
    return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12, 16)].join('-');
  }
  return s;
}

function candidateKeyPaths() {
  const repoRoot = __dirname;
  const cands = [];
  if (process.env.LICENSE_PRIVATE_KEY) cands.push(process.env.LICENSE_PRIVATE_KEY);
  cands.push(path.join(repoRoot, 'license-private-key.json'));
  cands.push(path.join(path.dirname(repoRoot), 'license-keys', 'license-private-key.json'));
  cands.push(path.join(os.homedir(), '.license-keys', 'private-key.json'));
  return cands;
}

function loadPrivateKey(explicitPath) {
  const cands = explicitPath ? [explicitPath] : candidateKeyPaths();
  for (const p of cands) {
    if (!p || !fs.existsSync(p)) continue;
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8').trim();
    } catch (_) {
      continue;
    }
    try {
      if (raw.startsWith('{')) {
        const j = JSON.parse(raw);
        if (j.privateKeyPem) return crypto.createPrivateKey(j.privateKeyPem);
        if (j.privateSeedHex) {
          const seed = Buffer.from(j.privateSeedHex.trim(), 'hex');
          if (seed.length === 32) {
            return crypto.createPrivateKey({
              key: Buffer.concat([PKCS8_SEED_PREFIX, seed]),
              format: 'der',
              type: 'pkcs8',
            });
          }
        }
      } else if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        const seed = Buffer.from(raw, 'hex');
        return crypto.createPrivateKey({
          key: Buffer.concat([PKCS8_SEED_PREFIX, seed]),
          format: 'der',
          type: 'pkcs8',
        });
      }
    } catch (_) {
      // 换下一个候选
    }
  }
  throw new Error(
    '找不到私钥。请把私钥文件放到下列任一位置，或用环境变量指定：\n' +
    '  - 环境变量 LICENSE_PRIVATE_KEY=<私钥文件路径>\n' +
    '  - <仓库根>/license-private-key.json\n' +
    '  - <仓库根>/../license-keys/license-private-key.json\n' +
    '  - ~/.license-keys/private-key.json'
  );
}

function generateLicenseCode(machineCode, serial, privateKey) {
  if (!MACHINE_RE.test(String(machineCode || '').trim().toUpperCase())) {
    throw new Error(`无效的机器码格式: ${machineCode}`);
  }
  const n = Number(serial);
  if (!Number.isInteger(n) || n < 1 || n > 9999) {
    throw new Error('序列号必须是 1..9999 之间的整数');
  }
  const key = privateKey || loadPrivateKey();
  const prefix = String(machineCode).trim().toUpperCase().replace(/-/g, '').slice(0, 8);
  const serialStr = String(n).padStart(4, '0');
  const msg = Buffer.from(`${LICENSE_PREFIX}-${prefix}-${serialStr}`, 'utf8');
  const sig = crypto.sign(null, msg, key);
  return `${LICENSE_PREFIX}-${prefix}-${serialStr}-${base32Encode(sig)}`;
}

function printOne(machineCode, serial, key) {
  let code;
  try {
    code = generateLicenseCode(machineCode, serial, key);
  } catch (e) {
    console.error(`错误: ${e.message}`);
    return false;
  }
  console.log('='.repeat(60));
  console.log(`机器码:  ${machineCode}`);
  console.log(`序列号:  ${serial}`);
  console.log(`注册码长度: ${code.length} 字符`);
  console.log('='.repeat(60));
  console.log('注册码:');
  console.log(`  ${code}`);
  console.log('='.repeat(60));
  console.log('请把整串**完整复制**给用户（不要手输）。');
  return true;
}

function usage() {
  console.log('用法:');
  console.log('  node gen-license.js <机器码> [序列号]');
  console.log('  node gen-license.js <机器码> --count <个数>');
  console.log('  node gen-license.js                 # 交互模式');
  console.log('');
  console.log(`本程序配额：试用 ${TRIAL_LIMIT} 份；每次注册授权 ${LICENSE_LIMIT} 份。`);
  console.log('续期：同一个机器码用"更大的序列号"重新发一张，旧码不可重复使用。');
}

function interactive(machineCodeArg) {
  let key;
  try {
    key = loadPrivateKey();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  (async () => {
    console.log('='.repeat(60));
    console.log('PrintShare 注册码生成工具（Ed25519 / 交互模式）');
    console.log('='.repeat(60));
    for (;;) {
      const raw = machineCodeArg || (await ask('请输入机器码（直接回车退出）: '));
      machineCodeArg = null;
      const machineCode = normalizeMachineCode(raw);
      if (!machineCode) { console.log('已退出。'); break; }
      if (!MACHINE_RE.test(machineCode)) {
        console.log(`  机器码格式无效：${machineCode || '(空)'}（应为 XXXX-XXXX-XXXX-XXXX）`);
        continue;
      }
      const serialStr = (await ask('请输入序列号（默认 1，续期请填比上次更大的数字）: ')).trim();
      const serial = parseInt(serialStr || '1', 10);
      console.log('');
      printOne(machineCode, Number.isFinite(serial) && serial >= 1 ? serial : 1, key);
      console.log('');
    }
    rl.close();
  })();
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) return interactive(null);

  const machineCode = normalizeMachineCode(argv[0]);
  if (!MACHINE_RE.test(machineCode)) {
    console.error(`错误: 机器码格式无效: ${argv[0]}`);
    return usage();
  }

  let key;
  try {
    key = loadPrivateKey();
  } catch (e) {
    console.error(`错误: ${e.message}`);
    process.exit(1);
  }

  const ci = argv.indexOf('--count');
  if (ci >= 0) {
    const n = parseInt(argv[ci + 1], 10);
    if (!Number.isFinite(n) || n < 1 || n > 9999) {
      console.error('错误: --count 需要一个 1..9999 的数字');
      return usage();
    }
    for (let s = 1; s <= n; s++) printOne(machineCode, s, key);
    return;
  }

  const serial = argv.length > 1 ? parseInt(argv[1], 10) : 1;
  if (!Number.isFinite(serial) || serial < 1) {
    console.error('错误: 序列号必须是大于等于 1 的整数');
    return usage();
  }
  printOne(machineCode, serial, key);
}

// 只有直接运行本文件时才走 CLI；被 require（例如测试）时不执行
if (require.main === module) main();

module.exports = { generateLicenseCode, loadPrivateKey, base32Encode };
