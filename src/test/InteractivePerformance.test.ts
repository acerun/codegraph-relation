import * as assert from 'assert';
import * as vscode from 'vscode';
import { SymbolController } from '../features/symbol/SymbolController.js';
import { RelationController } from '../features/relation/RelationController.js';
import { CodeGraphService } from '../shared/services/CodeGraphService.js';
import { RelationWebviewProvider } from '../features/relation/RelationWebviewProvider.js';

suite('Interactive Performance Test Suite', () => {
    test('reuses completed project symbol searches', async () => {
        let searchCalls = 0;
        const range = new vscode.Range(0, 0, 0, 6);
        const codeGraph = {
            isAvailable: true,
            searchSymbols: async () => {
                searchCalls++;
                return [{
                    name: 'needle',
                    detail: '',
                    kind: vscode.SymbolKind.Function,
                    uri: vscode.Uri.file('C:/repo/needle.ts').toString(),
                    range,
                    selectionRange: range,
                    children: []
                }];
            },
            getProjectSymbols: async () => []
        } as unknown as CodeGraphService;
        const controller = new SymbolController(createContext(), codeGraph, 'project');
        (controller as any).provider = { postMessage: () => undefined, isVisible: true };

        await controller.handleSearch('needle');
        await delay(350);
        await controller.handleSearch('needle');
        await delay(350);

        assert.strictEqual(searchCalls, 1);
        controller.dispose();
    });

    test('renders a relation level before prefetching the next level', async () => {
        const { controller, model, root, child, tokenSource, messages } = createRelationHarness();
        let incomingCalls = 0;
        let releasePrefetch!: () => void;
        const prefetchGate = new Promise<void>(resolve => { releasePrefetch = resolve; });
        model.getIncomingCalls = async (item: vscode.CallHierarchyItem) => {
            incomingCalls++;
            if (item.name === root.name) {
                return [new vscode.CallHierarchyIncomingCall(child, [child.selectionRange])];
            }
            await prefetchGate;
            return [];
        };

        let updatedChildren: any[] = [];
        await (controller as any).fetchInitialChildren(
            root,
            'incoming',
            tokenSource.token,
            (children: any[]) => { updatedChildren = children; }
        );

        assert.strictEqual(incomingCalls, 1);
        assert.strictEqual(updatedChildren.length, 1);
        assert.strictEqual(updatedChildren[0].hasChildren, false);
        assert.strictEqual(updatedChildren[0].children, undefined);

        await waitFor(() => incomingCalls === 2);
        releasePrefetch();
        await waitFor(() => updatedChildren[0].children !== undefined);

        assert.strictEqual(updatedChildren[0].hasChildren, false);
        assert.deepStrictEqual(updatedChildren[0].children, []);
        assert.ok(messages.some(message =>
            message.command === 'updateNode' &&
            message.itemId === updatedChildren[0].id &&
            message.children.length === 0
        ));
        tokenSource.dispose();
        controller.dispose();
    });

    test('prefetches the next level after expanding cached relation children', async () => {
        const { controller, model, root, child, tokenSource } = createRelationHarness();
        const grandchild = new vscode.CallHierarchyItem(
            vscode.SymbolKind.Function,
            'grandchild',
            '',
            vscode.Uri.file('C:/repo/grandchild.ts'),
            child.range,
            child.selectionRange
        );
        model.getIncomingCalls = async (item: vscode.CallHierarchyItem) => {
            if (item.name === root.name) {
                return [new vscode.CallHierarchyIncomingCall(child, [child.selectionRange])];
            }
            if (item.name === child.name) {
                return [new vscode.CallHierarchyIncomingCall(grandchild, [grandchild.selectionRange])];
            }
            return [];
        };

        let rootChildren: any[] = [];
        await (controller as any).fetchInitialChildren(
            root,
            'incoming',
            tokenSource.token,
            (children: any[]) => { rootChildren = children; }
        );
        await waitFor(() => rootChildren[0]?.children !== undefined);

        const childRelation = rootChildren[0];
        assert.strictEqual(childRelation.hasChildren, true);
        assert.strictEqual(childRelation.children.length, 1);
        const grandchildRelation = childRelation.children[0];
        assert.strictEqual(grandchildRelation.children, undefined);

        (controller as any).cancellationTokenSource = tokenSource;
        await (controller as any).resolveHierarchy(childRelation.id, 'incoming');
        await waitFor(() => grandchildRelation.children !== undefined);

        assert.strictEqual(grandchildRelation.hasChildren, false);
        assert.deepStrictEqual(grandchildRelation.children, []);
        controller.dispose();
    });

    test('coalesces concurrent expansion of the same relation node', async () => {
        const { controller, model, root } = createRelationHarness();
        let incomingCalls = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        model.getIncomingCalls = async () => {
            incomingCalls++;
            await gate;
            return [];
        };
        (controller as any).itemCache.set('root', root);
        (controller as any).relationItemCache.set('root', {
            id: 'root',
            name: root.name,
            detail: '',
            kind: root.kind,
            uri: root.uri.toString(),
            range: root.range,
            selectionRange: root.selectionRange,
            hasChildren: true
        });

        const first = (controller as any).resolveHierarchy('root', 'incoming');
        const second = (controller as any).resolveHierarchy('root', 'incoming');
        await new Promise(resolve => setImmediate(resolve));
        release();
        await Promise.all([first, second]);

        assert.strictEqual(incomingCalls, 1);
        controller.dispose();
    });
});

function createContext(): vscode.ExtensionContext {
    return {
        subscriptions: [],
        workspaceState: {
            get: <T>(_key: string, defaultValue?: T) => defaultValue,
            update: async () => undefined
        }
    } as unknown as vscode.ExtensionContext;
}

function createRelationHarness() {
    const messages: any[] = [];
    const provider = {
        onMessage: () => new vscode.Disposable(() => undefined),
        postMessage: (message: any) => { messages.push(message); },
        isVisible: () => true
    } as unknown as RelationWebviewProvider;
    const controller = new RelationController(
        createContext(),
        provider,
        undefined,
        {} as CodeGraphService
    );
    const model: any = {
        getIncomingCalls: async () => [],
        getOutgoingCalls: async () => [],
        getDeepIncomingCalls: async () => [],
        getDeepOutgoingCalls: async () => []
    };
    (controller as any).model = model;

    const range = new vscode.Range(0, 0, 0, 4);
    const root = new vscode.CallHierarchyItem(
        vscode.SymbolKind.Function,
        'root',
        '',
        vscode.Uri.file('C:/repo/root.ts'),
        range,
        range
    );
    const child = new vscode.CallHierarchyItem(
        vscode.SymbolKind.Function,
        'child',
        '',
        vscode.Uri.file('C:/repo/child.ts'),
        range,
        range
    );

    return {
        controller,
        model,
        root,
        child,
        messages,
        tokenSource: new vscode.CancellationTokenSource()
    };
}

function delay(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for asynchronous relation update.');
        }
        await delay(5);
    }
}
