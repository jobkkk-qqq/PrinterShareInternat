'use strict';

// 原始 TCP 打印转发服务（印刷队列版）
// 客户端通过 "Standard TCP/IP 端口" (主机IP:9100) 发送打印字节流。
// 每个任务 = 一条 TCP 连接，数据流式写入磁盘队列；单 worker 串行投递给
// Windows spooler（WinSpool，PowerShell P/Invoke，零原生依赖）。
// 管理页提供队列可视化：排队/打印中/已完成、取消、暂停、优先级、全局暂停，
// 重启后自动恢复尚未完成的任务。

const net = require('net');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const DRYRUN = process.env.DRYRUN === '1'; // 测试用：只走队列流程，不真投 lp 弹窗
const PS = 'powershell';
const PS_OPTS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const WINSPOOL = path.join(__dirname, 'winspool.ps1');

// PowerShell 在没有控制台时（打包版 GUI 正常运行即如此）用 OEM 代码页写 stdout，
// Node 按 UTF-8 读取，中文打印机名会变成 U+FFFD 乱码（"M227fdw 财务" -> "M227fdw ���"）。
// 乱码名会连带毁掉打印目标与驱动型号查询，所以每条要读文本的 -Command 都先强制 UTF-8 输出。
const PS_UTF8 = 'try{[Console]::OutputEncoding=[Text.Encoding]::UTF8}catch{}; ';
function psCmd(cmd) { return PS_UTF8 + cmd; }

// 便携版 exe 每次启动都会解压到临时目录，__dirname 随之变化，
// 队列与配置若写在 __dirname 下会每次重启就丢。因此打包运行时改放 %APPDATA%\PrintShare；
// 源码方式运行（npm start / npm run electron / 测试）仍用项目目录，行为不变。
const PACKAGED = !!(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE);
const DATA_ROOT = PACKAGED
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PrintShare')
  : __dirname;

const QUEUE_DIR = path.join(DATA_ROOT, 'queue');
const META_FILE = path.join(QUEUE_DIR, 'meta.json');

const CONFIG = {
  rawPort: Number(process.env.RAW_PORT) || 9100,
  adminPort: Number(process.env.ADMIN_PORT) || 8081,
  configFile: path.join(DATA_ROOT, 'config.json'),
};

// ---------- 状态 ----------
let targetPrinter = null;
let globalPaused = false;
let stripLang = false; // 是否在转发前剥离作业语言前导（PJL/EJL/UEL），默认关闭
let jobs = []; // 任务数组（内存中的元数据，数据本体在磁盘）
let seq = 0;
let pumping = false;

// ---------- 防火墙自动放行（单文件部署免手动配置） ----------
// 检测放行规则是否存在，缺失时弹一次 UAC 授权自动添加，保证客户端 9100 / 管理页端口可被局域网访问。
function firewallRuleMissing(name) {
  return new Promise((resolve) => {
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`], (err) => resolve(!!err));
  });
}

async function ensureFirewall() {
  if (DRYRUN) return; // 测试模式不弹 UAC
  const rules = [
    { name: 'PrintShare 9100', port: CONFIG.rawPort },
    { name: `PrintShare Admin ${CONFIG.adminPort}`, port: CONFIG.adminPort },
  ];
  const missing = [];
  for (const r of rules) if (await firewallRuleMissing(r.name)) missing.push(r);
  if (!missing.length) return; // 都已放行
  // 缺失 -> 写一个 ASCII 临时脚本，通过 UAC 提权子进程添加
  const ps1 = path.join(os.tmpdir(), `PrintShare-firewall-${process.pid}.ps1`);
  try {
    fs.writeFileSync(ps1, missing.map((r) => `netsh advfirewall firewall add rule name="${r.name}" dir=in action=allow protocol=TCP localport=${r.port}`).join('\r\n'), 'utf8');
  } catch (_) { return; }
  const elevated = `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}'`;
  execFile(PS, ['-NoProfile', '-Command', elevated], () => {
    setTimeout(() => fs.unlink(ps1, () => {}), 10000); // 稍后清理临时脚本
  });
  console.log('[防火墙] 检测到 TCP 放行规则缺失，已请求管理员授权自动添加...');
}

function ensureDirs() { fs.mkdirSync(QUEUE_DIR, { recursive: true }); }

function loadState() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG.configFile, 'utf8'));
    targetPrinter = c.printer || null;
    stripLang = !!c.stripLang;
  } catch (_) { /* 首次运行 */ }
  try {
    const m = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    jobs = Array.isArray(m.jobs) ? m.jobs : [];
    globalPaused = !!m.paused;
    seq = m.seq || 0;
    // 重启后没有"正在打印"的任务，统一回到排队中等待重新投递
    jobs.forEach((j) => { if (j.status === 'printing') { j.status = 'queued'; j.startedAt = null; } });
  } catch (_) { jobs = []; }
}

function persist() {
  try {
    fs.writeFileSync(META_FILE, JSON.stringify({ jobs, seq, paused: globalPaused }, null, 2));
  } catch (e) { console.error('保存队列元数据失败:', e.message); }
}

