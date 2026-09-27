# CatDesktop - Build and Release

This document describes exactly what `build.ps1` does, how versions flow through the pipeline, what the installer does
on the target PC, and the checklist for shipping a build to another computer. For the day-to-day developer loop see the
"Run in development" section of the [README](../README.md).

## 1. Pipeline overview

```
cat-desktop/                    Desktop/CatDesktop.Host/                    Installer/
  npm ci (if needed)              dotnet publish -r win-x64 --self-contained  ISCC.exe CatDesktop.iss
  npm run build (production)        copies dist/cat-desktop/browser            embeds publish\win-x64\* (+ WebView2 bootstrapper)
        |                            into wwwroot/ next to CatDesktop.exe             |
        v                                     |                                       v
dist/cat-desktop/browser  ---->  bin/publish/win-x64/{CatDesktop.exe,wwwroot,...} ---->  output/CatDesktop-Setup-<version>.exe
```

One command runs everything:

```powershell
.\build.ps1
```

Steps, in order, with the exact commands the script executes (paths are absolute at run time):

| Step | What happens | Skip with |
|---|---|---|
| Prerequisites | Locates `node`, `npm`, `dotnet` on `PATH`, prints their versions. Only the tools needed for the steps that will run are required. | - |
| Angular | `npm ci` in `cat-desktop/` when `node_modules` is missing, then `npm run build -- --configuration production`. Verifies `dist/cat-desktop/browser/index.html`. | `-SkipAngular` |
| Publish | Deletes the previous publish folder, then `dotnet publish Desktop/CatDesktop.Host/CatDesktop.Host.csproj -c Release -r win-x64 --self-contained true -p:Version=<v> -p:FileVersion=<v>.0 -p:PublishReadyToRun=false -p:PublishSingleFile=false --disable-build-servers -o Desktop/CatDesktop.Host/bin/publish/win-x64`. Verifies `CatDesktop.exe` and `wwwroot/index.html`. | `-SkipPublish` |
| Tools | Ensures `Installer/tools/innosetup/ISCC.exe` and `Installer/redist/MicrosoftEdgeWebview2Setup.exe` (details below). | `-SkipInstaller` |
| Installer | `ISCC.exe /Qp "/DAppVersion=<v>" "/DSourceDir=<publish dir>" "/DOutputDir=<Installer/output>" "/DRedistDir=<Installer/redist>" "/DRuntime=win-x64" "/DSelfContained=1" Installer/CatDesktop.iss`, then prints the setup path and size. | `-SkipInstaller` |

The publish output is verified even when publishing is skipped, so `-SkipAngular -SkipPublish` can never package a
folder without a UI. The script is Windows PowerShell 5.1 compatible, uses `$ErrorActionPreference = 'Stop'` and exits
with code 1 on any failure (child processes are run through `Start-Process` so that npm/dotnet/ISCC warnings written to
stderr never abort the build). The script waits for the tool process itself (`WaitForExit`), not for `Start-Process
-Wait`, which would also wait for every descendant: an MSBuild node or compiler server left running by dotnet would
block the build forever. `--disable-build-servers` keeps `dotnet publish` from starting such servers in the first place.
`dev.ps1` runs `dotnet run` the same way.

## 2. Versioning

* The single source of truth is `<Version>` in `Desktop/CatDesktop.Host/CatDesktop.Host.csproj` (`1.0.0` today).
  `build.ps1` reads it when `-Version` is not given.
* `-p:Version=<v>` stamps the assembly informational version; `HostConfig` reads it at run time, so `app.getInfo`,
  the *About* information and the log header show the same version as the installer.
* `-p:FileVersion=<v>.0` keeps the Win32 file version (Explorer -> Properties -> Details) in sync. Pre-release suffixes
  such as `1.2.0-beta.1` are allowed in the product version; the numeric prefix is used for the file version.
* Inno Setup receives `/DAppVersion=<v>`; it becomes `AppVersion`, the *Apps & features* entry and the file name
  `CatDesktop-Setup-<v>.exe` (`-arm64` suffix for `-Runtime win-arm64`).
* `AppId` in `CatDesktop.iss` (`{2E8EAACD-8EBB-481E-BD05-604016CA12D1}`) identifies the product. **Never change it**:
  it is what makes a newer setup upgrade the existing installation instead of installing a second copy.

To release a new version: change `<Version>` in the csproj (or pass `-Version`), build, test, ship.

## 3. Tooling that build.ps1 downloads

Nothing has to be installed for packaging. On the first run (or with `-FetchToolsOnly`) the script fetches:

