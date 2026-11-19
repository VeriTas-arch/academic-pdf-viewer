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

Press <kbd>F5</kbd> in VS Code to open the manual fixtures with `customEditorDiffs` and the built-in SyncTeX bridge enabled. Trust the workspace if prompted, then open `synctex/fixture.tex` in that Extension Development Host to test forward and inverse search.

## Build and release

Build both channels from the same checkout, or build either one independently.

```bash
npm run package:vsix
npm run package:vsix -- stable
npm run package:vsix -- beta
```

The command cleans and compiles once, then stages each selected channel and runs `vsce ls --tree` before packaging. It writes `dist/academic-pdf-viewer-<version>.vsix` and `dist/academic-pdf-viewer-<version>-beta.vsix`. The stable package omits the Proposed API declaration, diff contributions and diff webview modules. The Beta keeps the development manifest's diff contributions and sets VSIX pre-release metadata.

For a new release, update the version in `package.json` and `package-lock.json` together with `CHANGELOG.md`. Run the verification checks and package from that commit. To exercise an actual package in the extension-host suite, extract the VSIX and point the runner at its `extension/` directory with `npm run test:extension -- <extracted-extension-directory>`.

Publish the verified stable VSIX to the Marketplace with `npx @vscode/vsce publish --packagePath dist/academic-pdf-viewer-<version>.vsix`. Attach that same file to the GitHub release tagged `v<version>` and mark it Latest. Publish the Beta VSIX to GitHub with a tag such as `v<version>-beta.1` and select **Set as a pre-release**. Further Beta iterations can increment the tag suffix. Both tags point at the source commit used to build the packages.

## PDF.js maintenance

PDF.js maintenance is explicit and separate from ordinary builds:

```bash
npm run pdfjs:check
npm run pdfjs:verify
npm run pdfjs:update -- --version x.y.z
```

The official release URL, archive digest and asset exclusions are recorded in [`vendor.json`](../assets/pdfviewer/vendor.json). The extension owns `assets/pdfviewer/lib/pdf.css`.

## Remote PDF performance

The ordinary reader opens remote disk PDFs of at least 1 MiB using byte ranges. The webview starts with a 64 KiB prefix. The remote extension host serves requests for the open file in binary messages of up to 512 KiB, with up to four reads in flight. Search can read ahead within one 512 KiB window. The local reader, virtual file systems and PDF diffs use the buffered path.

Use VS Code 1.134 or later and a real Remote SSH workspace for manual acceptance. Compare first visible page, bytes sent before it renders, jump latency, search, and memory against the previous build on the same connection. The Webview Performance panel shows `Academic PDF Viewer: first page` from the start of processing a document load through its first render. Viewer and extension host errors are logged in their respective developer consoles. Try `main.pdf` and a large image-heavy PDF. Verify that reloading after a rebuild preserves the view, rapid reloads cancel superseded reads, and saving a complete PDF works after a partial open. The independent viewer suite exercises partial loading, form saving and replacement of a stalled load.

See [AGENTS.md](https://github.com/VeriTas-arch/academic-pdf-viewer/blob/main/AGENTS.md) for repository boundaries, the verification matrix, and PDF.js update requirements.

[Back to README](https://github.com/VeriTas-arch/academic-pdf-viewer/blob/main/README.md)
