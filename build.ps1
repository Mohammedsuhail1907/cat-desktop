<#
.SYNOPSIS
    Builds the CatDesktop Windows installer: Angular production build -> dotnet publish -> Inno Setup.

.DESCRIPTION
    Pipeline (every step prints a "==> " header and can be skipped individually):
      1. Prerequisites  node / npm / dotnet are located and their versions printed.
      2. Angular        npm ci (only when cat-desktop/node_modules is missing), then npm run build (production).
      3. Publish        dotnet publish of Desktop/CatDesktop.Host (self-contained by default). The csproj copies the
                        Angular output to wwwroot/ next to CatDesktop.exe, which is why step 2 must run first.
      4. Tools          Inno Setup compiler (NuGet package Tools.InnoSetup, cached in Installer/tools/innosetup) and the
                        WebView2 Evergreen bootstrapper (Installer/redist). Both are downloaded once and reused.
      5. Installer      ISCC compiles Installer/CatDesktop.iss into Installer/output/CatDesktop-Setup-<version>.exe.

    Windows PowerShell 5.1 compatible (no PowerShell 7 operators). Exit code is non-zero on any failure.

.PARAMETER Configuration
    Build configuration for the host. Default: Release.
.PARAMETER Runtime
    .NET runtime identifier to publish for: win-x64 (default) or win-arm64.
.PARAMETER Version
    Product version stamped into the exe and the installer. Default: <Version> from CatDesktop.Host.csproj.
.PARAMETER SkipAngular
    Reuse the existing cat-desktop/dist output instead of rebuilding the UI.
.PARAMETER SkipPublish
    Reuse the existing publish folder instead of running dotnet publish.
.PARAMETER SkipInstaller
    Stop after publishing; do not fetch tools or compile the installer.
.PARAMETER FetchToolsOnly
    Only download and cache Inno Setup and the WebView2 bootstrapper, then exit.
.PARAMETER SelfContained
    Bundle the .NET runtime into the publish output (default $true). -SelfContained:$false produces a much smaller
    framework-dependent build that needs the .NET 9 Desktop Runtime on the target PC.

.EXAMPLE
    .\build.ps1
.EXAMPLE
    .\build.ps1 -Version 1.2.0
.EXAMPLE
    .\build.ps1 -SkipAngular -SkipPublish     # only recompile the installer from the existing publish folder
.EXAMPLE
    .\build.ps1 -FetchToolsOnly
#>
[CmdletBinding()]
param(
    [string]$Configuration = 'Release',

    [ValidateSet('win-x64', 'win-arm64')]
    [string]$Runtime = 'win-x64',

    [string]$Version,

    [switch]$SkipAngular,
    [switch]$SkipInstaller,
    [switch]$SkipPublish,
    [switch]$FetchToolsOnly,

    [bool]$SelfContained = $true
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest's progress bar makes downloads dramatically slower in Windows PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ---- Tool versions / download locations ------------------------------------------------------------------------------

# Inno Setup packaged for NuGet (https://github.com/vslavik/nuget-tools-innosetup). 6.7.3 = Inno Setup 6.7.3, which is
# free for any use, including commercial (see license.txt in the package). Stay on the 6.x line unless you have checked
# the licence terms of a newer major version. Check for newer releases with:
#   dotnet package search Tools.InnoSetup --exact-match
$InnoSetupPackageVersion = '6.7.3'
$InnoSetupPackageUrl = "https://api.nuget.org/v3-flatcontainer/tools.innosetup/$InnoSetupPackageVersion/tools.innosetup.$InnoSetupPackageVersion.nupkg"
# Microsoft Edge WebView2 Evergreen bootstrapper (small online installer for the WebView2 Runtime).
$WebView2BootstrapperUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'

# ---- Repository layout -----------------------------------------------------------------------------------------------

$RepoRoot = $PSScriptRoot
$AngularDir = Join-Path $RepoRoot 'cat-desktop'
$AngularDist = Join-Path $AngularDir 'dist\cat-desktop\browser'
$HostDir = Join-Path $RepoRoot 'Desktop\CatDesktop.Host'
$HostProject = Join-Path $HostDir 'CatDesktop.Host.csproj'
$PublishDir = Join-Path $HostDir (Join-Path 'bin\publish' $Runtime)
$InstallerDir = Join-Path $RepoRoot 'Installer'
$IssFile = Join-Path $InstallerDir 'CatDesktop.iss'
$ToolsDir = Join-Path $InstallerDir 'tools'
$InnoDir = Join-Path $ToolsDir 'innosetup'
$InnoPackageDir = Join-Path $ToolsDir 'innosetup-pkg'
$RedistDir = Join-Path $InstallerDir 'redist'
$OutputDir = Join-Path $InstallerDir 'output'
$BootstrapperPath = Join-Path $RedistDir 'MicrosoftEdgeWebview2Setup.exe'

# ---- Console helpers -------------------------------------------------------------------------------------------------

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info([string]$Message) { Write-Host "    $Message" }
function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "    WARNING: $Message" -ForegroundColor Yellow }

