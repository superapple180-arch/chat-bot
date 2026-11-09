$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = Split-Path $PSScriptRoot -Parent
$asm = [Reflection.Assembly]::LoadFrom((Join-Path $root 'bin\GeminiDriver.exe'))
$type = $asm.GetType('GeminiDriver')
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$all = $type.GetMethod('All', $flags)
$text = $type.GetMethod('Text', $flags)
$proc = Get-Process Gemini | Where-Object MainWindowHandle -ne 0
$element = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
$elements = $all.Invoke($null, @($element))
$user = @($elements | Where-Object { $_.Current.AutomationId -like 'user-query-content-*' })[-1]
$prompt = $text.Invoke($null, @($user.PSObject.BaseObject))
if (($prompt -notlike '*QQ_SYNTHETIC_*' -and $prompt -notlike '*QQ_VERIFY_*') -or $prompt -notlike '*QQBRIDGE_*') { throw 'NO_SYNTHETIC_TEST_PROMPT' }
$replies = @($elements | Where-Object { $_.Current.AutomationId -like 'model-response-message-content*' })
$answer = if ($replies.Count) { $text.Invoke($null, @($replies[-1].PSObject.BaseObject)) } else { $null }
$nodes = @($all.Invoke($null, @($user.PSObject.BaseObject)) | ForEach-Object { @{ type = $_.Current.ControlType.ProgrammaticName; id = $_.Current.AutomationId; label = $_.Current.LocalizedControlType; preview = $_.Current.Name.Substring(0, [Math]::Min(28, $_.Current.Name.Length)) } })
@{ syntheticPrompt = $prompt; syntheticReply = $answer; nodes = $nodes } | ConvertTo-Json -Compress -Depth 4
