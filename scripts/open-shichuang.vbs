Set shell = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
ps1 = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "open-shichuang.ps1")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
