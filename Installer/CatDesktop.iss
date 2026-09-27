; =====================================================================================================================
;  CatDesktop - Inno Setup script (Inno Setup 6.3+ and 7.x)
;
;  Normally compiled by build.ps1 at the repository root:
;    ISCC.exe /Qp "/DAppVersion=<version>" "/DSourceDir=<publish folder>" "/DOutputDir=<Installer\output>"
;             "/DRedistDir=<Installer\redist>" "/DRuntime=win-x64" "/DSelfContained=1" CatDesktop.iss
;
;  Every /D symbol has a default below, so the script also compiles unchanged from the Inno Setup IDE
;  (after "dotnet publish" into Desktop\CatDesktop.Host\bin\publish\win-x64).
;
;  What the installer does
;    * Installs the published host (CatDesktop.exe, .NET runtime when self-contained, wwwroot\ with the Angular UI)
;      per user into {localappdata}\Programs\CatDesktop, or for all users into Program Files when the user chooses so.
;    * Optional desktop shortcut and, on a first per-user install only, "start when I sign in" (HKCU Run entry).
;      Afterwards the in-app "Start with Windows" setting owns that value; uninstall removes it when it starts this copy.
;    * Installs the Microsoft Edge WebView2 Runtime with the Evergreen bootstrapper when it is missing
;      (only when the bootstrapper was present in RedistDir at compile time; otherwise a download hint is shown).
;    * Refuses to run while CatDesktop is running (AppMutex; with /SUPPRESSMSGBOXES a silent run exits non-zero
;      instead of asking) and closes it when files are in use (CloseApplications).
;    * On an interactive per-user uninstall asks whether the user's local data (%LOCALAPPDATA%\CatDesktop) should be
;      deleted too (default No). Silent uninstalls never ask and keep it; all-users uninstalls keep it and explain why.
;  Keep this file ASCII-only: Inno Setup 7 rejects bytes that are invalid in the script's code page.
; =====================================================================================================================

; ---- Compile-time parameters (all overridable with /D) --------------------------------------------------------------

#ifndef Runtime
  #define Runtime "win-x64"
#endif
#ifndef SourceDir
  #define SourceDir AddBackslash(SourcePath) + "..\Desktop\CatDesktop.Host\bin\publish\" + Runtime
#endif
#ifndef OutputDir
  #define OutputDir AddBackslash(SourcePath) + "output"
#endif
#ifndef RedistDir
  #define RedistDir AddBackslash(SourcePath) + "redist"
#endif
#ifndef SelfContained
  #define SelfContained 1
#endif
; Values passed with /D arrive as strings ("0"), the default above is an integer: normalise once for the comparisons below.
#define FrameworkDependent Int(SelfContained, 1) == 0
#ifndef AppVersion
  #if FileExists(AddBackslash(SourceDir) + "CatDesktop.exe")
    ; Not passed on the command line: take the file version of the published exe and drop the 4th part (1.2.3.0 -> 1.2.3).
    #define private ExeVersion GetVersionNumbersString(AddBackslash(SourceDir) + "CatDesktop.exe")
    #define AppVersion Copy(ExeVersion, 1, RPos(".", ExeVersion) - 1)
  #else
    #define AppVersion "1.0.0"
  #endif
#endif

#define AppName "CatDesktop"
#define AppExeName "CatDesktop.exe"
; Must match SingleInstance.MutexName in the host (created in the session-local namespace, which is what Setup checks).
#define AppMutexName "CatDesktop.SingleInstance.v1"
#define WebView2BootstrapperName "MicrosoftEdgeWebview2Setup.exe"
#define WebView2DownloadUrl "https://developer.microsoft.com/microsoft-edge/webview2/"
#define DotNetDownloadUrl "https://dotnet.microsoft.com/download/dotnet/9.0"
; "win-x64" -> "x64", "win-arm64" -> "arm64": used for the .NET runtime registry check of framework-dependent builds.
#define DotNetArch Copy(Runtime, Pos("-", Runtime) + 1, Len(Runtime))

#if FileExists(AddBackslash(RedistDir) + WebView2BootstrapperName)
  #define HasWebView2Bootstrapper
  #pragma message "WebView2 bootstrapper found in " + RedistDir + " - it will be embedded and run when the runtime is missing."
#else
  #pragma message "WebView2 bootstrapper NOT found in " + RedistDir + " - the installer will only show a download hint (run build.ps1 -FetchToolsOnly)."
#endif

#if Runtime != "win-x64" && Runtime != "win-arm64"
  #error Runtime must be win-x64 or win-arm64
#endif

; ---- [Setup] --------------------------------------------------------------------------------------------------------

