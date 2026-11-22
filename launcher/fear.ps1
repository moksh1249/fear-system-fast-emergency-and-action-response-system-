<#
  FEAR launcher. The .bat files in the FEAR folder call this - double-click those.

    fear.ps1 start       start the FEAR server in the background, open the GUI when it's ready
    fear.ps1 stop        stop it (the same as the GUI's "Close server" button)
    fear.ps1 setup       first time on a computer: Python environment, packages, shortcuts
    fear.ps1 shortcuts   desktop + Start menu shortcuts only
    fear.ps1 phone       install the Android apps on a phone over a USB cable
    fear.ps1 build       rebuild both Android apps and the web dashboard (developers; needs Flutter)

  Only ASCII in this file: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.
#>
param(
    [ValidateSet('start', 'stop', 'setup', 'shortcuts', 'phone', 'build')]
    [string]$Action = 'start'
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest's progress bar is very slow in PowerShell 5.1

$Root     = Split-Path -Parent $PSScriptRoot
$AppDir   = Join-Path $Root 'traffic light revamped'
$VenvPy   = Join-Path $Root '.venv\Scripts\python.exe'
$LogDir   = Join-Path $Root 'logs'
$ApkDir   = Join-Path $Root 'Android apps'
$IconDir  = Join-Path $PSScriptRoot 'icons'
$GuiUrl   = 'http://127.0.0.1:8765/simulation.html'
$GuiPing  = 'http://127.0.0.1:8765/api/signal/overrides'
$ApiPing  = 'http://127.0.0.1:8080/health'
$Servers  = 'http://127.0.0.1:8080/v2/servers'
$LinkFile = Join-Path $AppDir 'backend\fear_backend\public_link.json'
$ApiLog   = Join-Path $AppDir 'backend\fear_backend\fear_backend.log'

# ------------------------------------------------------------------ helpers

function Say([string]$Text = '', [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

function Show-Title([string]$Text) {
    try { $Host.UI.RawUI.WindowTitle = "FEAR - $Text" } catch { }
    Say ''
    Say "  FEAR - $Text" Cyan
    Say ('  ' + ('-' * (7 + $Text.Length))) DarkCyan
    Say ''
}

function Test-Url([string]$Url, [int]$TimeoutSec = 3) {
    try { $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop; return $true }
    catch { return $false }
}

function Get-Json([string]$Url) {
    try { return Invoke-RestMethod -Uri $Url -TimeoutSec 4 -ErrorAction Stop } catch { return $null }
}

function Get-PublicAddress {
    # The permanent internet address (backend/setup_permanent_link.py), if this computer has one.
    try {
        $s = Get-Content $LinkFile -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($s.named -and $s.named.hostname -and (Test-Path $s.named.config)) { return "https://$($s.named.hostname)" }
    } catch { }
    return $null
}

function Get-RunningAddresses {
    # What the running server answers on: @{ Public = 'https://...'; Lan = 'http://<wifi-ip>:8080' }
    $list = @((Get-Json $Servers).servers)
    return @{
        Public = ($list | Where-Object { $_ -like 'https://*' } | Select-Object -First 1)
        Lan    = ($list | Where-Object { $_ -like 'http://*' } | Select-Object -First 1)
    }
}

function Wait-Key([int]$Seconds = 0) {
    Say ''
    try {
        if ($Seconds -gt 0) {
            Say "  This window closes by itself in $Seconds seconds (or press any key)." DarkGray
            $end = (Get-Date).AddSeconds($Seconds)
            while ((Get-Date) -lt $end) {
                if ([Console]::KeyAvailable) { $null = [Console]::ReadKey($true); return }
                Start-Sleep -Milliseconds 200
            }
        } else {
            Say '  Press any key to close this window.' DarkGray
            $null = [Console]::ReadKey($true)
        }
    } catch { Start-Sleep -Seconds ([Math]::Max($Seconds, 3)) }
}

function Show-Addresses {
    $a = Get-RunningAddresses
    Say '  FEAR is running.' Green
    Say ''
    Say "  On this computer:              $GuiUrl"
    if ($a.Public) { Say "  Other computers (any network): $($a.Public)/command/" White }
    if ($a.Lan)    { Say "  Other computers (same Wi-Fi):  $($a.Lan)/command/" }
    $get = if ($a.Public) { $a.Public } else { $a.Lan }
    if ($get)      { Say "  Phones - get the apps:         $get/get" White }
    if (-not $a.Public) {
        Say ''
        Say '  There is no internet address right now: only computers and phones on this Wi-Fi can connect.' Yellow
        Say '  (README.md, "The internet address", explains it.)' Yellow
    }
    Say ''
    Say '  FEAR keeps running after you close this window.' Gray
    Say '  To stop it: the "Stop FEAR" icon, or "Close server" in the GUI.' Gray
}

# ------------------------------------------------------------------ start / stop

function Start-Fear {
    Show-Title 'Start'
    if (-not (Test-Path $VenvPy)) {
        Say '  FEAR is not set up on this computer yet.' Yellow
        Say '  Double-click "Set up FEAR (first time)" in the FEAR folder, then start FEAR again.'
        Wait-Key; return
    }
    if (Test-Url $GuiPing) {
        Say '  FEAR is already running - opening it.' Green
        Start-Process $GuiUrl
        Show-Addresses
        Wait-Key 30; return
    }

    New-Item -ItemType Directory -Force $LogDir | Out-Null
    $log = Join-Path $LogDir 'server.log'
    if (Test-Path $log) { Move-Item $log "$log.previous" -Force -ErrorAction SilentlyContinue }

    $env:PYTHONUNBUFFERED  = '1'
    $env:PYTHONIOENCODING  = 'utf-8'   # the log is a file: without this a non-ASCII print could stop the server
    $env:FEAR_OPEN_BROWSER = '0'       # serve.py would open the map editor; we open the GUI once FEAR is ready
    Say '  Starting the FEAR server...'
    # Through cmd in its own hidden window: the server keeps running when this window is closed.
    $cmdLine = "/s /c `"`"$VenvPy`" serve.py > `"$log`" 2>&1`""
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdLine -WorkingDirectory $AppDir -WindowStyle Hidden -PassThru

    $guiUp = $false; $apiUp = $false; $said = $false
    $deadline = (Get-Date).AddMinutes(4)
    while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
        if (-not $guiUp) { $guiUp = Test-Url $GuiPing 2 }
        if ($guiUp -and -not $apiUp) { $apiUp = Test-Url $ApiPing 2 }
        if ($guiUp -and $apiUp) { break }
        if (-not $said -and -not $guiUp -and ((Get-Date) -gt $deadline.AddMinutes(-3.75))) {
            Say '  Preparing the road map (longer after a map change)...' DarkGray; $said = $true
        }
        Start-Sleep -Seconds 1
    }

    if (-not ($guiUp -and $apiUp)) {
        Say ''
        if ($guiUp) {
            Say '  The GUI started but the FEAR backend did not.' Red
            Say "  Its log: $ApiLog"
            Get-Content $ApiLog -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Say "    $_" DarkGray }
        } else {
            Say "  FEAR didn't start." Red
            Get-Content $log -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Say "    $_" DarkGray }
            Say ''
            Say "  Full log: $log"
            Say '  If it says the address is already in use, another program is using port 8765 - restart the computer and try again.'
        }
        Wait-Key; return
    }

    $want = Get-PublicAddress
    if ($want) {
        Say "  Connecting the internet address $want ..."
        $end = (Get-Date).AddSeconds(40)
        while ((Get-Date) -lt $end -and -not (Get-RunningAddresses).Public) { Start-Sleep -Seconds 1 }
    }
    Start-Process $GuiUrl
    Say ''
    Show-Addresses
    Wait-Key 60
}

function Stop-Leftovers {
    # FEAR processes still running without their parent (a server that was ended hard).
    $n = 0
    $checks = @(
        @{ Port = 8080; Mine = { (Get-Json $ApiPing).service -eq 'fear_backend' } },
        @{ Port = 8765; Mine = { Test-Url $GuiPing 1 } }
    )
    foreach ($c in $checks) {
        if (-not (& $c.Mine)) { continue }
        $owners = Get-NetTCPConnection -LocalPort $c.Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($id in $owners) {
            $p = Get-Process -Id $id -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -like 'python*') { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; $n++ }
        }
    }
    # the internet link and the traffic engine, when started from this FEAR folder
    Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe' OR Name='sim_engine.exe' OR Name='ch_query.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
    return $n
}

