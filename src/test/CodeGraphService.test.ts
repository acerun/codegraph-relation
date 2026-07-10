import * as assert from 'assert';
import * as vscode from 'vscode';
import { CodeGraphService } from '../shared/services/CodeGraphService.js';
import { normalizeAutoSyncDebounceMs, shouldAutoSync } from '../shared/services/CodeGraphAutoSync.js';
import { RelationItem } from '../shared/common/types.js';
import { applyPrefetchedChildren, shouldPublishResolvedChildren } from '../features/relation/relationCache.js';

suite('CodeGraphService Test Suite', () => {
    test('requests enough query results for project symbol filtering', async () => {
        const service = new CodeGraphService('C:/repo');
        let requestedLimit = 0;
        (service as any).findProjectRoot = () => 'C:/repo';
        (service as any).execCodeGraph = () => assert.fail('search must not launch the CLI');
        (service as any).withCodeGraph = (_root: string, operation: (graph: any) => unknown) => operation({
            searchNodes: (_query: string, options: { limit: number }) => {
                requestedLimit = options.limit;
                return [];
            }
        });

        await service.searchSymbols('needle');

        assert.strictEqual(requestedLimit, 500);
    });

    test('loads project symbols in one embedded SDK session', async () => {
        const service = new CodeGraphService('C:/repo');
        let sessions = 0;
        let fileQueries = 0;
        const files = Array.from({ length: 4 }, (_, index) => ({
            path: `src/${index}.ts`,
            nodeCount: 5
        }));

        (service as any).findProjectRoot = () => 'C:/repo';
        (service as any).execCodeGraph = () => assert.fail('project symbols must not launch the CLI');
        (service as any).withCodeGraph = (_root: string, operation: (graph: any) => unknown) => {
            sessions++;
            return operation({
                getFiles: () => files,
                getNodesInFile: (filePath: string) => {
                    fileQueries++;
                    return Array.from({ length: 5 }, (_, index) => createSdkNode(
                        `${filePath}:${index}`,
                        `symbol${index}`,
                        filePath,
                        index + 1
                    ));
                }
            });
        };

        const symbols = await service.getProjectSymbols(20);

        assert.strictEqual(sessions, 1);
        assert.strictEqual(fileQueries, 4);
        assert.strictEqual(symbols.length, 20);
    });

    test('reuses document symbols while the file is unchanged', async () => {
        const service = new CodeGraphService('C:/repo');
        let calls = 0;
        (service as any).findProjectRoot = () => 'C:/repo';
        (service as any).isInsideWorkspace = () => true;
        (service as any).toRelativePath = () => 'src/sample.ts';
        (service as any).execCodeGraph = () => assert.fail('document symbols must not launch the CLI');
        (service as any).withCodeGraph = (_root: string, operation: (graph: any) => unknown) => operation({
            getNodesInFile: () => {
                calls++;
                return [createSdkNode('sample-id', 'sample', 'src/sample.ts', 1)];
            }
        });
        const uri = vscode.Uri.file('C:/repo/src/sample.ts');

        await service.getDocumentSymbols(uri);
        await service.getDocumentSymbols(uri);

        assert.strictEqual(calls, 1);
    });

    test('maps query JSON nodes to symbol items', () => {
        const items = CodeGraphService.mapQueryResults([
            {
                node: {
                    id: 'handle-search-id',
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
        assert.strictEqual(items[0].codeGraphNodeId, 'handle-search-id');
    });

    test('closes the embedded graph when a query fails', () => {
        const service = new CodeGraphService('C:/repo');
        const originalOpen = (CodeGraphService as any).openCodeGraph;
        let closed = false;
        (CodeGraphService as any).openCodeGraph = () => ({ close: () => { closed = true; } });

        try {
            assert.throws(
                () => (service as any).withCodeGraph('C:/repo', () => { throw new Error('query failed'); }),
                /query failed/
            );
            assert.strictEqual(closed, true);
        } finally {
            (CodeGraphService as any).openCodeGraph = originalOpen;
        }
    });

    test('queries relations by CodeGraph node ID without launching the CLI', async () => {
        const service = new CodeGraphService('C:/repo');
        const range = new vscode.Range(0, 0, 0, 4);
        const root = new vscode.CallHierarchyItem(
            vscode.SymbolKind.Function,
            'root',
            '',
            vscode.Uri.file('C:/repo/root.ts'),
            range,
            range
        );
        (root as any).codeGraphNodeId = 'root-id';
        let requestedId = '';
        (service as any).findProjectRoot = () => 'C:/repo';
        (service as any).execCodeGraph = () => assert.fail('relations must not launch the CLI');
        (service as any).withCodeGraph = (_root: string, operation: (graph: any) => unknown) => operation({
            getCallers: (nodeId: string) => {
                requestedId = nodeId;
                return [{ node: createSdkNode('caller-id', 'caller', 'src/caller.ts', 7), edge: {} }];
            }
        });

        const callers = await service.getRelationItems(root, 'incoming');

        assert.strictEqual(requestedId, 'root-id');
        assert.strictEqual(callers.length, 1);
        assert.strictEqual(callers[0].name, 'caller');
        assert.strictEqual((callers[0] as any).codeGraphNodeId, 'caller-id');
    });

    test('resolves a restored relation item by file and line', async () => {
        const service = new CodeGraphService('C:/repo');
        const range = new vscode.Range(9, 0, 9, 4);
        const restored = new vscode.CallHierarchyItem(
            vscode.SymbolKind.Function,
            'sameName',
            '',
            vscode.Uri.file('C:/repo/src/sample.ts'),
            range,
            range
        );
        let requestedId = '';
        (service as any).findProjectRoot = () => 'C:/repo';
        (service as any).withCodeGraph = (_root: string, operation: (graph: any) => unknown) => operation({
            getNodesInFile: () => [
                createSdkNode('other-id', 'sameName', 'src/sample.ts', 2),
                createSdkNode('restored-id', 'sameName', 'src/sample.ts', 10)
            ],
            getCallees: (nodeId: string) => {
                requestedId = nodeId;
                return [];
            }
        });

        await service.getRelationItems(restored, 'outgoing');

        assert.strictEqual(requestedId, 'restored-id');
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

function createSdkNode(id: string, name: string, filePath: string, startLine: number) {
    return {
        id,
        name,
        qualifiedName: name,
        kind: 'function',
        filePath,
        language: 'typescript',
        startLine,
        endLine: startLine,
        startColumn: 0,
        endColumn: name.length
    };
}
