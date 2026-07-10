import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SymbolItem } from '../common/types.js';
import { performDeepSearch } from '../utils/search.js';

interface CodeGraphNode {
    kind?: string;
    name?: string;
    qualifiedName?: string;
    filePath?: string;
    language?: string;
    startLine?: number;
    endLine?: number;
    startColumn?: number;
    endColumn?: number;
    signature?: string;
}

interface CodeGraphSearchResult {
    node?: CodeGraphNode;
    score?: number;
}

interface CodeGraphRelationNode {
    name?: string;
    kind?: string;
    filePath?: string;
    startLine?: number;
}

interface CodeGraphFile {
    path?: string;
    nodeCount?: number;
}

export class CodeGraphService {
    private static readonly DEFAULT_LIMIT = 500;
    private static readonly DEFAULT_PROJECT_SYMBOL_LIMIT = 20;
    private static readonly output = vscode.window.createOutputChannel('CodeGraph Relation');
    private readonly documentSymbolsCache = new Map<string, { mtimeMs: number; value: Promise<SymbolItem[]> }>();

    constructor(private readonly fallbackRoot: string) {
        this.log(`Activated. fallbackRoot=${fallbackRoot}`);
    }

    public get isAvailable(): boolean {
        return !!this.findProjectRoot();
    }

    public get workspaceRoot(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || this.fallbackRoot;
    }

    public static hasIndex(workspaceRoot: string | undefined): boolean {
        return !!workspaceRoot && fs.existsSync(path.join(workspaceRoot, '.codegraph'));
    }

    public async status(): Promise<'ready' | 'missing' | 'error'> {
        const root = this.findProjectRoot();
        if (!root) {
            this.log('Status: missing .codegraph');
            return 'missing';
        }

        try {
            await this.execCodeGraph(['status', root], root);
            return 'ready';
        } catch {
            return 'error';
        }
    }

    public async runWorkspaceCommand(
        command: 'init' | 'sync',
        onProgress?: (percent: number) => void
    ): Promise<void> {
        await this.execCodeGraphStreaming([command], this.workspaceRoot, onProgress);
        this.documentSymbolsCache.clear();
    }

    public async searchSymbols(query: string, limit = CodeGraphService.DEFAULT_LIMIT): Promise<SymbolItem[]> {
        const root = this.findProjectRoot();
        if (!query.trim() || !root) {
            this.log(`searchSymbols skipped. query="${query}", root=${root || '<missing>'}`);
            return [];
        }

        const output = await this.execCodeGraph(['query', query, '-p', root, '--json', '-l', String(limit)], root);
        const items = CodeGraphService.mapQueryResults(JSON.parse(output) as CodeGraphSearchResult[], root);
        this.log(`searchSymbols "${query}" -> ${items.length} items`);
        return items;
    }

