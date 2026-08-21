# =============================================================================
# Daily marketplace message sync -- scheduler wrapper.
#
# Runs the EXISTING command and nothing else:
#
#     npm run sync:messages -- --apply
#
# No sync logic lives here. Watermarks, duplicate protection, thread building,
# direction rules and the varmen_db / varmen_user identity check all belong to
# that command and are untouched -- this only decides when it runs and where the
# output goes.
#
# ALWAYS EXITS 0, deliberately. Windows Task Scheduler records a non-zero exit
# as a failed task, and a run of failures is one of the things that can leave a
# task disabled or buried in retries. A sync failure is a normal, expected
# event -- the source may be unreachable for a minute -- and it must not stop
# tomorrow's run. The real exit code is written to the log, and the log is where
# failures are read from.
#
# SAFE TO FAIL. The sync writes its watermark inside the same transaction as the
# data it describes, so an interrupted run leaves the cursor no further ahead
# than the rows that actually landed. The next run resumes from there.
# =============================================================================

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$log = Join-Path $logDir ('sync-{0}.log' -f (Get-Date -Format 'yyyy-MM'))
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

function Write-Log([string]$line) {
    Add-Content -Path $log -Value $line -Encoding utf8
}

Write-Log ''
Write-Log "===== $stamp  daily sync starting ====="

Push-Location $root
try {
    # 2>&1 merges the command's stderr into the captured output so a failure
    # message reaches the log rather than disappearing.
    $output = & npm run sync:messages -- --apply 2>&1
    $code = $LASTEXITCODE

    foreach ($line in $output) { Write-Log $line }

    if ($code -eq 0) {
        Write-Log "===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  finished OK ====="
    } else {
        # Recorded prominently, but not re-thrown: see the exit-0 note above.
        Write-Log "===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  FAILED exit=$code ====="
    }
} catch {
    Write-Log "===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  FAILED exception ====="
    Write-Log $_.Exception.Message
} finally {
    Pop-Location
}

# Keep a year of monthly logs and no more. Unbounded logs in a repo working
# directory are their own small problem.
Get-ChildItem -Path $logDir -Filter 'sync-*.log' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 12 |
    Remove-Item -Force -ErrorAction SilentlyContinue

exit 0
