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
const QUEUE_DIR = path.join(__dirname, 'queue');
const META_FILE = path.join(QUEUE_DIR, 'meta.json');

const CONFIG = {
  rawPort: Number(process.env.RAW_PORT) || 9100,
  adminPort: Number(process.env.ADMIN_PORT) || 8081,
  configFile: path.join(__dirname, 'config.json'),
};

// ---------- 状态 ----------
let targetPrinter = null;
let globalPaused = false;
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

async function listPrinters() {
  try {
    const { stdout } = await execFileP(PS, PS_OPTS.concat(['-Command', 'Get-Printer | ForEach-Object { $_.Name }']), { maxBuffer: 1e6 });
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}
async function defaultPrinter() {
  try {
    const { stdout } = await execFileP(PS, PS_OPTS.concat(['-Command', '(Get-CimInstance Win32_Printer -Filter "Default=$true").Name']), { maxBuffer: 1e6 });
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

async function deliver(job) {
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

  socket.on('data', (c) => {
    if (closed) return;
    received += c.length;
    w.write(c); // 流式写盘，不占用内存缓冲
  });
  socket.on('error', (e) => { console.error('TCP 错误:', e.message); closed = true; w.destroy(); fs.unlink(ingest, () => {}); });
  socket.on('end', () => {
    if (closed) return;
    closed = true;
    w.end(() => {
      if (received === 0) { fs.unlink(ingest, () => {}); return; }
      try { fs.renameSync(ingest, finalFile); } catch (e) { console.error('改文件名失败:', e.message); return; }
      const job = {
        id, seq: ++seq, from: fromAddr,
        printer: targetPrinter || null, bytes: received,
        status: 'queued', priority: 0, paused: false,
        createdAt: Date.now(), startedAt: null, finishedAt: null, error: null, file: finalFile,
      };
      jobs.push(job); persist();
      console.log(`[入队] 任务#${job.seq} 来自 ${job.from}（${received} 字节）`);
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
    const { stdout } = await execFileP(PS, PS_OPTS.concat(['-Command', cmd]), { maxBuffer: 1e6 });
    best = (stdout.match(/\d+\.\d+\.\d+\.\d+/) || [])[0] || null;
  } catch (_) { best = null; }
  if (!best || best === '0.0.0.0') best = serverIPs()[0] || null;
  if (best) { preferredCache = best; preferredAt = now; }
  return best;
}

// 生成客户端一键安装脚本：安装共享打印机.bat —— 纯 Batch 单文件、可读可审计
//   （先只读校验、后最小提权修改、失败不破坏原配置），跨 Win7/8/10/11。
// 安全设计：不用 Base64 隐藏、不自带可执行 ps1（删除 client-install.ps1 相关注释）、
//   用系统内置 prnport.vbs/prnmngr.vbs（cscript）避免 Win8+ 才有的 Get-Printer 依赖、
//   UAC 提权只在真正需要创建/删除打印机时触发、删除前先确认且只动本脚本命名的对象、
//   创建端口前先用 TCP 探测验证目标服务器可达。
function buildClientScript(host, portNum, driver) {
  const printerName = `共享打印机 (${host})`;

  const portName = `IP_${host}`;

  // 纯 Batch 单文件安装脚本，跨 Windows 7/8/8.1/10/11（32/64 位）。
  // 用系统内置的打印管理脚本（prnport.vbs 管端口、prnmngr.vbs 管打印机），经 cscript 运行，
  // 不依赖 Win8+ 才有的 Get-Printer/Add-Printer cmdlet。
  // 存在性/可达性检查用 WMI(Get-WmiObject) 与 Net.Sockets.TcpClient —— Win7 的 PowerShell 2.0 就具备。
  // 安全：无 Base64、无全局 ExecutionPolicy 绕过、提权仅在确需建打印机时触发（自提权重进 elev 分支）、
  //   删除前先询问且只删本脚本命名的对象、创建端口前先验证服务器 TCP 可达。
  const bat = String.raw`@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 网络打印机安装程序（安全模式）
REM ============================================================
REM  网络打印机一键安装 · 单文件 · 适用 Windows 7/8/10/11(32/64位)
REM  用系统内置打印脚本：prnport.vbs(端口) + prnmngr.vbs(打印机)，
REM  经 cscript 运行，不依赖 Win8+ 才有的 Get-Printer/Add-Printer。
REM  先做只读检查(验证服务器、检查驱动、检查同名对象)，仅在确需
REM  修改打印机时才请求管理员权限；只动"本脚本创建的对象"。
REM  本文件可先用记事本打开，核对下方"配置"的服务器IP/驱动，确认无误再运行。
REM ============================================================

REM ===== 配置（打印服务器自动生成，可核对/修改）=====
set "_HOST=${host}"
set "_PORT=${portNum}"
set "_DRV=${driver}"
set "_PORTN=${portName}"
set "_PNAME=${printerName}"
set "_DRVF=${driver},"

set "_PP=%WinDir%\System32\Printing_Admin_Scripts\zh-CN\prnport.vbs"
if not exist "%_PP%" set "_PP=%WinDir%\System32\Printing_Admin_Scripts\en-US\prnport.vbs"
set "_PN=%WinDir%\System32\Printing_Admin_Scripts\zh-CN\prnmngr.vbs"
if not exist "%_PN%" set "_PN=%WinDir%\System32\Printing_Admin_Scripts\en-US\prnmngr.vbs"
if not exist "%_PP%" goto :noAdminScript
if not exist "%_PN%" goto :noAdminScript

REM ===== 若是提权后的第二趟（带参数 elev），直接进入修改 =====
if /i "%~1"=="elev" goto :modify

echo.
echo   ////////////////////////////////////////////
echo   //  网络打印机安装程序（安全模式）          //
echo   ////////////////////////////////////////////
echo   目标服务器 : %_HOST%
echo   打印端口   : %_PORT%
echo   使用驱动   : %_DRV%
echo   将新建     : %_PNAME%  ^(端口 %_PORTN%^)
echo.

REM ---- [1/4] 验证服务器 TCP 可达（只读，无需管理员）----
echo   [1/4] 验证服务器 %_HOST%:%_PORT% 是否可达 ...
set "_CK=%TEMP%\pschk_rch"
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect($env:_HOST,[int]$env:_PORT);$x=1}catch{$x=0};$c.Close(); if($x){[IO.File]::WriteAllText($env:_CK,'1')}else{[IO.File]::WriteAllText($env:_CK,'0')}"
set "_RCH=0"
set /p _RCH= < "%_CK%"
if "%_RCH%"=="1" goto :reach_ok
echo   无法连接 %_HOST%:%_PORT%。
echo   请检查：IP 是否正确；打印服务器主机是否开机且服务已运行；防火墙是否放行 TCP %_PORT%。
set /p "YN=   仍要继续安装吗？ y/N "
if /i not "%YN%"=="y" goto :cancel
:reach_ok
echo   OK，服务器在线。

REM ---- [2/4] 检查驱动（只读）----
echo.
echo   [2/4] 检查打印机驱动 %_DRV% ...
set "_CK=%TEMP%\pschk_drv"
powershell -NoProfile -Command "if(@(Get-WmiObject Win32_PrinterDriver | Where-Object { $_.Name.StartsWith($env:_DRVF) }).Count -gt 0){[IO.File]::WriteAllText($env:_CK,'1')}else{[IO.File]::WriteAllText($env:_CK,'0')}"
set "_HD=0"
set /p _HD= < "%_CK%"
if "%_HD%"=="1" goto :drv_ok
echo   未安装该驱动：%_DRV%
echo   这台电脑上已安装的驱动：
powershell -NoProfile -Command "Get-WmiObject Win32_PrinterDriver | ForEach-Object { Write-Host ('      - ' + $_.Name) }"
echo   请先安装与该型号匹配的厂商官方驱动，再重跑本脚本。
pause
exit /b 4
:drv_ok
echo   驱动已就绪。

REM ---- [3/4] 检查是否有本脚本之前创建的同名对象（只读）----
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
echo   [3/4] 检测到之前用本脚本安装过的对象：
if "%_PR%"=="1" echo          - 打印机 %_PNAME%
if "%_PE%"=="1" echo          - 端口   %_PORTN%
set /p "YN=         将删除并重建它们。不影响其它打印机/端口，继续？ y/N "
if /i not "%YN%"=="y" goto :cancelKeep
echo         确认覆盖。
goto :chkdone
:fresh
echo   [3/4] 未发现同名旧对象，按全新安装处理。
:chkdone

REM ---- [4/4] 仅在需要修改打印机时才要求管理员权限 ----
echo.
net session >nul 2>&1
if "%errorlevel%"=="0" goto :haveAdmin
echo   创建/删除端口或打印机需要管理员权限，即将请求授权 ...
powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '""%~f0"" elev' -Verb RunAs"
echo   已请求提权重跑（本窗口可关闭）。
pause
exit /b 0
:haveAdmin
echo   已具备管理员权限，开始配置 ...
goto :modify

:modify
echo.
echo   [已提权] 开始创建/更新打印机（只读检查已在普通权限下完成）...
REM 提权后为一次全新 cmd 会话，重新确认同名对象是否存在
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
echo   删除旧打印机 %_PNAME% ...
cscript //Nologo "%_PN%" -d -p "%_PNAME%"
:delPrnNext
if "%_PE%"=="1" goto :delPrnPort
goto :createPort
:delPrnPort
echo   删除旧端口 %_PORTN% ...
cscript //Nologo "%_PP%" -d -r "%_PORTN%"
:createPort
echo   正在创建打印端口 %_PORTN% (%_HOST%:%_PORT%) ...
cscript //Nologo "%_PP%" -a -r "%_PORTN%" -h "%_HOST%" -o raw -n %_PORT%
if errorlevel 1 goto :modifyFail

echo   正在建立打印机 %_PNAME% ...
cscript //Nologo "%_PN%" -a -p "%_PNAME%" -r "%_PORTN%" -m "%_DRV%"
if errorlevel 1 goto :modifyFail

echo.
echo   配置完成！已创建打印机：%_PNAME%
echo.
echo   本脚本不修改默认打印机，如需设为默认请自己操作：
echo     方式1：设置 - 蓝牙和其他设备 - 打印机和扫描仪 - 选中"%_PNAME%" - 点击"设为默认值"；
echo     方式2：控制面板 - 设备和打印机 - 右键"%_PNAME%" - 设为默认打印机。
pause
exit /b 0

:cancel
echo   已取消，保留原配置不变。
pause
exit /b 3
:cancelKeep
echo   已取消，保留现有配置。
pause
exit /b 5
:noAdminScript
echo   [错误] 找不到系统打印管理脚本（Printing_Admin_Scripts\prnport.vbs 等）。
echo   请确认这是完整的 Windows 系统目录。按回车退出。
pause
exit /b 1
:modifyFail
echo   [失败] 打印机配置未成功，请查看上方报错后重试；原配置已尽量保留。
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
    return sendJson(res, { rawPort: CONFIG.rawPort, adminPort: CONFIG.adminPort, targetPrinter, defaultPrinter: def, printers, paused: globalPaused, serverIPs: serverIPs(), preferredIP, queue });
  }

  if (url === '/api/printer' && method === 'POST') {
    let body = ''; req.on('data', (c) => (body += c));
    return req.on('end', async () => {
      try {
        const { name } = JSON.parse(body);
        if (name) { const printers = await listPrinters(); targetPrinter = printers.includes(name) ? name : targetPrinter; }
        else targetPrinter = null;
        fs.writeFileSync(CONFIG.configFile, JSON.stringify({ printer: targetPrinter }, null, 2));
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
    const driver = q.get('driver') || targetPrinter || (await cachedDefaultPrinter());
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) host = (await preferredHostIP()) || '';
    if (!driver) return sendJson(res, { ok: false, reason: '尚未选择要共享的打印机，请先在上方选择并保存' }, 400);
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
console.log('(DRYRUN 测试模式)' );
if (DRYRUN) console.log('[提示] DRYRUN=1：只走队列流程，不真正打印');