function Format-Size([long]$Bytes) {
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
    return "$Bytes bytes"
}

# ---- Process helpers -------------------------------------------------------------------------------------------------

function Format-Argument([string]$Value) {
    # Windows command-line quoting rules (CommandLineToArgvW): quote when the value contains whitespace or quotes,
    # escape embedded quotes and double any backslashes that would otherwise escape the closing quote.
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Invoke-Tool {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = $RepoRoot
    )
    # Start-Process lets the child write straight to the console. With the call operator, Windows PowerShell 5.1 turns
    # every stderr line of npm/dotnet/ISCC into an ErrorRecord whenever the host's stderr is redirected, and
    # $ErrorActionPreference = 'Stop' would then abort the build on a harmless warning.
    $argumentLine = ($Arguments | ForEach-Object { Format-Argument $_ }) -join ' '
    Write-Host "    > $FilePath $argumentLine" -ForegroundColor DarkGray
    # No -Wait: it waits for every descendant process too, so a build server that dotnet leaves running (MSBuild node,
    # VBCSCompiler) would block the script forever. WaitForExit() waits for the tool itself, polled so that Ctrl+C
    # still stops the script; reading Handle first keeps ExitCode available after the process has exited
    # (Windows PowerShell 5.1 otherwise returns $null).
    $startParams = @{
        FilePath         = $FilePath
        WorkingDirectory = $WorkingDirectory
        NoNewWindow      = $true
        PassThru         = $true
    }
    if ($argumentLine.Length -gt 0) { $startParams.ArgumentList = $argumentLine }
    $process = Start-Process @startParams
    $null = $process.Handle
    while (-not $process.WaitForExit(250)) { }
    if ($process.ExitCode -ne 0) {
        throw "'$([IO.Path]::GetFileName($FilePath))' exited with code $($process.ExitCode)."
    }
}

function Find-Executable([string]$Name) {
    # Node installs ship an extension-less "npm" shell shim next to npm.cmd; only real Windows executables can be started.
    $candidates = @(Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue)
    $runnable = @($candidates | Where-Object { [IO.Path]::GetExtension($_.Path) -match '^\.(exe|cmd|bat|com)$' })
    if ($runnable.Count -gt 0) { return $runnable[0].Path }
    if ($candidates.Count -gt 0) { return $candidates[0].Path }
    return $null
}

function Get-ToolVersion([string]$FilePath) {
    # Version probes must never fail the build, and native stderr noise must not become a terminating error.
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath --version 2>&1 | Where-Object { $_ -is [string] } | Select-Object -First 1
        if ([string]::IsNullOrWhiteSpace($output)) { return 'unknown' }
        return $output.Trim()
    }
    catch {
        return 'unknown'
    }
}

function Require-Executable([string]$Name, [string]$Hint) {
    $path = Find-Executable $Name
    if ($null -eq $path) { throw "'$Name' was not found on PATH. $Hint" }
    Write-Info ("{0,-8} {1,-12} {2}" -f $Name, (Get-ToolVersion $path), $path)
    return $path
}

