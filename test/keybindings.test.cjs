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
