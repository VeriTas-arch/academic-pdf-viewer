# Development

Use Node.js 24.x:

```bash
npm install
npm run check
npm test
npm run test:viewer
npm run test:extension
```

The tests remain independent from the normal build and VSIX prepublish path. `test:viewer` launches the bundled PDF.js viewer in a local Chromium-based browser; set `PLAYWRIGHT_BROWSER_EXECUTABLE` if the browser is outside its standard location. `test:extension` launches an isolated VS Code extension host.

The extension-host runner pins its VS Code version in `test/extensionHost/run.mjs` and reuses the downloaded installation in `.vscode-test/`. Each run creates separate user-data and extensions directories under `.vscode-test/runs/run-*`, with AI features, Claude/Codex providers, automatic updates, and telemetry disabled. Before removing successful run data, the runner checks for agent SDK download attempts and cached SDK files; either makes the run fail.

The most recent failed run is retained at `.vscode-test/runs/last-failed/`, including its settings and logs. A later failure replaces it; successful runs leave it available for diagnosis. Forced termination can leave a `run-*` directory behind. After the corresponding test instance has exited, obsolete run directories and older VS Code installations can be removed. Keep the installation matching the runner's pinned version to avoid downloading it again. These settings and cleanup rules apply to `npm run test:extension`, not the F5 development host.

Press <kbd>F5</kbd> in VS Code to open the manual fixtures with `customEditorDiffs` and the built-in SyncTeX bridge enabled. Trust the workspace if prompted, then open `synctex/fixture.tex` in that Extension Development Host to test forward and inverse search. Before packaging, inspect the release contents:

```bash
npx @vscode/vsce ls --tree
npx @vscode/vsce package
```

Packaging automatically cleans and rebuilds the extension and webview assets; a separate `npm run build` is unnecessary. Nested npm script banners are suppressed during packaging, while compiler diagnostics remain visible.

PDF.js maintenance is explicit and separate from ordinary builds:

```bash
npm run pdfjs:check
npm run pdfjs:verify
npm run pdfjs:update -- --version x.y.z
```

See [AGENTS.md](https://github.com/VeriTas-arch/academic-pdf-viewer/blob/main/AGENTS.md) for repository boundaries, the verification matrix, and PDF.js update requirements.

[Back to README](https://github.com/VeriTas-arch/academic-pdf-viewer/blob/main/README.md)
