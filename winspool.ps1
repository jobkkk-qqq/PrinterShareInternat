<#
  winspool.ps1 — 把原始打印数据投递给本机打印机（WinSpool RAW）
  零原生依赖：通过 Add-Type 用 Windows 自带 .NET Framework 编译 WinSpool P/Invoke。
  server.js 调用本脚本完成真正"交给打印机"这一步。
#>
param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$DataFile
)

# 打包版 GUI 运行没有控制台，PowerShell 5.1 会用 OEM 代码页写 stdout/stderr，
# Node 按 UTF-8 读，下面的中文报错会变成乱码显示在管理页上。强制 UTF-8 输出。
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WSP {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOC_INFO_1 {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }

  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "OpenPrinterW")]
  public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

  // StartDocPrinterW 的返回值是后台给这次作业分配的作业号（失败时为 0）。
  // 必须声明成 int 才拿得到它——server.js 要靠这个作业号去打印服务操作日志里
  // 核对作业到底有没有真的送到打印机端口（WritePrinter 成功只代表后台收下了数据）。
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "StartDocPrinterW")]
  public static extern int StartDocPrinter(IntPtr hPrinter, int level, ref DOC_INFO_1 di);

  [DllImport("winspool.drv", SetLastError = true, EntryPoint = "WritePrinter")]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int cbBuf, out int pcWritten);

  [DllImport("winspool.drv", SetLastError = true, EntryPoint = "EndDocPrinter")]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError = true, EntryPoint = "ClosePrinter")]
  public static extern bool ClosePrinter(IntPtr hPrinter);
}
'@

$Server = $PrinterName
if ($Server -notmatch '^\\\\') {
  # 本地打印机，用 ., 5 (访问权限) 打开
  $h = [IntPtr]::Zero
  $ok = [WSP]::OpenPrinter($PrinterName, [ref]$h, [IntPtr]::Zero)
  if (-not $ok) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Error "OpenPrinter 失败 (错误码 $err)。请确认打印机名存在：$PrinterName"
    exit 2
  }
} else {
  Write-Error "不支持 UNC 打印机名，请在本机安装好目标打印机驱动后，用其本地名称。"
  exit 2
}

$di = New-Object 'WSP+DOC_INFO_1'
$di.pDocName = 'PrintShare-' + (Get-Date -Format 'HHmmss')
$di.pOutputFile = $null
$di.pDatatype = 'RAW'

try {
  $jobId = [WSP]::StartDocPrinter($h, 1, [ref]$di)
  if ($jobId -eq 0) {
    Write-Error 'StartDocPrinter 失败'
    exit 3
  }
  Write-Output "JOBID: $jobId"

  $raw = [System.IO.File]::ReadAllBytes($DataFile)

  # 剥离前导 0x00 —— 部分客户机（尤其经官方驱动 + Standard TCP/IP 端口）会在打印任务
  # 最前面写入固定数量（如 11000 字节）的 0 占位，导致打印机无法识别到 Esc E 开头的
  # 合法任务头。对 RAW 打印语言，任务开头的 0 是纯垃圾，直接剔除更稳。
  $trimStart = 0
  while ($trimStart -lt $raw.Length -and $raw[$trimStart] -eq 0) { $trimStart++ }
  if ($trimStart -ge $raw.Length) {
    # 整个任务都是 0x00（极端情况）：$raw[$len..($len-1)] 在 PowerShell 里会反过来取到
    # 最后一个字节，所以这里显式当成空任务，交给下面的 Length 判断跳过写入。
    $bytes = [byte[]]@()
    Write-Output "任务内容全为 0x00，按空任务处理 (原始 $($raw.Length) 字节)"
  } elseif ($trimStart -gt 0) {
    $bytes = [byte[]]($raw[$trimStart..($raw.Length - 1)])
    Write-Output "已剥离前导 0x00 字节: $trimStart (剩余 $($bytes.Length) 字节)"
  } else {
    $bytes = $raw
  }

  $written = 0
  if ($bytes.Length -gt 0 -and -not [WSP]::WritePrinter($h, $bytes, $bytes.Length, [ref]$written)) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Error "WritePrinter 失败 (错误码 $err)。客户端与打印机语言不一致时会出现此错误。"
    exit 4
  }

  [WSP]::EndDocPrinter($h) | Out-Null
  Write-Output "OK: $($bytes.Length) 字节已投递"
} finally {
  [WSP]::ClosePrinter($h) | Out-Null
}
exit 0
