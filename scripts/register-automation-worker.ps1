# =============================================================================
# Registers the always-running post-dispatch automation worker.
#
#     powershell -ExecutionPolicy Bypass -File scripts\register-automation-worker.ps1
#     powershell -ExecutionPolicy Bypass -File scripts\register-automation-worker.ps1 -Status
#     powershell -ExecutionPolicy Bypass -File scripts\register-automation-worker.ps1 -Remove
#
# WHY THIS EXISTS, AND WHAT IT REPLACES. The task it supersedes --
# `CST Post-Dispatch Automation`, registered by
# scripts\register-post-dispatch-automation.ps1 -- ran the automation every 15
# MINUTES. That is not the same thing as running it on time. A record comes due
# at one instant, `dispatched_at + delay_hours`, and a 15-minute tick only
# decides how late that instant is noticed: a record due at 09:14 is processed at
# 09:15, and the first tick after a restart is the only one that matters to a
# backlog. run-automation-worker.mjs starts ONCE and waits on the exact moment,
# so the delay between a record coming due and being processed is a second rather
# than up to fifteen minutes -- and the "automation" is no longer a timer at all.
#
# ONE TRIGGER, AT LOGON. Not a repetition interval and not every 15 minutes:
# `-AtLogOn` with no `-RepetitionInterval` anywhere in this file. The worker runs
# for as long as the machine is up. The header of the superseded script says the
# same thing in reverse, and points here.
#
# IT STARTS THE WORKER, AND NOTHING ELSE. No HTTP call, no `npm run dev`, no dev
# server to be running. The worker opens the two database connections itself
# (lib/db/app-connection.ts), so the previous design's one real weakness --
# a task that silently did nothing whenever the app was not serving -- is gone.
#
# TEST MODE IS UNCHANGED AND CANNOT BE CHANGED FROM HERE. The worker holds no
# setting and writes no row: it calls the same `runPostDispatchAutomation`
# processing path the deployed route calls, and every processed record is written
# `processed_mode = 'test_mode'`, which 0011's
# `ck_automation_items_sent_requires_test_mode` enforces at the database. Nothing
# in this file, and nothing it starts, can transmit a message.
#
# LOGS. logs\automation-worker-YYYY-MM.log, one line per event, twelve months
# kept. The first thing to read if a record sat past its moment.
#
# IT NEEDS MIGRATION 0012 FOR THE FAST PATH. Without it the worker still works --
# it re-checks the soonest record every 15 seconds -- it just will not be woken
# the instant a new earlier record is inserted. The worker says so in its log at
# startup.
# =============================================================================

param(
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

$TaskName = 'CST Post-Dispatch Automation Worker'
# The task this one replaces. Named here so the two can never both be running:
# two triggers for one automation is exactly the confusion this removes.
$SupersededTaskName = 'CST Post-Dispatch Automation'

$root = Split-Path -Parent $PSScriptRoot
$hiddenLauncher = Join-Path $PSScriptRoot 'run-automation-worker-hidden.vbs'

if ($Status) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Output "Not registered: '$TaskName'"
    } else {
        Write-Output "Registered : '$TaskName'"
        Write-Output "State      : $($task.State)"
        $task.Triggers | ForEach-Object { Write-Output "Trigger    : $($_.CimClass.CimClassName)" }
    }
    if (Get-ScheduledTask -TaskName $SupersededTaskName -ErrorAction SilentlyContinue) {
        Write-Output "WARNING    : the 15-minute task '$SupersededTaskName' is still registered."
        Write-Output "             Remove it with: powershell -File scripts\register-post-dispatch-automation.ps1 -Remove"
    }
    Write-Output "Logs       : logs\automation-worker-YYYY-MM.log"
    exit 0
}

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Removed scheduled task: $TaskName"
    } else {
        Write-Output "No scheduled task named '$TaskName' to remove."
    }
    # The worker is running right now. Unregistering the task does not stop the
    # process it already started, so say how, rather than leaving an orphan the
    # next person cannot find.
    $running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*run-automation-worker.mjs*' }
    if ($running) {
        Write-Output "The worker process is still running (pid $($running.ProcessId -join ', ')). Stop it with:"
        Write-Output "    Stop-Process -Id $($running.ProcessId -join ',')"
    }
    exit 0
}

if (-not (Test-Path $hiddenLauncher)) { throw "Hidden launcher not found: $hiddenLauncher" }

# wscript.exe running a .vbs: node.exe launched directly still flashes its own
# console window. No CLI window, ever -- not PowerShell, not cmd, not a console.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH -- cannot register the task." }

$action = New-ScheduledTaskAction `
    -Execute 'wscript.exe' `
    -Argument "//B //Nologo `"$hiddenLauncher`" `"$node`"" `
    -WorkingDirectory $root

# AT LOGON, ONCE. No -RepetitionInterval and no -RepetitionDuration: this starts
# a resident process, not a periodic job. The worker waits on the database rather
# than being polled.
$trigger = New-ScheduledTaskTrigger -AtLogOn

# MultipleInstances IgnoreNew: OVERLAP PROTECTION. A second worker would contend
#   for the same due rows -- the claim is FOR UPDATE SKIP LOCKED so they could not
#   double-process, but the second copy would hold database connections all day
#   for nothing. IgnoreNew means a logon cannot start a duplicate.
# AllowStartIfOnBatteries / DontStopIfGoingOnBatteries: a laptop on battery is
#   still expected to process its own records. The previous task did the same.
# ExecutionTimeLimit 0 (omitted): UNLIMITED, which is the whole point here. The
#   default of 72 hours would kill a worker that is meant to run for weeks, and a
#   worker that dies quietly is worse than one that never started.
# RestartCount/Interval: covers a crash and a database that was not up yet.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5)

$description = @(
    'Runs scripts\run-automation-worker.mjs once, at logon, and leaves it running.',
    'The worker waits on the exact scheduled_at of the next due post-dispatch record.',
    'No host is contacted and no credential is read.',
    'Processes in TEST MODE only; it cannot transmit anything.',
    'If the 15-minute task ''CST Post-Dispatch Automation'' still exists, remove it.'
) -join ' '

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Replaced the existing '$TaskName'."
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description $description | Out-Null

Write-Output "Registered '$TaskName' -- starts once at logon, then runs continuously."
Write-Output "Logs: logs\automation-worker-YYYY-MM.log"
Write-Output ""
Write-Output "Start it now, without logging off:"
Write-Output "    Start-ScheduledTask -TaskName '$TaskName'"
Write-Output ""
if (Get-ScheduledTask -TaskName $SupersededTaskName -ErrorAction SilentlyContinue) {
    Write-Output "STILL REGISTERED: the 15-minute task '$SupersededTaskName'."
    Write-Output "Two triggers for one automation is what this design removes. Stop it with:"
    Write-Output "    powershell -ExecutionPolicy Bypass -File scripts\register-post-dispatch-automation.ps1 -Remove"
}
