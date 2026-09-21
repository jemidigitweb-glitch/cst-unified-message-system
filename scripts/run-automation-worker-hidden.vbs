' Silent launcher for run-automation-worker.mjs.
'
' The ONLY reason this file exists, and it is the same reason as the sync one:
' Task Scheduler starting node.exe directly still flashes a console window for
' node.exe itself. WScript.Shell.Run with window style 0 is the one way to start
' a process with no window at all -- not even a flash -- without elevation, a
' stored password, or changing the task's logon type.
'
' WHY IT DOES *NOT* WAIT, UNLIKE THE 15-MINUTE WRAPPER'S LAUNCHER. That one runs
' a script that finishes in seconds, so it passes True and lets Task Scheduler
' track the run. This launches a worker that is meant to run for days: waiting
' would keep wscript.exe alive for the whole life of the worker, and Task
' Scheduler would see one task that never ends. Passing False detaches it, and
' Task Scheduler's own MultipleInstances policy is what stops a second copy.
'
' Nothing else is decided here. It runs the same run-automation-worker.mjs that
' `npm run worker:automation` runs, in the project root, with node.exe's full
' path passed in as the one argument rather than assumed on PATH.
Dim shell, fso, scriptDir, root, nodePath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(scriptDir)
nodePath = WScript.Arguments(0)

' 0 = hidden window. False = do not wait: this is a long-running process.
shell.CurrentDirectory = root
shell.Run """" & nodePath & """ --import .\scripts\register-hooks.mjs .\scripts\run-automation-worker.mjs", 0, False
