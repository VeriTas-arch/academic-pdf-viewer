const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'),
);

test('PDF navigation has scoped, user-rebindable defaults', () => {
    const commands = packageJson.contributes?.commands ?? [];
    const keybindings = packageJson.contributes?.keybindings ?? [];
    const when = 'activeCustomEditorId == academicPdfViewer.pdf'
        + ' && config.academicPdfViewer.navigation.defaultAltShortcuts';
    const properties = packageJson.contributes?.configuration?.properties ?? {};

    assert.equal(properties['academicPdfViewer.navigation.defaultAltShortcuts']?.default, true);
    assert.equal(properties['academicPdfViewer.navigation.mouseButtons']?.default, true);
    assert.equal(properties['academicPdfViewer.navigation.mouseButtonMapping']?.default, 'standard');
    assert.deepEqual(properties['academicPdfViewer.navigation.mouseButtonMapping']?.enum, [
        'standard',
        'swapped',
    ]);
    assert.equal(properties['academicPdfViewer.navigation.defaultSidebar']?.default, 'pages');
    assert.deepEqual(properties['academicPdfViewer.navigation.defaultSidebar']?.enum, [
        'pages',
        'outline',
        'attachments',
        'layers',
    ]);

    for (const command of [
        'academicPdfViewer.navigateBack',
        'academicPdfViewer.navigateForward',
    ]) {
        assert(
            commands.some(contribution => contribution.command === command),
            `Missing command contribution for ${command}.`,
        );
    }

    for (const [command, key] of [
        ['academicPdfViewer.navigateBack', 'alt+left'],
        ['academicPdfViewer.navigateForward', 'alt+right'],
    ]) {
        assert(
            keybindings.some(binding => (
                binding.command === command
                && binding.key === key
                && binding.when === when
            )),
            `Missing ${key} binding for ${command}.`,
        );
    }
});

test('built-in SyncTeX bridge is opt-in and has discoverable source actions without a default keybinding', () => {
    const commands = packageJson.contributes?.commands ?? [];
    const keybindings = packageJson.contributes?.keybindings ?? [];
    const menus = packageJson.contributes?.menus ?? {};
    const properties = packageJson.contributes?.configuration?.properties ?? {};
    const command = 'academicPdfViewer.tex.synctexForwardFromCursor';
    const when = 'config.academicPdfViewer.tex.bridge.enabled && resourceExtname == .tex';

    for (const [setting, defaultValue] of [
        ['academicPdfViewer.tex.bridge.enabled', false],
        ['academicPdfViewer.tex.bridge.executable', 'synctex'],
        ['academicPdfViewer.tex.bridge.pdfPath', ''],
    ]) {
        assert.equal(properties[setting]?.default, defaultValue);
        assert.equal(properties[setting]?.scope, 'window');
        assert.equal(properties[setting]?.restricted, true);
    }
    assert(
        commands.some(contribution => contribution.command === command && contribution.enablement === when),
        'Missing the scoped SyncTeX forward command contribution.',
    );
    for (const menu of ['commandPalette', 'editor/title', 'editor/context']) {
        assert(
            (menus[menu] ?? []).some(contribution => contribution.command === command && contribution.when === when),
            `Missing the scoped SyncTeX forward action in ${menu}.`,
        );
    }
    assert.equal(
        keybindings.some(binding => binding.command === command),
        false,
        'The SyncTeX bridge must not claim a default keybinding.',
    );
});
