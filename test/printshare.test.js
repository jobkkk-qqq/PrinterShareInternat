'use strict';
/*
 * npm test —— 零依赖回归测试（Node 内置 test runner + DRYRUN 模式）
 *
 * 覆盖三块最容易被改坏的地方：
 *   1) 生成客户端安装脚本：纯 ASCII、行尾统一 \r\n、注入值收敛、goto 标签成对
 *   2) 队列：TCP 入队 → 串行投递 → 完成；取消；未选打印机时不丢件
 *   3) 清空已完成：只删被清掉那批任务的数据文件，绝不动排队/打印中的任务
 * 另外验证作业语言前导的剥离、以及管理页写接口的跨站防护。
 *
 * 全程跑在 DRYRUN=1 + 独立临时数据目录（PRINTSHARE_DATA_DIR）里：
 * 不碰真实打印机、不起 PowerShell、不会读写项目里的 queue/ 与 config.json。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'printshare-test-'));
let srv = null;
let RAW_PORT = 0;
let ADMIN_PORT = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ADMIN_PORT, path: urlPath, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* 非 JSON 响应，保持 null */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const api = (method, urlPath, obj) => request(method, urlPath, {
  body: obj === undefined ? undefined : JSON.stringify(obj),
  headers: { 'Content-Type': 'application/json' },
});
const status = async () => (await api('GET', '/api/status')).json;

function sendJob(buf) {
  return new Promise((resolve) => {
    const s = net.connect(RAW_PORT, '127.0.0.1', () => s.end(buf));
    s.on('close', resolve);
    s.on('error', resolve);
  });
}

// 发一个任务并等到它出现在队列里、且满足条件（靠"新出现的 id"认领，不依赖 seq 连续）
async function enqueueJob(buf, pred, what) {
  const before = await status();
  const seen = new Set(before.queue.map((j) => j.id));
  await sendJob(buf);
  const st = await waitFor((q) => q.some((j) => !seen.has(j.id) && pred(j)), what);
  return st.queue.find((j) => !seen.has(j.id));
}

async function waitFor(pred, what, ms = 20000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await status();
    if (last && Array.isArray(last.queue) && pred(last.queue)) return last;
    await sleep(150);
  }
  const seen = ((last && last.queue) || []).map((j) => `#${j.seq}:${j.status}`).join(' ');
  throw new Error(`等待超时（${what}），当前队列：${seen || '(空)'}`);
}

before(async () => {
  RAW_PORT = await freePort();
  ADMIN_PORT = await freePort();
  process.env.DRYRUN = '1';
  process.env.PRINTSHARE_DATA_DIR = DATA_DIR;
  process.env.RAW_PORT = String(RAW_PORT);
  process.env.ADMIN_PORT = String(ADMIN_PORT);
  // 预置目标打印机：DRYRUN 下"投递"会立刻成功，用来造 done 任务
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'),
    JSON.stringify({ printer: '__TestPrinter__', stripLang: false }));
  srv = require('../server.js');
  await waitFor(() => true, '管理页就绪');
});

