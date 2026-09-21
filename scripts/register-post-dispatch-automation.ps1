# =============================================================================
# Registers (or re-registers) the automatic post-dispatch automation.
#
#     powershell -ExecutionPolicy Bypass -File scripts\register-post-dispatch-automation.ps1
#     powershell -ExecutionPolicy Bypass -File scripts\register-post-dispatch-automation.ps1 -IntervalMinutes 5
#     powershell -ExecutionPolicy Bypass -File scripts\register-post-dispatch-automation.ps1 -Remove
#
# WHY THIS EXISTS. The automation is meant to run when a record comes due, on
# its own. Without a trigger it does not: records sit at Scheduled past their
# moment, which from the admin page is indistinguishable from something being
# broken. A schedule is what makes an automation automatic; a button on a page
# is what makes it manual, which is why the button was removed and this added.
#
# EVERY 15 MINUTES BY DEFAULT, not every 5 like the message sync. The two are
# answering different clocks: a customer message belongs in the inbox minutes
# after it lands, whereas a post-dispatch record is already waiting 24 hours by
# design. Fifteen minutes is well inside the noise of that delay and is a
# quarter of the requests.
#
# IT SENDS NOTHING, and neither does what it calls. Every processed record is
# written with `test_mode = true`, and `ck_automation_items_sent_requires_test_mode`
# means the database refuses a `sent` row that is not one. Putting this on a
# timer changes what runs and when -- it does not change what the run is
# allowed to do.
#
# ONE MECHANISM, NOT TWO. The action calls GET /api/cron/automation with the
# CRON_SECRET, which is exactly what the deployment's own cron calls. There is
# no second entry point and no second copy of the safety assertions.
#
# IT NEEDS THE APP TO BE SERVING. On this machine that means `npm run dev` (or
# `npm start`) is running. If it is not, a tick logs a connection failure and
# the next one tries again -- nothing is lost, because a record that was due
# stays due. That is the one real difference from the sync task, which talks to
# the databases directly.
#
# RUNS AS THE CURRENT USER, interactively, so it uses the same environment and
# the same .env this project already runs with. No elevation is required and
# nothing is installed system-wide.
#
# ONE CAVEAT, stated plainly: a task on a workstation only runs while that
# workstation is on. `StartWhenAvailable` catches a missed slot once the
# machine wakes. The deployment's cron entry in vercel.json is the answer for
# anything that must run without this PC.
# =============================================================================

param(
    [switch]$Remove,
    # Minutes between runs. 15 by default. IgnoreNew below means a run slower
    # than the interval skips its next slot rather than overlapping.
    [int]$IntervalMinutes = 15
)

if ($IntervalMinutes -lt 1) { throw "IntervalMinutes must be at least 1." }

$ErrorActionPreference = 'Stop'

$TaskName = 'CST Post-Dispatch Automation'
$root = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $PSScriptRoot 'run-post-dispatch-automation.mjs'
$hiddenLauncher = Join-Path $PSScriptRoot 'run-post-dispatch-automation-hidden.vbs'

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

# wscript.exe running a two-line .vbs, for the same reason the sync task does
# it: node.exe launched directly still flashes its own console window on every
# tick. No CLI window, ever -- not PowerShell, not cmd, not a node console.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH -- cannot register the task." }

$action = New-ScheduledTaskAction `
    -Execute 'wscript.exe' `
    -Argument "//B //Nologo `"$hiddenLauncher`" `"$node`"" `
    -WorkingDirectory $root

# Repeats indefinitely from a minute after registration. RepetitionDuration is
# deliberately omitted, which Task Scheduler reads as "indefinitely" --
# [TimeSpan]::MaxValue is rejected outright as out of range for the task XML.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

# StartWhenAvailable: run a missed slot as soon as the machine is next awake.
# MultipleInstances IgnoreNew: OVERLAP PROTECTION. Two concurrent runs would
#   contend for the same due rows; the claim is FOR UPDATE SKIP LOCKED so they
#   could not double-process, but there is nothing to gain from the fight.
# ExecutionTimeLimit 30m: a hung run must not block the next several slots.
# RestartCount/Interval: covers a dev server that is mid-restart.
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
    -Description "Calls GET /api/cron/automation every $IntervalMinutes minutes. Processes due post-dispatch records in TEST MODE only; it cannot transmit anything." | Out-Null

Write-Output "Registered '$TaskName', every $IntervalMinutes minute(s)."
Write-Output "It calls GET /api/cron/automation on http://localhost:3000 by default -- the app must be serving."
Write-Output "Logs: logs\post-dispatch-YYYY-MM.log"
