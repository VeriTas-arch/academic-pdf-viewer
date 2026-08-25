import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTests } from '@vscode/test-electron';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(testDirectory, '..', '..');

try {
    await runTests({
        version: '1.134.0',
        extensionDevelopmentPath,
        extensionTestsPath: path.join(testDirectory, 'suite.cjs'),
        launchArgs: [
            path.join(extensionDevelopmentPath, 'manual-tests'),
            '--disable-extensions',
            '--disable-workspace-trust',
            '--skip-release-notes',
            '--skip-welcome',
            '--enable-proposed-api=ovolab-veritas.academic-pdf-viewer',
        ],
    });
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