# ---- Download helpers ------------------------------------------------------------------------------------------------

function Save-RemoteFile([string]$Url, [string]$Destination) {
    $directory = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $partial = "$Destination.download"
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing
    Move-Item -LiteralPath $partial -Destination $Destination -Force
}

function Test-WindowsExecutable([string]$Path) {
    # A real PE file starts with the "MZ" signature; a captive-portal or error page does not.
    $stream = [IO.File]::OpenRead($Path)
    try {
        $header = New-Object byte[] 2
        $read = $stream.Read($header, 0, 2)
        return ($read -eq 2 -and $header[0] -eq 0x4D -and $header[1] -eq 0x5A)
    }
    finally {
        $stream.Dispose()
    }
}

# ---- Version -----------------------------------------------------------------------------------------------------------

function Get-ProjectVersion {
    $xml = [xml](Get-Content -LiteralPath $HostProject -Raw)
    $node = $xml.SelectSingleNode('/Project/PropertyGroup/Version')
    if ($null -eq $node -or [string]::IsNullOrWhiteSpace($node.InnerText)) {
        throw "No <Version> element found in $HostProject. Pass -Version explicitly."
    }
    return $node.InnerText.Trim()
}

function Get-FileVersion([string]$ProductVersion) {
    # Win32 file versions are strictly numeric (a.b.c.d); strip pre-release suffixes such as 1.2.0-beta.1.
    if ($ProductVersion -notmatch '^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?') {
        throw "Version '$ProductVersion' must start with major.minor.patch (for example 1.2.0 or 1.2.0-beta.1)."
    }
    $revision = if ($Matches[4]) { $Matches[4] } else { '0' }
    return "$($Matches[1]).$($Matches[2]).$($Matches[3]).$revision"
}

# ---- Build steps -------------------------------------------------------------------------------------------------------

function Build-Angular([string]$NpmPath) {
    if (Test-Path -LiteralPath (Join-Path $AngularDir 'node_modules')) {
        Write-Info 'node_modules present - skipping npm ci'
    }
    else {
        Write-Info 'node_modules missing - running npm ci'
        Invoke-Tool -FilePath $NpmPath -Arguments @('ci') -WorkingDirectory $AngularDir
    }

    Invoke-Tool -FilePath $NpmPath -Arguments @('run', 'build', '--', '--configuration', 'production') -WorkingDirectory $AngularDir

    $indexHtml = Join-Path $AngularDist 'index.html'
    if (-not (Test-Path -LiteralPath $indexHtml)) {
        throw "The Angular build finished but $indexHtml does not exist. Check angular.json (outputPath) and the build output above."
    }
    $files = Get-ChildItem -LiteralPath $AngularDist -Recurse -File
    Write-Ok ("Angular build ready: {0} files, {1} in {2}" -f $files.Count, (Format-Size (($files | Measure-Object Length -Sum).Sum)), $AngularDist)
}

function Publish-Host([string]$DotnetPath, [string]$ProductVersion) {
    if (-not (Test-Path -LiteralPath (Join-Path $AngularDist 'index.html'))) {
        throw "Angular output not found at $AngularDist. Run without -SkipAngular (or run 'npm run build' inside cat-desktop) before publishing - the csproj copies that folder into wwwroot/."
    }

    # dotnet publish never removes stale files; Angular emits new hashed chunk names on every build, so start clean.
    if (Test-Path -LiteralPath $PublishDir) {
        Write-Info "Cleaning $PublishDir"
        Remove-Item -LiteralPath $PublishDir -Recurse -Force
    }

    $selfContainedValue = if ($SelfContained) { 'true' } else { 'false' }
    $publishArguments = @(
        'publish', $HostProject,
        '-c', $Configuration,
        '-r', $Runtime,
        '--self-contained', $selfContainedValue,
        "-p:Version=$ProductVersion",
        "-p:FileVersion=$(Get-FileVersion $ProductVersion)",
        '-p:PublishReadyToRun=false',
        '-p:PublishSingleFile=false',
        # One-shot build: do not leave MSBuild / compiler server processes running after publish.
        '--disable-build-servers',
        '-o', $PublishDir
    )
    Invoke-Tool -FilePath $DotnetPath -Arguments $publishArguments
}

