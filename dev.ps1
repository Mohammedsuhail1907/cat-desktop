<#
.SYNOPSIS
    Runs CatDesktop in development mode: Angular dev server (live reload) + the .NET host pointed at it.

.DESCRIPTION
    1. Starts "npm start" (ng serve) in cat-desktop/ in a new PowerShell window, unless -NoServe is given or a server
       already answers on the port. Runs "npm ci" first when node_modules is missing.
    2. Waits (up to 90 s) until http://127.0.0.1:<Port> answers with the CatDesktop page (another project answering
       on the same port is reported instead of being loaded).
    3. Runs the host in this window:  dotnet run --project Desktop/CatDesktop.Host -- --dev-url http://127.0.0.1:<Port>
       Dev mode enables DevTools (F12) and the right-click context menu inside the WebView.

    Close the host window (or press Ctrl+C here) to stop the host; the dev-server window keeps running for the next start.

.PARAMETER NoServe
    Do not start the Angular dev server; assume it is (or will be) running on the port.
.PARAMETER Port
    Port of the Angular dev server. Default 4280 (CatDesktop's own port, see cat-desktop/angular.json).

.EXAMPLE
    .\dev.ps1
.EXAMPLE
    .\dev.ps1 -NoServe -Port 4300
#>
[CmdletBinding()]
param(
    [switch]$NoServe,

    [ValidateRange(1, 65535)]
    [int]$Port = 4280
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoRoot = $PSScriptRoot
$AngularDir = Join-Path $RepoRoot 'cat-desktop'
$HostDir = Join-Path $RepoRoot 'Desktop\CatDesktop.Host'
$DevUrl = "http://127.0.0.1:$Port"
$WaitSeconds = 90

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info([string]$Message) { Write-Host "    $Message" }
function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "    WARNING: $Message" -ForegroundColor Yellow }

function Find-Executable([string]$Name) {
    # Node installs ship an extension-less "npm" shell shim next to npm.cmd; only real Windows executables can be started.
    $candidates = @(Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue)
    $runnable = @($candidates | Where-Object { [IO.Path]::GetExtension($_.Path) -match '^\.(exe|cmd|bat|com)$' })
    if ($runnable.Count -gt 0) { return $runnable[0].Path }
    if ($candidates.Count -gt 0) { return $candidates[0].Path }
    throw "'$Name' was not found on PATH. Install Node.js 22 LTS and the .NET 9 SDK (see README.md)."
}

function Format-Argument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Invoke-Tool([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
    # Start-Process keeps the child's stdout/stderr on the console; Windows PowerShell 5.1 would otherwise convert
    # stderr lines (npm/dotnet warnings) into terminating errors under $ErrorActionPreference = 'Stop'.
    # No -Wait: it also waits for descendants such as a lingering dotnet build server. WaitForExit() waits for the tool
    # only (polled, so Ctrl+C still stops the script); reading Handle first keeps ExitCode available afterwards in
    # Windows PowerShell 5.1.
    $argumentLine = ($Arguments | ForEach-Object { Format-Argument $_ }) -join ' '
    Write-Host "    > $FilePath $argumentLine" -ForegroundColor DarkGray
    $process = Start-Process -FilePath $FilePath -ArgumentList $argumentLine -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru
    $null = $process.Handle
    while (-not $process.WaitForExit(250)) { }
    return $process.ExitCode
}

function Test-DevServer {
    try {
        Invoke-WebRequest -Uri $DevUrl -UseBasicParsing -TimeoutSec 3 | Out-Null
        return $true
    }
    catch {
        # Any HTTP answer (even 404) means the server is up; only connection failures count as "not yet".
        return ($null -ne $_.Exception.Response)
    }
}

# True when the page at $DevUrl is CatDesktop's index.html (its <title>), not another project that took the port.
function Test-CatDesktopPage {
    try {
        $page = Invoke-WebRequest -Uri $DevUrl -UseBasicParsing -TimeoutSec 3
        return $page.Content -match '<title>s*CatDesktops*</title>'
    }
    catch {
        return $false
    }
}

try {
    Write-Host 'CatDesktop development run' -ForegroundColor White
    Write-Info "Dev server URL: $DevUrl"

    if ($NoServe) {
        Write-Step 'Angular dev server not started (-NoServe)'
    }
    elseif (Test-DevServer) {
        Write-Step "Angular dev server already answering at $DevUrl - reusing it"
    }
    else {
        $npm = Find-Executable 'npm'
        if (-not (Test-Path -LiteralPath (Join-Path $AngularDir 'node_modules'))) {
            Write-Step 'Installing npm packages (first run)'
            $exitCode = Invoke-Tool -FilePath $npm -Arguments @('ci') -WorkingDirectory $AngularDir
            if ($exitCode -ne 0) { throw "npm ci failed with exit code $exitCode." }
        }

        Write-Step "Starting Angular dev server in a new window (port $Port)"
        # The child window inherits this variable, so the Angular CLI never blocks on its analytics prompt.
        $env:NG_CLI_ANALYTICS = 'false'
        $escapedDir = $AngularDir.Replace("'", "''")
        $serverCommand = "`$Host.UI.RawUI.WindowTitle = 'CatDesktop - Angular dev server'; Set-Location -LiteralPath '$escapedDir'; npm start -- --host 127.0.0.1 --port $Port"
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ('"' + $serverCommand + '"')) `
            -WorkingDirectory $AngularDir | Out-Null
    }

    Write-Step "Waiting for $DevUrl (up to $WaitSeconds s)"
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $ready = Test-DevServer
    while (-not $ready -and (Get-Date) -lt $deadline) {
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 2
        $ready = Test-DevServer
    }
    Write-Host ''
    if ($ready -and -not (Test-CatDesktopPage)) {
        throw "Another application answers at $DevUrl - not CatDesktop's Angular app, so the host would load the wrong UI. Stop that server or use -Port with a free port."
    }
    if ($ready) {
        Write-Ok 'Dev server is up.'
    }
    else {
        Write-Warn "$DevUrl did not answer within $WaitSeconds s. Starting the host anyway - it shows a retry page; press F5 in the app once the dev server is ready."
    }

    Write-Step "Starting host: dotnet run --project Desktop/CatDesktop.Host -- --dev-url $DevUrl"
    $dotnet = Find-Executable 'dotnet'
    $hostExitCode = Invoke-Tool -FilePath $dotnet -Arguments @('run', '--project', $HostDir, '--disable-build-servers', '--', '--dev-url', $DevUrl) -WorkingDirectory $RepoRoot
    if ($hostExitCode -ne 0) {
        Write-Warn "Host exited with code $hostExitCode. Logs: $env:LOCALAPPDATA\CatDesktop\Logs"
    }
    exit $hostExitCode
}
catch {
    Write-Host ''
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
