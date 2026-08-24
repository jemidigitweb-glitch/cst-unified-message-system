# =============================================================================
# Registers (or re-registers) the automatic message sync.
#
#     powershell -ExecutionPolicy Bypass -File scripts\register-message-sync.ps1
#     powershell -ExecutionPolicy Bypass -File scripts\register-message-sync.ps1 -IntervalMinutes 15
#     powershell -ExecutionPolicy Bypass -File scripts\register-message-sync.ps1 -Remove
#
# REPEATS, rather than running once a day. A customer message that arrives at
# 09:00 belongs in the inbox minutes later, not tomorrow morning. The default is
# every 30 minutes, which feels automatic and costs almost nothing: each run
# reads only what is past the stored watermark, so a quiet half-hour is one
# cheap query per feed.
#
# IT NEVER GENERATES A DRAFT. The trigger runs the sync command and nothing
# else. An automatic draft per incoming message would spend a model call on
# every courier notification that arrives, so AI generation stays behind the
# Generate button where a person chooses it.
#
# ONE MECHANISM, NOT TWO. This is the same task, the same wrapper and the same
# `npm run sync:messages -- --apply` the project already had; only the trigger
# changed. Watermarks, duplicate protection, thread building, direction rules
# and the varmen_db / varmen_user identity check all belong to that command and
# are untouched.
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

param(
    [switch]$Remove,
    # Minutes between runs. 30 by default. IgnoreNew below means a run slower
    # than the interval just skips its next slot rather than overlapping, so a
    # short interval is safe -- it costs one cheap incremental query per feed
    # on a quiet cycle, not a growing pile of concurrent runs.
    [int]$IntervalMinutes = 30
)

if ($IntervalMinutes -lt 1) { throw "IntervalMinutes must be at least 1." }

$ErrorActionPreference = 'Stop'

$TaskName = 'CST Message Sync'
$root = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $PSScriptRoot 'run-message-sync.mjs'
$hiddenLauncher = Join-Path $PSScriptRoot 'run-message-sync-hidden.vbs'

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
if (-not (Test-Path $hiddenLauncher)) { throw "Hidden launcher not found: $hiddenLauncher" }

# PowerShell registers the task -- a one-time setup command -- but nothing
# PowerShell-based runs on every tick, and no window of any kind appears on
# any tick either. node.exe run directly still flashes its own console even
# once its children are hidden, so the action is wscript.exe (Windows' own
# script host, present on every machine) running a two-line .vbs that starts
# node.exe with a hidden window style. No CLI window, ever -- not PowerShell,
# not cmd, not a node console.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH -- cannot register the task." }

$action = New-ScheduledTaskAction `
    -Execute 'wscript.exe' `
    -Argument "//B //Nologo `"$hiddenLauncher`" `"$node`"" `
    -WorkingDirectory $root

# Repeats indefinitely from a minute after registration.
#
# RepetitionDuration is deliberately omitted, which Task Scheduler reads as
# "indefinitely". Passing [TimeSpan]::MaxValue instead is rejected outright: it
# serialises to P99999999DT23H59M59S, which is out of range for the task XML.
#
# There is deliberately no -AtLogOn trigger beside it. A logon trigger applies
# to all users unless a principal is named, so registering one needs elevation
# and fails with "Access is denied" from an ordinary shell. `StartWhenAvailable`
# below already covers the case it was there for: a machine that was off runs
# its missed slot as soon as it wakes.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

# StartWhenAvailable: run a missed slot as soon as the machine is next awake.
# MultipleInstances IgnoreNew: OVERLAP PROTECTION, and the reason the interval
#   can be short. A run slower than the interval simply skips the next slot;
#   two concurrent runs would fight over the same watermark rows for no gain.
# ExecutionTimeLimit 30m: shorter than an hour now that runs are frequent -- a
#   hung run must not block the next several slots.
# RestartCount/Interval: the retry the source's own flakiness needs.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
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
    -Description "Runs npm run sync:messages -- --apply every $IntervalMinutes minutes. Incremental and idempotent; generates no AI draft; logs to logs\sync-YYYY-MM.log." | Out-Null

# -User / -RunLevel are deliberately NOT passed. Naming a principal explicitly
# asks Task Scheduler to write another account's registration and is refused
# with "Access is denied" unless the shell is elevated. Omitting them registers
# under the invoking user, which is what was wanted anyway: the same account,
# the same environment, the same .env, and no elevation.

Write-Output "Registered '$TaskName' -- every $IntervalMinutes minutes."
Write-Output "Runs   : $wrapper"
Write-Output "Logs   : $(Join-Path $root 'logs')"
Write-Output ""
Write-Output "Verify : Get-ScheduledTask -TaskName '$TaskName'"
Write-Output "Run now: Start-ScheduledTask -TaskName '$TaskName'"
Write-Output "Remove : powershell -ExecutionPolicy Bypass -File scripts\register-message-sync.ps1 -Remove"
