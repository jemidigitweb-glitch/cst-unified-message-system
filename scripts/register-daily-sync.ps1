# =============================================================================
# Registers (or re-registers) the daily 08:00 message sync.
#
#     powershell -ExecutionPolicy Bypass -File scripts\register-daily-sync.ps1
#     powershell -ExecutionPolicy Bypass -File scripts\register-daily-sync.ps1 -Remove
#
# WINDOWS TASK SCHEDULER, because that is what actually fits. The sync is a
# command-line process that needs a direct connection to both the marketplace
# source and varmen_db, and it runs on this machine today. An in-process timer
# would need a long-running Node server the project does not have, and a
# Vercel cron would need the deployment to reach those databases -- which is
# still unverified.
#
# RUNS AS THE CURRENT USER, interactively, so it uses the same environment and
# the same .env this project already runs with. No elevation is required, and
# nothing is installed system-wide.
#
# ONE CAVEAT, stated plainly: a task on a workstation only runs while that
# workstation is on. `StartWhenAvailable` catches up a missed run once the
# machine wakes, but if the PC is off all day there is no sync that day. Moving
# this to a server or a hosted cron is the fix, and it is a deployment decision
# rather than a code one.
# =============================================================================

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$TaskName = 'CST Daily Message Sync'
$root = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $PSScriptRoot 'run-daily-sync.ps1'

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Removed scheduled task: $TaskName"
    } else {
        Write-Output "No scheduled task named '$TaskName' to remove."
    }
    exit 0
}

if (-not (Test-Path $wrapper)) { throw "Wrapper not found: $wrapper" }

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$wrapper`"" `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Daily -At 08:00

# StartWhenAvailable: run a missed 08:00 as soon as the machine is next awake,
#   which is the difference between "skipped a day" and "an hour late".
# MultipleInstances IgnoreNew: a long run must never overlap the next day's.
#   The sync is idempotent, but two concurrent runs would fight over the same
#   watermark rows for no benefit.
# ExecutionTimeLimit 1h: a hung run is stopped rather than blocking tomorrow.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 15) `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Runs npm run sync:messages -- --apply once daily at 08:00. Idempotent; logs to logs\sync-YYYY-MM.log.' `
    -User $env:USERNAME `
    -RunLevel Limited | Out-Null

Write-Output "Registered '$TaskName' -- daily at 08:00."
Write-Output "Runs   : $wrapper"
Write-Output "Logs   : $(Join-Path $root 'logs')"
Write-Output ""
Write-Output "Verify : Get-ScheduledTask -TaskName '$TaskName'"
Write-Output "Run now: Start-ScheduledTask -TaskName '$TaskName'"
Write-Output "Remove : powershell -ExecutionPolicy Bypass -File scripts\register-daily-sync.ps1 -Remove"