after(async () => {
  // 先让 pump 把手上的任务送完再拆环境，避免测试日志里出现"文件已删"的噪音
  try {
    await api('POST', '/api/pause', { paused: true });
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const st = await status();
      if (!st.queue.some((j) => j.status === 'printing')) break;
      await sleep(100);
    }
  } catch (_) { /* 服务已停，忽略 */ }
  try { srv.tcpServer.close(); } catch (_) { /* 已关闭 */ }
  try { srv.adminServer.close(); } catch (_) { /* 已关闭 */ }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---------- 1. 客户端安装脚本 ----------

test('生成安装脚本：纯 ASCII + 行尾统一 CRLF', () => {
  const { bat } = srv.buildClientScript('192.168.1.50', 9100, 'HP LaserJet MFP M227-M231 PCL-6');
  assert.ok(bat.startsWith('@echo off\r\n'), '脚本应以 @echo off 开头');
  assert.equal(/\r\r\n/.test(bat), false, '不能出现 CR CR LF（Windows 检出 + replace(\\n) 的经典错误）');
  assert.equal(/(^|[^\r])\n/.test(bat), false, '不能出现裸 LF');
  assert.equal(/[^\x00-\x7F]/.test(bat), false, '脚本必须是纯 ASCII（中文批处理在 Win7 会闪退）');
  assert.ok(bat.includes('set "_HOST=192.168.1.50"\r\n'), '应注入服务器 IP');
  assert.ok(bat.includes('set "_PORT=9100"\r\n'), '应注入端口');
  assert.ok(bat.includes('set "_DRV=HP LaserJet MFP M227-M231 PCL-6"\r\n'), '应注入驱动型号名');
});

test('生成安装脚本：注入值收敛为 ASCII，引号与 % 不进入脚本', () => {
  const { bat } = srv.buildClientScript('192.168.1.50', 9100, 'M227fdw 财务 "引号" 100%');
  const drvLine = bat.split('\r\n').find((l) => l.startsWith('set "_DRV='));
  assert.equal(drvLine, 'set "_DRV=M227fdw 100"', '中文/引号/% 都要被剥掉，只留可打印 ASCII');
  assert.equal(/[^\x00-\x7F]/.test(bat), false);
  assert.ok(bat.includes('reduced to ASCII'), '驱动名被裁剪过时要留下核对提示');
});

test('生成安装脚本：每个 goto 都有对应标签', () => {
  const { bat } = srv.buildClientScript('10.0.0.9', 9100, 'Generic PCL6');
  const labels = new Set([...bat.matchAll(/^:([A-Za-z0-9_]+)/gm)].map((m) => m[1].toLowerCase()));
  const gotos = [...bat.matchAll(/goto :([A-Za-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
  assert.ok(gotos.length > 0, '脚本应有跳转逻辑');
  for (const g of gotos) assert.ok(labels.has(g), `goto :${g} 没有对应标签`);
});

// ---------- 2. 作业语言前导 ----------

test('作业语言前导：识别并只剥离 UEL/@PJL/@EJL 前导，正文不动', () => {
  const UEL = Buffer.from([0x1b, 0x25, 0x2d, 0x31, 0x32, 0x33, 0x34, 0x35, 0x58]);
  const body = Buffer.from([0x1b, 0x45, 0x41, 0x42, 0x43, 0x44]); // ESC E + 正文

  const pjlJob = Buffer.concat([UEL, Buffer.from('@PJL SET TEST=1\r\n'), body, UEL]);
  const flags = srv.scanJobLanguage(pjlJob.slice(0, 64));
  assert.equal(flags.uel, true, '应识别 UEL');
  assert.equal(flags.pjl, true, '应识别 @PJL');
  const r = srv.stripJobLanguage(pjlJob);
  assert.equal(r.removed, UEL.length * 2 + '@PJL SET TEST=1\r\n'.length);
  assert.deepEqual([...r.buf], [...body], '剥离后应原样剩下正文');

  const ejlJob = Buffer.concat([Buffer.from([0x1b, 0x01]), Buffer.from('@EJL 1284.4\r\n'), body]);
  const r2 = srv.stripJobLanguage(ejlJob);
  assert.deepEqual([...r2.buf], [...body], 'EJL 打包模式前导应被剥掉');

  assert.equal(srv.stripJobLanguage(body), null, '没有前导时不改动作业');
});

// ---------- 3. 队列 ----------

test('队列：TCP 入队后串行投递并完成', async () => {
  const before = await status();
  assert.equal(before.paused, false, '初始不应是暂停状态');
  const payload = Buffer.from('PCL-JOB-1\n' + 'A'.repeat(200));
  const job = await enqueueJob(payload, (j) => j.status === 'done', '任务完成');
  assert.equal(job.bytes, payload.length, '字节数应与客户端发送一致');
  assert.equal(job.printer, '__TestPrinter__', '应投递到配置的打印机');
  assert.equal(fs.existsSync(job.file), true, '已完成任务的数据文件此时仍在磁盘上');
});

test('清空已完成：只删已清掉任务的数据文件，排队任务的文件必须保留', async () => {
  await api('POST', '/api/pause', { paused: true }); // 暂停，保证新任务留在排队
  const queuedJob = await enqueueJob(Buffer.from('PCL-JOB-2\n' + 'B'.repeat(200)), (j) => j.status === 'queued', '任务进入排队');
  const st = await status();

  const done = st.queue.filter((j) => j.status === 'done');
  const queued = st.queue.filter((j) => j.status === 'queued');
  assert.ok(done.length >= 1, '应至少有一个已完成任务');
  assert.ok(queued.length >= 1, '应至少有一个排队任务');
  assert.ok(queued.some((j) => j.id === queuedJob.id), '新任务应在排队列表里');

  const res = await api('POST', '/api/clear-done');
  assert.equal(res.status, 200);
  assert.equal(res.json.removed, done.length, '应返回被清掉的条数');
  await sleep(300);

  for (const j of done) {
    assert.equal(fs.existsSync(j.file), false, `已完成任务#${j.seq} 的数据文件应被删除`);
  }
  for (const j of queued) {
    assert.equal(fs.existsSync(j.file), true, `排队任务#${j.seq} 的数据文件被误删（清空删错对象的经典 bug）`);
  }
  const after = await status();
  assert.equal(after.queue.length, queued.length, '清空后队列里应只剩未完成的任务');
  assert.ok(after.queue.every((j) => j.status === 'queued'), '剩下的必须仍是排队任务');
});

test('取消排队任务：状态置为 cancelled 并删除数据文件', async () => {
  const job = await enqueueJob(Buffer.from('PCL-JOB-CANCEL'), (j) => j.status === 'queued', '任务进入排队');

  const res = await api('POST', `/api/jobs/${job.id}/cancel`);
  assert.equal(res.status, 200);
  await sleep(300);
  const after = await status();
  const cancelled = after.queue.find((j) => j.id === job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(fs.existsSync(job.file), false, '取消后数据文件应被删除');
});

test('管理页写接口：拒绝表单跨站提交与异站 Origin', async () => {
  const form = await request('POST', '/api/clear-done', {
    body: '', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(form.status, 415, '表单/纯文本跨站提交应被拒绝');

  const cross = await request('POST', '/api/clear-done', {
    body: '{}', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
  });
  assert.equal(cross.status, 403, '异站 Origin 应被拒绝');

  const same = await request('POST', '/api/clear-done', {
    body: '{}', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${ADMIN_PORT}` },
  });
  assert.equal(same.status, 200, '本机管理页的请求应正常放行');
});

// 放在最后：这一步会把"目标打印机"清空并恢复队列运行
test('未选打印机：任务保持排队等待，不判失败、不丢件', async () => {
  await api('POST', '/api/printer', { name: null });
  await api('POST', '/api/pause', { paused: false });
  const payload = Buffer.from('PCL-JOB-NOPRINTER\n' + 'C'.repeat(100));
  const job = await enqueueJob(payload, () => true, '任务入队');
  await sleep(800); // 给 pump 足够机会走到"没有打印机"这一支
  const current = (await status()).queue.find((j) => j.id === job.id);
  assert.ok(current, '任务不应从队列里消失');
  assert.equal(current.status, 'queued', '未设置打印机时应保持排队等待，而不是标记失败');
  assert.equal(current.printer, null);
  assert.equal(fs.existsSync(current.file), true, '任务数据文件必须保留，选好打印机后还能继续打');
});
