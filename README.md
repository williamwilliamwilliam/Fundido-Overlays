# Fundido Overlays

A Windows desktop application that captures game frames, evaluates user-defined screen regions against configurable state rules, and displays responsive overlays on top of the game window.

## Quick Start (Development)

### Prerequisites

- Node.js 20+ and npm 10+
- Angular CLI: `npm install -g @angular/cli`
- Visual Studio Build Tools with "Desktop development with C++" (for native addon)
  - https://visualstudio.microsoft.com/visual-cpp-build-tools/
  - Desktop development with C++
- Python 3.x (for node-gyp)

### Setup

```bash
git clone <repo-url> fundido-overlays
cd fundido-overlays
npm install
cd ui && npm install && cd ..
```

### Run in Dev Mode

```bash
npm run start:dev
```

This launches Angular on `localhost:4241` and Electron in dev mode concurrently.

### Build a Release

```bash
npm run build:all
npm run package
```

The installer is output to `release/`.

## Documentation

- [Developer Build Guide](docs/developer/BUILD.md)
- [User Installation Guide](docs/user/INSTALLATION.md)
- [User Guide](docs/user/USER_GUIDE.md)

## Architecture

```
Electron Main Process (TypeScript)
├── Game Capture Service ──► DXGI native addon (C++)
├── State Calculation Engine
├── Overlay Window Manager
├── Config Persistence (JSON file)
└── IPC Handlers

Angular UI (Renderer Process)
├── Capture Preview
├── Monitored Regions Editor
├── Overlay Groups Editor
└── Debug Console

Overlay Windows (Renderer Processes)
└── Transparent, click-through, always-on-top
```

## License

TBD