' launch-hidden.vbs - starts start-dashboard.cmd (next to this file) with no console window.
' Used by the "JobRadar" scheduled task that setup.ps1 registers; without it the
' logon task would flash (and keep) a black cmd window on screen.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & here & "\start-dashboard.cmd""", 0, False
