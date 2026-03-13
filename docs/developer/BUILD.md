# Fundido Overlays — Developer Build Guide

## Prerequisites

- **Node.js** 20+ and **npm** 10+
- **Angular CLI** (`npm install -g @angular/cli`)
- **Python 3.x** (required by `node-gyp` for native addon compilation)
- **Visual Studio Build Tools** (Windows) with the "Desktop development with C++" workload
  - Needed for compiling the DXGI native addon via `node-gyp`
- **Git**

## Repository Setup

```bash
git clone <repo-url> fundido-overlays
cd fundido-overlays
npm install
cd ui
npm install
cd ..
```

## Project Structure

```
fundido-overlays/
├── src/                        # Electron main process (TypeScript)
│   ├── main.ts                 # App entry point & lifecycle
│   ├── preload.ts              # Preload for the Angular config UI
│   ├── preload-overlay.ts      # Preload for overlay windows
│   ├── capture/                # Game frame capture service
│   ├── state/                  # State calculation engine
│   ├── overlay/                # Overlay window manager
│   ├── persistence/            # JSON config file read/write
│   ├── ipc/                    # IPC handler registration
│   └── shared/                 # Models, IPC channels, logger
├── ui/                         # Angular frontend (config UI)
│   ├── src/app/
│   │   ├── services/           # Angular services wrapping the preload API
│   │   ├── components/         # UI components (capture, regions, overlays, debug)
│   │   └── models/             # Re-exported shared types for Angular
│   └── angular.json
├── native/                     # C++ DXGI capture addon
│   ├── binding.gyp
│   └── src/dxgi_capture.cpp
├── docs/
│   ├── developer/              # This file and other dev docs
│   └── user/                   # End-user documentation (bundled in release)
├── assets/                     # Icons, images
├── package.json                # Root package.json (Electron + build scripts)
└── tsconfig.electron.json      # TypeScript config for the main process
```

## Running in Development

The dev workflow runs three things concurrently:

1. The Electron main process (compiled TypeScript, watching for changes)
2. The Angular dev server on `http://localhost:4200`
3. Electron loads the Angular dev server URL instead of the built files

```bash
npm run start:dev
```

This uses `concurrently` + `wait-on` to start Angular first, wait for it to be ready, then launch Electron with the `--dev` flag.

### Running pieces individually

```bash
# Compile the main process once
npm run build:electron

# Watch-compile the main process
npx tsc -p tsconfig.electron.json --watch

# Start the Angular dev server
cd ui && ng serve

# Launch Electron (expects Angular to already be running)
npx electron . --dev
```

## Building the Native Addon

The DXGI capture addon must be compiled on Windows:

```bash
npm run build:native
```

This invokes `node-gyp rebuild` inside the `native/` directory. The compiled `.node` file will be at `native/build/Release/dxgi_capture.node`.

If you don't have the native toolchain set up yet, the app will run in **stub mode** — producing blank frames. This is fine for UI development.

## Building a Release

```bash
# Build everything: native addon, Electron main process, Angular production build
npm run build:all

# Package into a Windows installer
npm run package
```

The installer will be output to the `release/` directory. electron-builder is configured in `package.json` under the `"build"` key.

## Testing

```bash
# Main process unit tests (Jest)
npm run test:electron

# Angular unit tests (Karma)
npm run test:ui
```

## Key Architectural Decisions

### IPC Communication
The Angular UI runs in a renderer process with `contextIsolation: true`. All communication with the main process goes through the preload script (`src/preload.ts`), which exposes a typed `fundidoApi` object on `window`. There is no direct Node.js access from the renderer.

### Capture → State → Overlay Pipeline
The main process runs a loop: capture a frame → evaluate monitored regions → broadcast state to overlay windows and the UI. This pipeline is set up in `main.ts` via the `setupCaptureToOverlayPipeline` function.

### Overlay Windows
Each overlay group gets its own transparent, always-on-top, click-through `BrowserWindow`. The `OverlayWindowManager` handles their lifecycle. They receive state updates over IPC and render accordingly.

### Configuration Persistence
All config is stored as a single JSON file in Electron's `userData` directory. The `ConfigPersistenceService` handles read/write and import/export.
