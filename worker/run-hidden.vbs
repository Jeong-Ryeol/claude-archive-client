' Run the worker without a console window and keep it alive.
' Exit 0 = intentional stop. Any other code (75 = self-update, crash) -> wait 5 s and relaunch.
' More than 20 restarts within an hour -> give up and write logs\restart-stop.txt.
Option Explicit
Dim fso, sh, here, logs, code, starts(), n, i, recent, f
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
logs = fso.BuildPath(here, "logs")
If Not fso.FolderExists(logs) Then fso.CreateFolder logs

ReDim starts(0)
n = 0
Do
  code = sh.Run("node dist\index.js", 0, True)
  If code = 0 Then Exit Do

  ' count restarts within the last hour
  n = n + 1
  ReDim Preserve starts(n)
  starts(n) = Now
  recent = 0
  For i = 1 To n
    If DateDiff("s", starts(i), Now) < 3600 Then recent = recent + 1
  Next
  If recent > 20 Then
    Set f = fso.CreateTextFile(fso.BuildPath(logs, "restart-stop.txt"), True)
    f.WriteLine Now & " stopped: " & recent & " restarts within 1 hour, last exit code " & code
    f.WriteLine "Check logs\worker.log, then run install again."
    f.Close
    WScript.Quit code
  End If
  WScript.Sleep 5000
Loop
WScript.Quit code
