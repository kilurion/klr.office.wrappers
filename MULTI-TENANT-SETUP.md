# Multi-Tenant Setup Guide

This guide explains how to set up and run Teams and Outlook for multiple Microsoft 365 tenants as separate desktop applications on Linux (KDE/Kubuntu).

## Overview

Each tenant gets its own Electron wrapper instance with isolated sessions (cookies, logins, storage). This allows you to be signed into multiple Microsoft 365 tenants simultaneously.

| App | Tenant | Session Partition |
|-----|--------|-------------------|
| Teams KLR | Kilurion (KLR) | `persist:teams-klr` |
| Teams E4U | ERP4U (E4U) | `persist:teams-e4u` |
| Outlook KLR | Kilurion (KLR) | `persist:outlook-klr` |
| Outlook E4U | ERP4U (E4U) | `persist:outlook-e4u` |

## Prerequisites

- **Node.js** (v20+): `sudo apt install nodejs`
- **npm**: `sudo apt install npm`

## Installation

```bash
git clone https://github.com/kilurion/klr.office.wrappers.git
cd klr.office.wrappers
npm install
```

## Running in Development Mode

```bash
npm run dev:teams-klr
npm run dev:teams-e4u
npm run dev:outlook-klr
npm run dev:outlook-e4u
```

## Desktop Shortcuts (KDE/Kubuntu)

### Install shortcuts

Copy the `.desktop` files to your applications directory and desktop:

```bash
cp ~/.local/share/applications/teams-klr.desktop ~/Desktop/
cp ~/.local/share/applications/teams-e4u.desktop ~/Desktop/
cp ~/.local/share/applications/outlook-klr.desktop ~/Desktop/
cp ~/.local/share/applications/outlook-e4u.desktop ~/Desktop/
```

### Create the .desktop files

For each app, create a file in `~/.local/share/applications/` (e.g., `outlook-klr.desktop`):

```ini
[Desktop Entry]
Name=Outlook KLR
Comment=Microsoft Outlook - Kilurion
Exec=/home/<user>/klr.office.wrappers/launch-outlook-klr.sh
Icon=/home/<user>/klr.office.wrappers/apps/outlook-klr/icons/icon.png
Terminal=false
Type=Application
Categories=Network;Office;Email;
StartupWMClass=outlook-klr
```

Replace `<user>` with your username. Repeat for `teams-klr`, `teams-e4u`, and `outlook-e4u`.

### Make shortcuts executable

```bash
chmod +x ~/Desktop/*.desktop
chmod +x ~/.local/share/applications/{teams-klr,teams-e4u,outlook-klr,outlook-e4u}.desktop
```

### Refresh the application database

```bash
update-desktop-database ~/.local/share/applications/
```

The apps will then appear in KDE's application launcher search (KRunner / Kickoff).

## Troubleshooting

### App doesn't open when launched from desktop shortcut

**Cause:** Electron's SUID sandbox requires `chrome-sandbox` to be owned by root with mode 4755. Desktop launchers don't inherit terminal environment where this is often bypassed.

**Fix:** The `--no-sandbox` flag is added to the Electron spawn in `dev-run.js`. This is safe for desktop wrapper applications.

### Single-instance lock

Each app uses a unique session partition based on `snapName` in `config.json`. If clicking a shortcut does nothing, the app may already be running — check Alt+Tab or the taskbar.

## Building Snap Packages

```bash
npm run build:teams-klr
npm run build:teams-e4u
npm run build:outlook-klr
npm run build:outlook-e4u
```

## Project Structure (tenant apps)

```
apps/
├── teams-klr/          # Teams for Kilurion
│   ├── config.json     # App name, URL, session partition
│   ├── package.json    # Build metadata
│   ├── icons/          # App icons
│   └── snap/           # Snap packaging files
├── teams-e4u/          # Teams for ERP4U
├── outlook-klr/        # Outlook for Kilurion
└── outlook-e4u/        # Outlook for ERP4U

launch-teams-klr.sh     # Launcher script for desktop shortcuts
launch-teams-e4u.sh
launch-outlook-klr.sh
launch-outlook-e4u.sh
```
