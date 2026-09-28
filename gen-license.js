'use strict';
/*
 * 开发者发码工具（生成注册码）
 *
 * 注册码与 PDFconvertAdd 通用：同一个机器码 + 同一套算法，两个程序都能验证通过。
 * 所以既可以用本脚本发码，也可以用 PDFconvertAdd 的 licensing/scripts/generate_license.py，
 * 输出完全一致。
 *
 * 用法：
 *   node gen-license.js <机器码>               生成序列号 1 的注册码
 *   node gen-license.js <机器码> 3             生成序列号 3 的注册码
 *   node gen-license.js <机器码> --count 5     连续生成序列号 1..5（续期发码用）
 *   node gen-license.js                        交互模式（可直接粘贴机器码）
 *
 * 机器码从管理页"注册授权"卡片复制；也允许粘不带连字符的 16 位十六进制，会自动补连字符。
 */

const readline = require('readline');
const { generateLicenseCode, MACHINE_RE, LICENSE_LIMIT, TRIAL_LIMIT } = require('./license.js');

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

function printOne(machineCode, serial) {
  let code;
  try {
    code = generateLicenseCode(machineCode, serial);
  } catch (e) {
    console.error(`错误: ${e.message}`);
    return false;
  }
  console.log('='.repeat(60));
  console.log(`机器码:  ${machineCode}`);
  console.log(`序列号:  ${serial}`);
  console.log(`注册码:  ${code}`);
  console.log('='.repeat(60));
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  (async () => {
    console.log('='.repeat(60));
    console.log('PrintShare 注册码生成工具（交互模式）');
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
      const serialStr = (await ask('请输入序列号（默认 1）: ')).trim();
      const serial = parseInt(serialStr || '1', 10);
      if (!Number.isFinite(serial) || serial < 1) { console.log('  序列号无效，已用 1。'); }
      console.log('');
      printOne(machineCode, Number.isFinite(serial) && serial >= 1 ? serial : 1);
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

  // --count N：连续发 N 张（序列号 1..N），方便一次备好续期用的码
  const ci = argv.indexOf('--count');
  if (ci >= 0) {
    const n = parseInt(argv[ci + 1], 10);
    if (!Number.isFinite(n) || n < 1 || n > 9999) {
      console.error('错误: --count 需要一个 1..9999 的数字');
      return usage();
    }
    for (let s = 1; s <= n; s++) printOne(machineCode, s);
    return;
  }

  const serial = argv.length > 1 ? parseInt(argv[1], 10) : 1;
  if (!Number.isFinite(serial) || serial < 1) {
    console.error('错误: 序列号必须是大于等于 1 的整数');
    return usage();
  }
  printOne(machineCode, serial);
}

main();
