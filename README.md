<div align="center">

# 🖨️ PrintShare · 打印机共享

**基于 TCP 的局域网打印机共享工具 —— 一台主机共享 USB 打印机，局域网任意电脑轻松使用**

绕过 SMB 打印共享的种种报错（`0x0000011b`、`0x00000709`…），无需第三方打印服务器，
单文件部署、开机自启、Web 队列可视化，一键生成客户端安装脚本。

</div>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/Platform-Windows%207%2F8%2F10%2F11-blue?logo=windows&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2018-green?logo=node.js&logoColor=white">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-31-purple?logo=electron&logoColor=white">
  <img alt="Version" src="https://img.shields.io/badge/version-0.2.0-orange">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-lightgrey">
  <img alt="Type3 raw" src="https://img.shields.io/badge/协议-RAW%20(TCP%209100)-informational">
</p>

---

## 这是什么？

打印机通过 **USB** 连在主机上。只要在主机运行本服务，局域网内其他电脑就能
用 Windows 自带的功能 ——「**标准 TCP/IP 端口**」—— 把打印任务发给主机，
由主机交给 USB 打印机。**客户机不用装任何共享软件**，只需一条自动生成的安装脚本。

- **主机**：`PrintShare`（系统托盘常驻）在 **TCP 9100** 提供原始打印服务，**TCP 8081** 提供 Web 管理页。
- **客户端**：添加一台 `Standard TCP/IP` 端口打印机，填主机 `IP:9100` 即可使用。

## 特性

- ✅ **纯 TCP 打印共享**，绕开 SMB 共享的 `0x0000011b` / `0x00000709` 等历史顽疾
- ✅ **可靠的磁盘暂存队列 + 串行投递**：同一时刻只向打印后台投递一个任务，多客户端并发生成有序
- ✅ **队列可视化**：排队 / 打印中 / 已完成、可取消、暂停单任务、调优先级、全局暂停
- ✅ **崩溃恢复**：重启后自动续打未完成任务，数据不丢
- ✅ **Web 管理页**（`localhost:8081`）：选打印机、看队列、下载客户端脚本
- ✅ **系统托盘**：开机自启动、暂停 / 继续、复制服务器 IP、清空队列、退出
- ✅ **单文件便携 exe**：复制到任意 Win7–11 机器双击即用，首次自动放行防火墙
- ✅ **客户端一键安装**：单文件 `.bat`，先用记事本可审计，跨 Win7–11 一键建端口 + 建打印机
- ✅ **前导 0 剥离**：自动剔除不同驱动在任务头塞入的 0x00 垃圾字节，避免打印不被识别

## 工作原理

```
┌────────────────┐  9100 (原始打印数据/每次连接=一个任务)   ┌─────────────────────────────┐
│  局域网客户端     │ ─────────────────────────────────────► │        PrintShare (主机)        │
│  自带 TCP/IP 端口 │                                      │  收流落盘(磁盘暂存)              │
│  (IP:9100)      │                                      │  单 worker 串行投递             │
└────────────────┘ ◄───────────────────────────────────── │  WinSpool(DocRAW)→本机USB打印机 │
                         8081 (Web 管理页/面向管理员)          └─────────────────────────────┘
```

客户端发送打印任务 = 建立一条到 `主机IP:9100` 的 TCP 连接并写完数据。
主机把**每个连接流式写入磁盘暂存队列**，再由**单个 worker 按序串行提交**给 Windows 打印后台
（通过 `winspool.drv` 的 `OpenPrinter / StartDoc / WritePrinter / EndDoc`，PowerShell P/Invoke，零原生依赖），
最终把 raw 数据交给 USB 打印机。

## 快速开始（用打包好的 exe）

### 1️⃣ 主机端

1. 把 `PrintShare *.exe` 复制到主机（本机接好 USB 打印机，驱动已装）。
2. **双击运行**：首次会自动弹一次 UAC 授权，放行防火墙（TCP `9100` / `8081`），出现托盘图标。
3. 打开管理页 <kbd>http://localhost:8081</kbd>，在页面上选中本机**实际连接的打印机**并保存。

### 2️⃣ 客户端

两种方式任选：

<details>
<summary><b>A. 手动添加（通用）</b></summary>

- 「设置 → 蓝牙和其他设备 → 打印机和扫描仪 → 添加设备」
- 选「**通过 TCP/IP 地址或主机名添加打印机**」
- IP 填主机的**局域网 IP**；端口默认 `9100`；取消勾选“查询打印机自动选择驱动”
- 选择与该型号匹配的**厂商驱动**完成添加

> 客户机必须安装与主机同型号的**厂商 Type-3 完整驱动**，否则可能出现乱码 / 白纸。
</details>

<details>
<summary><b>B. 客户端一键脚本（推荐）</b></summary>

- 在主机管理页点「**下载 zip 安装包**」
- 把 zip 拷到客户机，解压后用**记事本打开** `安装共享打印机.bat` 核对服务器 IP / 驱动
- **右键以管理员身份运行**：脚本会先验证服务器可达、检查驱动，仅在确需建打印机时才请求提权，
  删除旧同名打印机前先询问，**失败不破坏原配置**