function Stop-Fear {
    Show-Title 'Stop'
    $wasUp = Test-Url $GuiPing
    if ($wasUp) {
        Say '  Stopping FEAR...'
        try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/api/shutdown' -Method Post -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop } catch { }
        $end = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $end -and ((Test-Url $GuiPing 1) -or (Test-Url $ApiPing 1))) { Start-Sleep -Milliseconds 500 }
    }
    $left = Stop-Leftovers
    if ($wasUp -or $left -gt 0) {
        Say '  FEAR is stopped.' Green
        Say '  Phones and other computers stay signed in and reconnect by themselves when FEAR starts again.'
    } else {
        Say '  FEAR was not running.' Green
    }
    Wait-Key 6
}

# ------------------------------------------------------------------ first-time setup + shortcuts

function Find-BasePython {
    # A Python 3.10+ to build FEAR's .venv from: the py launcher first, then python on PATH.
    $probe = "import sys; print('%d.%d|%s' % (sys.version_info[0], sys.version_info[1], sys.executable))"
    foreach ($c in @(@('py', '-3'), @('python'))) {
        if (-not (Get-Command $c[0] -ErrorAction SilentlyContinue)) { continue }
        try {
            $rest = @($c | Select-Object -Skip 1)
            $out = (& $c[0] @rest -c $probe 2>$null | Select-Object -First 1)
            if ($out -match '^(\d+)\.(\d+)\|(.+)$' -and ([int]$Matches[1] -gt 3 -or ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 10))) {
                return @{ Version = "$($Matches[1]).$($Matches[2])"; Exe = $Matches[3].Trim() }
            }
        } catch { }
    }
    return $null
}