    public async getProjectSymbols(symbolLimit = CodeGraphService.DEFAULT_PROJECT_SYMBOL_LIMIT): Promise<SymbolItem[]> {
        const root = this.findProjectRoot();
        if (!root) {
            this.log('getProjectSymbols skipped. No .codegraph found');
            return [];
        }

        const output = await this.execCodeGraph(['files', '-p', root, '--json'], root);
        const files = JSON.parse(output) as CodeGraphFile[];
        const indexedFiles = CodeGraphService.selectDefaultProjectFiles(files, symbolLimit);
        const hasMainFile = CodeGraphService.hasMainFile(indexedFiles);
        const items: SymbolItem[] = [];

        for (let offset = 0; offset < indexedFiles.length; offset += 4) {
            const batch = await Promise.all(indexedFiles.slice(offset, offset + 4).map(async file => {
                const relativePath = file.path!;
                try {
                    const symbolsOutput = await this.execCodeGraph([
                        'node',
                        '-p',
                        root,
                        '-f',
                        relativePath,
                        relativePath,
                        '--symbols-only'
                    ], root);
                    return CodeGraphService.parseFileSymbols(symbolsOutput, root, relativePath);
                } catch (error) {
                    this.log(`getProjectSymbols skipped file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
                    return [];
                }
            }));
            items.push(...batch.flat());
            if (items.length >= symbolLimit && !hasMainFile) {
                break;
            }
        }

        this.log(`getProjectSymbols files=${indexedFiles.length}/${files.length} -> ${items.length} items`);
        return hasMainFile ? items : items.slice(0, symbolLimit);
    }

    public async getDocumentSymbols(uri: vscode.Uri): Promise<SymbolItem[]> {
        if (uri.scheme !== 'file') {
            this.log(`getDocumentSymbols skipped. Unsupported uri scheme=${uri.scheme}, uri=${uri.toString()}`);
            return [];
        }

        const root = this.findProjectRoot(uri);
        if (!root) {
            this.log(`getDocumentSymbols skipped. No .codegraph found for ${uri.fsPath}`);
            return [];
        }

        if (!this.isInsideWorkspace(uri.fsPath, root)) {
            this.log(`getDocumentSymbols skipped. File is outside CodeGraph root. file=${uri.fsPath}, root=${root}`);
            return [];
        }

        const relativePath = this.toRelativePath(uri.fsPath, root);
        const cacheKey = `${root}:${relativePath}`;
        const mtimeMs = fs.existsSync(uri.fsPath) ? fs.statSync(uri.fsPath).mtimeMs : 0;
        const cached = this.documentSymbolsCache.get(cacheKey);
        if (cached?.mtimeMs === mtimeMs) {
            return cached.value;
        }

        const value = this.execCodeGraph([
            'node',
            '-p',
            root,
            '-f',
            relativePath,
            relativePath,
            '--symbols-only'
        ], root).then(output => {
            const items = CodeGraphService.parseFileSymbols(output, root, relativePath);
            this.log(`getDocumentSymbols ${relativePath} -> ${items.length} items`);
            return items;
        });
        this.documentSymbolsCache.set(cacheKey, { mtimeMs, value });

        try {
            return await value;
        } catch (error) {
            if (this.documentSymbolsCache.get(cacheKey)?.value === value) {
                this.documentSymbolsCache.delete(cacheKey);
            }
            throw error;
        }
    }

    public async findSymbolAtLocation(uri: vscode.Uri, position: vscode.Position): Promise<vscode.CallHierarchyItem | undefined> {
        const symbols = await this.getDocumentSymbols(uri);
        const matching = symbols
            .filter(symbol => symbol.range.contains(position) || symbol.selectionRange.contains(position))
            .sort((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line))[0];

        if (matching) {
            return this.symbolItemToCallHierarchyItem(matching);
        }

        const document = await vscode.workspace.openTextDocument(uri);
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return undefined;
        }

        const word = document.getText(wordRange);
        const matches = await this.searchSymbols(word, 20);
        const exact = matches.find(item => item.name === word) || matches[0];
        return exact ? this.symbolItemToCallHierarchyItem(exact) : new vscode.CallHierarchyItem(
            vscode.SymbolKind.Function,
            word,
            '',
            uri,
            wordRange,
            wordRange
        );
    }

    public async getDefinition(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location | undefined> {
        const item = await this.findSymbolAtLocation(uri, position);
        return item ? new vscode.Location(item.uri, item.selectionRange) : undefined;
    }

    public async getReferences(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
        const item = await this.findSymbolAtLocation(uri, position);
        if (!item) {
            return [];
        }

        return this.findReferencesByName(item.name, uri);
    }

    public async findReferencesByName(name: string, fallbackUri?: vscode.Uri): Promise<vscode.Location[]> {
        const root = this.findProjectRoot(fallbackUri);
        if (!name || !root) {
            this.log(`findReferencesByName skipped. name="${name}", root=${root || '<missing>'}`);
            return [];
        }

        return performDeepSearch({
            query: name,
            cwd: root,
            isCaseSensitive: false,
            isWordMatch: true,
            disabledByDefault: true
        }).then(locations => {
            if (locations.length > 0 || !fallbackUri) {
                return locations;
            }
            return [new vscode.Location(fallbackUri, new vscode.Range(0, 0, 0, 0))];
        });
    }

    public async getRelationItems(symbol: string, direction: 'incoming' | 'outgoing', limit = 100): Promise<vscode.CallHierarchyItem[]> {
        const root = this.findProjectRoot();
        if (!symbol.trim() || !root) {
            this.log(`getRelationItems skipped. symbol="${symbol}", root=${root || '<missing>'}`);
            return [];
        }

        const command = direction === 'incoming' ? 'callers' : 'callees';
        const output = await this.execCodeGraph([command, symbol, '-p', root, '--json', '-l', String(limit)], root);
        const parsed = JSON.parse(output) as { callers?: CodeGraphRelationNode[]; callees?: CodeGraphRelationNode[] };
        const nodes = direction === 'incoming' ? parsed.callers || [] : parsed.callees || [];

        const items = nodes
            .filter(node => node.filePath && node.name)
            .map(node => this.relationNodeToCallHierarchyItem(node, root));
        this.log(`getRelationItems ${direction} ${symbol} -> ${items.length} items`);
        return items;
    }

    public symbolItemToCallHierarchyItem(item: SymbolItem): vscode.CallHierarchyItem {
        return new vscode.CallHierarchyItem(
            item.kind,
            item.name,
            item.detail || '',
            vscode.Uri.parse(item.uri || vscode.Uri.file(this.fallbackRoot).toString()),
            item.range,
            item.selectionRange
        );
    }

    public static parseProgressPercent(output: string): number | undefined {
        const match = output.match(/(?:^|[^\d])(\d{1,3})(?:\.\d+)?\s*%/);
        if (!match) {
            return undefined;
        }

        return Math.max(0, Math.min(Number(match[1]), 100));
    }

    public static selectDefaultProjectFiles(files: CodeGraphFile[], limit: number): CodeGraphFile[] {
        const indexedFiles = files
            .filter(file => file.path && (file.nodeCount || 0) > 0)
            .sort((a, b) => a.path!.localeCompare(b.path!));
        const mainFiles = indexedFiles.filter(file => CodeGraphService.isMainFile(file.path!));

        return (mainFiles.length > 0 ? mainFiles : indexedFiles).slice(0, limit);
    }

    public static mapQueryResults(results: CodeGraphSearchResult[], workspaceRoot: string): SymbolItem[] {
        return results
            .filter(result => !!result.node?.name && !!result.node.filePath)
            .map(result => ({
                ...CodeGraphService.nodeToSymbolItem(result.node!, workspaceRoot),
                score: result.score
            }));
    }

    public static parseFileSymbols(output: string, workspaceRoot: string, filePath: string): SymbolItem[] {
        const items: SymbolItem[] = [];
        const symbolLine = /^-\s+`(.+?)`\s+\(([^)]+)\)(?:\s+(.+?))?\s+(?:\u2014|-)\s+:(\d+)/;

        for (const line of output.split(/\r?\n/)) {
            const match = line.match(symbolLine);
            if (!match) {
                continue;
            }

            const name = match[1];
            const kind = match[2];
            const detail = (match[3] || '').trim();
            const lineNumber = Math.max(Number(match[4]) - 1, 0);
            const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
            const range = new vscode.Range(lineNumber, 0, lineNumber, Number.MAX_SAFE_INTEGER);

            items.push({
                name,
                detail,
                kind: CodeGraphService.kindToVscodeKind(kind),
                range,
                selectionRange: range,
                children: [],
                uri: vscode.Uri.file(absolutePath).toString(),
                path: CodeGraphService.formatPath(workspaceRoot, absolutePath, lineNumber)
            });
        }

        return items;
    }

    public static kindToVscodeKind(kind: string | undefined): vscode.SymbolKind {
        switch ((kind || '').toLowerCase()) {
            case 'class':
                return vscode.SymbolKind.Class;
            case 'method':
                return vscode.SymbolKind.Method;
            case 'constructor':
                return vscode.SymbolKind.Constructor;
            case 'function':
                return vscode.SymbolKind.Function;
            case 'interface':
                return vscode.SymbolKind.Interface;
            case 'property':
                return vscode.SymbolKind.Property;
            case 'variable':
                return vscode.SymbolKind.Variable;
            case 'constant':
                return vscode.SymbolKind.Constant;
            case 'type_alias':
            case 'type':
                return vscode.SymbolKind.TypeParameter;
            case 'file':
                return vscode.SymbolKind.File;
            case 'import':
                return vscode.SymbolKind.Module;
            default:
                return vscode.SymbolKind.Object;
        }
    }

    private static nodeToSymbolItem(node: CodeGraphNode, workspaceRoot: string): SymbolItem {
        const absolutePath = path.isAbsolute(node.filePath!) ? node.filePath! : path.join(workspaceRoot, node.filePath!);
        const startLine = Math.max((node.startLine || 1) - 1, 0);
        const endLine = Math.max((node.endLine || node.startLine || 1) - 1, startLine);
        const startColumn = Math.max(node.startColumn || 0, 0);
        const endColumn = Math.max(node.endColumn || startColumn + (node.name?.length || 1), startColumn + 1);
        const range = new vscode.Range(startLine, startColumn, endLine, endColumn);
        const selectionRange = new vscode.Range(startLine, startColumn, startLine, startColumn + (node.name?.length || 1));

        return {
            name: node.name!,
            detail: node.qualifiedName && node.qualifiedName !== node.name ? node.qualifiedName : node.signature || '',
            kind: CodeGraphService.kindToVscodeKind(node.kind),
            range,
            selectionRange,
            children: [],
            uri: vscode.Uri.file(absolutePath).toString(),
            path: CodeGraphService.formatPath(workspaceRoot, absolutePath, startLine),
            containerName: node.qualifiedName
        };
    }

    private relationNodeToCallHierarchyItem(node: CodeGraphRelationNode, root: string): vscode.CallHierarchyItem {
        const absolutePath = path.isAbsolute(node.filePath!) ? node.filePath! : path.join(root, node.filePath!);
        const startLine = Math.max((node.startLine || 1) - 1, 0);
        const range = new vscode.Range(startLine, 0, startLine, Number.MAX_SAFE_INTEGER);

        return new vscode.CallHierarchyItem(
            CodeGraphService.kindToVscodeKind(node.kind),
            node.name!,
            '',
            vscode.Uri.file(absolutePath),
            range,
            range
        );
    }

    private static formatPath(workspaceRoot: string, absolutePath: string, line: number): string {
        const relativePath = path.relative(workspaceRoot, absolutePath) || path.basename(absolutePath);
        const filename = path.basename(relativePath);
        const dir = path.dirname(relativePath);
        return dir === '.' ? `${filename}:${line + 1}` : `${filename} (${dir}):${line + 1}`;
    }

    private static isMainFile(filePath: string): boolean {
        const filename = path.basename(filePath).toLowerCase();
        return /^main(\.[^.]+)+$/.test(filename);
    }

    private static hasMainFile(files: CodeGraphFile[]): boolean {
        return files.some(file => file.path && CodeGraphService.isMainFile(file.path));
    }

    private toRelativePath(filePath: string, root: string): string {
        return path.relative(root, filePath).replace(/\\/g, '/');
    }

    private isInsideWorkspace(filePath: string, root: string): boolean {
        const relative = path.relative(root, filePath);
        return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    }

    private findProjectRoot(uri?: vscode.Uri): string | undefined {
        const candidates: string[] = [];
        if (uri?.scheme === 'file') {
            candidates.push(path.dirname(uri.fsPath));
        }

        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri?.scheme === 'file') {
            candidates.push(path.dirname(activeUri.fsPath));
        }

        for (const folder of vscode.workspace.workspaceFolders || []) {
            candidates.push(folder.uri.fsPath);
        }
        candidates.push(this.fallbackRoot);

        for (const candidate of candidates) {
            const root = this.findNearestCodeGraphRoot(candidate);
            if (root) {
                return root;
            }
        }
        return undefined;
    }

    private findNearestCodeGraphRoot(startPath: string): string | undefined {
        let current = startPath;
        try {
            if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) {
                current = path.dirname(current);
            }
        } catch {
            return undefined;
        }

        while (true) {
            if (CodeGraphService.hasIndex(current)) {
                return current;
            }

            const parent = path.dirname(current);
            if (parent === current) {
                return undefined;
            }
            current = parent;
        }
    }

    private log(message: string) {
        const line = `[${new Date().toISOString()}] ${message}`;
        CodeGraphService.output.appendLine(line);
        console.log(`[CodeGraph Relation] ${message}`);
    }

    // On Windows shell:true is required to launch the codegraph.cmd shim, but the
    // shell then re-splits the joined command line on whitespace. Quote args that
    // contain spaces (multi-word queries, paths) so they stay a single argument.
    private static readonly useShell = process.platform === 'win32';
    private static quoteArgs(args: string[]): string[] {
        return CodeGraphService.useShell ? args.map(arg => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
    }

    private execCodeGraph(args: string[], cwd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const command = vscode.workspace.getConfiguration('shared').get<string>('codeGraphPath', 'codegraph');
            const execArgs = CodeGraphService.quoteArgs(args);
            this.log(`${command} ${execArgs.join(' ')}`);
            cp.execFile(command, execArgs, {
                cwd,
                maxBuffer: 1024 * 1024 * 20,
                shell: CodeGraphService.useShell
            }, (error, stdout, stderr) => {
                if (error) {
                    const message = stderr || stdout || error.message;
                    this.log(message);
                    reject(new Error(message));
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }

    private execCodeGraphStreaming(args: string[], cwd: string, onProgress?: (percent: number) => void): Promise<void> {
        return new Promise((resolve, reject) => {
            const command = vscode.workspace.getConfiguration('shared').get<string>('codeGraphPath', 'codegraph');
            const execArgs = CodeGraphService.quoteArgs(args);
            this.log(`${command} ${execArgs.join(' ')}`);

            const child = cp.spawn(command, execArgs, {
                cwd,
                shell: CodeGraphService.useShell
            });
            let output = '';

            const handleChunk = (chunk: Buffer) => {
                const text = chunk.toString();
                output += text;
                const percent = CodeGraphService.parseProgressPercent(text);
                if (percent !== undefined) {
                    onProgress?.(percent);
                }
            };

            child.stdout?.on('data', handleChunk);
            child.stderr?.on('data', handleChunk);

            child.on('error', error => {
                this.log(error.message);
                reject(error);
            });

            child.on('close', code => {
                if (code && code !== 0) {
                    const message = output.trim() || `CodeGraph exited with code ${code}`;
                    this.log(message);
                    reject(new Error(message));
                    return;
                }
                resolve();
            });
        });
    }
}
