# Run once: right-click -> "Run with PowerShell". Registers autostart at user logon (no admin needed).
$root = Split-Path -Parent $PSScriptRoot
$bat  = Join-Path $root 'start.bat'
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$bat`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'ClinicalCompass' -Action $action -Trigger $trigger -Settings $set -Description 'Klinicheskiy kompas local server' -Force | Out-Null
Start-ScheduledTask -TaskName 'ClinicalCompass'
Write-Host 'Done. Site: http://localhost:3000  (starts automatically at every logon)'
Write-Host 'Remove: Unregister-ScheduledTask -TaskName ClinicalCompass -Confirm:$false'
