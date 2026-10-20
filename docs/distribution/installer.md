# Installer: one file per platform

Prerequisites: [product-changes.md](product-changes.md). Without dropping
Python and PowerShell and without the `setup` engine, an installer would only
copy files, and everything would still have to be configured by hand.

## What gets installed

| Part | Source | Size (estimate) |
| --- | --- | --- |
| Atlas (Electron 41) | in the installer | about 90-120 MB compressed installer |
| Gateway (`application-gateway-cli` bundle, 1.2 MB) and controller template | in the installer, in the app resources | a few MB |
| `agents-factory` CLI | in the installer (same code); a link in `PATH` is opt-in (checkbox) | - |
| Claude Agent SDK and the `claude` binary | **not in the installer**: the wizard installs it from npm on first run | about 240 MB per platform |
| Git | not in the installer: the wizard checks for it and explains how to install it | - |

## Technology: electron-builder

electron-builder builds all the needed formats from one configuration and
provides auto-update (electron-updater) from GitHub Releases:

| OS | Build formats | Auto-update |
| --- | --- | --- |
| Windows | NSIS `.exe` (main), MSI (for companies, later) | NSIS |
| macOS | `.dmg` (+ `.zip` for update metadata) | `.dmg`, needs signing |
| Linux | `.deb`, `.rpm`, `.AppImage` | AppImage, deb, rpm (package signatures: `allowUnverifiedLinuxPackages=false` once we have our own keys) |

Electron Forge was considered: it uses Squirrel.Windows (which
electron-updater does not support) and has no AppImage out of the box.
MSIX/Store, the Mac App Store, Flatpak and Snap do not fit for now: their
sandboxes get in the way of running `git`, `claude` and agents in arbitrary
project folders.

## Windows

- **NSIS, per-user install** (`perMachine: false`) into
  `%LOCALAPPDATA%\Programs\AgentsFactory`, without administrator rights or
  UAC. A Start menu shortcut; the CLI in the user `PATH` is opt-in
  (checkbox).
- **Silent install:** `AgentsFactory-Setup-<version>.exe /S`, for winget,
  corporate scripts and CI.
- **Authenticode signing.** The first releases are unsigned: SmartScreen
  shows "Windows protected your PC", and the app starts through "More info →
  Run anyway"; the README has instructions and `SHA256SUMS`. Before a wide
  release: signing with publisher **Aleksandr Khutornoi** through SignPath
  Foundation (free for open source) or Azure Trusted Signing (about $10 a
  month; availability for an individual is still to be checked). The
  installer, the app `.exe` and the uninstaller are signed.
- **winget:** a manifest in `microsoft/winget-pkgs` after the first signed
  release (`winget install AgentsFactory.AgentsFactory`).
- **MSI** later, if users in companies appear (Intune, GPO).

## macOS

- **`.dmg`** with the app to drag into Applications. One universal build
  (arm64 + x64) or two separate ones: decide by size.
- **Developer ID signing + hardened runtime + notarization** (`notarytool`,
  stapling), publisher **Aleksandr Khutornoi**, Apple Developer Program ($99
  a year). Without it, Gatekeeper does not open the app (since macOS 15, only
  through "System Settings → Privacy & Security → Open Anyway"), and
  auto-update does not work. The first macOS builds can ship unsigned with
  these instructions; for regular users, only signed builds.
- **No Mac and no Xcode project.** GitHub Actions macOS runners build, sign
  and notarize (they have the Xcode Command Line Tools); the keys are in
  secrets. xtool is not needed (it builds only iOS apps), and neither are
  Swift templates (they are for native Swift apps): electron-builder runs the
  same pipeline: `.app`, `codesign`, `notarytool`, DMG, updates.
- **Entitlements** for Electron (JIT); the App Store sandbox is not used.
- **The `claude` binary** is installed into `~/Library/Application Support/...`
  by our code, not by a browser, so it has no quarantine attribute. Before a
  release, verify that the SDK binary is signed by Anthropic and runs under
  Gatekeeper.
- **Homebrew:** a cask for the app (`brew install --cask agents-factory`), a
  formula for the CLI.
- The headless Gateway is a launchd agent (`~/Library/LaunchAgents`).

## Linux

- **`.deb` and `.rpm`** are the main formats for Ubuntu/Debian and Fedora:
  the system package manager installs them, and they can install an AppArmor
  profile.
