param([ValidateSet('restore','minimize','background')][string]$Action = 'restore')
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WindowTest {
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
$proc = Get-Process Gemini | Where-Object MainWindowHandle -ne 0
if (@($proc).Count -ne 1) { throw 'GEMINI_WINDOW_AMBIGUOUS' }
if ($Action -eq 'restore') { [WindowTest]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null; [WindowTest]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null }
if ($Action -eq 'minimize') { [WindowTest]::ShowWindow($proc.MainWindowHandle, 6) | Out-Null }
if ($Action -eq 'background') { [WindowTest]::SetForegroundWindow([WindowTest]::GetShellWindow()) | Out-Null }
@{ action = $Action; foregroundGemini = ([WindowTest]::GetForegroundWindow() -eq $proc.MainWindowHandle); minimized = [WindowTest]::IsIconic($proc.MainWindowHandle) } | ConvertTo-Json -Compress
