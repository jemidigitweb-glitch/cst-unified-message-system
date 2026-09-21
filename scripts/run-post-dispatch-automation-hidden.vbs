' Silent launcher for run-post-dispatch-automation.mjs.
'
' The ONLY reason this file exists, and it is the same reason as the sync one:
' Task Scheduler running node.exe directly still flashes a console window for
' node.exe itself. WScript.Shell.Run with window style 0 is the one way to
' launch a process with no window at all -- not even a flash -- without
' elevation, a stored password, or changing the task's logon type.
'
' Everything else is unchanged: this runs the same run-post-dispatch-automation.mjs,
' which calls the same /api/cron/automation the deployment's cron calls. No
' automation logic here. node.exe's full path is passed in as the one argument
' rather than assumed on PATH, matching how the registration script resolves it.
Dim shell, fso, scriptDir, nodePath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = WScript.Arguments(0)

' 0 = hidden window. True = wait for it to finish before this script exits, so
' Task Scheduler's own "is this task still running" tracking stays correct.
shell.Run """" & nodePath & """ """ & scriptDir & "\run-post-dispatch-automation.mjs""", 0, True
