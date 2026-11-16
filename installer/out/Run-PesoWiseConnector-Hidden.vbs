Set sh = CreateObject("Wscript.Shell")
sh.Run """" & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\PesoWiseSync.exe"" run", 0, False