function persistConfig() {
  try {
    fs.writeFileSync(CONFIG.configFile, JSON.stringify({ printer: targetPrinter, stripLang }, null, 2));
  } catch (e) { console.error('保存配置失败:', e.message); }
}

async function listPrinters() {
  try {
    const { stdout } = await execFileP(PS, PS_OPTS.concat(['-Command', psCmd('Get-Printer | ForEach-Object { $_.Name }')]), { maxBuffer: 1e6 });
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}
async function defaultPrinter() {
  try {
    const { stdout } = await execFileP(PS, PS_OPTS.concat(['-Command', psCmd('(Get-CimInstance Win32_Printer -Filter "Default=$true").Name')]), { maxBuffer: 1e6 });
    return stdout.trim() || null;
  } catch (_) { return null; }
}

// 打印机列表/默认打印机带 TTL 缓存：管理页刷新绝不等子进程，避免慢/阻塞
let printerCache = null;
let printerCacheAt = 0;
let defCache = null;
let defCacheAt = 0;
const CACHE_TTL = 8000;
async function cachedPrinters() {
  const now = Date.now();
  if (printerCache && now - printerCacheAt < CACHE_TTL) return printerCache;
  const p = await listPrinters();
  if (p) { printerCache = p; printerCacheAt = now; }
  return printerCache || [];
}
async function cachedDefaultPrinter() {
  const now = Date.now();
  if (defCache && now - defCacheAt < CACHE_TTL) return defCache;
  const d = await defaultPrinter();
  if (d != null) { defCache = d; defCacheAt = now; }
  return defCache;
}

// 队列名 -> 驱动型号名（Win32_Printer.DriverName）。
// 客户端脚本里 `prnmngr.vbs -m` 需要的是"驱动型号名"，不是队列名：
//   队列名可以随意改成中文（"M227fdw 财务"），驱动型号名是安装驱动时写死的，
//   实际都是 ASCII（"HP LaserJet MFP M227-M231 PCL-6"）。
// 传队列名会导致 -m 匹配不到驱动而安装失败；中文队列名还会让 .bat 变成非 ASCII，
// 在 Win7 cmd 下解析错乱甚至闪退。用队列名作参数，靠 env 传递避免引号/编码问题。
const drvModelCache = new Map();
async function printerDriverModel(queueName) {
  if (!queueName) return null;
  if (drvModelCache.has(queueName)) return drvModelCache.get(queueName);
  let model = null;
  try {
    const { stdout } = await execFileP(
      PS,
      PS_OPTS.concat(['-Command', psCmd('(Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $env:_Q } | Select-Object -First 1).DriverName')]),
      { maxBuffer: 1e6, env: Object.assign({}, process.env, { _Q: queueName }) }
    );
    model = stdout.trim() || null;
  } catch (_) { model = null; }
  if (model) drvModelCache.set(queueName, model);
  return model;
}

// 生成的 .bat 必须纯 ASCII：非 ASCII 字节在 Win7 的 cmd 下会解析错乱甚至闪退
//（UTF-8 中文批处理 + chcp 65001 是已知的崩溃组合）。这里把所有注入值收敛到
// 可打印 ASCII，并去掉会破坏 `set "X=..."` 的引号与 %（% 会被当变量展开），
// 保证任何 Windows 任何代码页下解析一致。
function asciiOnly(s) {
  return String(s == null ? '' : s)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["%]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- 任务队列 ----------
function nextJob() {
  return jobs
    .filter((j) => j.status === 'queued' && !j.paused)
    .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt))[0] || null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runWinspool(job) {
  try {
    const { stderr } = await execFileP(
      PS,
      PS_OPTS.concat(['-File', WINSPOOL, '-PrinterName', job.printer, '-DataFile', job.file]),
      { maxBuffer: 1e7, timeout: 120000 }
    );
    return { ok: true, err: stderr ? stderr.trim() : '' };
  } catch (e) {
    return { ok: false, err: String((e.stderr || e.message || e)).trim() };
  }
}

// 转发前剥离作业语言前导（仅在管理页开启该开关时执行）
function applyStrip(job) {
  try {
    const buf = fs.readFileSync(job.file);
    const r = stripJobLanguage(buf);
    if (!r) return;
    const tmp = `${job.file}.tmp`;
    fs.writeFileSync(tmp, r.buf);
    fs.renameSync(tmp, job.file);
    job.bytes = r.buf.length;
    job.stripped = r.removed;
    console.log(`[协商] 任务#${job.seq} 已剥离 ${r.removed} 字节作业语言前导（${buf.length} -> ${r.buf.length} 字节）`);
  } catch (e) {
    console.error(`[协商] 任务#${job.seq} 剥离失败，按原样投递：`, e.message);
  }
}

async function deliver(job) {
  if (stripLang && langFlags(job.lang).length) applyStrip(job);
  if (DRYRUN) { await sleep(1200); return { ok: true, err: '' }; }       // 测试：模拟投递耗时
  return runWinspool(job);
}

// 单 worker 串行泵：同一时刻只送一个任务给 spooler
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (!globalPaused) {
      const job = nextJob();
      if (!job) break;

      if (!job.printer) job.printer = targetPrinter || (await defaultPrinter());
      if (!job.printer) {
        job.status = 'failed'; job.error = '未设置共享打印机'; job.finishedAt = Date.now();
        persist(); console.error(`[队列] 任务#${job.seq} 失败：未设置打印机`);
        continue;
      }

      job.status = 'printing'; job.startedAt = Date.now(); persist();
      console.log(`[队列] 打印中 任务#${job.seq} -> ${job.printer}（${job.bytes} 字节）`);
      const r = await deliver(job);
      job.finishedAt = Date.now();
      job.status = r.ok ? 'done' : 'failed';
      job.error = r.ok ? (r.err || null) : r.err;
      persist();
      console.log(`[队列] 完成   任务#${job.seq} -> ${job.status}`);
    }
  } finally {
    pumping = false;
  }
}

