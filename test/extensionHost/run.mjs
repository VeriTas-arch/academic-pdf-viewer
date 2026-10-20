import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTests } from '@vscode/test-electron';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(testDirectory, '..', '..');
const cacheDirectory = path.join(extensionDevelopmentPath, '.vscode-test');
const runsDirectory = path.join(cacheDirectory, 'runs');
const failedRunDirectory = path.join(runsDirectory, 'last-failed');
let runDirectory;

try {
    await fs.mkdir(runsDirectory, { recursive: true });
    runDirectory = await fs.mkdtemp(path.join(runsDirectory, 'run-'));
    const userDataDirectory = path.join(runDirectory, 'user-data');
    const extensionsDirectory = path.join(runDirectory, 'extensions');
    await fs.mkdir(path.join(userDataDirectory, 'User'), { recursive: true });
    await fs.mkdir(extensionsDirectory);
    await fs.writeFile(path.join(userDataDirectory, 'User', 'settings.json'), JSON.stringify({
        'chat.disableAIFeatures': true,
        'chat.agentHost.claudeAgent.enabled': false,
        'chat.agentHost.codexAgent.enabled': false,
        'update.mode': 'none',
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
        'extensions.ignoreRecommendations': true,
        'telemetry.telemetryLevel': 'off',
    }, null, 4) + '\n');
    console.log(`Test run data: ${runDirectory}`);
    await runTests({
        version: '1.134.0',
        cachePath: cacheDirectory,
        extensionDevelopmentPath,
        extensionTestsPath: path.join(testDirectory, 'suite.cjs'),
        launchArgs: [
            path.join(extensionDevelopmentPath, 'manual-tests'),
            `--user-data-dir=${userDataDirectory}`,
            `--extensions-dir=${extensionsDirectory}`,
            '--disable-extensions',
            '--disable-workspace-trust',
            '--skip-release-notes',
            '--skip-welcome',
            '--enable-proposed-api=ovolab-veritas.academic-pdf-viewer',
        ],
    });

    // Check before removing successful run data so background downloads cannot go unnoticed.
    let sdkFiles = 0;
    for await (const entry of fs.glob('agent-host/sdk-cache/**/*', { cwd: userDataDirectory, withFileTypes: true })) {
        if (entry.isFile()) {
            sdkFiles++;
        }
    }
    let sdkDownloads = 0;
    for await (const logPath of fs.glob('logs/**/agenthost.log', { cwd: userDataDirectory })) {
        const log = await fs.readFile(path.join(userDataDirectory, logPath), 'utf8');
        sdkDownloads += [...log.matchAll(/\[AgentSdkDownloader\].*downloading from/g)].length;
    }
    console.log(`Agent SDK check: ${sdkDownloads} download attempts, ${sdkFiles} cache files.`);
    if (sdkDownloads || sdkFiles) {
        throw new Error('The test instance downloaded an agent SDK despite its isolated settings.');
    }
    await fs.rm(runDirectory, { recursive: true, maxRetries: 10, retryDelay: 200 });
    console.log('Successful test run data removed.');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
    if (runDirectory) {
        try {
            await fs.rm(failedRunDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            await fs.rename(runDirectory, failedRunDirectory);
            console.error(`Failed test run data retained: ${failedRunDirectory}`);
        } catch (cleanupError) {
            console.error(`Could not rotate failed test data; inspect ${runDirectory}`, cleanupError);
        }
    }
}
