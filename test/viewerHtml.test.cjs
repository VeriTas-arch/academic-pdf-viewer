const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { loadSource } = require('./helpers/extensionSource.cjs');

test('production viewer HTML restricts resources and escapes configuration attributes', () => {
    const { readViewerHtml, renderViewerHtml } = loadSource('extension/viewerHtml.ts', {
        Uri: { joinPath: (_uri, ...parts) => ({ toString: () => `https://local.webview/${parts.join('/')}` }) },
    });
    const raw = readViewerHtml({ asAbsolutePath: relative => path.resolve(__dirname, '..', relative) });
    const label = '"><script src="https://example.invalid/inject.js"></script>&';
    const html = renderViewerHtml(raw, {}, {
        cspSource: 'https://local.webview', asWebviewUri: value => value,
    }, {
        debug: false, diffRole: 'modified', diffLabel: label,
        linkPreviewEnabled: true, linkPreviewResolutionScale: 0,
        mouseNavigationEnabled: true, mouseButtonMapping: 'standard',
        defaultSidebar: 'pages', syncTexMode: 'doubleclick',
    });
    const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    const directives = new Map(policy.split(';').filter(value => value.trim()).map(value => {
        const [name, ...sources] = value.trim().split(/\s+/);
        return [name, sources];
    }));
    for (const name of ['default-src', 'base-uri', 'form-action']) {
        assert.deepEqual(directives.get(name), ["'none'"]);
    }
    assert.deepEqual(directives.get('connect-src'), ['https://local.webview']);
    assert.equal(directives.get('script-src').includes("'unsafe-eval'"), false);
    assert.equal(directives.get('script-src').includes("'unsafe-inline'"), false);
    for (const match of html.matchAll(/<script\s+[^>]*src="([^"]+)"/g)) {
        assert(match[1].startsWith('https://local.webview/assets/'));
    }
    assert.equal(html.includes('<script src="https://example.invalid'), false);
    const encoded = html.match(/id="pdf-preview-config" data-config="([^"]+)"/)[1];
    const decoded = encoded.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const config = JSON.parse(decoded);
    assert.equal(config.diffLabel, label);
    for (const name of ['workerSrc', 'cMapUrl', 'iccUrl', 'standardFontDataUrl', 'wasmUrl']) {
        assert(config[name].startsWith('https://local.webview/assets/pdfviewer/lib/'));
    }
});