// ---------- TCP 打印端口 ----------
function enqueue(socket) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const fromAddr = socket.remoteAddress || '(未知)';
  const ingest = path.join(QUEUE_DIR, `${id}.ing`); // 接收中临时文件，随数据增长
  const finalFile = path.join(QUEUE_DIR, `${id}.pcl`);
  const w = fs.createWriteStream(ingest);
  let received = 0;
  let closed = false;
  let head = Buffer.alloc(0); // 只保留开头一小段，用于识别作业语言前导

  socket.on('data', (c) => {
    if (closed) return;
    received += c.length;
    if (head.length < HEAD_SCAN) head = Buffer.concat([head, c.slice(0, HEAD_SCAN - head.length)]);
    w.write(c); // 流式写盘，不占用内存缓冲
  });
  socket.on('error', (e) => { console.error('TCP 错误:', e.message); closed = true; w.destroy(); fs.unlink(ingest, () => {}); });
  socket.on('end', () => {
    if (closed) return;
    closed = true;
    w.end(() => {
      if (received === 0) { fs.unlink(ingest, () => {}); return; }
      try { fs.renameSync(ingest, finalFile); } catch (e) { console.error('改文件名失败:', e.message); return; }
      const lang = scanJobLanguage(head);
      const job = {
        id, seq: ++seq, from: fromAddr,
        printer: targetPrinter || null, bytes: received,
        status: 'queued', priority: 0, paused: false,
        createdAt: Date.now(), startedAt: null, finishedAt: null, error: null, file: finalFile,
        lang, stripped: 0,
      };
      jobs.push(job); persist();
      console.log(`[入队] 任务#${job.seq} 来自 ${job.from}（${received} 字节）`);
      const flags = langFlags(lang);
      if (flags.length) {
        console.warn(`[协商] 任务#${job.seq} 检测到作业语言前导：${flags.join(' + ').toUpperCase()}` +
          `（目标打印机 ${job.printer || '未设置'}，品牌 ${brandOf(job.printer)}）`);
        console.warn(`[协商] 纸面若出现乱码，请在客户端驱动侧关闭对应开关；` +
          `或在管理页开启"剥离作业语言前导"由主机自动剥离。`);
      }
      pump();
    });
  });
}

const tcpServer = net.createServer(enqueue);
tcpServer.listen(CONFIG.rawPort, () => console.log(`[打印] 0.0.0.0:${CONFIG.rawPort}  客户端请用 主机IP:${CONFIG.rawPort}`));
tcpServer.on('error', (e) => { console.error(`无法监听 ${CONFIG.rawPort}：`, e.message); process.exit(1); });

// ---------- 管理页 / API ----------
function sendJson(res, obj, code) { res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

// 本机 IPv4 列表，供生成客户端脚本时选用（优先私有网段 IP，避免首选到 Tailscale/VPN/虚拟网卡）
function isPrivateLan(ip) {
  const p = (ip || '').split('.').map(Number);
  if (p.length !== 4) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}
function serverIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && a.address !== '127.0.0.1') out.push(a.address);
    }
  }
  const lan = out.filter(isPrivateLan);
  const rest = out.filter((ip) => !isPrivateLan(ip)); // 含 Tailscale(100.64/10)/VPN/虚拟网卡
  const all = [...lan, ...rest];
  return all.length ? [...new Set(all)] : ['127.0.0.1'];
}

// 首选"服务器该被局域网客户端访问的 IP"：取默认路由所在网卡的 IPv4（真实 WLAN/以太网），带缓存
let preferredCache = null;
let preferredAt = 0;
async function preferredHostIP() {
  const now = Date.now();
  if (preferredCache && now - preferredAt < 15000) return preferredCache;
  let best = null;
  try {
    const cmd = `$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1; if ($r) { (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $r.ifIndex -ErrorAction SilentlyContinue | Where-Object { $_.Address -notlike '169.254*' } | Select-Object -First 1).IPAddress }`;
    const { stdout } = await execFileP(PS, PS_OPTS.concat(['-Command', psCmd(cmd)]), { maxBuffer: 1e6 });
    best = (stdout.match(/\d+\.\d+\.\d+\.\d+/) || [])[0] || null;
  } catch (_) { best = null; }
  if (!best || best === '0.0.0.0') best = serverIPs()[0] || null;
  if (best) { preferredCache = best; preferredAt = now; }
  return best;
}