function New-Shortcut([string]$Path, [string]$Target, [string]$Icon, [string]$Description) {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($Path)
    $lnk.TargetPath = $Target
    $lnk.WorkingDirectory = $Root
    $lnk.IconLocation = "$Icon,0"
    $lnk.Description = $Description
    $lnk.Save()
}

function New-Shortcuts {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'FEAR'
    New-Item -ItemType Directory -Force $menu | Out-Null
    foreach ($dir in @($desktop, $menu)) {
        New-Shortcut (Join-Path $dir 'Start FEAR.lnk') (Join-Path $Root 'Start FEAR.bat') (Join-Path $IconDir 'fear.ico') 'Start the FEAR server and open it'
        New-Shortcut (Join-Path $dir 'Stop FEAR.lnk') (Join-Path $Root 'Stop FEAR.bat') (Join-Path $IconDir 'fear-stop.ico') 'Stop the FEAR server'
    }
    New-Shortcut (Join-Path $menu 'Install FEAR apps on a phone (USB).lnk') (Join-Path $ApkDir 'Install on phone (USB).bat') (Join-Path $IconDir 'fear-command.ico') 'Install the FEAR Android apps on a phone connected by USB'
    New-Shortcut (Join-Path $menu 'FEAR folder.lnk') $Root (Join-Path $IconDir 'fear.ico') 'The FEAR project folder'
    Say '  Shortcuts: "Start FEAR" and "Stop FEAR" on the desktop, and a FEAR folder in the Start menu.' Green
}