| Tool | Source | Cached at |
|---|---|---|
| Inno Setup 6.7.3 compiler (includes ISPP) | NuGet package `Tools.InnoSetup` 6.7.3: `https://api.nuget.org/v3-flatcontainer/tools.innosetup/6.7.3/tools.innosetup.6.7.3.nupkg` (a zip). The `.nupkg` is kept in `Installer/tools/innosetup-pkg/`, its `tools/` folder is copied to `Installer/tools/innosetup/`. | `Installer/tools/innosetup/ISCC.exe` |
| WebView2 Evergreen bootstrapper (about 1.8 MB, signed by Microsoft) | `https://go.microsoft.com/fwlink/p/?LinkId=2124703` | `Installer/redist/MicrosoftEdgeWebview2Setup.exe` |

Resolution order for the compiler: cached copy in `Installer/tools/innosetup` -> `ISCC.exe` on `PATH` ->
`Inno Setup 6`/`Inno Setup 7` under `Program Files (x86)`, `Program Files` or `%LOCALAPPDATA%\Programs` -> download.
`-FetchToolsOnly` always fills the repo-local cache so a clone is self-sufficient afterwards.

The script requires TLS 1.2 for downloads and validates that the bootstrapper is a real Windows executable. If the
bootstrapper download fails, the build **continues with a warning**: the installer is then compiled without it and
shows a download hint on PCs that lack the WebView2 Runtime instead of installing it silently.

**Licence**: Inno Setup 6 is free software. Its licence (`Installer/tools/innosetup/license.txt`) permits use "for any
purpose, including commercial applications", so building and selling or distributing CatDesktop setups needs no paid
licence. The conditions: keep Inno Setup's copyright notices in place (a compiled setup keeps them in its *About
Setup* box as long as that is not altered), do not misrepresent its origin, and mark modified versions of Inno Setup
as such. An acknowledgment in the product documentation is appreciated but not required.

To pin a newer compiler, change `$InnoSetupPackageVersion` at the top of `build.ps1`; list the available versions with
`dotnet package search Tools.InnoSetup --exact-match`. Stay on the 6.x line unless you have checked the licence terms
of a newer major version. The script is verified with Inno Setup 6.7.3. The `.iss` targets Inno Setup 6.3 or newer and
is meant to keep compiling with 7.x (earlier revisions were verified with 7.1.0; the 7-only `SetupArchitecture`
directive is guarded).

All of `Installer/tools/`, `Installer/redist/` and `Installer/output/` are git-ignored.

## 4. The installer (Installer/CatDesktop.iss)

Compile-time symbols (all have defaults, so the script also compiles from the Inno Setup IDE after a manual publish):

| Symbol | Passed by build.ps1 | Default |
|---|---|---|
| `AppVersion` | `-Version` / csproj version | File version of `CatDesktop.exe` in `SourceDir` (minus the 4th part), else `1.0.0` |
| `SourceDir` | absolute publish folder | `..\Desktop\CatDesktop.Host\bin\publish\<Runtime>` |
| `OutputDir` | absolute `Installer\output` | `Installer\output` |
| `RedistDir` | absolute `Installer\redist` | `Installer\redist` |
| `Runtime` | `win-x64` or `win-arm64` | `win-x64` |
| `SelfContained` | `1` or `0` | `1` |

Behaviour on the target PC:

* **Scope**: `PrivilegesRequired=lowest` with the override dialog. Default is a per-user install into
  `%LOCALAPPDATA%\Programs\CatDesktop` without UAC; *all users* installs into `Program Files` after elevation.
* **Architecture**: `x64compatible` (x64 Windows and Arm64 Windows through emulation) for `win-x64` builds; `arm64` only
  for `win-arm64` builds. Minimum Windows 10 1809 (build 17763). With Inno Setup 7 the setup itself is a 64-bit exe.
* **Files**: the whole publish folder (`*.pdb` excluded) with `ignoreversion`, so reinstalls and downgrades overwrite.
  `[InstallDelete]` removes the old `{app}\wwwroot` first because Angular's hashed chunk names change every build.
* **Shortcuts**: Start menu entry, optional desktop shortcut (task, checked), *Uninstall CatDesktop* entry.
* **Start when I sign in** (task, unchecked): `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\CatDesktop =
  "<app>\CatDesktop.exe" --hidden`. The in-app *Start with Windows* setting (`app.startWithWindows`) manages the same
  value: on its first start the app adopts the value as its setting, and from then on the setting wins at every start
  (see the contract). So the task is offered only where it can mean something (`Check: StartupTaskAvailable`):
  * only on a **first install** (no uninstall key for this `AppId` yet). On an upgrade or repair the task is hidden;
    otherwise `UsePreviousTasks` would re-select it from the previous installation and silently re-enable autostart
    that the user had turned off in the app. (`dontinheritcheck` cannot do this: it only affects child tasks.)
  * only in **per-user** mode. In an all-users install, HKCU is the hive of the elevating account, which may be another
    user than the one signed in; each user turns *Start with Windows* on in the app instead.
  * If CatDesktop data from an earlier installation is still present, the setting stored there wins over the task.