// ---------- 驱动 ↔ 打印机协商：作业语言前导 ----------
// 现象：驱动经 TCP/IP 端口打印时，会在作业开头插入一段"作业语言"同步/协商命令。
//   打印机不支持（或该模式被关）时，这段命令不会被识别，而是被当正文原样打印出来，
//   纸面出现乱码、正文被下移、版式与本地打印不一致。
//   - 爱普生 LQ 针式：EJL（`@EJL` / `ESC 01 @EJL 1284.4`），纸面表现为 "284.4@EJL"。
//     官方解法是驱动"打包模式(Packet mode)"设为关（爱普生 FAQ 310058）。
//   - HP：PJL 包在 UEL（ESC%-12345X）之间；HP PJL 手册说明，非 PJL 打印机会把这些
//     命令在 PCL 复位(ESC E)之前按 ASCII 文本打印出来，即纸面出现 `@PJL`。
//   - 佳能：官方把"打印乱码"归因为驱动选错型号；CAPT 为宿主型驱动，依赖佳能专有
//     数据流，跨 TCP/IP 转发时应优先改用 PCL/PS 或 UFR II 驱动。
const UEL = Buffer.from([0x1b, 0x25, 0x2d, 0x31, 0x32, 0x33, 0x34, 0x35, 0x58]); // ESC % - 1 2 3 4 5 X
const HEAD_SCAN = 4096; // 只扫作业开头这么多字节

function brandOf(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('epson') || s.includes('爱普生')) return 'epson';
  if (s.includes('hewlett') || s.includes('惠普') || /\bhp\b/.test(s) || s.includes('laserjet') || s.includes('deskjet')) return 'hp';
  if (s.includes('canon') || s.includes('佳能')) return 'canon';
  return 'generic';
}

const BRAND_TIPS = {
  epson: [
    'Symptom: garbage text at the top of the page (e.g. "284.4@EJL") and the body',
    'is pushed down, so the layout differs from printing locally.',
    'Cause: the driver sends an EJL "Packet mode" sync command first; a printer',
    'that does not support it (or has Packet mode off) prints it as plain text.',
    'Fix: on the CLIENT PC open this printer\'s "Printer properties" ->',
    '"Device settings" -> set "Packet mode" to "Off". If the driver has no such',
    'option, set the printer\'s own default "Packet mode" to "Auto".',
    'Reference: Epson FAQ 310058.',
  ],
  hp: [
    'Symptom: control text such as "@PJL" printed on paper.',
    'Cause: the driver wraps the job in PJL between UEL (ESC%-12345X) markers;',
    'a printer without PJL support prints those commands as ASCII text.',
    'Fix: use the driver that matches this exact model, set the printer',
    'language / "Personality" to "Auto", and prefer a PCL5/PCL6 or PostScript',
    'driver (HP universal drivers do not support host-based devices).',
    'Reference: HP PJL Technical Reference Manual.',
  ],
  canon: [
    'Symptom: garbled text or a wrong layout.',
    'Canon attributes garbled output to the wrong driver being selected: make',
    'sure the driver installed matches this exact model. CAPT drivers are',
    'host-based and rely on a Canon proprietary data stream, so for printing',
    'through a raw TCP/IP port prefer a PCL/PS or UFR II driver.',
  ],
  generic: [
    'Symptom: control text such as "284.4@EJL" (Epson) or "@PJL" (HP) printed',
    'on paper, with the body pushed down.',
    'Cause: the client driver is sending a job-language handshake that the',
    'printer does not understand, so it is printed as plain text.',
    'Fix: Epson -> "Device settings" -> "Packet mode" = Off;',
    '     HP     -> printer language / "Personality" = "Auto", use PCL/PS driver;',
    '     Canon  -> install the driver matching this exact model.',
  ],
};

function tipBlock(driver) {
  const brand = brandOf(driver);
  const label = brand === 'generic' ? 'general' : brand.toUpperCase();
  return [`--- Driver/printer negotiation tips (${label}) ---`]
    .concat(BRAND_TIPS[brand])
    .concat([
      'Common to all brands: on the CLIENT PC, "Printer properties" -> "Ports" ->',
      'clear "Enable bidirectional support" - this relay is one-way, so status',
      'queries can only make printing stall.',
    ])
    .map((l) => `REM  ${l}`)
    .join('\n');
}

// 扫描作业开头，判断是否含作业语言前导（返回命中的标志位）
function scanJobLanguage(head) {
  if (!head || !head.length) return { uel: false, pjl: false, ejl: false };
  const txt = head.toString('latin1');
  return {
    uel: head.indexOf(UEL) >= 0,
    pjl: txt.includes('@PJL'),
    ejl: txt.includes('@EJL'),
  };
}

