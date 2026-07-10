import * as vscode from 'vscode';
import { SymbolModel } from './SymbolModel';
import { SymbolWebviewProvider } from './SymbolWebviewProvider';
import { SymbolMode, SymbolItem } from '../../shared/common/types';
import { CodeGraphService } from '../../shared/services/CodeGraphService';
import { symbolKindNames } from '../../shared/common/symbolKinds';

export class SymbolController {
    private model: SymbolModel;
    private provider?: SymbolWebviewProvider;
    private context: vscode.ExtensionContext;
    public currentMode: SymbolMode = 'current';
    private debounceTimer: NodeJS.Timeout | undefined;
    private currentSearchId: number = 0;
    private searchCts: vscode.CancellationTokenSource | undefined;
    
    private currentQuery: string = '';
    private currentScopePath: string | undefined;
    private currentIncludePattern: string | undefined;
    private currentExcludePattern: string | undefined;
    private currentDocumentSymbols: SymbolItem[] = [];
    private currentFilter: number[] = [];
    private projectFilter: number[] = [];

    // Caching
    private searchCache: Map<string, SymbolItem[]> = new Map();
    // Pagination
    private allSearchResults: SymbolItem[] = [];
    private loadedCount: number = 0;
    private readonly BATCH_SIZE = 100;
    
    private disposables: vscode.Disposable[] = [];