function Install-Fear {
    Show-Title 'First-time setup'
    if (-not (Test-Path $VenvPy)) {
        $base = Find-BasePython
        if (-not $base) {
            Say '  FEAR needs Python 3.10 or newer, and it is not on this computer.' Yellow
            if (Get-Command winget -ErrorAction SilentlyContinue) {
                $a = Read-Host '  Install Python 3.13 now? (Y/N)'
                if ($a -match '^[Yy]') {
                    winget install -e --id Python.Python.3.13 --scope user --accept-package-agreements --accept-source-agreements
                    Say ''
                    Say '  Done. Close this window and double-click "Set up FEAR (first time)" again.' Green
                    Wait-Key; return
                }
            }
            Say '  Install Python from https://www.python.org/downloads/ (tick "Add python.exe to PATH"),'
            Say '  then double-click "Set up FEAR (first time)" again.'
            Start-Process 'https://www.python.org/downloads/'
            Wait-Key; return
        }
        Say "  Making FEAR's Python environment (.venv) with Python $($base.Version)..."
        & $base.Exe -m venv (Join-Path $Root '.venv')
        if (-not (Test-Path $VenvPy)) { Say '  Could not make the .venv folder.' Red; Wait-Key; return }
    }
    Say '  Installing the Python packages FEAR needs (a minute or two the first time)...'
    & $VenvPy -m pip install --disable-pip-version-check -q -r (Join-Path $Root 'requirements.txt')
    if ($LASTEXITCODE -ne 0) {
        Say '  Installing the packages failed. Check the internet connection and run the setup again.' Red
        Wait-Key; return
    }
    Say '  Python packages: OK' Green

    $parts = [ordered]@{
        'Traffic engine'        = 'backend\sim\sim_engine.exe'
        'Route planner'         = 'backend\ch\ch_query.exe'
        'Route index builder'   = 'backend\ch\ch_preprocess.exe'
    }
    foreach ($k in $parts.Keys) {
        if (Test-Path (Join-Path $AppDir $parts[$k])) { Say "  ${k}: OK" Green }
        else { Say "  ${k}: missing - it is built from its C++ source on first use, which needs g++ (MSYS2 UCRT64) on PATH." Yellow }
    }
    if (Test-Path (Join-Path $Root 'tools\cloudflared\cloudflared.exe')) { Say '  Internet link tool (cloudflared): OK' Green }
    else { Say '  Internet link tool missing (tools\cloudflared\cloudflared.exe): only this Wi-Fi will be able to connect.' Yellow }
    $pub = Get-PublicAddress
    if ($pub) { Say "  Internet address: $pub" Green }
    else { Say '  Internet address: not set up on this computer. README.md, "The internet address", explains it.' Yellow }

    New-Shortcuts
    Say ''
    Say '  Setup finished. Start FEAR with the "Start FEAR" icon on the desktop.' Green
    Say '  The first time, Windows may ask whether Python may use networks: click "Allow".'
    Say '  Without that, computers and phones on this Wi-Fi cannot connect (the internet address still works).'
    Wait-Key
}

# ------------------------------------------------------------------ phones