function langFlags(lang) {
  return ['uel', 'pjl', 'ejl'].filter((k) => lang && lang[k]);
}

// 只剥离作业开头的 UEL / @PJL / @EJL 前导块与结尾 UEL，不动正文；返回剥离掉的字节数
function stripJobLanguage(buf) {
  let i = 0;
  for (;;) {
    if (buf.length - i >= UEL.length && buf.compare(UEL, 0, UEL.length, i, i + UEL.length) === 0) {
      i += UEL.length; continue;
    }
    // 爱普生打包模式前缀 ESC 01，仅在紧跟 @EJL 时剥离
    if (buf[i] === 0x1b && buf[i + 1] === 0x01 && buf.toString('latin1', i + 2, i + 6) === '@EJL') {
      i += 2; continue;
    }
    let j = i;
    while (j < buf.length && (buf[j] === 0x20 || buf[j] === 0x09 || buf[j] === 0x0d || buf[j] === 0x0a)) j++;
    const tag = buf.toString('latin1', j, j + 4);
    if (tag === '@PJL' || tag === '@EJL') {
      while (j < buf.length && buf[j] !== 0x0a && buf[j] !== 0x0d) j++;
      while (j < buf.length && (buf[j] === 0x0a || buf[j] === 0x0d)) j++;
      i = j; continue;
    }
    break;
  }
  let end = buf.length;
  if (end - i >= UEL.length && buf.compare(UEL, 0, UEL.length, end - UEL.length, end) === 0) end -= UEL.length;
  if (i === 0 && end === buf.length) return null;
  return { buf: buf.slice(i, end), removed: buf.length - (end - i) };
}

