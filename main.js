'use strict';

// Electron 主进程：作为系统托盘外壳运行打印共享服务
// - require('./server.js') 直接运行原有的打印服务(9100) + 管理页(8081)
// - 托盘右键菜单：打开管理页、查看/复制服务器IP、暂停/继续队列、清空已完成、退出

const { app, Tray, Menu, nativeImage, shell, clipboard } = require('electron');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 8081;
const ADMIN_URL = `http://localhost:${ADMIN_PORT}`;

// 开机自启动：直接写 HKCU 的 Run 键，值为固定的 "PrintShare"。
// 便携版运行时会解压到临时目录，process.execPath 指向临时路径，无法用于开机自启，
// 因此改用 electron-builder 注入的 PORTABLE_EXECUTABLE_FILE 拿到原始 exe 真身。
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'PrintShare';

function startupExe() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

async function startupEnabled() {
  try {
    const { stdout } = await execFileP('reg', ['query', RUN_KEY, '/v', RUN_VALUE]);
    return stdout.trim().length > 0;
  } catch (_) { return false; }
}

async function setStartup(enable) {
  try {
    if (enable) {
      await execFileP('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${startupExe()}"`, '/f']);
    } else {
      await execFileP('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    }
    return true;
  } catch (_) { return false; }
}

// 启动打印服务（server.js 启动即开始监听，并处理队列）
require('./server.js');

let tray = null;

// 局域网 IPv4 列表
function localIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && a.address !== '127.0.0.1') out.push(a.address);
    }
  }
  return out.length ? out : ['127.0.0.1'];
}

// 轻量 JSON 请求，用于托盘菜单调用管理接口
function api(method, urlPath, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: 'localhost', port: ADMIN_PORT, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (data) req.write(data);
    req.end();
  });
}

function refreshMenu() {
  api('GET', '/api/status').then(async (st) => {
    if (!tray) return;
    const paused = !!(st && st.paused);
    const ips = localIPs();
    const startup = await startupEnabled();
    const template = [
      { label: '打开管理页', click: () => shell.openExternal(ADMIN_URL) },
      { type: 'separator' },
      { label: `服务端口：9100 / 管理端口：${ADMIN_PORT}`, enabled: false },
      { label: '服务器IP（点击复制）', enabled: false },
      ...ips.map((ip) => ({ label: '  ' + ip, click: () => clipboard.writeText(ip) })),
      { type: 'separator' },
      { label: '开机自启动', type: 'checkbox', checked: startup, click: async () => { await setStartup(!startup); refreshMenu(); } },
      { label: paused ? '继续队列' : '暂停队列', click: async () => { await api('POST', '/api/pause', { paused: !paused }); refreshMenu(); } },
      { label: '清空已完成', click: async () => { await api('POST', '/api/clear-done'); } },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(`打印机共享（${paused ? '已暂停' : '运行中'}）`);
  });
}

app.whenReady().then(() => {
  const iconPath = path.join(__dirname, 'tray-icon.png');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) img = nativeImage.createEmpty();

  tray = new Tray(img);
  tray.on('click', () => shell.openExternal(ADMIN_URL)); // 单击打开管理页
  tray.on('double-click', () => shell.openExternal(ADMIN_URL));
  refreshMenu();

  const ip = localIPs()[0];
  tray.displayBalloon({
    title: '打印机共享已启动',
    content: `管理页：${ADMIN_URL}   服务器IP：${ip}。右键托盘图标可快速管理。`,
  });
});

app.on('before-quit', () => { app.isQuitting = true; });
// 无窗口时保持常驻在系统托盘，不退出
app.on('window-all-closed', () => { });