function Assert-PublishOutput {
    $exe = Join-Path $PublishDir 'CatDesktop.exe'
    $indexHtml = Join-Path (Join-Path $PublishDir 'wwwroot') 'index.html'

    if (-not (Test-Path -LiteralPath $exe)) {
        throw "Publish output incomplete: $exe is missing. Run without -SkipPublish, or check the dotnet publish output above."
    }
    if (-not (Test-Path -LiteralPath $indexHtml)) {
        throw "Publish output incomplete: $indexHtml is missing, so the packaged app would start without a UI. The csproj copies cat-desktop/dist/cat-desktop/browser into wwwroot/ - build the Angular app first (run without -SkipAngular), then publish again without -SkipPublish."
    }

    $files = Get-ChildItem -LiteralPath $PublishDir -Recurse -File
    Write-Ok ("Publish output verified: {0} files, {1} in {2}" -f $files.Count, (Format-Size (($files | Measure-Object Length -Sum).Sum)), $PublishDir)
}

function Find-SystemInnoSetup {
    $onPath = Find-Executable 'ISCC.exe'
    if ($null -ne $onPath) { return $onPath }

    $roots = @()
    foreach ($variable in @('ProgramFiles(x86)', 'ProgramFiles')) {
        $value = [Environment]::GetEnvironmentVariable($variable)
        if (-not [string]::IsNullOrEmpty($value)) { $roots += $value }
    }
    $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
    if (-not [string]::IsNullOrEmpty($localAppData)) { $roots += (Join-Path $localAppData 'Programs') }

    foreach ($root in $roots) {
        foreach ($folder in @('Inno Setup 6', 'Inno Setup 7')) {
            $candidate = Join-Path (Join-Path $root $folder) 'ISCC.exe'
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    return $null
}

function Install-InnoSetupFromNuGet {
    if (-not (Test-Path -LiteralPath $InnoPackageDir)) { New-Item -ItemType Directory -Path $InnoPackageDir -Force | Out-Null }

    $nupkg = Join-Path $InnoPackageDir "tools.innosetup.$InnoSetupPackageVersion.nupkg"
    if (Test-Path -LiteralPath $nupkg) {
        Write-Info "Using cached package $nupkg"
    }
    else {
        Write-Info "Downloading $InnoSetupPackageUrl"
        Save-RemoteFile -Url $InnoSetupPackageUrl -Destination $nupkg
        Write-Info ("Downloaded {0}" -f (Format-Size (Get-Item -LiteralPath $nupkg).Length))
    }

    # A .nupkg is a plain zip, but Expand-Archive insists on the .zip extension.
    $zip = [IO.Path]::ChangeExtension($nupkg, '.zip')
    Copy-Item -LiteralPath $nupkg -Destination $zip -Force
    $extractDir = Join-Path $InnoPackageDir $InnoSetupPackageVersion
    if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
    try {
        Expand-Archive -LiteralPath $zip -DestinationPath $extractDir -Force
    }
    finally {
        Remove-Item -LiteralPath $zip -Force
    }

    $compiler = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter 'ISCC.exe' -File | Select-Object -First 1
    if ($null -eq $compiler) {
        Remove-Item -LiteralPath $nupkg -Force
        throw "ISCC.exe was not found inside the Tools.InnoSetup $InnoSetupPackageVersion package. The cached package was deleted; run the build again."
    }

    # Keep only the compiler folder (tools/) as Installer/tools/innosetup; the expanded package is disposable.
    if (Test-Path -LiteralPath $InnoDir) { Remove-Item -LiteralPath $InnoDir -Recurse -Force }
    Copy-Item -LiteralPath $compiler.DirectoryName -Destination $InnoDir -Recurse -Force
    Remove-Item -LiteralPath $extractDir -Recurse -Force

    return (Join-Path $InnoDir 'ISCC.exe')
}

function Get-InnoSetupCompiler([bool]$ForceLocalCache) {
    $cached = Join-Path $InnoDir 'ISCC.exe'
    $compiler = $null

    if (Test-Path -LiteralPath $cached) {
        $compiler = $cached
        Write-Info "Using cached Inno Setup at $InnoDir"
    }
    elseif (-not $ForceLocalCache) {
        $compiler = Find-SystemInnoSetup
        if ($null -ne $compiler) { Write-Info "Using installed Inno Setup: $compiler" }
    }

    if ($null -eq $compiler) {
        Write-Info "Inno Setup not available - fetching NuGet package Tools.InnoSetup $InnoSetupPackageVersion"
        $compiler = Install-InnoSetupFromNuGet
    }

    Write-Ok "Inno Setup compiler: $compiler ($(Get-InnoSetupVersion $compiler))"
    return $compiler
}

function Get-InnoSetupVersion([string]$CompilerPath) {
    # ISCC.exe carries no usable version resource. Inno Setup 7.1+ answers --version ("7.1.0"); older compilers
    # print "Inno Setup 6 Command-Line Compiler" as the first banner line when started without arguments.
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $CompilerPath --version 2>&1 | Where-Object { $_ -is [string] })
        if ($LASTEXITCODE -eq 0 -and $output.Count -gt 0 -and $output[0] -match '^\d+(\.\d+)+$') { return "Inno Setup $($output[0].Trim())" }
        $banner = @(& $CompilerPath 2>&1 | Where-Object { $_ -is [string] -and $_ -match 'Inno Setup' })
        if ($banner.Count -gt 0) { return $banner[0].Trim() }
    }
    catch {
        # fall through
    }
    return 'unknown version'
}