// 生成客户端一键安装脚本：安装共享打印机.bat —— 纯 Batch 单文件、可读可审计
//   （先只读校验、后最小提权修改、失败不破坏原配置），跨 Win7/8/10/11。
// 编码：整个 bat 只用 ASCII（英文提示），不用 chcp/UTF-8 —— UTF-8 中文批处理在
//   Win7 的 chcp 65001 下会解析错乱闪退，部分 Win10 配置也会丢失中文，纯 ASCII
//   在任何 Windows 上解析一致。
// 安全设计：不用 Base64 隐藏、不自带可执行 ps1（删除 client-install.ps1 相关注释）、
//   用系统内置 prnport.vbs/prnmngr.vbs（cscript）避免 Win8+ 才有的 Get-Printer 依赖、
//   UAC 提权只在真正需要创建/删除打印机时触发、删除前先确认且只动本脚本命名的对象、
//   创建端口前先用 TCP 探测验证目标服务器可达。
function buildClientScript(host, portNum, driver) {
  // 注入到 .bat 的值全部收敛为 ASCII，避免非 ASCII 批处理在 Win7 cmd 下闪退
  const safeHost = asciiOnly(host);
  const safeDriver = asciiOnly(driver);
  const safePort = String(Number(portNum) || 9100);
  const portName = `IP_${safeHost}`;
  // 原始驱动名被裁剪过（含中文等）时，留一行 REM 提示，便于客户机核对/手改
  const drvNote = safeDriver !== String(driver == null ? '' : driver).trim()
    ? ['REM  NOTE: the driver name above was reduced to ASCII. If the [2/4] driver check',
       'REM  fails, edit _DRV to the exact driver model name shown on the client PC by:',
       'REM    wmic printer get name,drivername',
       'REM  (queue names may be localized, but the driver model name is ASCII).',
       ''].join('\r\n')
    : '';

  // 纯 Batch 单文件安装脚本，跨 Windows 7/8/8.1/10/11（32/64 位）。
  // 用系统内置的打印管理脚本（prnport.vbs 管端口、prnmngr.vbs 管打印机），经 cscript 运行，
  // 不依赖 Win8+ 才有的 Get-Printer/Add-Printer cmdlet。
  // 存在性/可达性检查用 WMI(Get-WmiObject) 与 Net.Sockets.TcpClient —— Win7 的 PowerShell 2.0 就具备。
  // 安全：无 Base64、无全局 ExecutionPolicy 绕过、提权仅在确需建打印机时触发（自提权重进 elev 分支）、
  //   删除前先询问且只删本脚本命名的对象、创建端口前先验证服务器 TCP 可达。
  const bat = String.raw`@echo off
setlocal EnableExtensions
title Network Printer Installer (Safe Mode)
REM ============================================================
REM  Network printer one-click installer - single file - Windows 7/8/10/11 (32/64 bit)
REM  Uses built-in Windows print scripts: prnport.vbs (port) + prnmngr.vbs (printer),
REM  run via cscript - no dependency on Win8+ only Get-Printer/Add-Printer cmdlets.
REM  Read-only checks first (server reachable, driver present, same-name objects);
REM  admin rights requested ONLY when actually creating/deleting the printer;
REM  only touches objects created by this script.
REM  This file is pure ASCII text - open it in Notepad to review the
REM  server IP / driver below before running. (ASCII: no chcp/codepage issues
REM  on any Windows, unlike UTF-8 batch files that break on Win7 cmd.)
REM
${tipBlock(safeDriver)}
REM ============================================================

REM ===== Configuration (generated by print server - verify/edit below) =====
set "_HOST=${safeHost}"
set "_PORT=${safePort}"
set "_DRV=${safeDriver}"
set "_PORTN=${portName}"
set "_PNAME=SharedPrinter (%_HOST%)"
set "_DRVF=${safeDriver},"
${drvNote}
set "_PP=%WinDir%\System32\Printing_Admin_Scripts\zh-CN\prnport.vbs"
if not exist "%_PP%" set "_PP=%WinDir%\System32\Printing_Admin_Scripts\en-US\prnport.vbs"
set "_PN=%WinDir%\System32\Printing_Admin_Scripts\zh-CN\prnmngr.vbs"
if not exist "%_PN%" set "_PN=%WinDir%\System32\Printing_Admin_Scripts\en-US\prnmngr.vbs"
if not exist "%_PP%" goto :noAdminScript
if not exist "%_PN%" goto :noAdminScript

REM ===== Second run after UAC elevation (arg: elev) goes straight to modification =====
if /i "%~1"=="elev" goto :modify

echo.
echo   ////////////////////////////////////////////
echo   //  Network Printer Installer (Safe Mode) //
echo   ////////////////////////////////////////////
echo   Server       : %_HOST%
echo   Port         : %_PORT%
echo   Driver       : "%_DRV%"
echo   Will create  : %_PNAME%  ^(port %_PORTN%^)
echo.

REM ---- [1/4] Verify server TCP reachable (read-only, no admin needed) ----
echo   [1/4] Checking server %_HOST%:%_PORT% ...
set "_CK=%TEMP%\pschk_rch"
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect($env:_HOST,[int]$env:_PORT);$x=1}catch{$x=0};$c.Close(); if($x){[IO.File]::WriteAllText($env:_CK,'1')}else{[IO.File]::WriteAllText($env:_CK,'0')}"
set "_RCH=0"
set /p _RCH= < "%_CK%"
if "%_RCH%"=="1" goto :reach_ok
echo   Cannot reach %_HOST%:%_PORT%.
echo   Check: is the IP correct? Is the print-server PC on and the service running?
echo   Is the firewall allowing inbound TCP %_PORT%?
set /p "YN=   Continue anyway? y/N "
if /i not "%YN%"=="y" goto :cancel
:reach_ok
echo   OK, server is online.

REM ---- [2/4] Check driver (read-only) ----
echo.
echo   [2/4] Checking printer driver "%_DRV%" ...
set "_CK=%TEMP%\pschk_drv"
powershell -NoProfile -Command "if(@(Get-WmiObject Win32_PrinterDriver | Where-Object { $_.Name.StartsWith($env:_DRVF) }).Count -gt 0){[IO.File]::WriteAllText($env:_CK,'1')}else{[IO.File]::WriteAllText($env:_CK,'0')}"
set "_HD=0"
set /p _HD= < "%_CK%"
if "%_HD%"=="1" goto :drv_ok
echo   Driver not installed: "%_DRV%"
echo   Drivers installed on this PC:
powershell -NoProfile -Command "Get-WmiObject Win32_PrinterDriver | ForEach-Object { Write-Host ('      - ' + $_.Name) }"
echo   Install the matching vendor driver for this model, then run this script again.
pause
exit /b 4
:drv_ok
echo   Driver is ready.

REM ---- [3/4] Check for same-name objects created before (read-only) ----
echo.
set "_CK=%TEMP%\pschk_prt"
set "_PE=0"
powershell -NoProfile -Command "if(@(Get-WmiObject Win32_TCPIPPrinterPort | Where-Object { $_.Name -eq $env:_PORTN }).Count -gt 0){[IO.File]::WriteAllText($env:_CK,'1')}else{[IO.File]::WriteAllText($env:_CK,'0')}"
set /p _PE= < "%_CK%"
set "_CK=%TEMP%\pschk_ptr"
set "_PR=0"
powershell -NoProfile -Command "if(@(Get-WmiObject Win32_Printer | Where-Object { $_.Name -eq $env:_PNAME }).Count -gt 0){[IO.File]::WriteAllText($env:_CK,'1')}else{[IO.File]::WriteAllText($env:_CK,'0')}"
set /p _PR= < "%_CK%"
set "_HIT=0"
if "%_PE%"=="1" set "_HIT=1"
if "%_PR%"=="1" set "_HIT=1"
if not "%_HIT%"=="1" goto :fresh
echo   [3/4] Found objects installed by this script before:
if "%_PR%"=="1" echo          - printer %_PNAME%
if "%_PE%"=="1" echo          - port   %_PORTN%
set /p "YN=         Delete and recreate them? Other printers/ports are untouched. Continue? y/N "
if /i not "%YN%"=="y" goto :cancelKeep
echo         Confirmed overwrite.
goto :chkdone
:fresh
echo   [3/4] No same-name old objects found; treating as fresh install.
:chkdone

REM ---- [4/4] Request admin rights only when the printer must be modified ----
echo.
net session >nul 2>&1
if "%errorlevel%"=="0" goto :haveAdmin
echo   Creating/deleting ports or printers requires administrator rights. Requesting now ...
powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '""%~f0"" elev' -Verb RunAs"
echo   Elevation requested - this window can be closed.
pause
exit /b 0
:haveAdmin
echo   Running with administrator rights; configuring ...
goto :modify

:modify
echo.
echo   [elevated] Creating/updating the printer (read-only checks already done) ...
REM after elevation this is a fresh cmd session - re-check same-name objects
set "_CK=%TEMP%\pschk_prt"
set "_PE=0"
powershell -NoProfile -Command "if(@(Get-WmiObject Win32_TCPIPPrinterPort | Where-Object { $_.Name -eq $env:_PORTN }).Count -gt 0){[IO.File]::WriteAllText($env:_CK,'1')}else{[IO.File]::WriteAllText($env:_CK,'0')}"
set /p _PE= < "%_CK%"
set "_CK=%TEMP%\pschk_ptr"
set "_PR=0"
powershell -NoProfile -Command "if(@(Get-WmiObject Win32_Printer | Where-Object { $_.Name -eq $env:_PNAME }).Count -gt 0){[IO.File]::WriteAllText($env:_CK,'1')}else{[IO.File]::WriteAllText($env:_CK,'0')}"
set /p _PR= < "%_CK%"
if "%_PR%"=="1" goto :delPrn
goto :delPrnNext
:delPrn
echo   Deleting old printer %_PNAME% ...
cscript //Nologo "%_PN%" -d -p "%_PNAME%"
:delPrnNext
if "%_PE%"=="1" goto :delPrnPort
goto :createPort
:delPrnPort
echo   Deleting old port %_PORTN% ...
cscript //Nologo "%_PP%" -d -r "%_PORTN%"
:createPort
echo   Creating printer port %_PORTN% (%_HOST%:%_PORT%) ...
cscript //Nologo "%_PP%" -a -r "%_PORTN%" -h "%_HOST%" -o raw -n %_PORT%
if errorlevel 1 goto :modifyFail

echo   Creating printer %_PNAME% ...
cscript //Nologo "%_PN%" -a -p "%_PNAME%" -r "%_PORTN%" -m "%_DRV%"
if errorlevel 1 goto :modifyFail

echo.
echo   Done! Printer created: %_PNAME%
echo.
echo   This script does NOT change the default printer. To set it as default:
echo     Settings - Bluetooth ^& devices - Printers ^& scanners - select "%_PNAME%" - "Set as default";
echo     or Control Panel - Devices and Printers - right-click "%_PNAME%" - Set as default printer.
pause
exit /b 0

:cancel
echo   Cancelled - original configuration kept unchanged.
pause
exit /b 3
:cancelKeep
echo   Cancelled - existing configuration kept.
pause
exit /b 5
:noAdminScript
echo   [ERROR] Windows print admin scripts not found (Printing_Admin_Scripts\prnport.vbs etc).
echo   Please make sure this is a full Windows system directory. Press Enter to exit.
pause
exit /b 1
:modifyFail
echo   [FAILED] Printer configuration was not applied. See errors above and retry;
echo   original configuration was preserved as much as possible.
pause
exit /b 1`.replace(/\n/g, '\r\n');

  return { bat, ps1Name: null, batName: '安装共享打印机.bat', ps1: null };
}