    constructor(
        context: vscode.ExtensionContext,
        private codeGraph: CodeGraphService,
        private lockedMode?: SymbolMode
    ) {
        this.context = context;
        this.model = new SymbolModel(codeGraph);
        
        // Restore state
        if (this.lockedMode) {
            this.currentMode = this.lockedMode;
        } else {
            this.currentMode = this.context.workspaceState.get<SymbolMode>('symbolWindow.mode', 'current');
        }
        this.currentScopePath = this.context.workspaceState.get<string>('symbolWindow.scopePath');
        
        const allKinds = Object.keys(symbolKindNames).map(Number);
        this.currentFilter = this.context.workspaceState.get<number[]>('symbolWindow.currentFilter', allKinds);
        this.projectFilter = this.context.workspaceState.get<number[]>('symbolWindow.projectFilter', allKinds);
        
        if (!this.lockedMode) {
            vscode.commands.executeCommand('setContext', 'symbolWindow.mode', this.currentMode);
        }

        // Listen to active editor changes
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
            // Current Mode: Always try to update immediately
            if (this.currentMode === 'current') {
                if (editor) {
                    this.updateCurrentSymbols(editor.document.uri).catch(e => {
                        console.error('[CodeGraph Relation] updateCurrentSymbols failed', e);
                        this.provider?.postMessage({ command: 'status', status: 'timeout' });
                    });
                } else {
                    this.provider?.postMessage({ command: 'updateSymbols', symbols: [] });
                }
            }
        }));

        // Listen to document changes (re-parse symbols)
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            // 1. Clear Project Cache (Always)
            this.searchCache.clear();

            // 2. Current Mode: Update immediately
            if (this.currentMode === 'current') {
                this.updateCurrentSymbols(doc.uri);
            }
        }, null, context.subscriptions);
        
        // Listen to selection changes for sync
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (this.currentMode === 'current' && this.provider && this.provider.isVisible) {
                const cursor = e.selections[0].active;
                const symbol = this.findSymbolAtPosition(this.currentDocumentSymbols, cursor);
                if (symbol) {
                    this.provider.postMessage({ command: 'selectSymbol', range: symbol.range });
                }
            }
        }, null, context.subscriptions);

        // Listen to configuration changes
        this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('symbolWindow.enableHighlighting') || 
                e.affectsConfiguration('shared.enableRipgrepFallback')) {
                this.refresh();
            }
        }));
    }

    private findSymbolAtPosition(symbols: SymbolItem[], position: vscode.Position): SymbolItem | undefined {
        for (const symbol of symbols) {
            if (symbol.range.contains(position)) {
                // Check children first for more specific match
                if (symbol.children && symbol.children.length > 0) {
                    const child = this.findSymbolAtPosition(symbol.children, position);
                    if (child) {
                        return child;
                    }
                }
                return symbol;
            }
        }
        return undefined;
    }

    public setProvider(provider: SymbolWebviewProvider) {
        this.provider = provider;
        // When provider is set (webview becomes visible or reloaded), refresh immediately
        // This is crucial when controller is recreated but webview was already there
        this.refresh();
    }

    public async refresh() {
        // Clear cache on explicit refresh
        this.searchCache.clear();

        // Sync mode to webview to ensure consistency
        this.provider?.postMessage({ command: 'setMode', mode: this.currentMode, lockedMode: this.lockedMode });
        
        const codeGraphReady = this.codeGraph.isAvailable;
        vscode.commands.executeCommand('setContext', 'symbolWindow.databaseReady', codeGraphReady);
        this.provider?.postMessage({ command: 'setDatabaseMode', enabled: codeGraphReady });

        // Sync settings
        const config = vscode.workspace.getConfiguration('symbolWindow');
        this.provider?.postMessage({ 
            command: 'setSettings', 
            settings: {
                enableHighlighting: config.get<boolean>('enableHighlighting', true)
            }
        });
        
        // Sync mode
        this.provider?.postMessage({ command: 'setMode', mode: this.currentMode });

        // Sync scope
        this.provider?.postMessage({ command: 'setScope', scopePath: this.currentScopePath });

        // Sync filters
        this.provider?.postMessage({ 
            command: 'setFilters', 
            currentFilter: this.currentFilter, 
            projectFilter: this.projectFilter 
        });

        this.provider?.postMessage({ command: 'status', status: codeGraphReady ? 'ready' : 'timeout' });

        if (this.currentMode === 'current') {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                await this.updateCurrentSymbols(editor.document.uri);
            } else {
                // No active editor, clear symbols
                this.provider?.postMessage({ command: 'updateSymbols', symbols: [] });
                this.provider?.postMessage({ command: 'status', status: 'ready' });
            }
            return;
        }

        if (!codeGraphReady) {
            return;
        }
        
        // Project mode refresh: Ask webview to re-send search query
        this.provider?.postMessage({ command: 'refresh' });
    }

    public toggleMode() {
        if (this.lockedMode) { return; }
        this.setMode(this.currentMode === 'current' ? 'project' : 'current');
    }

    public setMode(mode: SymbolMode) {
        if (this.lockedMode) { return; }
        if (this.currentMode === mode) { return; }
        
        this.currentMode = mode;
        this.context.workspaceState.update('symbolWindow.mode', this.currentMode);
        vscode.commands.executeCommand('setContext', 'symbolWindow.mode', this.currentMode);
        if (this.provider) {
            // Force update mode in webview
            this.provider.postMessage({ command: 'setMode', mode: this.currentMode });
            
            // Sync settings on mode toggle too
            const config = vscode.workspace.getConfiguration('symbolWindow');
            this.provider.postMessage({ 
                command: 'setSettings', 
                settings: {
                    enableHighlighting: config.get<boolean>('enableHighlighting', true)
                }
            });
        }
        
        this.refresh();
    }

    public async startPolling() {
        this.refresh();
    }

    public cancelSearch() {
        if (this.searchCts) {
            this.searchCts.cancel();
            this.searchCts.dispose();
            this.searchCts = undefined;
        }
        this.provider?.postMessage({ command: 'status', status: 'ready' });
        this.provider?.postMessage({ command: 'updateSymbols', symbols: this.allSearchResults });
    }

    // Removed checkReadiness method as it is replaced by startPolling/poll
    public async handleSearch(query: string, includePattern?: string, excludePattern?: string, kinds?: number[]) {
        if (this.currentMode === 'project') {
            // Update patterns
            this.currentIncludePattern = includePattern;
            this.currentExcludePattern = excludePattern;
            if (kinds) {
                this.projectFilter = kinds;
            }

            if (!this.codeGraph.isAvailable) {
                this.provider?.postMessage({ command: 'status', status: 'timeout' });
                return;
            }

            // Cancel any ongoing search immediately when user types
            if (this.searchCts) {
                this.searchCts.cancel();
                this.searchCts.dispose();
                this.searchCts = undefined;
            }

            // Debounce
            if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
            
            const searchId = ++this.currentSearchId;
            const cacheKey = query.trim();
            const debounceTime = this.searchCache.has(cacheKey) ? 0 : 300;

            this.debounceTimer = setTimeout(async () => {
                if (searchId !== this.currentSearchId) { return; }

                this.currentQuery = query;
                const keywords = query.trim().split(/\s+/).filter(k => k.length > 0);
                
                this.provider?.postMessage({ command: 'searchStart' });

                this.searchCts = new vscode.CancellationTokenSource();
                const token = this.searchCts.token;

                let allSymbols: SymbolItem[] = [];

                try {
                    const cachedSymbols = this.searchCache.get(cacheKey);
                    if (cachedSymbols) {
                        allSymbols = [...cachedSymbols];
                    } else {
                        const fetchedSymbols = keywords.length === 0
                            ? await this.model.getProjectSymbols()
                            : await this.model.getWorkspaceSymbols(query);
                        if (searchId !== this.currentSearchId || token.isCancellationRequested) {
                            return;
                        }
                        this.searchCache.set(cacheKey, fetchedSymbols);
                        allSymbols = [...fetchedSymbols];
                    }
                    if (searchId !== this.currentSearchId || token.isCancellationRequested) {
                        return;
                    }

                    if (kinds && kinds.length === 0) {
                        allSymbols = [];
                    } else if (kinds && kinds.length < Object.keys(symbolKindNames).length) {
                        allSymbols = allSymbols.filter(symbol => kinds.includes(symbol.kind));
                    }

                    allSymbols = this.sortSymbols(allSymbols, query);

                    this.allSearchResults = allSymbols;
                    this.loadedCount = this.BATCH_SIZE;

                    // Send first batch
                    const initialBatch = this.allSearchResults.slice(0, this.loadedCount);
                    this.provider?.postMessage({ 
                        command: 'updateSymbols', 
                        symbols: initialBatch,
                        totalCount: this.allSearchResults.length 
                    });
                    this.provider?.postMessage({ command: 'status', status: 'ready' });

                } catch (error) {
                    if (error instanceof vscode.CancellationError) {
                        // ignore
                    } else {
                        console.error(`[CodeGraph Relation] SearchId ${searchId} failed`, error);
                        this.allSearchResults = [];
                        this.loadedCount = 0;
                        this.provider?.postMessage({ command: 'status', status: 'ready' });
                        this.provider?.postMessage({ command: 'updateSymbols', symbols: [] });
                    }
                    return;
                }
            }, debounceTime);
        }
    }

    private async updateCurrentSymbols(uri: vscode.Uri) {
        try {
            const symbols = await this.model.getDocumentSymbols(uri);
            this.currentDocumentSymbols = symbols;
            this.provider?.postMessage({ command: 'status', status: this.codeGraph.isAvailable ? 'ready' : 'timeout' });
            this.provider?.postMessage({ command: 'updateSymbols', symbols });
        } catch (error) {
            console.error('[CodeGraph Relation] Failed to load document symbols', error);
            this.currentDocumentSymbols = [];
            this.provider?.postMessage({ command: 'status', status: 'timeout' });
            this.provider?.postMessage({ command: 'updateSymbols', symbols: [] });
        }
    }

    public jumpTo(uriStr: string | undefined, range: any) {
        if (uriStr) {
            const uri = vscode.Uri.parse(uriStr);
            vscode.window.showTextDocument(uri, { selection: new vscode.Range(range[0].line, range[0].character, range[1].line, range[1].character) });
        } else {
            // Current document
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                editor.revealRange(new vscode.Range(range[0].line, range[0].character, range[1].line, range[1].character));
                editor.selection = new vscode.Selection(range[0].line, range[0].character, range[1].line, range[1].character);
            }
        }
    }

    public loadMore() {
        if (this.currentMode === 'project') {
            if (this.loadedCount < this.allSearchResults.length) {
                const start = this.loadedCount;
                this.loadedCount += this.BATCH_SIZE;
                const nextBatch = this.allSearchResults.slice(start, this.loadedCount);
                this.provider?.postMessage({ 
                    command: 'appendSymbols', 
                    symbols: nextBatch,
                    totalCount: this.allSearchResults.length
                });
            }
        }
    }

    public async deepSearch(isAuto: boolean = false) {
        if (this.currentMode !== 'project' || !this.currentQuery) {
            return;
        }

        const keywords = this.currentQuery.trim().split(/\s+/).filter(k => k.length > 0);
        if (keywords.length === 0) {
            return;
        }

        // If auto-triggered, we don't want to set status to loading if it's already loading?
        // Actually, handleSearch sets 'searchStart' which might set loading.
        // But deepSearch is async.
        this.provider?.postMessage({ command: 'status', status: 'loading' });

        try {
            const textSearchResults = await this.model.findSymbolsByTextSearch(
                this.currentQuery,
                this.searchCts?.token,
                this.currentScopePath,
                this.currentIncludePattern
            );
            
            // Check cancellation
            if (this.searchCts?.token.isCancellationRequested) {
                return;
            }

            // Deduplicate against existing results
            const existingKeys = new Set<string>();
            this.allSearchResults.forEach(s => {
                // Use selectionRange for better matching between DocumentSymbol and WorkspaceSymbol
                // WorkspaceSymbol range usually points to the name, which matches DocumentSymbol.selectionRange
                const key = `${s.uri}|${s.selectionRange.start.line}:${s.selectionRange.start.character}`;
                existingKeys.add(key);
            });

            const newItems: SymbolItem[] = [];
            textSearchResults.forEach(s => {
                const key = `${s.uri}|${s.selectionRange.start.line}:${s.selectionRange.start.character}`;
                if (!existingKeys.has(key)) {
                    s.isDeepSearch = true;
                    newItems.push(s);
                    existingKeys.add(key); // Avoid duplicates within new items too
                }
            });

            if (newItems.length > 0) {
                // Prepend new items
                this.allSearchResults = [...newItems, ...this.allSearchResults];
                
                this.allSearchResults = this.sortSymbols(this.allSearchResults, this.currentQuery);

                // Refresh UI
                this.loadedCount = Math.max(this.loadedCount + newItems.length, this.BATCH_SIZE);
                const batch = this.allSearchResults.slice(0, this.loadedCount);
                
                this.provider?.postMessage({ 
                    command: 'updateSymbols', 
                    symbols: batch,
                    totalCount: this.allSearchResults.length 
                });
            }
        } catch (e) {
            console.error('[Source Window] Deep search failed', e);
        } finally {
            this.provider?.postMessage({ command: 'status', status: 'ready' });
        }
    }

    public setScope(scope: string) {
        // Sanitize input: Ensure we have a valid fsPath for internal use
        try {
            // If it looks like a URI, parse it
            if (scope.startsWith('file://') || scope.startsWith('vscode-remote://')) {
                this.currentScopePath = vscode.Uri.parse(scope).fsPath;
            } else {
                // Otherwise treat as path (but normalize it via Uri.file to be safe)
                this.currentScopePath = vscode.Uri.file(scope).fsPath;
            }
        } catch (e) {
            console.warn('[Source Window] Invalid scope path:', scope);
            this.currentScopePath = scope; // Fallback
        }

        this.context.workspaceState.update('symbolWindow.scopePath', this.currentScopePath);
        
        // Switch to project mode if not already
        if (this.currentMode !== 'project') {
            this.toggleMode();
        }
        
        // Send back to Webview as URI string (External Communication)
        const scopeUri = vscode.Uri.file(this.currentScopePath).toString();
        this.provider?.postMessage({ command: 'setScope', scopePath: scopeUri });
        
        // Trigger search if query exists
        if (this.currentQuery) {
            this.handleSearch(this.currentQuery, this.currentIncludePattern, this.currentExcludePattern, this.projectFilter);
        }
    }

    public clearScope() {
        this.currentScopePath = undefined;
        this.context.workspaceState.update('symbolWindow.scopePath', undefined);
        this.provider?.postMessage({ command: 'setScope', scopePath: undefined });
        
        // Trigger search if query exists
        if (this.currentQuery) {
            this.handleSearch(this.currentQuery, this.currentIncludePattern, this.currentExcludePattern, this.projectFilter);
        }
    }

    public async selectScope() {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select Search Scope'
        });

        if (uris && uris.length > 0) {
            // Internal: Use fsPath
            this.setScope(uris[0].fsPath);
        }
    }

    private sortSymbols(symbols: SymbolItem[], query: string): SymbolItem[] {
        const queryLower = query.toLowerCase();
        return symbols.sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();

            // 1. Exact Match
            const aExact = aName === queryLower;
            const bExact = bName === queryLower;
            if (aExact && !bExact) { return -1; }
            if (!aExact && bExact) { return 1; }

            // 2. CodeGraph relevance score (higher first), when available
            if (a.score !== undefined && b.score !== undefined && a.score !== b.score) {
                return b.score - a.score;
            }

            // 3. Length (Shortest First)
            const lenDiff = aName.length - bName.length;
            if (lenDiff !== 0) { return lenDiff; }

            // 4. Alphabetical
            return aName.localeCompare(bName);
        });
    }

    public saveFilters(currentFilter: number[], projectFilter: number[]) {
        this.currentFilter = currentFilter;
        this.projectFilter = projectFilter;
        this.context.workspaceState.update('symbolWindow.currentFilter', currentFilter);
        this.context.workspaceState.update('symbolWindow.projectFilter', projectFilter);
    }

    public dispose() {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}