function Get-WebView2Bootstrapper {
    if (Test-Path -LiteralPath $BootstrapperPath) {
        Write-Ok ("WebView2 bootstrapper cached: {0} ({1})" -f $BootstrapperPath, (Format-Size (Get-Item -LiteralPath $BootstrapperPath).Length))
        return $true
    }

    try {
        Write-Info "Downloading WebView2 Evergreen bootstrapper from $WebView2BootstrapperUrl"
        Save-RemoteFile -Url $WebView2BootstrapperUrl -Destination $BootstrapperPath
        if (-not (Test-WindowsExecutable $BootstrapperPath)) {
            Remove-Item -LiteralPath $BootstrapperPath -Force
            throw 'the downloaded file is not a Windows executable (proxy or captive portal page?)'
        }
        Write-Ok ("WebView2 bootstrapper cached: {0} ({1})" -f $BootstrapperPath, (Format-Size (Get-Item -LiteralPath $BootstrapperPath).Length))
        return $true
    }
    catch {
        Write-Warn "Could not download the WebView2 bootstrapper: $($_.Exception.Message)"
        Write-Warn 'Continuing without it. Windows 11 and up-to-date Windows 10 PCs already have the WebView2 Runtime;'
        Write-Warn 'on a PC without it, the installer will show a download hint instead of installing it silently.'
        return $false
    }
}

