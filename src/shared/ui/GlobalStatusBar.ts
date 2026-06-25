import * as vscode from 'vscode';
import { CodeGraphService } from '../services/CodeGraphService';

export class GlobalStatusBar {
    private statusBarItem: vscode.StatusBarItem;
    private isRunning = false;

    constructor(
        context: vscode.ExtensionContext,
        private readonly codeGraph: CodeGraphService,
        private readonly onIndexUpdated?: () => void | Promise<void>
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'symbol-window.showStatusMenu';
        context.subscriptions.push(
            this.statusBarItem,
            vscode.commands.registerCommand('symbol-window.showStatusMenu', this.showMenu.bind(this))
        );
        this.update();
    }

    public update() {
        if (this.isRunning) {
            return;
        }

        if (this.codeGraph.isAvailable) {
            this.statusBarItem.text = '$(graph) CodeGraph: Ready';
            this.statusBarItem.tooltip = 'Using the workspace .codegraph index.';
            this.codeGraph.status();
        } else {
            this.statusBarItem.text = '$(warning) CodeGraph: Missing';
            this.statusBarItem.tooltip = 'Run codegraph init in the workspace root.';
            this.codeGraph.status();
        }
        this.statusBarItem.show();
    }

    public static createStatusMenuItems(): vscode.QuickPickItem[] {
        return [
            {
                label: '$(terminal) codegraph init',
                detail: 'Initialize the CodeGraph index for the current workspace.'
            },
            {
                label: '$(sync) codegraph sync',
                detail: 'Synchronize the existing CodeGraph index for the current workspace.'
            }
        ];
    }

    public async runCodeGraphCommand(command: 'init' | 'sync') {
        this.isRunning = true;
        this.setProgress(command, 0);

        try {
            await this.codeGraph.runWorkspaceCommand(command, percent => this.setProgress(command, percent));
            this.setProgress(command, 100);
            vscode.window.showInformationMessage(`CodeGraph ${command} completed.`);
            await this.onIndexUpdated?.();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`CodeGraph ${command} failed: ${message}`);
        } finally {
            this.isRunning = false;
            this.update();
        }
    }

    private async showMenu() {
        const selection = await vscode.window.showQuickPick(GlobalStatusBar.createStatusMenuItems(), {
            placeHolder: 'CodeGraph actions'
        });

        if (!selection) {
            return;
        }

        if (selection.label.includes('init')) {
            await this.runCodeGraphCommand('init');
        } else if (selection.label.includes('sync')) {
            await this.runCodeGraphCommand('sync');
        }
    }

    private setProgress(command: 'init' | 'sync', percent: number) {
        this.statusBarItem.text = `$(sync~spin) CodeGraph ${command}: ${percent}%`;
        this.statusBarItem.tooltip = `Running codegraph ${command} in ${this.codeGraph.workspaceRoot}`;
        this.statusBarItem.show();
    }

    public dispose() {
        this.statusBarItem.dispose();
    }
}