- 脚本不自动设默认打印机，可按需要在系统设置里手动设为默认
</details>

### 3️⃣ 日常管理

右键托盘图标：开机自启动 / 暂停队列 / 复制服务器 IP / 清空已完成 / 退出。
管理页可随时查看队列、暂停、取消、调优先级。

## 从源码构建 / 运行

需要 **Node.js ≥ 18**。

```bash
npm install          # 安装依赖（自动生成图标）

npm start            # 命令行跑打印服务（联调用）
npm run electron     # 带系统托盘运行
start-server.bat     # 一键启动（检测 Node、放行防火墙、打开管理页）

npm run build        # 打包单文件便携版 exe → dist\PrintShare *.exe
```

> `build.bat` 已内置国内网络所需的镜像配置（nsis 等构建工具走 npmmirror），并把构建缓存放在
> 项目内 `.buildcache\`，保证一键出包。

联调模式（仅走队列流程、不真正打印）：
```bash
set DRYRUN=1   # 然后 node server.js
```

## ⚙️ 配置

| 项 | 说明 | 默认 |
| --- | --- | --- |
| `RAW_PORT` | 客户端打印连接端口（环境变量） | `9100` |
| `ADMIN_PORT` | Web 管理页端口（环境变量） | `8081` |
| `config.json` | 目标打印机名（首次运行自动创建，可缺省） | 自动取默认打印机 |
| `queue/` | 磁盘暂存的任务队列；`meta.json` 存元数据 | 自动创建 |

## 安全设计

本项目的安装脚本与服务刻意做到**最小权限、可审计、不破坏原配置**：

- 生成给客户机的 `安装共享打印机.bat` 是**可读纯文本**（非 Base64 混淆），能用记事本核对 IP / 驱动
- 用系统内置的 `prnport.vbs` / `prnmngr.vbs`（经 `cscript`），**不依赖 Win8+ 才有**的
  `Get-Printer` / `Add-Printer`，因此跨 **Win7 → Win11** 全系可用
- 提权（UAC）**只在真正需要创建 / 删除打印机时**触发；删除前先询问，且只操作本脚本命名的对象
- 创建端口前先用 TCP 探测验证服务器可达
- 服务端投递前自动**剥离任务开头连续 0x00**（不同驱动前导 0 长度不同，动态适配）

## 技术栈

| 层 | 技术 |
| --- | --- |
| 打印服务 | Node.js `net` / `http` 原生模块，TCP 9100 + Web 8081 |
| Spooler 投递 | PowerShell P/Invoke → `winspool.drv`（RAW，零原生依赖） |
| 桌面外壳 | Electron + 系统托盘 + 开机自启动（注册表 `Run` 键） |
| 打包分发 | electron-builder → 单文件 portable exe（x64） |

## 目录结构

```
main.js            Electron 主进程：托盘菜单 + 开机自启动 + 启动服务
server.js          核心打印服务：TCP 9100 收流 → 磁盘队列 → 串行投递 → WinSpool
winspool.ps1       PowerShell P/Invoke，把数据交给本机打印机（零原生依赖，含前导0剥离）
public/index.html  Web 管理页：打印机选择、队列可视化、客户端脚本生成
make-icon.js       生成托盘/应用图标（ico/png）
build.bat          一键打包脚本（内置镜像与缓存路径）
start-server.bat   一键启动脚本（检测 Node、放行防火墙、打开管理页）
```

## ❓ 常见问题

- **客户端脱机 / 打不开管理页**：确认主机已放行 `TCP 9100` 与 `8081`。便携 exe 首次启动会自动弹
  UAC 放行；若点过「否」或用旧版，可右键 `start-server.bat` 以管理员运行补放行。
- **任务显示“已完成”但打印机不动**：多半是硬件（缺纸 / 缺墨盒），或打印机语言与驱动不匹配。
  本版已在投递前剥离前导 0，若仍异常可在管理页看队列里的字节数是否合理。
- **端口被占**：管理页默认 `8081`、打印端口 `9100`，可用 `ADMIN_PORT` / `RAW_PORT` 环境变量更换。
- **开机自启动不生效**：复选框状态来自注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  的值 `PrintShare`；必须是便携版 exe 的真实路径（代码已自动处理便携版解压到临时目录的情况）。
- **客户端乱码 / 白纸**：客户机未装与主机同型号的厂商完整驱动。请先安装对应驱动再打印。

## ✅ Roadmap

- [x] TCP 打印共享核心 + 可靠性队列
- [x] Web 管理页与队列可视化
- [x] 系统托盘 + 开机自启动 + 单文件打包
- [x] 客户端一键安装脚本（跨 Win7–11 纯 BAT）
- [x] 前导 0 剥离修复
- [ ] 打印页数 / 耗材状态上报
- [ ] 打印机多实例 / 一台主机管理多台打印机

## License

[MIT](./LICENSE) © PrintShare

---

<p align="center">有问题 → <a href="https://github.com/jobkkk-qqq/PrinterShareInternat/issues">提交 Issue</a> | ⭐ 如果对你有用，欢迎点个 Star</p>