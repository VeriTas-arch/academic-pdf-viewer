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
