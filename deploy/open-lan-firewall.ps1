# Запускать от имени администратора ОДИН раз: телефоны и другие ноутбуки из той же сети откроют http://<IP-ноутбука>:3000
# Если сеть Wi-Fi в Windows помечена как «Общедоступная» (Public), правило для Private не сработает.
# По умолчанию открываем порт и для частных, и для общедоступных сетей. Только для домашней сети оставьте -Profile Private.
param([string]$Profile = 'Private,Public')
Get-NetFirewallRule -DisplayName 'ClinicalCompass 3000' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'ClinicalCompass 3000' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile $Profile | Out-Null
Write-Host "Порт 3000 открыт для профилей: $Profile"
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' } | ForEach-Object { Write-Host ("  http://{0}:3000   ({1})" -f $_.IPAddress, $_.InterfaceAlias) }
Write-Host 'Закрыть доступ: Remove-NetFirewallRule -DisplayName "ClinicalCompass 3000"'
