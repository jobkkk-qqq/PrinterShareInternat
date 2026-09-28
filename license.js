'use strict';
/*
 * 注册授权模块 —— 与 PDFconvertAdd 通用
 *
 * 三要素刻意与 PDFconvertAdd 保持逐字节一致，改动任何一个都会让两个程序发出的
 * 注册码互不通用：
 *   1) 注册码前缀  PDF
 *   2) 签名密钥    DEVELOPER_SECRET
 *   3) 机器码算法  组件顺序 CPU->BOARD->MAC->HDD，SHA256 取前 16 位十六进制
 *
 * 注册码格式（四段）：
 *   PDF - XXXXXXXX - NNNN - YYYYYYYY
 *          │          │       └─ HMAC-SHA256(密钥, "PDF-{前缀}-{序列号}") 前 8 位
 *          │          └─ 序列号（4 位数字）= "第几次授权"，续期就是把它 +1
 *          └─ 机器码前 8 位（绑定机器）
 *
 * 序列号是这里唯一能区分"新旧注册码"的变量：同一台机器每次续期都要用更大的
 * 序列号，因此每次拿到的注册码都不同，旧码也无法被再次拿来注册。
 *
 * 配额规则（本程序特有，与 PDFconvertAdd 的 20 份/授权不同）：
 *   - 未注册：白送 TRIAL_LIMIT 次
 *   - 已注册：每次授权 LICENSE_LIMIT 次，用满必须凭新注册码续期
 *   - 只有"确认打印成功"才扣次数（失败/卡纸不扣）
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const PS = 'powershell';
const PS_OPTS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const MACHINECODE_PS1 = path.join(__dirname, 'machinecode.ps1');

// ---- 与 PDFconvertAdd 对齐的常量（改动即失去通用性）----
const LICENSE_PREFIX = 'PDF';
const DEVELOPER_SECRET = 'PDFConverter2026_SecretKey_v1.0';

// ---- 本程序的配额（可独立调整，不影响通用性）----
// 支持环境变量覆盖：自动化测试要构造"刚好用满"的场景
const TRIAL_LIMIT = Number(process.env.PRINTSHARE_TRIAL_LIMIT) || 20;    // 未注册时的免费试用次数
const LICENSE_LIMIT = Number(process.env.PRINTSHARE_LICENSE_LIMIT) || 500; // 每次注册授权可打印的份数

const MACHINE_RE = /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/;
const LICENSE_RE = /^PDF-([A-F0-9]{8})-(\d{4})-([A-F0-9]{8})$/;

function sha256Upper(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase();
}

function signatureOf(machinePrefix, serial) {
  const msg = `${LICENSE_PREFIX}-${machinePrefix}-${String(serial).padStart(4, '0')}`;
  return crypto.createHmac('sha256', Buffer.from(DEVELOPER_SECRET, 'utf8'))
    .update(msg, 'utf8').digest('hex').toUpperCase().slice(0, 8);
}

function machinePrefixOf(machineCode) {
  return String(machineCode || '').trim().toUpperCase().replace(/-/g, '').slice(0, 8);
}

// ---------- 机器码 ----------
// 纯函数，便于离线单测：给定硬件组件算出机器码。
// 严格对齐 get_machine_code.py 的 generate_machine_code()：
//   - 组件按 CPU/BOARD/MAC/HDD 顺序加入，带前缀，以 "|" 连接
//   - 一个组件都没有时退化为 FALLBACK:<主机名>
//   - SHA256 -> 大写十六进制 -> 取前 16 位 -> 每 4 位一组拼 XXXX-XXXX-XXXX-XXXX
function composeMachineCode(parts, hostname) {
  const p = parts || {};
  const components = [];
  if (p.cpu) components.push(`CPU:${p.cpu}`);
  if (p.board) components.push(`BOARD:${p.board}`);
  if (p.mac) components.push(`MAC:${p.mac}`);
  if (p.hdd) components.push(`HDD:${p.hdd}`);
  if (!components.length) components.push(`FALLBACK:${hostname || os.hostname()}`);
  const body = sha256Upper(components.join('|')).slice(0, 16);
  const code = [body.slice(0, 4), body.slice(4, 8), body.slice(8, 12), body.slice(12, 16)].join('-');
  return { code, components };
}

// 读取硬件组件（实际查询在 machinecode.ps1，保持与 Python 端同源）
async function readHardwareParts() {
  const { stdout } = await execFileP(
    PS,
    PS_OPTS.concat(['-File', MACHINECODE_PS1]),
    { maxBuffer: 1e6, timeout: 30000 }
  );
  const parts = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^(CPU|BOARD|MAC|HDD):(.+)$/.exec(line.trim());
    if (m) parts[m[1].toLowerCase()] = m[2].trim();
  }
  return parts;
}

// 进程内缓存：机器码在一次运行里不会变，避免每次请求都起 PowerShell
let machineCodeCache = null;

async function getMachineCode() {
  if (machineCodeCache) return machineCodeCache;
  if (process.env.DRYRUN === '1') {
    // 测试环境不起 PowerShell：用固定组件算出一个稳定的机器码
    const r = composeMachineCode({ board: 'TEST_BOARD', mac: '00:11:22:33:44:55' }, 'testhost');
    machineCodeCache = { code: r.code, components: r.components, parts: { board: 'TEST_BOARD', mac: '00:11:22:33:44:55' } };
    return machineCodeCache;
  }
  try {
    const parts = await readHardwareParts();
    const r = composeMachineCode(parts);
    machineCodeCache = { code: r.code, components: r.components, parts };
  } catch (e) {
    // 取不到硬件信息也要给出一个确定的值，而不是让整站崩掉
    const r = composeMachineCode({}, os.hostname());
    machineCodeCache = { code: r.code, components: r.components, parts: {}, error: e.message };
  }
  return machineCodeCache;
}

function forgetMachineCode() { machineCodeCache = null; }

// ---------- 注册码 ----------
function parseLicenseCode(code) {
  const m = LICENSE_RE.exec(String(code || '').trim().toUpperCase());
  if (!m) return null;
  return { machinePrefix: m[1], serial: parseInt(m[2], 10), signature: m[3] };
}

// 与 generate_license.py 的 verify_license_code() 等价：
// 用注册码里内嵌的序列号重算校验位，因此天然支持续期（序列号 >= 2）
function verifyLicenseCode(code, machineCode) {
  const parsed = parseLicenseCode(code);
  if (!parsed) return { ok: false, reason: '注册码格式无效（应形如 PDF-XXXXXXXX-0000-XXXXXXXX）' };
  const machine = String(machineCode || '').trim().toUpperCase();
  if (!MACHINE_RE.test(machine)) return { ok: false, reason: '机器码格式无效' };
  if (parsed.serial < 1) return { ok: false, reason: '注册码序列号无效' };
  const prefix = machinePrefixOf(machine);
  if (parsed.machinePrefix !== prefix) return { ok: false, reason: '注册码与本机机器码不匹配（不是这台机器的注册码）' };
  if (parsed.signature !== signatureOf(prefix, parsed.serial)) return { ok: false, reason: '注册码校验失败（校验位不对，可能是伪造或输错）' };
  return { ok: true, serial: parsed.serial };
}

// 开发者发码用；与 generate_license.py 的 generate_license_code() 输出一致
function generateLicenseCode(machineCode, serial) {
  const machine = String(machineCode || '').trim().toUpperCase();
  if (!MACHINE_RE.test(machine)) throw new Error(`无效的机器码格式: ${machineCode}`);
  const prefix = machinePrefixOf(machine);
  return `${LICENSE_PREFIX}-${prefix}-${String(serial).padStart(4, '0')}-${signatureOf(prefix, serial)}`;
}

// ---------- 授权状态（配额） ----------
class LicenseStore {
  constructor(file, machineCode) {
    this.file = file;
    this.machineCode = machineCode;
    this.state = this._load();
  }

  _defaults() {
    return { licenseCode: null, serial: 0, maxSerial: 0, registeredAt: null, used: 0, history: [] };
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const s = Object.assign(this._defaults(), raw);
      if (!Array.isArray(s.history)) s.history = [];
      return s;
    } catch (_) {
      return this._defaults();
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error('[授权] 保存授权状态失败:', e.message);
    }
  }

  // 未注册按试用额度，已注册按每次授权的额度
  allowance() { return this.state.serial ? LICENSE_LIMIT : TRIAL_LIMIT; }

  used() { return this.state.used; }

  canPrint() { return this.state.used < this.allowance(); }

  status() {
    const allowance = this.allowance();
    const used = this.state.used;
    return {
      machineCode: this.machineCode,
      registered: !!this.state.serial,
      trial: !this.state.serial,
      serial: this.state.serial || null,
      maxSerial: this.state.maxSerial || 0,
      licenseCode: this.state.licenseCode,
      registeredAt: this.state.registeredAt,
      used,
      allowance,
      remaining: Math.max(0, allowance - used),
      canPrint: used < allowance,
      trialLimit: TRIAL_LIMIT,
      licenseLimit: LICENSE_LIMIT,
    };
  }

  // 只有"确实打印成功"才调用；失败/卡纸不扣次数
  consume() {
    this.state.used += 1;
    this._save();
    return this.status();
  }

  // 注册 / 续期。序列号必须比本机用过的最大值更大，因此：
  //   - 同一张注册码无法重复使用（"过期后要拿到不一样的注册码"）
  //   - 旧码也不能在续期后回滚使用
  register(code) {
    const normalized = String(code || '').trim().toUpperCase();
    const v = verifyLicenseCode(normalized, this.machineCode);
    if (!v.ok) return { ok: false, reason: v.reason };
    const maxSerial = this.state.maxSerial || 0;
    if (v.serial <= maxSerial) {
      return {
        ok: false,
        reason: maxSerial
          ? `这是第 ${v.serial} 次授权，本机已用到第 ${maxSerial} 次。请使用序列号大于 ${maxSerial} 的新注册码`
          : '这是第 0 次授权，序列号无效。请使用序列号从 0001 开始的新注册码',
      };
    }
    if (this.state.serial) {
      this.state.history.push({
        serial: this.state.serial,
        code: this.state.licenseCode,
        registeredAt: this.state.registeredAt,
        used: this.state.used,
      });
    }
    this.state.licenseCode = normalized;
    this.state.serial = v.serial;
    this.state.maxSerial = v.serial;
    this.state.registeredAt = Date.now();
    this.state.used = 0;
    this._save();
    return { ok: true, serial: v.serial, status: this.status() };
  }
}

module.exports = {
  LICENSE_PREFIX,
  DEVELOPER_SECRET,
  TRIAL_LIMIT,
  LICENSE_LIMIT,
  MACHINE_RE,
  LICENSE_RE,
  composeMachineCode,
  getMachineCode,
  forgetMachineCode,
  parseLicenseCode,
  verifyLicenseCode,
  generateLicenseCode,
  LicenseStore,
};
