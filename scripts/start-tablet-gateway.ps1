$ErrorActionPreference = 'Stop'
$gatewayRoot = Join-Path $PSScriptRoot '..\..\..\tablet-readonly'
$configFile = Join-Path $gatewayRoot 'gateway.json'
$gatewayScript = Join-Path $PSScriptRoot 'tablet-gateway.mjs'
$nodePath = 'C:\Program Files\nodejs\node.exe'
$mutex = New-Object System.Threading.Mutex($false, 'Local\V9TabletReadOnlyGateway')
if (-not $mutex.WaitOne(0)) { exit 0 }
$gatewayProcess = $null
try {
    while ($true) {
        $homeNetwork = $false
        try {
            $profile = Get-NetConnectionProfile -InterfaceAlias 'WLAN' -ErrorAction Stop
            $ip = Get-NetIPAddress -InterfaceAlias 'WLAN' -AddressFamily IPv4 -ErrorAction Stop
            $route = Get-NetRoute -InterfaceAlias 'WLAN' -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop
            $homeNetwork = ($profile.Name -eq 'L6175 5G') -and ($ip.IPAddress -contains '192.168.1.122') -and ($route.NextHop -contains '192.168.1.1')
        } catch { $homeNetwork = $false }
        if ($gatewayProcess -and -not $gatewayProcess.HasExited -and -not $homeNetwork) {
            Stop-Process -Id $gatewayProcess.Id -ErrorAction SilentlyContinue
            $gatewayProcess = $null
        }
        if ($homeNetwork -and (-not $gatewayProcess -or $gatewayProcess.HasExited)) {
            $busy = Get-NetTCPConnection -State Listen -LocalPort 5180 -ErrorAction SilentlyContinue
            if (-not $busy) {
                $gatewayProcess = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $gatewayScript + '"'), ('"' + $configFile + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $gatewayRoot 'gateway.log') -RedirectStandardError (Join-Path $gatewayRoot 'gateway-error.log')
            }
        }
        Start-Sleep -Seconds 5
    }
} finally {
    if ($gatewayProcess -and -not $gatewayProcess.HasExited) { Stop-Process -Id $gatewayProcess.Id -ErrorAction SilentlyContinue }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
