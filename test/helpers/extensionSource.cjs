const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadSource(relativePath, vscode, overrides = {}) {
    const modules = new Map();
    function load(filename) {
        const absolute = path.resolve(filename);
        if (modules.has(absolute)) return modules.get(absolute).exports;
        const module = { exports: {} };
        modules.set(absolute, module);
        const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const localRequire = name => {
            if (Object.hasOwn(overrides, name)) return overrides[name];
            if (name === 'vscode') return vscode;
            if (name.startsWith('.')) return load(path.resolve(path.dirname(absolute), name + '.ts'));
            return require(name);
        };
        new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
            module.exports, localRequire, module, absolute, path.dirname(absolute));
        return module.exports;
    }
    return load(path.resolve(__dirname, '../../src', relativePath));
}

class EventEmitter {
    listeners = new Set();
    event = listener => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value) { for (const listener of [...this.listeners]) listener(value); }
    dispose() { this.listeners.clear(); }
}

class CancellationError extends Error {}
class CancellationTokenSource {
    emitter = new EventEmitter();
    token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
    cancel() {
        if (!this.token.isCancellationRequested) {
            this.token.isCancellationRequested = true;
            this.emitter.fire();
        }
    }
    dispose() { this.emitter.dispose(); }
}

module.exports = { loadSource, EventEmitter, CancellationError, CancellationTokenSource };