// 极简 ZIP 打包（STORE 不压缩，仅用于把客户端安装脚本打成单个可下载包，零依赖）
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  const localChunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    lfh.writeUInt16LE(20, 4);           // 需要版本
    lfh.writeUInt16LE(0x0800, 6);       // 文件名用 UTF-8
    lfh.writeUInt16LE(0, 8);            // 压缩方式=STORE
    lfh.writeUInt16LE(0, 10);           // 修改时间
    lfh.writeUInt16LE(0x21, 12);        // 修改日期(1980-01-01)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);           // 扩展字段长度
    const local = Buffer.concat([lfh, name, data]);
    central.push({ name, crc, size: data.length, headerOffset: offset });
    localChunks.push(local);
    offset += local.length;
  }
  const cdChunks = [];
  let cdSize = 0;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);    // 中央目录头签名
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.size, 20); ch.writeUInt32LE(c.size, 24);
    ch.writeUInt16LE(c.name.length, 28); ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(c.headerOffset, 42);
    const part = Buffer.concat([ch, c.name]);
    cdChunks.push(part); cdSize += part.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);    // 中央目录结束签名
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, Buffer.concat(cdChunks), eocd]);
}

const adminServer = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  const method = req.method;

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }

  if (url === '/api/status' && method === 'GET') {
    const printers = await cachedPrinters();
    let def = await cachedDefaultPrinter();
    if (!def && printers.length) def = printers[0];
    const queue = [...jobs].sort((a, b) => (a.createdAt - b.createdAt));
    const preferredIP = await preferredHostIP();
    return sendJson(res, { rawPort: CONFIG.rawPort, adminPort: CONFIG.adminPort, targetPrinter, defaultPrinter: def, printers, paused: globalPaused, stripLang, serverIPs: serverIPs(), preferredIP, queue });
  }

  if (url === '/api/printer' && method === 'POST') {
    let body = ''; req.on('data', (c) => (body += c));
    return req.on('end', async () => {
      try {
        const { name } = JSON.parse(body);
        if (name) { const printers = await listPrinters(); targetPrinter = printers.includes(name) ? name : targetPrinter; }
        else targetPrinter = null;
        persistConfig();
        printerCache = null; defCacheAt = 0; // 让下次 /api/status 重新枚举
        // 已入队未指定打印机的任务沿用新选择
        jobs.forEach((j) => { if (!j.printer && j.status === 'queued') j.printer = targetPrinter; });
        persist(); pump();
      } catch (_) { /* 保留原设置 */ }
      sendJson(res, { ok: true, printer: targetPrinter });
    });
  }

  if (url === '/api/pause' && method === 'POST') {
    let body = ''; req.on('data', (c) => (body += c));
    return req.on('end', () => {
      try { globalPaused = !!JSON.parse(body).paused; persist(); } catch (_) {}
      pump();
      sendJson(res, { paused: globalPaused });
    });
  }

  if (url === '/api/strip-lang' && method === 'POST') {
    let body = ''; req.on('data', (c) => (body += c));
    return req.on('end', () => {
      try { stripLang = !!JSON.parse(body).stripLang; } catch (_) {}
      persistConfig();
      sendJson(res, { stripLang });
    });
  }

  if (url === '/api/clear-done' && method === 'POST') {
    const finished = ['done', 'failed', 'cancelled'];
    jobs = jobs.filter((j) => !finished.includes(j.status));
    jobs.forEach((j) => fs.unlink(j.file, () => {}));
    persist();
    return sendJson(res, { ok: true });
  }

  const m = url.match(/^\/api\/jobs\/([^/]+)\/(cancel|pause|priority)$/);
  if (m && method === 'POST') {
    const job = jobs.find((j) => j.id === m[1]);
    if (!job) return sendJson(res, { ok: false, reason: '任务不存在' });
    let body = ''; req.on('data', (c) => (body += c));
    return req.on('end', () => {
      if (m[2] === 'cancel') {
        if (job.status === 'printing') return sendJson(res, { ok: false, reason: '正在打印，无法取消' });
        job.status = 'cancelled'; job.finishedAt = Date.now();
        fs.unlink(job.file, () => {});
      } else if (m[2] === 'pause') {
        job.paused = !job.paused;
      } else if (m[2] === 'priority') {
        try { job.priority = Math.max(-9, Math.min(9, parseInt(JSON.parse(body).priority, 10) || 0)); } catch (_) {}
      }
      persist(); pump();
      sendJson(res, { ok: true });
    });
  }

  if ((url === '/api/client-script' || url === '/api/client-package') && method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    let host = q.get('host') || '';
    const queue = q.get('driver') || targetPrinter || (await cachedDefaultPrinter());
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) host = (await preferredHostIP()) || '';
    if (!queue) return sendJson(res, { ok: false, reason: '尚未选择要共享的打印机，请先在上方选择并保存' }, 400);
    // 客户端脚本的 -m 要的是"驱动型号名"而不是队列名（队列名可能是中文，会导致脚本非 ASCII
    // 而在 Win7 闪退，且 -m 匹配不到驱动）。优先用队列名反查 DriverName，查不到才退回队列名。
    const driver = (await printerDriverModel(queue)) || queue;
    if (!host) return sendJson(res, { ok: false, reason: '无法确定服务器 IP' }, 400);
    const { bat, batName } = buildClientScript(host, CONFIG.rawPort, driver);
    if (url === '/api/client-script') {
      return sendJson(res, { ok: true, hostIP: host, port: CONFIG.rawPort, driver, batName, bat });
    }
    // /api/client-package：把单文件安装脚本（bat）打进一个 zip，方便整体拷贝到客户机
    const zip = buildZip([{ name: batName, data: bat }]);
    const fname = encodeURIComponent(`打印客户端安装包_${host}.zip`);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${fname}`,
      'Content-Length': zip.length,
    });
    return res.end(zip);
  }

  res.writeHead(404); res.end('Not Found');
});

adminServer.listen(CONFIG.adminPort, () => console.log(`[管理] http://localhost:${CONFIG.adminPort}`));

// ---------- 启动 ----------
ensureDirs();
loadState();
pump(); // 重启后继续处理队列里未完成的任务
ensureFirewall(); // 自动放行防火墙（首次运行会弹一次 UAC）
if (DRYRUN) console.log('[提示] DRYRUN=1：只走队列流程，不真正打印');

module.exports = { buildClientScript, brandOf, tipBlock, scanJobLanguage, stripJobLanguage, langFlags };