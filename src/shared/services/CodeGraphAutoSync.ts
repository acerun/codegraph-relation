import * as vscode from 'vscode';
import { CodeGraphService } from './CodeGraphService';

export type AutoSyncDecision = 'run' | 'disabled' | 'missing-index' | 'busy';

export function shouldAutoSync(options: {
    enabled: boolean;
    hasIndex: boolean;
    isRunning: boolean;
    isActive?: boolean;
}): AutoSyncDecision {
    if (!options.enabled) {
        return 'disabled';
    }
    if (options.isActive === false) {
        return 'disabled';
    }
    if (!options.hasIndex) {
        return 'missing-index';
    }
    if (options.isRunning) {
        return 'busy';
    }
    return 'run';
}

export function normalizeAutoSyncDebounceMs(value: number | undefined): number {
    return Math.max(250, Math.min(value ?? 30000, 30000));
}

export class CodeGraphAutoSync implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private timer: NodeJS.Timeout | undefined;
    private isRunning = false;

    constructor(
        private readonly codeGraph: CodeGraphService,
        private readonly onSynced?: () => void | Promise<void>,
        private readonly isActive?: () => boolean
    ) {
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(document => this.schedule(document.uri)),
            vscode.workspace.onDidCreateFiles(event => this.scheduleFromUris(event.files)),
            vscode.workspace.onDidDeleteFiles(event => this.scheduleFromUris(event.files)),
            vscode.workspace.onDidRenameFiles(event => this.scheduleFromUris(event.files.map(file => file.newUri)))
        );

        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        this.disposables.push(
            watcher,
            watcher.onDidCreate(uri => this.schedule(uri)),
            watcher.onDidChange(uri => this.schedule(uri)),
            watcher.onDidDelete(uri => this.schedule(uri))
        );
    }

    public schedule(uri?: vscode.Uri) {
        if (uri && this.shouldIgnore(uri)) {
            return;
        }

        const decision = shouldAutoSync({
            enabled: this.isEnabled(),
            hasIndex: this.codeGraph.isAvailable,
            isRunning: this.isRunning,
            isActive: this.isActive?.()
        });

        if (decision !== 'run') {
            return;
        }

        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.sync();
        }, this.debounceMs());
    }

    private scheduleFromUris(uris: readonly vscode.Uri[]) {
        if (uris.length > 0 && uris.every(uri => this.shouldIgnore(uri))) {
            return;
        }
        this.schedule();
    }

    private async sync() {
        const decision = shouldAutoSync({
            enabled: this.isEnabled(),
            hasIndex: this.codeGraph.isAvailable,
            isRunning: this.isRunning,
            isActive: this.isActive?.()
        });

        if (decision !== 'run') {
            return;
        }

        this.isRunning = true;
        try {
            await this.codeGraph.runWorkspaceCommand('sync');
            await this.onSynced?.();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`CodeGraph auto sync failed: ${message}`);
        } finally {
            this.isRunning = false;
        }
    }

    private isEnabled(): boolean {
        return vscode.workspace.getConfiguration('shared').get<boolean>('autoSyncOnSave', true);
    }

    private debounceMs(): number {
        const configured = vscode.workspace.getConfiguration('shared').get<number>('autoSyncDebounceMs');
        return normalizeAutoSyncDebounceMs(configured);
    }

    private shouldIgnore(uri: vscode.Uri): boolean {
        if (uri.scheme !== 'file') {
            return true;
        }

        const normalized = uri.fsPath.replace(/\\/g, '/');
        return normalized.includes('/.codegraph/')
            || normalized.includes('/.git/')
            || normalized.includes('/node_modules/');
    }

    public dispose() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.disposables.forEach(disposable => disposable.dispose());
    }
}
