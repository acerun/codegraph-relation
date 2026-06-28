// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { SymbolController } from './features/symbol/SymbolController';
import { SymbolWebviewProvider } from './features/symbol/SymbolWebviewProvider';
import { RelationController } from './features/relation/RelationController';
import { RelationWebviewProvider } from './features/relation/RelationWebviewProvider';
import { ReferenceController } from './features/reference/ReferenceController';
import { ReferenceWebviewProvider } from './features/reference/ReferenceWebview';
import { DisabledWebviewProvider } from './features/placeholder/DisabledWebviewProvider';
import { GlobalStatusBar } from './shared/ui/GlobalStatusBar';
import { CodeGraphService } from './shared/services/CodeGraphService';
import { CodeGraphAutoSync } from './shared/services/CodeGraphAutoSync';
import * as fs from 'fs';
import { rgPath } from '@vscode/ripgrep';

function ensureRipgrepPermissions() {
    if (process.platform !== 'win32') {
        try {
            // Check if file exists first
            if (fs.existsSync(rgPath)) {
                fs.chmodSync(rgPath, 0o755);
                console.log(`[Source Window] Fixed permissions for: ${rgPath}`);
            } else {
                console.warn(`[Source Window] Ripgrep binary not found at: ${rgPath}`);
            }
        } catch (error) {
            console.error(`[Source Window] Failed to set permissions for ripgrep: ${error}`);
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
	console.log('[CodeGraph Relation] Extension is active.');

    // Ensure ripgrep has executable permissions on Linux/macOS
    ensureRipgrepPermissions();

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const codeGraph = new CodeGraphService(workspaceRoot || context.extensionPath);

    // Symbol Window Logic
    let controller: SymbolController | undefined;
    let provider: SymbolWebviewProvider | undefined;
    let symbolViewDisposable: vscode.Disposable | undefined;

    // Project Window Logic (Split View)
    let projectController: SymbolController | undefined;
    let projectProvider: SymbolWebviewProvider | undefined;
    let projectViewDisposable: vscode.Disposable | undefined;
    let lastSplitView: boolean | undefined;

    // Relation Window Logic
    let relationController: RelationController | undefined;
    let relationProvider: RelationWebviewProvider | undefined;
    let relationViewDisposable: vscode.Disposable | undefined;

    // Reference Window Logic
    let referenceProvider: ReferenceWebviewProvider | undefined;
    let referenceController: ReferenceController | undefined;
    let referenceViewDisposable: vscode.Disposable | undefined;

    const refreshCodeGraphViews = async () => {
        await controller?.refresh();
        await projectController?.refresh();
        await relationController?.refresh();
    };

    // Initialize Global Status Bar
    const globalStatusBar = new GlobalStatusBar(context, codeGraph, refreshCodeGraphViews);
    const isCodeGraphViewVisible = () => Boolean(
        provider?.isVisible
        || projectProvider?.isVisible
        || relationProvider?.isVisible()
        || referenceProvider?.isVisible()
    );
    context.subscriptions.push(new CodeGraphAutoSync(codeGraph, refreshCodeGraphViews, isCodeGraphViewVisible));

    const initSymbolWindow = () => {
        const config = vscode.workspace.getConfiguration('symbolWindow');
        const enabled = config.get<boolean>('enable', true);
        const splitView = config.get<boolean>('splitView', false);
        
        vscode.commands.executeCommand('setContext', 'symbolWindow.splitView', splitView);

        if (enabled) {
            // Primary Window
            // If splitView changed, we MUST recreate the controller to update lockedMode
            if (!controller || lastSplitView !== splitView) {
                if (controller) {
                    controller.dispose();
                }
                
                const lockedMode = splitView ? 'current' : undefined;
                controller = new SymbolController(context, codeGraph, lockedMode);
                
                if (provider) {
                    provider.setController(controller);
                } else {
                    provider = new SymbolWebviewProvider(context.extensionUri, controller);
                    
                    symbolViewDisposable = vscode.window.registerWebviewViewProvider(
                        SymbolWebviewProvider.viewType,
                        provider, {
                            webviewOptions: {
                                retainContextWhenHidden: true
                            }
                        }
                    );
                    context.subscriptions.push(symbolViewDisposable);
                }
            }

            // Secondary Window (Project)
            if (splitView) {
                if (!projectController) {
                    projectController = new SymbolController(context, codeGraph, 'project');
                    
                    if (projectProvider) {
                        projectProvider.setController(projectController);
                    } else {
                        projectProvider = new SymbolWebviewProvider(context.extensionUri, projectController);
                    }
                    
                    projectViewDisposable = vscode.window.registerWebviewViewProvider(
                        'symbol-window-project-view',
                        projectProvider, {
                            webviewOptions: {
                                retainContextWhenHidden: true
                            }
                        }
                    );
                    context.subscriptions.push(projectViewDisposable);
                }
            } else {
                if (projectController) {
                    projectController.dispose();
                    projectController = undefined;
                    projectViewDisposable?.dispose();
                    projectViewDisposable = undefined;
                }
            }
            
            lastSplitView = splitView;
        } else {
            if (controller) {
                controller.dispose();
                controller = undefined;
                // provider = undefined; // Don't dispose provider to keep webview alive? No, we should.
                // Actually, if we disable, the view is hidden by 'when' clause.
                // But we should clean up resources.
                
                // symbolViewDisposable?.dispose(); // Don't dispose view registration, just controller logic?
                // If we dispose view registration, we can't re-register easily without reload?
                // VS Code allows re-registering.
                
                // However, the issue is likely that when re-enabling, we create a NEW controller,
                // but the OLD webview might still be there or re-created.
                // And we need to ensure the new controller syncs its state.
            }
            if (projectController) {
                projectController.dispose();
                projectController = undefined;
            }
        }
    };

    initSymbolWindow();

    const disabledProvider = new DisabledWebviewProvider(context.extensionUri);

    const initRelationWindow = () => {
        const config = vscode.workspace.getConfiguration('relationWindow');
        if (config.get<boolean>('enable', true)) {
            if (!relationController) {
                relationProvider = new RelationWebviewProvider(context.extensionUri);
                relationController = new RelationController(context, relationProvider, referenceController, codeGraph);
                
                relationViewDisposable = vscode.window.registerWebviewViewProvider(
                    RelationWebviewProvider.viewType,
                    relationProvider, {
                        webviewOptions: {
                            retainContextWhenHidden: true
                        }
                    }
                );
                context.subscriptions.push(relationViewDisposable);
            }
        } else {
            if (relationController) {
                relationController.dispose();
                relationController = undefined;
                relationProvider = undefined;
                relationViewDisposable?.dispose();
                relationViewDisposable = undefined;
            }
        }
    };

    initRelationWindow();
    
    const initReferenceWindow = () => {
        const config = vscode.workspace.getConfiguration('referenceWindow');
        if (config.get<boolean>('enable', true)) {
            if (!referenceController) {
                referenceProvider = new ReferenceWebviewProvider(context.extensionUri);
                referenceController = new ReferenceController(context, referenceProvider, codeGraph);
                referenceViewDisposable = vscode.window.registerWebviewViewProvider(
                    ReferenceWebviewProvider.viewType,
                    referenceProvider,
                    {
                        webviewOptions: {
                            retainContextWhenHidden: true
                        }
                    }
                );
                context.subscriptions.push(referenceViewDisposable);
            }
        } else {
            // Dispose if disabled
            if (referenceController) {
                referenceController.dispose(); // Ensure dispose is called
                referenceController = undefined;
                referenceProvider = undefined;
                referenceViewDisposable?.dispose();
                referenceViewDisposable = undefined;
            }
        }

        // Update RelationController with the new (or undefined) ReferenceController
        relationController?.setReferenceController(referenceController);
    };

    initReferenceWindow();

    // Update RelationController's reference when Reference Window changes
    // Note: We need to re-inject referenceController if RelationController exists
    if (relationController) {
        relationController.setReferenceController(referenceController);
    }

    // Listen for config changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('symbolWindow.enable')) {
            initSymbolWindow();
        }
        if (e.affectsConfiguration('relationWindow.enable')) {
            initRelationWindow();
        }
        if (e.affectsConfiguration('referenceWindow.enable')) {
            initReferenceWindow();
            // Update RelationController's reference
            if (relationController) {
                relationController.setReferenceController(referenceController);
            }
        }
    }));

    // Register Disabled Provider (always registered, but only shown via 'when' clause in package.json)
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(DisabledWebviewProvider.viewType, disabledProvider)
    );

	context.subscriptions.push(
		vscode.commands.registerCommand('symbol-window.refresh', () => {
			controller?.refresh();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('symbol-window.toggleMode', () => {
			controller?.toggleMode();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('symbol-window.deepSearch', () => {
			controller?.deepSearch();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('symbol-window.searchInFolder', async (uri: vscode.Uri) => {
            if (uri && uri.fsPath && controller) {
                // Focus the view
                await vscode.commands.executeCommand('symbol-window-view.focus');
                // Set scope
                controller.setScope(uri.fsPath);
            }
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('symbol-window.rebuildIndex', async () => {
            await globalStatusBar.runCodeGraphCommand('sync');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('symbol-window.rebuildIndexFull', async () => {
            await globalStatusBar.runCodeGraphCommand('init');
		})
	);

    context.subscriptions.push(
        vscode.commands.registerCommand('relation-window.toggleDirection', () => {
            relationController?.toggleDirection();
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('symbolWindow.enable') || e.affectsConfiguration('symbolWindow.splitView')) {
                initSymbolWindow();
            }
            if (e.affectsConfiguration('relationWindow.enable')) {
                initRelationWindow();
            }
            if (e.affectsConfiguration('referenceWindow.enable')) {
                initReferenceWindow();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('relation-window.refresh', () => {
            relationController?.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('relation-window.manualSearch', () => {
            relationController?.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('relation-window.jumpToDefinition', (item: any) => {
            if (relationController && item) {
                relationController.jumpToDefinition(item);
            }
        })
    );



    context.subscriptions.push(
        vscode.commands.registerCommand('symbol-window.focusProjectSearch', async () => {
            const config = vscode.workspace.getConfiguration('symbolWindow');
            const enabled = config.get<boolean>('enable', true);
            if (!enabled) { return; }

            // Extract the symbol/word currently under the cursor
            let queryText = '';
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const selection = editor.selection;
                if (!selection.isEmpty) {
                    queryText = editor.document.getText(selection).trim();
                } else {
                    const wordRange = editor.document.getWordRangeAtPosition(selection.active);
                    if (wordRange) {
                        queryText = editor.document.getText(wordRange).trim();
                    }
                }
            }

            const splitView = config.get<boolean>('splitView', true);
            
            if (splitView) {
                // Split View: Focus Project Window
                await vscode.commands.executeCommand('symbol-window-project-view.focus');
                if (projectProvider) {
                    projectProvider.postMessage({ command: 'focusInput', query: queryText });
                }
            } else {
                // Single View: Switch to Project Mode and Focus
                await vscode.commands.executeCommand('symbol-window-view.focus');
                if (controller) {
                    if (controller.currentMode !== 'project') {
                        controller.setMode('project');
                    }
                    if (provider) {
                        provider.postMessage({ command: 'focusInput', query: queryText });
                    }
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('symbol-window.focusCurrentSearch', async () => {
            const config = vscode.workspace.getConfiguration('symbolWindow');
            const enabled = config.get<boolean>('enable', true);
            if (!enabled) { return; }

            const splitView = config.get<boolean>('splitView', true);
            
            if (splitView) {
                // Split View: Focus Current Window
                await vscode.commands.executeCommand('symbol-window-view.focus');
                if (provider) {
                    provider.postMessage({ command: 'focusInput' });
                }
            } else {
                // Single View: Switch to Current Mode and Focus
                await vscode.commands.executeCommand('symbol-window-view.focus');
                if (controller) {
                    if (controller.currentMode !== 'current') {
                        controller.setMode('current');
                    }
                    if (provider) {
                        provider.postMessage({ command: 'focusInput' });
                    }
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('relation-window.lookupReference', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const uri = editor.document.uri;
                const position = editor.selection.active;
                const wordRange = editor.document.getWordRangeAtPosition(position);
                const word = wordRange ? editor.document.getText(wordRange) : 'Selection';
                
                await referenceController?.lookupReference(uri, position, word);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('reference-window.next', () => {
            referenceController?.next();
        }),
        vscode.commands.registerCommand('reference-window.prev', () => {
            referenceController?.prev();
        })
    );
}

export function deactivate() {
    console.log('[Source Window] Deactivated.');
}