[Setup]
; Stable per-product GUID: keep it forever so upgrades replace the previous installation instead of adding a second one.
AppId={{2E8EAACD-8EBB-481E-BD05-604016CA12D1}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
; Per-user install by default (no UAC prompt); the dialog lets the user pick an all-users install instead.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
; The HKCU Run entry and the {localappdata} data folder are per-user areas. Both are only touched in per-user mode
; (task Check StartupTaskAvailable, IsAdminInstallMode in CurUninstallStepChanged), so silence the compiler's warning.
UsedUserAreasWarning=no
#if Runtime == "win-arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
OutputBaseFilename={#AppName}-Setup-{#AppVersion}-arm64
#else
; x64compatible = x64 Windows and Arm64 Windows (which runs x64 binaries through emulation).
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename={#AppName}-Setup-{#AppVersion}
#endif
#if Ver >= EncodeVer(7,0,0,0)
; Inno Setup 7 can produce a native 64-bit setup executable; the directive does not exist in Inno Setup 6.
SetupArchitecture=x64
#endif
OutputDir={#OutputDir}
SetupIconFile=..\Desktop\CatDesktop.Host\Assets\app.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; Setup and Uninstall refuse to start while the app holds its single-instance mutex ...
AppMutex={#AppMutexName}
; ... and, should a file still be locked, Restart Manager closes the app instead of failing.
CloseApplications=yes
RestartApplications=no
; Windows 10 1809 (build 17763) is the oldest Windows the WebView2 Runtime supports.
MinVersion=10.0.17763
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup

; ---- Languages / messages -------------------------------------------------------------------------------------------

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
StartupTask=Start {#AppName} when I sign in
InstallingWebView2=Installing Microsoft Edge WebView2 Runtime...
WebView2Missing={#AppName} needs the Microsoft Edge WebView2 Runtime, which is not installed on this PC.%n%nOpen the Microsoft download page now? {#AppName} will start once the runtime is installed.
DotNetMissing={#AppName} needs the .NET 9 Desktop Runtime ({#DotNetArch}), which is not installed on this PC.%n%nOpen the Microsoft download page now?
DeleteDataQuestion=Also delete your local {#AppName} data (notes, tasks, settings)?%n%nFolder: %1
DeleteDataFailed=Some files in %1 could not be removed. You can delete the folder manually.
DataKeptAllUsers={#AppName} was installed for all users. Each user's notes, tasks and settings stay in that user's own %1 folder and were not deleted.%n%nEach user can delete that folder if the data is no longer needed.

; ---- Tasks ----------------------------------------------------------------------------------------------------------

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
; Offered unchecked, and only on a first per-user install (see StartupTaskAvailable): an upgrade would otherwise
; re-select it from the remembered task list (UsePreviousTasks) and silently re-enable autostart.
Name: "startup"; Description: "{cm:StartupTask}"; GroupDescription: "{cm:AutoStartProgramGroupDescription}"; Flags: unchecked; Check: StartupTaskAvailable

; ---- Files ----------------------------------------------------------------------------------------------------------

[InstallDelete]
; Angular emits new content-hashed chunk names on every build; drop the previous UI folder so upgrades leave no orphans.
Type: filesandordirs; Name: "{app}\wwwroot"

[Files]
; The complete publish folder: CatDesktop.exe, .NET runtime (self-contained builds), native SQLite/WebView2 loaders
; and wwwroot\ (the production Angular build). ignoreversion makes reinstalls and downgrades overwrite everything.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs
#ifdef HasWebView2Bootstrapper
; Extracted to {tmp} (cleaned up automatically) only when the WebView2 Runtime is missing on the target PC.
Source: "{#RedistDir}\{#WebView2BootstrapperName}"; DestDir: "{tmp}"; Check: WebView2Missing
#endif

; ---- Shortcuts / registry -------------------------------------------------------------------------------------------

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Comment: "Notes, tasks, focus timer and the desktop Cat Companion"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon
Name: "{autoprograms}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"

[Registry]
; "Start when I sign in": launches hidden in the tray. Same HKCU Run value the in-app "Start with Windows" toggle manages;
; the app takes it over as its setting on the next start. RemoveRunValue also cleans up a value the app wrote itself.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExeName}"" --hidden"; Flags: uninsdeletevalue; Tasks: startup

; ---- Run ------------------------------------------------------------------------------------------------------------

[Run]
#ifdef HasWebView2Bootstrapper
; The Evergreen bootstrapper downloads and installs the WebView2 Runtime (per user when Setup is not elevated).
Filename: "{tmp}\{#WebView2BootstrapperName}"; Parameters: "/silent /install"; StatusMsg: "{cm:InstallingWebView2}"; Check: WebView2Missing; Flags: waituntilterminated
#endif
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

; [UninstallDelete] is intentionally empty: user data lives in {localappdata}\CatDesktop and is only removed when the
; user confirms the question asked by OfferDataRemoval below (interactive per-user uninstalls only).

; ---- Code -----------------------------------------------------------------------------------------------------------

[Code]
const
  // Microsoft Edge WebView2 Runtime client id registered by Edge Update (per machine under WOW6432Node, per user under HKCU).
  WebView2ClientKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2ClientKeyWow64 = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
#if FrameworkDependent
  DotNetDesktopRuntimeKey = 'SOFTWARE\dotnet\Setup\InstalledVersions\{#DotNetArch}\sharedfx\Microsoft.WindowsDesktop.App';
#endif
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';

var
  StartupTaskEvaluated: Boolean;
  StartupTaskResult: Boolean;

// Check function of the "startup" task. Offered only on a first per-user install:
//  * all-users mode: HKCU would be the elevating account's hive, not the signed-in user's; each user turns
//    "Start with Windows" on in the app instead;
//  * upgrade/repair: the in-app setting owns the Run value by then, and the task remembered from the previous
//    installation (UsePreviousTasks) would silently re-enable autostart the user may have turned off in the app.
// Evaluated once and cached: Setup may call it again during the installation, after it has written the uninstall key.
function StartupTaskAvailable(): Boolean;
begin
  if not StartupTaskEvaluated then
  begin
    StartupTaskResult := not IsAdminInstallMode and
      not RegKeyExists(HKA, ExpandConstant('Software\Microsoft\Windows\CurrentVersion\Uninstall\{#SetupSetting("AppId")}_is1'));
    StartupTaskEvaluated := True;
  end;
  Result := StartupTaskResult;
end;

// True when the "pv" (product version) value at RootKey\SubKey names an installed WebView2 Runtime.
function HasWebView2Version(const RootKey: Integer; const SubKey: String): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(RootKey, SubKey, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

// Used as Check function: extract and run the bootstrapper only when no WebView2 Runtime is registered.
function WebView2Missing(): Boolean;
begin
  Result := not (HasWebView2Version(HKLM64, WebView2ClientKeyWow64) or
                 HasWebView2Version(HKLM64, WebView2ClientKey) or
                 HasWebView2Version(HKCU, WebView2ClientKey));
end;

#if FrameworkDependent
// Framework-dependent build only: the .NET installers register every shared framework version as a value name.
function DotNetDesktopRuntimeMissing(): Boolean;
var
  Names: TArrayOfString;
  I: Integer;
begin
  Result := True;
  if RegGetValueNames(HKLM64, DotNetDesktopRuntimeKey, Names) then
    for I := 0 to GetArrayLength(Names) - 1 do
      if Pos('9.', Names[I]) = 1 then
        Result := False;
end;
#endif

// Asks whether to open a download page; skipped (answer "No") during silent installs, also without /SUPPRESSMSGBOXES,
// so an unattended install never waits for a click.
procedure OfferDownload(const Question, Url: String);
var
  ErrorCode: Integer;
begin
  if WizardSilent then
    Exit;
  if SuppressibleMsgBox(Question, mbConfirmation, MB_YESNO or MB_DEFBUTTON1, IDNO) = IDYES then
    ShellExec('open', Url, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;

// The non-postinstall [Run] entries (WebView2 bootstrapper) have finished by the time the Finished page appears,
// so a runtime still missing here means it was not embedded or the bootstrapper failed (for example: no internet).
procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
#if FrameworkDependent
    if DotNetDesktopRuntimeMissing then
      OfferDownload(CustomMessage('DotNetMissing'), '{#DotNetDownloadUrl}');
#endif
    if WebView2Missing then
      OfferDownload(CustomMessage('WebView2Missing'), '{#WebView2DownloadUrl}');
  end;
end;

// The in-app "Start with Windows" toggle writes the Run value itself, so the uninstall log may not know about it.
// Remove it only when it starts this installation; a value that points at another copy (a portable or development
// build) is left alone.
procedure RemoveRunValue();
var
  Command: String;
begin
  if RegQueryStringValue(HKCU, RunKey, '{#AppName}', Command) and
     (Pos(Lowercase(AddBackslash(ExpandConstant('{app}'))), Lowercase(Command)) > 0) then
    RegDeleteValue(HKCU, RunKey, '{#AppName}');
end;

// After the program files are gone, offer to remove the per-user data folder as well. Silent uninstalls never ask and
// keep the data (so /VERYSILENT without /SUPPRESSMSGBOXES cannot block either). An all-users uninstall runs elevated,
// possibly under another account, and cannot reach the data of every user, so it only explains where the data is.
procedure OfferDataRemoval();
var
  DataDir: String;
begin
  if UninstallSilent then
    Exit;
  if IsAdminInstallMode then
  begin
    SuppressibleMsgBox(FmtMessage(CustomMessage('DataKeptAllUsers'), ['%LOCALAPPDATA%\{#AppName}']), mbInformation, MB_OK, IDOK);
    Exit;
  end;
  DataDir := ExpandConstant('{localappdata}\{#AppName}');
  if DirExists(DataDir) then
    if SuppressibleMsgBox(FmtMessage(CustomMessage('DeleteDataQuestion'), [DataDir]), mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
      if not DelTree(DataDir, True, True, True) then
        SuppressibleMsgBox(FmtMessage(CustomMessage('DeleteDataFailed'), [DataDir]), mbInformation, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  case CurUninstallStep of
    usUninstall: RemoveRunValue;
    usPostUninstall: OfferDataRemoval;
  end;
end;