function Build-Installer([string]$CompilerPath, [string]$ProductVersion) {
    if (-not (Test-Path -LiteralPath $IssFile)) { throw "Installer script not found: $IssFile" }
    if (-not (Test-Path -LiteralPath $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }

    $selfContainedFlag = if ($SelfContained) { '1' } else { '0' }
    $compilerArguments = @(
        '/Qp',
        "/DAppVersion=$ProductVersion",
        "/DSourceDir=$PublishDir",
        "/DOutputDir=$OutputDir",
        "/DRedistDir=$RedistDir",
        "/DRuntime=$Runtime",
        "/DSelfContained=$selfContainedFlag",
        $IssFile
    )
    Invoke-Tool -FilePath $CompilerPath -Arguments $compilerArguments -WorkingDirectory $InstallerDir

    $suffix = if ($Runtime -eq 'win-arm64') { '-arm64' } else { '' }
    $setupPath = Join-Path $OutputDir "CatDesktop-Setup-$ProductVersion$suffix.exe"
    if (-not (Test-Path -LiteralPath $setupPath)) {
        throw "ISCC reported success but $setupPath was not produced. Check OutputBaseFilename in $IssFile."
    }
    return $setupPath
}

# ---- Main --------------------------------------------------------------------------------------------------------------

$stopwatch = [Diagnostics.Stopwatch]::StartNew()
try {
    Write-Host 'CatDesktop build' -ForegroundColor White
    Write-Info "Repository: $RepoRoot"

    if ($FetchToolsOnly) {
        Write-Step 'Fetching installer tools'
        $compiler = Get-InnoSetupCompiler -ForceLocalCache $true
        $bootstrapperReady = Get-WebView2Bootstrapper
        Write-Host ''
        Write-Ok "Tools ready. ISCC: $compiler"
        if (-not $bootstrapperReady) { Write-Warn 'WebView2 bootstrapper is NOT cached; re-run -FetchToolsOnly when online to add it.' }
        exit 0
    }

    if ([string]::IsNullOrWhiteSpace($Version)) { $Version = Get-ProjectVersion }
    $fileVersion = Get-FileVersion $Version
    Write-Info "Version: $Version (file version $fileVersion)  Configuration: $Configuration  Runtime: $Runtime  Self-contained: $SelfContained"

    Write-Step 'Checking prerequisites'
    $npm = $null
    $dotnet = $null
    if (-not $SkipAngular) {
        Require-Executable 'node' 'Install Node.js 22 LTS from https://nodejs.org/ (end users do not need it).' | Out-Null
        $npm = Require-Executable 'npm' 'npm ships with Node.js; re-install Node.js 22 LTS.'
    }
    if (-not $SkipPublish) {
        $dotnet = Require-Executable 'dotnet' 'Install the .NET 9 SDK from https://dotnet.microsoft.com/download/dotnet/9.0.'
    }
    if ($SkipAngular -and $SkipPublish) { Write-Info 'Angular and publish steps skipped - no SDK checks needed.' }

    if ($SkipAngular) {
        Write-Step 'Angular build skipped (-SkipAngular)'
    }
    else {
        Write-Step 'Building Angular app (production)'
        Build-Angular -NpmPath $npm
    }

    if ($SkipPublish) {
        Write-Step 'Publish skipped (-SkipPublish)'
    }
    else {
        Write-Step "Publishing host ($Configuration, $Runtime, self-contained=$SelfContained)"
        Publish-Host -DotnetPath $dotnet -ProductVersion $Version
    }
    Assert-PublishOutput

    if ($SkipInstaller) {
        Write-Step 'Installer skipped (-SkipInstaller)'
        Write-Ok "Publish folder is ready for manual packaging: $PublishDir"
    }
    else {
        Write-Step 'Preparing installer tools'
        $compiler = Get-InnoSetupCompiler -ForceLocalCache $false
        Get-WebView2Bootstrapper | Out-Null

        Write-Step 'Compiling installer'
        $setupPath = Build-Installer -CompilerPath $compiler -ProductVersion $Version
        $setupSize = (Get-Item -LiteralPath $setupPath).Length
        Write-Ok "Installer: $setupPath"
        Write-Ok ("Size:      {0}" -f (Format-Size $setupSize))
    }

    Write-Host ''
    Write-Host ("Done in {0:N0} s." -f $stopwatch.Elapsed.TotalSeconds) -ForegroundColor Green
    exit 0
}
catch {
    Write-Host ''
    Write-Host "BUILD FAILED: $($_.Exception.Message)" -ForegroundColor Red
    if ($null -ne $_.InvocationInfo -and -not [string]::IsNullOrWhiteSpace($_.InvocationInfo.PositionMessage)) {
        Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkGray
    }
    exit 1
}
