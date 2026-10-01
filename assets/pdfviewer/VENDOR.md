# PDF.js vendor

The runtime files under `lib/build` and `lib/web` come from the official PDF.js
6.3.289 generic distribution:

- Release: <https://github.com/mozilla/pdf.js/releases/tag/v6.3.289>
- Archive: `pdfjs-6.3.289-dist.zip`
- SHA-256: `98c5832ffe7af4edd59853476a478c0d4d4d76dd49c1701f4c86f7182725cdf9`

`lib/pdf.css` is an extension-owned integration file and is not part of the
upstream archive. Source maps and these unused scripting/debug assets are omitted:

- `build/pdf.sandbox.mjs`
- `web/compressed.tracemonkey-pldi-09.pdf`
- `web/debugger.css`
- `web/debugger.js`
- `web/debugger.mjs`
- `web/wasm/quickjs-eval.js`
- `web/wasm/quickjs-eval.wasm`

Use the independent `npm run pdfjs:check`, `npm run pdfjs:update`, and
`npm run pdfjs:verify` commands to maintain this bundle.
