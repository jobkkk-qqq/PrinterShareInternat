<#
  printcheck.ps1 — 核对打印后台对某个作业的真实处理结果

  WritePrinter 返回成功只说明"后台收下了数据"，不代表数据送到了打印机端口。
  驱动/打印处理器异常（如 XPS 管道崩溃）或后台服务卡死时，作业会被静默删除，
  投递方却早已拿到成功返回——管理页于是把根本没打出来的任务显示成"已完成"。

  这里读打印服务操作日志 Microsoft-Windows-PrintService/Operational，按作业号判定：
    307 DocumentPrinted           作业已通过端口送达打印机       -> printed
    842 PrintDriverSandboxJob...  打印处理器返回非 0 错误码       -> proc_error
    824 PrintFilterPipeline...    打印筛选器管道崩溃（XPS 驱动）   -> pipeline_error
    310 DocumentDeleted           作业未送达端口即被后台删除       -> dropped
    超时仍无结论                                                -> unconfirmed
    日志里查不到该作业的入队记录（日志被关掉）                   -> unknown

  只有 printed 才算真的成功；unknown 表示无法核对，由调用方按投递结果处理。
#>
param(
  [Parameter(Mandatory=$true)][int]$JobId,
  [Parameter(Mandatory=$true)][string]$SinceUtc,
  [int]$TimeoutSeconds = 30
)

# 打包版 GUI 运行没有控制台，PowerShell 5.1 会用 OEM 代码页写 stdout，
# Node 按 UTF-8 读，下面的中文 DETAIL 会变成乱码。强制 UTF-8 输出。
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$since = [datetime]::Parse($SinceUtc, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)

function NodeText($node, $name) {
  $n = $node.SelectSingleNode("*[local-name()='$name']")
  if ($n) { return $n.InnerText } else { return '' }
}

$spooled = $false
$printed = $false
$dropped = $false
$procErr = ''
$procName = ''
$pipeErr = ''
$portName = ''
$byteCount = ''
$verdict = ''
$detail = ''

while (-not $verdict) {
  $events = Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-PrintService/Operational'; StartTime=$since} -ErrorAction SilentlyContinue
  foreach ($e in $events) {
    # 只看与"作业"相关的事件：打印机增删（300/301/302）之类的事件里 Param1 是打印机名，
    # 不加这层过滤会被当成作业号，既报类型错又可能误判。
    if ($e.Id -notin 800, 307, 310, 842, 824) { continue }
    $x = [xml]$e.ToXml()
    $u = $x.Event.UserData.ChildNodes | Select-Object -First 1
    if (-not $u) { continue }
    # 800/307/310 把作业号放在 Param1，842/824 放在 JobId
    $idText = NodeText $u 'JobId'
    if (-not $idText) { $idText = NodeText $u 'Param1' }
    if (-not $idText) { continue }
    $idNum = 0
    if (-not [int]::TryParse($idText.Trim(), [ref]$idNum)) { continue }
    if ($idNum -ne $JobId) { continue }

    switch ($e.Id) {
      800 { $spooled = $true }
      307 { $printed = $true; $portName = NodeText $u 'Param6'; $byteCount = NodeText $u 'Param7' }
      842 { $c = NodeText $u 'ErrorCode'; if ($c -and $c -ne '0x0') { $procErr = $c; $procName = NodeText $u 'Processor' } }
      824 { $c = NodeText $u 'ErrorInfo'; if ($c -and $c -ne '0x0') { $pipeErr = $c } }
      310 { $dropped = $true }
    }
  }
  # 成功优先：日志里既可能有 310（删除）也可能有 307（送达），顺序不保证
  if ($printed) {
    $verdict = 'printed'
    $detail = "已通过 $portName 端口送达打印机（$byteCount 字节）"
  } elseif ($procErr) {
    $verdict = 'proc_error'
    $detail = "打印处理器 $procName 返回错误 $procErr（驱动无法处理该打印数据）"
  } elseif ($pipeErr) {
    $verdict = 'pipeline_error'
    $detail = "打印筛选器管道崩溃（$pipeErr）：驱动无法处理该打印数据，作业未能送达打印机"
  } elseif ($dropped) {
    $verdict = 'dropped'
    $detail = '作业未送达打印机端口就被打印后台删除了（驱动/打印处理器异常，或打印后台服务卡死）'
  } elseif ((Get-Date) -ge $deadline) {
    if ($spooled) {
      $verdict = 'unconfirmed'
      $detail = "提交后 $TimeoutSeconds 秒内未确认打印完成：作业可能仍滞留在打印后台（打印机离线或后台异常），请检查打印机状态"
    } else {
      $verdict = 'unknown'
      $detail = '打印服务操作日志中查不到该作业，无法核对真实结果'
    }
  } else {
    Start-Sleep -Milliseconds 700
  }
}

Write-Output "VERDICT: $verdict"
Write-Output "DETAIL: $detail"
exit 0