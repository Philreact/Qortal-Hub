# Development

Requirements for the development of Qortal-Hub from sources:

- installation of Node.js 22.12 or newer from the [official site](https://nodejs.org/en/download)
- Python 3.9+ and Git on PATH for Reticulum networking during Electron development
- an IDE like vscode or Intellij, or similar tools
- some knowledge of React and its ecosystem

## Running Qortal-Hub while developing

Browser-only development:

Follow these steps:

- install dependencies: `npm install`
- `npm run dev`
- open the browser at page `http://localhost:5173/`

Electron development with Reticulum networking:

- install root dependencies: `npm install`
- sync Electron after web/native changes: `npx cap sync @capacitor-community/electron`
- move into Electron folder: `cd electron`
- install Electron dependencies: `npm install`
- start the desktop app: `npm run electron:start`

From `electron/`, run `npm run electron:start` again to open the Hub chooser.
Choose a running account to focus its window or select **Open another Hub** to
start an independent instance with a separate profile. The same chooser appears
when launching the packaged desktop executable again. The application menu and
tray menu also offer **Open another Hub**. `--new-instance` remains available
as a direct command-line override. Development instances use separate inspector
ports.

To open a published Q-App, pass
`--open-qapp=qortal://APP/Name` to the executable. When a Hub instance is
running, a Hub account picker shows account names, avatars, shortened
addresses, and instance numbers before routing the request. The picker also
offers **Use another account**, which starts a new Hub for authentication and
then opens the Q-App. The request waits until the
user has authenticated, then opens the app in a dedicated window. An open
Q-App tab can also be opened in its own window from the navigation bar.
If Hub is closed, a shortcut opens the Hub wallet unlock screen first; the
Q-App window opens automatically after unlock, then Hub runs hidden in the
background. Closing the last Q-App window quits a Hub instance started by a
Q-App shortcut. Launching Hub directly brings its window back.
Closing Hub's window while dedicated Q-App windows are open hides and locks
Hub; the Q-Apps keep running. The hidden Hub process quits after its last
Q-App window closes. An explicit application Quit still exits everything.
The window uses the same isolated Q-App guest policy as a Hub tab and sends
wallet requests to the authenticated Hub window. Locking the full Hub session
or quitting the application closes its Q-App windows.
Permission requests from a dedicated Q-App window are still processed by Hub,
but the prompt is displayed by the trusted Q-App window shell. Electron main
ties each prompt to the originating window and request; only that window's main
frame can answer it. A closed window, expired request, or timed-out prompt is
denied. The isolated Q-App guest has no permission-response API.
Dedicated Q-App windows have a navigation bar for Back, Refresh, copying
the current Qortal link, opening Hub, and uninstalling the app shortcut; the
guest viewer fills the space beneath it.

In Electron desktop, use Install app on the right side of the navigation bar
for a published Q-App to add a launcher to the user's applications. On first
install, Hub opens the Q-App in its own window and closes its tab after the
window loads. Once installed, the same button becomes Open as app.
Linux uses an XDG desktop entry, Windows uses a Start Menu shortcut, and macOS
uses an application launcher in `~/Applications`. The launcher starts Hub with
`--open-qapp` and opens the app in its dedicated window; it does not install a
second copy of Hub or download the Q-App for offline use. Remove the shortcut
from the dedicated Q-App window. A shortcut pointing to a moved Hub executable
(including an AppImage moved to a new path) must be recreated.
The launcher and window use the Q-App name and its name-avatar thumbnail for
the title and icon, falling back to the Hub icon when the avatar is unavailable.
Development launchers point to the current Electron project checkout and must
also be recreated if that checkout moves.
On Linux, an unpackaged Electron checkout may contain a `chrome-sandbox` helper
without the ownership and setuid mode required by GNOME's launch environment.
The Q-App launcher links that helper to a root-owned Chrome or Chromium helper
when one is available. If neither a valid helper nor user namespaces are
available, configure the Electron sandbox before launching the shortcut.

On first run, Electron installs the Qortal Reticulum runtime from `https://github.com/Philreact/Reticulum.git@master` plus LXMF into `electron/resources/reticulum-runtime/venv`. If that runtime gets stale or broken, rebuild it with:

```bash
cd electron
rm -rf resources/reticulum-runtime/venv
npm run bundle:reticulum-venv
```

## Build Qortal-Hub from Source

Follow these steps:

- install dependencies: `npm install`
- `npm run build`
- `npx cap sync @capacitor-community/electron`

- move into electron folder: `cd electron`
- `npm install`
- `npm run build`

Alternatively you can start the app:

- `npm run electron:start`

Or create an Executable Package for linux:

- `npm run electron:make-local`

Reticulum is bundled as a native binary for packaged Electron builds. For Linux release artifacts, prefer the Docker commands so the bundled native binaries are built on Debian 11 with an older glibc compatibility baseline:

- Linux x64: `npm run electron:make-lin-docker` or `npm run electron:make-lin-docker-appimage`
- Linux arm64: `npm run electron:make-arm-docker` or `npm run electron:make-arm-docker-appimage`
- macOS: `npm run electron:make-mac`
- Windows: `npm run electron:make-win`

Linux arm64 Docker builds from a non-arm64 host require QEMU/binfmt arm64 emulation on the host.

## Contribution guide

See some useful instructions about [contribution](contribution.md).
