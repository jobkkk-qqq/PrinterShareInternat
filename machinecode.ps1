# machinecode.ps1 - collect the hardware parts that make up the machine code.
#
# Output: one "KEY:VALUE" line per component (CPU:/BOARD:/MAC:/HDD:).
# Composition + hashing happen in Node (license.js) so the algorithm stays unit-testable;
# this script only reads hardware.
#
# IMPORTANT: the sources here intentionally mirror PDFconvertAdd's get_machine_code.py,
# so the two programs produce the SAME machine code for the same PC (shared license codes):
#   CPU   : registry ProcessorId, falling back to "wmic cpu get ProcessorId"
#   BOARD : registry BaseBoardProduct, falling back to wmic baseboard / computersystem
#   MAC   : UuidCreateSequential, i.e. exactly what CPython uuid.getnode() uses on Windows
#   HDD   : "wmic diskdrive get SerialNumber"
# On Windows 11 24H2+ wmic is removed, so CPU/HDD usually stay empty. That matches Python,
# which loses those components on the same machines too.
#
# Keep this file pure ASCII: PowerShell 5.1 reads .ps1 without a BOM as ANSI.

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

function Get-WmicCol {
  param([string]$Column, [string[]]$Query)
  if (-not (Get-Command wmic -ErrorAction SilentlyContinue)) { return $null }
  try {
    $out = & wmic @Query 2>$null
    foreach ($line in @($out)) {
      $t = "$line".Trim()
      if ($t -and $t -ne $Column) { return $t }   # skip the header line
    }
  } catch { }
  return $null
}

# --- CPU ---
$cpu = (Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -Name ProcessorId).ProcessorId
if (-not $cpu) { $cpu = Get-WmicCol -Column 'ProcessorId' -Query @('cpu', 'get', 'ProcessorId') }
if ($cpu) { $cpu = "$cpu".Trim() }

# --- BOARD ---
$board = (Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\BIOS' -Name BaseBoardProduct).BaseBoardProduct
if (-not $board) { $board = Get-WmicCol -Column 'Product' -Query @('baseboard', 'get', 'Product') }
if (-not $board) { $board = Get-WmicCol -Column 'UUID' -Query @('computersystem', 'get', 'UUID') }
if ($board) { $board = "$board".Trim() }

# --- MAC: same source as CPython uuid.getnode() on Windows ---
$mac = $null
try {
  if (-not ('RpcUuid' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RpcUuid {
  [DllImport("rpcrt4.dll")]
  public static extern int UuidCreateSequential(byte[] uuid);
}
'@
  }
  $buf = New-Object byte[] 16
  if ([RpcUuid]::UuidCreateSequential($buf) -eq 0) {
    # the adapter address is the last 6 bytes, in big-endian order
    $mac = (($buf[10..15] | ForEach-Object { $_.ToString('X2') }) -join ':')
  }
} catch { $mac = $null }
if (-not $mac) {
  $g = & getmac /fo csv /nh 2>$null
  foreach ($line in @($g)) {
    if ("$line" -match '"([0-9A-Fa-f]{2}(-[0-9A-Fa-f]{2}){5})"') {
      $mac = ($matches[1] -replace '-', ':').ToUpper(); break
    }
  }
}

# --- HDD ---
$hdd = Get-WmicCol -Column 'SerialNumber' -Query @('diskdrive', 'get', 'SerialNumber')
if ($hdd) { $hdd = "$hdd".Trim() }

if ($cpu) { "CPU:$cpu" }
if ($board) { "BOARD:$board" }
if ($mac) { "MAC:$mac" }
if ($hdd) { "HDD:$hdd" }
