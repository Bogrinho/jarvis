' Jarvis launcher: starts the server hidden from this file's own folder.
' If Jarvis is already running, main.js just opens another Jarvis window.
Dim fso, sh, folder
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = folder
sh.Run "node src\main.js", 0, False
