' Silent launcher for run-message-sync.mjs.
'
' The ONLY reason this file exists: Task Scheduler running node.exe directly
' still flashes a console window for node.exe itself, even once the child
' process it spawns is hidden. WScript.Shell.Run with window style 0 is the
' one way to launch a process with no window at all -- not even a flash --
' without elevation, a stored password, or changing the task's logon type.
'
' Everything else is unchanged: this runs the same run-message-sync.mjs, which
' runs the same `npm run sync:messages -- --apply`. No sync logic here.
' node.exe's full path is passed in as the one argument rather than assumed on
' PATH, matching how register-message-sync.ps1 resolves it -- one definition
' of "where node is," not two.
Dim shell, fso, scriptDir, nodePath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = WScript.Arguments(0)

' 0 = hidden window. True = wait for it to finish before this script exits,
' so Task Scheduler's own "is this task still running" tracking stays correct.
shell.Run """" & nodePath & """ """ & scriptDir & "\run-message-sync.mjs""", 0, True
