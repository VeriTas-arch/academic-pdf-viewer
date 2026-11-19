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

See [AGENTS.md](https://github.com/VeriTas-arch/academic-pdf-viewer/blob/main/AGENTS.md) for repository boundaries, the verification matrix, and PDF.js update requirements.

[Back to README](https://github.com/VeriTas-arch/academic-pdf-viewer/blob/main/README.md)
