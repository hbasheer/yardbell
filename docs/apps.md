# The apps

The desktop app for macOS and Linux, the Android app, and phone notifications.

## Apps

The desktop app for macOS and Linux opens the dashboard in a window of its own, shows the state of
every machine in the tray, and sends system notifications, so Yardbell does not need a browser
tab. It connects to a Yardbell that is already running (see [Quick start](../README.md#quick-start)), or, on a
machine with no server yet, **Run one on this machine** sets one up and runs it inside the app for as
long as the app runs. It finds the mesh VPN and this machine's mesh address by itself. The app needs a server from
the same release: an older server answers the app's sign-in with a 404, and the app then reports
that it can't reach the server. To build that release, run `git checkout v<version>` in your clone
before `cargo build --release`.

Download the file for your system from the
[latest release](https://github.com/hbasheer/yardbell/releases/latest):

| System | File |
|---|---|
| macOS, Apple silicon and Intel | `Yardbell_<version>_universal.dmg` |
| Linux | `Yardbell_<version>_amd64.AppImage` |
| Debian and Ubuntu | `Yardbell_<version>_amd64.deb` |
| Fedora and openSUSE | `Yardbell-<version>-1.x86_64.rpm` |
| Android 7 and later | `Yardbell_<version>_android.apk` |

- **macOS.** Open the `.dmg` and drag Yardbell to Applications. The app is not notarized by
  Apple, so macOS blocks the first launch. On macOS 14 and earlier, right-click Yardbell in
  Applications, choose **Open**, then **Open** again. On macOS 15 and later, open it once, then go
  to System Settings, Privacy & Security, and press **Open Anyway**. If macOS says the app is
  damaged, run `xattr -dr com.apple.quarantine /Applications/Yardbell.app` once.
- **Linux.** Run `chmod +x Yardbell_*.AppImage` and start the file, or on Debian and Ubuntu
  install the `.deb` with `sudo apt install ./Yardbell_<version>_amd64.deb`. On Fedora install
  the `.rpm` with `sudo dnf install ./Yardbell-<version>-1.x86_64.rpm`, on openSUSE with
  `sudo zypper install ./Yardbell-<version>-1.x86_64.rpm`. Arch and Omarchy need `webkit2gtk-4.1`
  (`sudo pacman -S webkit2gtk-4.1`).
- **Android.** Open the `.apk` on the phone and allow installing from your browser or file app
  when Android asks. Then, on a computer, open Yardbell's **Settings → Connect a phone** and press
  **Show pairing code**; in the app tap **Scan a pairing code** and point the camera at it. The
  phone signs in without the passcode (each code works once, for five minutes) and remembers the
  server. The phone must be on the same mesh VPN. Once it knows one server, the start screen lists
  the others it finds under **On your mesh**, where signing in takes only the passcode; it keeps
  offering a server you removed. The app shows the server's own pages, so the dashboard, terminals,
  Workspace and Dispatch work as in a browser, kept clear of the status bar and the keyboard; the
  back gesture returns to the server list. It also shows the notifications, see
  [Phone notifications](#phone-notifications).
- **iPhone and Windows.** There is no app yet. On an iPhone, open the dashboard in the browser, see
  [Terminal and phone](usage.md#terminal-and-phone).

There is no auto-update. To upgrade, install the newer release over the old one.

**First run.** The app asks for the server address and the passcode you set with
`yardbell passcode`. The servers it finds on your mesh are listed above the form; click one and
only the passcode is left. Or type the address you use in a browser, for example
`100.64.0.12:4000`; `http://` is added when you leave it out. The app signs in and keeps the session in the system
keychain (the macOS Keychain, or the Secret Service on Linux, such as GNOME Keyring or KWallet).
The passcode itself is not stored. Later launches go straight to the dashboard, and when the server
ends the session the app asks for the passcode again.

**Tabs.** The window has a tab bar: the first tab is the dashboard, and every terminal you open
(from the dashboard or from a notification) is a tab after it. A tab shows the session's folder and
machine, and a terminal you open twice reuses its tab. Close a terminal tab with its cross, a
middle click or the keys below. The tab keys work in the dashboard and in a terminal:

| Action | macOS | Linux |
|---|---|---|
| Go to tab 1 to 8 (1 is the dashboard) | `⌘1` to `⌘8` | `Ctrl+1` to `Ctrl+8` |
| Go to the last tab | `⌘9` | `Ctrl+9` |
| Next tab | `Ctrl+Tab` | `Ctrl+Tab` |
| Previous tab | `Ctrl+Shift+Tab` | `Ctrl+Shift+Tab` |

Closing is in the shortcuts table below.

**Tray.** On Linux the icon is the Yardbell mark in green when every machine is up, amber when a
machine is at 85% memory or more, red when a machine is down and gray when the server cannot be
reached. On macOS the menu bar shows
the logo's mark in the menu bar's color, with a dot when a machine is down or memory is high,
faded when not connected. A left click there opens a panel with every machine's memory and CPU
(the 1-minute load per core) and the sessions you can open; its gear holds the notification
switches, Start at login, Sign out and Quit. A right click opens the
menu. On Linux the panel draws the menu, so it opens however that panel opens tray menus
(a right click on Waybar, any click with GNOME's AppIndicator extension). The menu lists each machine
under **Machines** with a state dot, a memory bar and its memory and CPU use (click one to see it in
the dashboard), then every
session you can open under **Sessions**, named like its tab, with **working** after the ones whose
agent is busy. Click a session to bring the window forward on its tab. Past 15 sessions,
**All sessions…** opens the dashboard. After that come **Open Yardbell**, **New session**, **Notifications**, **Start at
login**, **About Yardbell** (Settings, About: the server's and the app's versions and whether a
newer release exists), **Sign out** and **Quit**. **Sign out**, also at the right end of the window's tab bar
(click it twice), forgets the login and shows the connect screen, where you can connect to another
server or run one on this machine. A server the app runs itself stops and no longer starts with the
app; its config and passcode stay, so running it again only asks for the passcode. Closing the
window only hides it: the app keeps running in the tray until you choose **Quit**. On Linux the
tray needs a desktop with tray support; GNOME needs the AppIndicator extension, which Ubuntu turns
on by default.

**Notifications.** The app checks the server every 5 seconds and shows a system notification when:

- an agent finished or is waiting for you (it has been idle for 20 seconds),
- a session ended,
- a machine went down (it has been unreachable for a minute) or came back,
- a machine's memory passed 95%.

Each kind has a switch under **Notifications** in the tray menu. All four are on by default and the
choice is kept between launches. These switches are for the desktop app on that computer; phone
notifications have their own in Settings. Click an agent notification to open that session's terminal.
Notifications that stay in the macOS Notification Center or in GNOME's list keep their click
routing. Once 8 of them are waiting, newer ones show without an **Open** button until older ones
are cleared.

**Clipboard and shortcuts.** Terminal tabs use the system clipboard directly, so copy and paste
work without the `https` limit described under [Terminal and phone](usage.md#terminal-and-phone).

| | Linux | macOS |
|---|---|---|
| Copy the selection | `Ctrl+Shift+C` | `Cmd+C` |
| Paste | `Ctrl+Shift+V` | `Cmd+V` |
| Close a terminal tab | `Ctrl+Shift+W` | `Cmd+W` |
| Quit | `Ctrl+Shift+Q` | `Cmd+Q` |
| New session (dashboard tab) | `Ctrl+N` | `Cmd+N` |

Plain `Ctrl+C`, `Ctrl+W` and the other control keys still go to the shell and the agent, except
`Ctrl+1` to `Ctrl+9` and `Ctrl+Tab`, which switch tabs. In the dashboard tab, `Ctrl+W` hides the
window and `Ctrl+Q` quits.

## Phone notifications

Yardbell can tell your phone when an agent is waiting for you, a session ends, a machine goes down
or comes back, or a machine's memory reaches 95%. No browser tab or desktop app has to be open.

The Android app does it with nothing to set up. While it is signed in to a server, it keeps a
connection to it in the background and shows its notifications. Android asks once whether Yardbell
may send notifications, and shows a quiet "Watching your agents" notification while the connection
is open, which you can hide in the app's notification settings. The connection goes over your mesh
VPN like everything else, so nothing passes through Google or any other service. It starts again
after the phone restarts. Tapping a notification opens the app. Notifications that came while the
phone could not reach the server, the last 50 of them, arrive when it is back, unless the server
restarted in between. The **Phone notifications** section of the Settings page says whether the app
is connected.

**The wait.** An agent counts as waiting once it has been idle for 20 seconds after working, or at
once when it shows a question or a permission prompt. Yardbell then holds the notification for 2
minutes and only sends it if the agent is still waiting, so nothing arrives when you answer it in
time. Change the minutes next to **Agent waiting**, or set 0 to be told right away. The other kinds
are sent at once. Each kind has its own switch, and a saved change applies on the next check.