* **WebView2**: `[Code] WebView2Missing` reads value `pv` under
  `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` (64-bit view, also
  the non-WOW path) and `HKCU\Software\Microsoft\EdgeUpdate\Clients\{...}`; empty or `0.0.0.0` means missing. When it is
  missing and the bootstrapper was embedded at compile time, `MicrosoftEdgeWebview2Setup.exe /silent /install` runs
  during installation (status "Installing Microsoft Edge WebView2 Runtime..."; needs internet). If the runtime is still
  missing on the Finished page (not embedded, or the bootstrapper failed) the user is offered the Microsoft download page.
* **.NET** (framework-dependent builds only, `SelfContained=0`): the Finished page also checks
  `HKLM\SOFTWARE\dotnet\Setup\InstalledVersions\<arch>\sharedfx\Microsoft.WindowsDesktop.App` for a 9.x entry and offers
  the .NET 9 Desktop Runtime download when none is found.
* **Running app**: `AppMutex=CatDesktop.SingleInstance.v1` (the host's single-instance mutex, session namespace) makes
  Setup and Uninstall ask the user to close CatDesktop (*OK* retries, *Cancel* exits). With `/SUPPRESSMSGBOXES` a silent
  run answers *Cancel*, so it exits with a non-zero code and changes nothing instead of waiting. Without that switch the
  question appears even in a silent run. `CloseApplications=yes` closes (without restarting) other programs that hold
  files Setup must replace; a silent run does that automatically.
* **Launch**: *Launch CatDesktop* checkbox on the Finished page (`postinstall skipifsilent nowait`).
* **Uninstall**: removes files, shortcuts and the Run entry. It also removes a Run value written by the in-app toggle
  (which the uninstall log does not know about), but only when its command points into `{app}`; a value that starts
  another copy stays. Then, for an **interactive per-user** uninstall only, it asks *Also delete your local CatDesktop
  data (notes, tasks, settings)?* (default *No*) and, on *Yes*, deletes `%LOCALAPPDATA%\CatDesktop`.
  * **Silent** uninstalls (`/SILENT`, `/VERYSILENT`, with or without `/SUPPRESSMSGBOXES`) never ask about the data and keep it.
  * **All-users** uninstalls keep the data and show a note: they run elevated, possibly as another account, and cannot
    reach every user's `%LOCALAPPDATA%`. Each user deletes their own folder if needed. The same applies to a Run value
    a user created in the app: the uninstaller only cleans the hive of the account it runs as, and Windows skips a
    Run entry whose program is gone.
* **Silent install**: `CatDesktop-Setup-<v>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` (add `/CURRENTUSER` or
  `/ALLUSERS` to skip the scope dialog, `/TASKS="desktopicon,startup"` to pick tasks). The WebView2 / .NET download
  offers on the Finished page are skipped in silent mode. Standard Inno Setup switches apply.
* **Silent uninstall**: `"<app>\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` (the command is also in the
  `UninstallString` / `QuietUninstallString` values under the `..._is1` uninstall key).

Quick way to iterate on the script: `.\build.ps1 -SkipAngular -SkipPublish` recompiles only the installer.

## 5. Variants

| Variant | Command | Result |
|---|---|---|
| Default x64, self-contained | `.\build.ps1` | Runs on any 64-bit Windows 10 1809+/11 without prerequisites (WebView2 installed on demand). Largest download. |
| Framework-dependent | `.\build.ps1 -SelfContained:$false` | Much smaller setup; target PC needs the .NET 9 Desktop Runtime (x64). The installer checks and offers the download. |
| Native Arm64 | `.\build.ps1 -Runtime win-arm64` | `CatDesktop-Setup-<v>-arm64.exe`, installs only on Arm64 Windows. The default x64 setup also runs there under emulation. |
| Debug host | `.\build.ps1 -Configuration Debug` | For diagnosing packaging issues; Debug builds fall back to the dev URL when `wwwroot` is missing. |

## 6. Release checklist - shipping to another PC

Only one file has to leave the build machine: `Installer/output/CatDesktop-Setup-<version>.exe`. The setup contains the
host, the .NET runtime, the Angular UI and (when it was cached) the WebView2 bootstrapper. The target PC does not need
Node.js, the .NET SDK, Inno Setup or a copy of the repository.

1. `git status` is clean and the intended commit is checked out.
2. Bump `<Version>` in `Desktop/CatDesktop.Host/CatDesktop.Host.csproj` (or decide on `-Version`).
3. If new SQL migrations were added, confirm they are in `Database/Migrations/` (they are embedded automatically) and
   that they upgrade an existing `application.db` from the previous release.
4. Run the end-to-end suite against a Debug build of the same commit (see `tests/e2e/README.md`):
   `node tests/e2e/bridge-smoke.mjs --exe <debug build>\CatDesktop.exe` must exit 0.
5. Make sure the tooling cache is complete: `.\build.ps1 -FetchToolsOnly` must report both ISCC and the WebView2
   bootstrapper (otherwise the installer cannot install WebView2 on PCs that lack it).
6. Build: `.\build.ps1` (add `-Version` if not taken from the csproj). Check the summary line for the setup path and
   size.
7. Smoke test the setup on a clean PC or VM (ideally Windows 10 1809 without WebView2, and Windows 11):
   * per-user install without UAC, main window and the cat appear (the cat walks after a few seconds), tray icon present;
   * create a note and a task, start the focus timer, press `Ctrl+Shift+P`;
   * close and reopen: data and window positions persist;
   * run the same setup again (repair) and a previous version's setup over it (upgrade) - data survives;
   * autostart: install fresh with *Start when I sign in*, turn *Start with Windows* off in the app, upgrade - the
     task is not offered and the Run value stays absent (`reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run`);
   * uninstall: answer *No* to the data question, confirm `%LOCALAPPDATA%\CatDesktop` still exists; reinstall;
     uninstall again with *Yes* and confirm the folder is gone;
   * silent: `/VERYSILENT /SUPPRESSMSGBOXES` install while CatDesktop runs exits non-zero without changes; silent
     uninstall finishes without any window and keeps `%LOCALAPPDATA%\CatDesktop`.
8. Record the SHA-256 for the release notes: `Get-FileHash Installer\output\CatDesktop-Setup-<version>.exe`.
9. Ship the single `.exe` (mail, share, download link). Tell users about the SmartScreen prompt (the setup is not
   code-signed) and that only 64-bit Windows 10 1809+ / Windows 11 is supported.
10. Tag the commit (`git tag v<version>`).

## 7. Troubleshooting the build

| Message | Fix |
|---|---|
| `'node' was not found on PATH` / `'dotnet' was not found on PATH` | Install Node.js 22 LTS / .NET 9 SDK, reopen the terminal. Use `-SkipAngular`/`-SkipPublish` if you only need the installer step. |
| `npm ci` fails with lock-file errors | `package.json` and `package-lock.json` diverged. Run `npm install` in `cat-desktop` once, commit the lock file. |
| Angular budget errors (`exceeded maximum budget`) | Raise the budgets in `cat-desktop/angular.json` or reduce the bundle; this is a hard error in the production configuration. |
| `Publish output incomplete: ...wwwroot\index.html is missing` | The Angular output was absent when `dotnet publish` ran. Run without `-SkipAngular`, then without `-SkipPublish`. |
| `dotnet publish` fails with NETSDK errors about the runtime identifier | Only `win-x64` and `win-arm64` are declared in the csproj (`RuntimeIdentifiers`). |
| `Could not download the WebView2 bootstrapper` (warning) | Proxy or offline. The build continues; re-run `-FetchToolsOnly` later or copy the file into `Installer/redist/` manually. |
| Inno Setup download fails | Copy `Installer/tools/` from another machine, or install Inno Setup 6/7 (found automatically). |
| ISCC: `Error on line N ... Operator not applicable` | `/D` values arrive as strings; compare with `Int(...)`/`Str(...)` in ISPP expressions (see `FrameworkDependent` in the script). |
| ISCC: `Source file "...\*" does not exist` | The `SourceDir` passed does not contain files; check the publish folder. |
| Installer compiles but is tiny | The publish folder was framework-dependent or partially deleted; look at the file count printed after the publish step. |

## 8. Continuous integration notes

`build.ps1` is non-interactive and works on a fresh Windows agent with Node 22 and the .NET 9 SDK installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -Version 1.2.$env:BUILD_NUMBER
```

Cache `cat-desktop/node_modules`, `Installer/tools/` and `Installer/redist/` between runs to avoid re-downloading;
publish `Installer/output/*.exe` as the build artefact.
