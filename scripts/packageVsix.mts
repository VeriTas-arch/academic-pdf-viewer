import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listFiles, PackageManager } from '@vscode/vsce';

interface CommandContribution {
    command: string;
    enablement?: string;
}

interface Manifest {
    name: string;
    version: string;
    enabledApiProposals?: string[];
    scripts?: Record<string, string>;
    contributes: {
        customEditors: { priority: string | { textEditor: string; diffEditor?: string } }[];
        commands: CommandContribution[];
        keybindings: CommandContribution[];
        menus: Record<string, CommandContribution[]>;
    };
}

function removePdfDiff(manifest: Manifest): void {
    const { contributes } = manifest;
    const diffCommands = new Set(contributes.commands
        .filter(({ enablement }) => enablement?.includes('academicPdfViewer.diffActive'))
        .map(({ command }) => command));
    const isStableCommand = ({ command }: CommandContribution): boolean => !diffCommands.has(command);

    delete manifest.enabledApiProposals;
    for (const editor of contributes.customEditors) {
        if (typeof editor.priority === 'object') {
            editor.priority = editor.priority.textEditor;
        }
    }
    contributes.commands = contributes.commands.filter(isStableCommand);
    contributes.keybindings = contributes.keybindings.filter(isStableCommand);
    for (const [menu, entries] of Object.entries(contributes.menus)) {
        contributes.menus[menu] = entries.filter(isStableCommand);
    }
}

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const vsce = fileURLToPath(import.meta.resolve('@vscode/vsce/vsce'));
const [requestedChannel, ...extraArguments] = process.argv.slice(2);
if (extraArguments.length || (requestedChannel && requestedChannel !== 'stable' && requestedChannel !== 'beta')) {
    throw new Error('Usage: npm run package:vsix -- [stable|beta]');
}

const manifestSource = await readFile(path.join(root, 'package.json'), 'utf8');
const files = await listFiles({ cwd: root, packageManager: PackageManager.None });
await mkdir(dist, { recursive: true });

for (const channel of requestedChannel ? [requestedChannel] : ['stable', 'beta']) {
    const manifest = JSON.parse(manifestSource) as Manifest;
    const beta = channel === 'beta';
    if (!beta) {
        removePdfDiff(manifest);
    }
    delete manifest.scripts;

    const stage = await mkdtemp(path.join(dist, '.vsix-'));
    try {
        await Promise.all(files.filter(file => file !== 'package.json'
            && (beta || !file.replaceAll('\\', '/').startsWith('assets/academic/pdfDiff')))
            .map(async file => {
                const destination = path.join(stage, file);
                await mkdir(path.dirname(destination), { recursive: true });
                await copyFile(path.join(root, file), destination);
            }));
        await copyFile(path.join(root, '.vscodeignore'), path.join(stage, '.vscodeignore'));
        await writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 4) + '\n');

        const output = path.join(dist, `${manifest.name}-${manifest.version}${beta ? '-beta' : ''}.vsix`);
        for (const args of [
            ['ls', '--tree'],
            ['package', '--out', output, ...(beta ? ['--pre-release'] : [])],
        ]) {
            const result = spawnSync(process.execPath, [vsce, ...args, '--no-dependencies'], {
                cwd: stage,
                stdio: 'inherit',
            });
            if (result.status !== 0) {
                throw result.error ?? new Error(`vsce ${args[0]} failed for the ${channel} package.`);
            }
        }
    } finally {
        await rm(stage, { force: true, recursive: true });
    }
}