function Find-Adb {
    $c = Get-Command adb -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @((Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'), (Join-Path $Root 'tools\platform-tools\adb.exe'))) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Get-DownloadPage {
    $a = Get-RunningAddresses
    if ($a.Public) { return "$($a.Public)/get" }
    $pub = Get-PublicAddress
    if ($pub) { return "$pub/get   (once FEAR is started)" }
    if ($a.Lan) { return "$($a.Lan)/get   (phone on this Wi-Fi)" }
    return 'http://<this computer''s Wi-Fi address>:8080/get   (start FEAR first)'
}

function Install-Phone {
    Show-Title 'Install the apps on a phone (USB)'
    $apps = [ordered]@{
        '1' = @('FEAR', (Join-Path $ApkDir 'FEAR.apk'))
        '2' = @('FEAR Command', (Join-Path $ApkDir 'FEAR Command.apk'))
    }
    if (-not ((Test-Path $apps['1'][1]) -or (Test-Path $apps['2'][1]))) {
        Say '  The app files are not in the "Android apps" folder yet.' Yellow
        Say '  A developer makes them with launcher\Build phone apps.bat.'
        Wait-Key; return
    }
    $adb = Find-Adb
    if (-not $adb) {
        Say '  The USB install tool (adb) is not on this computer.' Yellow
        Say ''
        Say '  Easiest instead - open this page on the phone and install from there:'
        Say "    $(Get-DownloadPage)" White
        Say '  Or copy FEAR.apk / FEAR Command.apk from the "Android apps" folder to the phone and tap it.'
        Wait-Key; return
    }
    Say '  On the phone, once:'
    Say '    1. Settings > About phone > tap "Build number" 7 times (turns on Developer options).'
    Say '    2. Settings > System > Developer options > turn on "USB debugging".'
    Say '  Then connect it with a USB cable and tap "Allow" when the phone asks.'
    Say ''
    $null = Read-Host '  Press Enter when the phone is connected'

    $devices = @()
    $end = (Get-Date).AddSeconds(30)
    do {
        $lines = @(& $adb devices 2>$null | ForEach-Object { "$_" })
        $devices = @($lines | Where-Object { $_ -match '^\S+\s+device$' } | ForEach-Object { ($_ -split '\s+')[0] })
        $waiting = @($lines | Where-Object { $_ -match '\s(unauthorized|authorizing)$' })
        if ($devices.Count -gt 0) { break }
        if ($waiting.Count -gt 0) { Say '  Waiting for you to tap "Allow" on the phone...' Yellow }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $end)
    if ($devices.Count -eq 0) {
        Say '  No phone found. Check the cable (a charge-only cable will not work), that USB debugging is on,' Red
        Say '  and that you tapped "Allow". Or install from the download page instead:'
        Say "    $(Get-DownloadPage)" White
        Wait-Key; return
    }

    $pick = Read-Host '  Which app? 1 = FEAR (citizens), 2 = FEAR Command (drivers), 3 = both'
    $keys = switch ($pick) { '1' { @('1') } '2' { @('2') } default { @('1', '2') } }
    foreach ($d in $devices) {
        foreach ($k in $keys) {
            $name, $apk = $apps[$k]
            if (-not (Test-Path $apk)) { Say "  $name.apk is missing - skipped." Yellow; continue }
            Say "  Installing $name on phone $d (about a minute)..."
            $out = @(& $adb -s $d install -r $apk 2>&1 | ForEach-Object { "$_" })
            if ($out -match 'Success') { Say "  $name installed." Green }
            elseif ($out -match 'UPDATE_INCOMPATIBLE') {
                Say "  The $name already on this phone was built on another computer. Uninstall it on the phone, then run this again." Yellow
            } else {
                Say "  Installing $name failed:" Red
                $out | Select-Object -Last 4 | ForEach-Object { Say "    $_" DarkGray }
            }
        }
    }
    Say ''
    Say '  Open the app on the phone: it finds the FEAR server by itself. Then sign in.'
    Wait-Key
}

# ------------------------------------------------------------------ developers

function Copy-Apks {
    New-Item -ItemType Directory -Force $ApkDir | Out-Null
    $pairs = @(
        @('apps\fear_public\build\app\outputs\flutter-apk\app-release.apk', 'FEAR.apk'),
        @('apps\fear_gov\build\app\outputs\flutter-apk\app-release.apk', 'FEAR Command.apk')
    )
    foreach ($p in $pairs) {
        $src = Join-Path $Root $p[0]
        if (Test-Path $src) { Copy-Item $src (Join-Path $ApkDir $p[1]) -Force; Say "  Android apps\$($p[1]) updated." Green }
    }
}

function Build-Apps {
    Show-Title 'Build the apps (developers)'
    $flutter = (Get-Command flutter -ErrorAction SilentlyContinue).Source
    if (-not $flutter -and (Test-Path 'C:\flutter\flutter\bin\flutter.bat')) { $flutter = 'C:\flutter\flutter\bin\flutter.bat' }
    if (-not $flutter) {
        Say '  Flutter was not found (on PATH or at C:\flutter\flutter). Install it from https://flutter.dev first.' Red
        Wait-Key; return
    }
    $steps = @(
        @{ Dir = 'apps\fear_public'; Args = @('build', 'apk', '--release'); Label = 'FEAR (Android)' },
        @{ Dir = 'apps\fear_gov'; Args = @('build', 'apk', '--release'); Label = 'FEAR Command (Android)' },
        @{ Dir = 'apps\fear_gov'; Args = @('build', 'web', '--release', '--base-href', '/command/'); Label = 'FEAR Command web dashboard' }
    )
    foreach ($s in $steps) {
        Say "  Building $($s.Label)..." Cyan
        Push-Location (Join-Path $Root $s.Dir)
        & $flutter @($s.Args) --suppress-analytics
        $code = $LASTEXITCODE
        Pop-Location
        if ($code -ne 0) { Say "  $($s.Label) failed (see above)." Red; Wait-Key; return }
    }
    Copy-Apks
    Say ''
    Say '  Done. Phones get the new apps from the download page (/get) or with "Install on phone (USB)".' Green
    Say '  The web dashboard is updated in place - browsers pick it up on their next reload.'
    Wait-Key
}

switch ($Action) {
    'start'     { Start-Fear }
    'stop'      { Stop-Fear }
    'setup'     { Install-Fear }
    'shortcuts' { Show-Title 'Shortcuts'; New-Shortcuts; Wait-Key 5 }
    'phone'     { Install-Phone }
    'build'     { Build-Apps }
}