- **`.AppImage`**: one file for the other distributions, no root.
- **Risk: Ubuntu 24.04+.** AppArmor forbids unprivileged user namespaces by
  default, and Electron builds its sandbox on them. An AppImage without a
  profile will not start or will need `--no-sandbox` (disabling the sandbox
  is not acceptable). For `.deb`, we ship an AppArmor profile for the app's
  main binary; for AppImage, we document how to install the profile. Test on
  every Ubuntu version in CI.
- On some distributions, AppImage needs `libfuse2`; say so in the
  instructions.
- The headless Gateway is a `systemd --user` unit.

## First run: the wizard in Atlas

The wizard is a UI over `agents-factory setup` ([cli.md](cli.md)); each step
shows what was done and can be repeated.

1. **Check:** git, disk space, data directory. If git is missing, the wizard
   shows instructions for the OS (Windows: `winget install Git.Git`).
2. **Claude:**
   - install the pinned Claude Agent SDK version (with download progress);
   - **Anthropic API key**: an input field with a link to the Claude Console,
     a key check without an agent turn, storage in the system credential
     store. The product does not offer claude.ai subscription sign-in
     (Anthropic's Agent SDK policy, see
     [product-changes.md](product-changes.md)).
3. **Telemetry:** a choice screen with two equal buttons and no default
   ([telemetry.md](telemetry.md)).
4. **Controller:** create an instance in the data directory (the path can be
   chosen).
5. **Gateway:** start it, wait until it is ready, optionally (checkbox)
   register it as a user service; Atlas pins `expectedWorkspace` itself.
6. **First project:** choose a project folder (a git repository, or create
   one), create an agent, and open the map.

A try-out mode without any of this remains: the fixture (`--dev-fixture`),
right from the menu.

## Updates

- **App:** electron-updater checks GitHub Releases, downloads in the
  background and offers a restart when no agent turns are running.
- **Controller instance:** after an update, Atlas runs
  `agents-factory migrate` (backup → migrations → verification); see
  [product-changes.md](product-changes.md).
- **SDK:** the version is pinned in the release; it is updated together with
  the app.
- Channels `stable` and `beta` (pre-releases on GitHub).

## Uninstall

- The uninstaller (Windows), removal from Applications (macOS) and the
  package manager (Linux) remove the app and stop the Gateway.
- **Data stays** by default: memory, conversations, the controller. Full
  removal is `agents-factory uninstall --purge`, with a confirmation and a
  list of what will be deleted.
- Project folders and their git history are never touched.

## Build and release

- **CI:** GitHub Actions in the public repository, matrix `windows-latest`,
  `macos-latest` (arm64 and x64), `ubuntu-latest`. Builds from a `vX.Y.Z`
  tag.
- **Signing keys** only in GitHub Actions secrets (SignPath or Azure Trusted
  Signing, an Apple ID/API key for notarization, GPG for Linux packages).
- **Version** from the `VERSION` file (semver, starting at v0.1.0); file
  names: `AgentsFactory-Setup-0.2.0.exe`,
  `AgentsFactory-0.2.0-universal.dmg`,
  `AgentsFactory-0.2.0-x86_64.AppImage`, `agents-factory_0.2.0_amd64.deb`.
- **Release artifacts:**
  - installers;
  - `install.ps1` and `install.sh` for the one-line install (links like
    `https://github.com/AlexKhutor/agents-factory/releases/latest/download/install.sh`);
  - `SHA256SUMS` and its signature;
  - SBOM (CycloneDX);
  - update metadata (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`).
- **Code path:** the maintainers' development repository → the export that
  generates this repository → `agents-factory` → tag → CI → GitHub Release.

## Testing the installers

Where we test: the maintainer has Windows and WSL. Windows manually and in
CI; Linux manually in WSL (the Atlas window through WSLg) and in CI; macOS
only in CI (GitHub Actions macOS runners); there is no manual check on a real
Mac yet.

On every OS in CI, without real models:

1. Silent install (`/S`, mounting the `.dmg`,
   `--appimage-extract-and-run`).
2. `agents-factory doctor --json`: everything green except the Claude
   sign-in.
3. `setup` with a fake SDK (as in the Gateway tests), Gateway start, `ready`.
4. The Atlas UI scene suite (on Linux, under `xvfb`).
5. Update from the previous release, then `migrate`.
6. Uninstall: the app is removed, the data stays; `--purge` removes the data
   too.
