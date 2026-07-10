import * as assert from 'assert';
import * as vscode from 'vscode';
import { CodeGraphService } from '../shared/services/CodeGraphService.js';
import { normalizeAutoSyncDebounceMs, shouldAutoSync } from '../shared/services/CodeGraphAutoSync.js';
import { RelationItem } from '../shared/common/types.js';
import { applyPrefetchedChildren, shouldPublishResolvedChildren } from '../features/relation/relationCache.js';

suite('CodeGraphService Test Suite', () => {
    test('requests enough query results for project symbol filtering', async () => {
        const service = new CodeGraphService('C:/repo');
        let args: string[] = [];
        (service as any).findProjectRoot = () => 'C:/repo';
        (service as any).execCodeGraph = async (nextArgs: string[]) => {
            args = nextArgs;
            return '[]';
        };

        await service.searchSymbols('needle');

        assert.strictEqual(args.at(-1), '500');
    });

    test('loads the default project files concurrently', async () => {
        const service = new CodeGraphService('C:/repo');
        let activeCalls = 0;
        let maxActiveCalls = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const files = Array.from({ length: 4 }, (_, index) => ({
            path: `src/${index}.ts`,
            nodeCount: 5
        }));

        (service as any).findProjectRoot = () => 'C:/repo';
        (service as any).execCodeGraph = async (args: string[]) => {
            if (args[0] === 'files') {
                return JSON.stringify(files);
            }

            activeCalls++;
            maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
            await gate;
            activeCalls--;
            return Array.from({ length: 5 }, (_, index) =>
                `- \`symbol${index}\` (function) - :${index + 1}`
            ).join('\n');
        };

        const symbolsPromise = service.getProjectSymbols(20);
        await new Promise(resolve => setImmediate(resolve));
        release();
        const symbols = await symbolsPromise;

        assert.strictEqual(maxActiveCalls, 4);
        assert.strictEqual(symbols.length, 20);
    });

    test('reuses document symbols while the file is unchanged', async () => {
        const service = new CodeGraphService('C:/repo');
        let calls = 0;
        (service as any).findProjectRoot = () => 'C:/repo';
        (service as any).isInsideWorkspace = () => true;
        (service as any).toRelativePath = () => 'src/sample.ts';
        (service as any).execCodeGraph = async () => {
            calls++;
            return '- `sample` (function) - :1';
        };
        const uri = vscode.Uri.file('C:/repo/src/sample.ts');

        await service.getDocumentSymbols(uri);
        await service.getDocumentSymbols(uri);

        assert.strictEqual(calls, 1);
    });

    test('maps query JSON nodes to symbol items', () => {
        const items = CodeGraphService.mapQueryResults([
            {
                node: {
                    kind: 'method',
                    name: 'handleSearch',
                    qualifiedName: 'SymbolController::handleSearch',
                    filePath: 'src/features/symbol/SymbolController.ts',
                    language: 'typescript',
                    startLine: 301,
                    endLine: 501,
                    startColumn: 4,
                    endColumn: 5,
                    signature: '(query: string)'
                },
                score: 10
            }
        ], 'C:/repo');

        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].name, 'handleSearch');
        assert.strictEqual(items[0].detail, 'SymbolController::handleSearch');
        assert.strictEqual(items[0].kind, vscode.SymbolKind.Method);
        assert.strictEqual(items[0].range.start.line, 300);
        assert.strictEqual(items[0].uri, vscode.Uri.file('C:/repo/src/features/symbol/SymbolController.ts').toString());
    });

    test('parses symbols-only output from codegraph node file mode', () => {
        const output = [
            '**src/sample.ts** - 2 symbols',
            '',
            '### Symbols',
            '- `Sample` (class) - :3',
            '- `run` (method) (value: string): void - :8'
        ].join('\n');

        const items = CodeGraphService.parseFileSymbols(output, 'C:/repo', 'src/sample.ts');

        assert.strictEqual(items.length, 2);
        assert.strictEqual(items[0].name, 'Sample');
        assert.strictEqual(items[0].kind, vscode.SymbolKind.Class);
        assert.strictEqual(items[0].range.start.line, 2);
        assert.strictEqual(items[1].name, 'run');
        assert.strictEqual(items[1].detail, '(value: string): void');
        assert.strictEqual(items[1].kind, vscode.SymbolKind.Method);
    });

    test('prefers main files for default project symbol files', () => {
        const files = CodeGraphService.selectDefaultProjectFiles([
            { path: 'src/zeta.ts', nodeCount: 2 },
            { path: 'src/main.ts', nodeCount: 3 },
            { path: 'src/app.ts', nodeCount: 4 }
        ], 20);

        assert.deepStrictEqual(files.map(file => file.path), ['src/main.ts']);
    });

    test('selects alphabetic files until the default project symbol limit', () => {
        const files = Array.from({ length: 25 }, (_, index) => ({
            path: `src/${String(index).padStart(2, '0')}.ts`,
            nodeCount: 1
        })).reverse();

        const selected = CodeGraphService.selectDefaultProjectFiles(files, 20);

        assert.strictEqual(selected.length, 20);
        assert.strictEqual(selected[0].path, 'src/00.ts');
        assert.strictEqual(selected[19].path, 'src/19.ts');
    });

    test('marks relation items without prefetched children as leaves', () => {
        const item = createRelationItem('parent');

        applyPrefetchedChildren(item, []);

        assert.deepStrictEqual(item.children, []);
        assert.strictEqual(item.hasChildren, false);
    });

    test('caches prefetched relation children on the parent item', () => {
        const item = createRelationItem('parent');
        const child = createRelationItem('child');

        applyPrefetchedChildren(item, [child]);

        assert.deepStrictEqual(item.children, [child]);
        assert.strictEqual(item.hasChildren, true);
    });

    test('publishes an empty first relation expansion so leaves can be marked', () => {
        assert.strictEqual(shouldPublishResolvedChildren(false, []), true);
        assert.strictEqual(shouldPublishResolvedChildren(true, []), false);
        assert.strictEqual(shouldPublishResolvedChildren(false, [createRelationItem('child')]), false);
    });

    test('auto sync only runs when enabled, indexed, and idle', () => {
        assert.strictEqual(shouldAutoSync({ enabled: false, hasIndex: true, isRunning: false }), 'disabled');
        assert.strictEqual(shouldAutoSync({ enabled: true, hasIndex: false, isRunning: false }), 'missing-index');
        assert.strictEqual(shouldAutoSync({ enabled: true, hasIndex: true, isRunning: true }), 'busy');
        assert.strictEqual(shouldAutoSync({ enabled: true, hasIndex: true, isRunning: false, isActive: false }), 'disabled');
        assert.strictEqual(shouldAutoSync({ enabled: true, hasIndex: true, isRunning: false }), 'run');
        assert.strictEqual(shouldAutoSync({ enabled: true, hasIndex: true, isRunning: false, isActive: true }), 'run');
    });

    test('auto sync debounce defaults to the maximum delay', () => {
        assert.strictEqual(normalizeAutoSyncDebounceMs(undefined), 30000);
        assert.strictEqual(normalizeAutoSyncDebounceMs(100), 250);
        assert.strictEqual(normalizeAutoSyncDebounceMs(60000), 30000);
        assert.strictEqual(normalizeAutoSyncDebounceMs(2000), 2000);
    });
});

function createRelationItem(name: string): RelationItem {
    const range = new vscode.Range(0, 0, 0, 1);
    return {
        id: name,
        name,
        detail: '',
        kind: vscode.SymbolKind.Function,
        uri: vscode.Uri.file(`C:/repo/${name}.ts`).toString(),
        range,
        selectionRange: range,
        hasChildren: true
    };
}
