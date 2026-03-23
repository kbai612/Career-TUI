$ErrorActionPreference = "Stop"
# In PowerShell 7+, native stderr can be promoted to terminating errors when
# ErrorActionPreference=Stop. Keep native stderr as log output instead.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$repo = "C:\Users\kevin\Documents\Github\Career Ops"
$logDir = Join-Path $repo "logs"
$runStamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$logFile = Join-Path $logDir ("toronto-daily-{0}-{1}.log" -f $runStamp, $PID)
$lockFile = Join-Path $logDir "toronto-daily.lock"
$script:runLock = $null

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log($msg) {
  $line = "[$(Get-Date -Format s)] $msg"
  Write-Output $line
  Add-Content -Path $logFile -Value $line
}

function Invoke-NativeLogged {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList
  )

  $stdoutFile = [System.IO.Path]::GetTempFileName()
  $stderrFile = [System.IO.Path]::GetTempFileName()
  try {
    $quotedArgs = $ArgumentList | ForEach-Object {
      if ($_ -match '\s|"') {
        '"' + ($_ -replace '"', '\"') + '"'
      } else {
        $_
      }
    }

    $process = Start-Process `
      -FilePath $FilePath `
      -ArgumentList ($quotedArgs -join " ") `
      -NoNewWindow `
      -Wait `
      -PassThru `
      -RedirectStandardOutput $stdoutFile `
      -RedirectStandardError $stderrFile

    if (Test-Path $stdoutFile) {
      Get-Content $stdoutFile | Tee-Object -FilePath $logFile -Append | Out-Null
    }
    if (Test-Path $stderrFile) {
      Get-Content $stderrFile | Tee-Object -FilePath $logFile -Append | Out-Null
    }
    return $process.ExitCode
  } finally {
    Remove-Item -Force $stdoutFile, $stderrFile -ErrorAction SilentlyContinue
  }
}

try {
  try {
    $script:runLock = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    Log "Another Toronto daily sync appears to be running; skipping this invocation."
    exit 0
  }

  Set-Location $repo
  Log "Run log file: $logFile"
  Log "Starting Toronto daily sync..."

  # Ensure Node is resolvable in scheduled task environments.
  $nodeCandidates = @(
    "C:\Program Files\nodejs\node.exe",
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  $node = $nodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $node) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { $node = $nodeCmd.Source }
  }
  if (-not $node) { throw "node.exe not found in scheduled task environment." }
  $nodeDir = Split-Path $node -Parent
  if (-not ($env:PATH -split ";" | Where-Object { $_ -eq $nodeDir })) {
    $env:PATH = "$nodeDir;$env:PATH"
  }
  Log "Using node: $node"

  $workerEntrypoint = Join-Path $repo "apps\\worker\\dist\\apps\\worker\\src\\index.js"
  if (-not (Test-Path $workerEntrypoint)) {
    # Build once if dist is missing.
    $pnpmCandidates = @(
      "C:\Users\kevin\AppData\Local\pnpm\pnpm.cmd",
      "$env:USERPROFILE\AppData\Local\pnpm\pnpm.cmd",
      "C:\Users\kevin\AppData\Roaming\npm\pnpm.cmd",
      "$env:APPDATA\npm\pnpm.cmd"
    )
    $pnpm = $pnpmCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $pnpm) {
      $cmd = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
      if ($cmd) { $pnpm = $cmd.Source }
    }
    if (-not $pnpm) {
      throw "Worker dist entrypoint missing and pnpm.cmd not found for build fallback."
    }
    Log "Worker dist missing; building with pnpm: $pnpm"
    $buildExitCode = Invoke-NativeLogged -FilePath $pnpm -ArgumentList @("--filter", "@career-ops/worker", "run", "build")
    if ($buildExitCode -ne 0) {
      throw "Worker build failed with exit code $buildExitCode."
    }
  }

  Log "Using worker entrypoint: $workerEntrypoint"
  $syncExitCode = Invoke-NativeLogged -FilePath $node -ArgumentList @(
    $workerEntrypoint,
    "sync-sources",
    "--region", "toronto-canada",
    "--concurrency", "3",
    "--evaluate"
  )
  if ($syncExitCode -ne 0) {
    throw "sync-sources failed with exit code $syncExitCode."
  }

  Log "Finished."
}
catch {
  Log "FAILED: $($_.Exception.Message)"
  Log "Stack: $($_.ScriptStackTrace)"
  exit 1
}
finally {
  if ($script:runLock -ne $null) {
    $script:runLock.Close()
    $script:runLock.Dispose()
    $script:runLock = $null
    Remove-Item -Force $lockFile -ErrorAction SilentlyContinue
  }
}
