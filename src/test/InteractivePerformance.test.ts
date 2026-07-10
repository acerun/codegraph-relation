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

    test('does not prefetch relation grandchildren after loading a level', async () => {
        const { controller, model, root, child, tokenSource } = createRelationHarness();
        let incomingCalls = 0;
        model.getIncomingCalls = async (item: vscode.CallHierarchyItem) => {
            incomingCalls++;
            return item.name === root.name
                ? [new vscode.CallHierarchyIncomingCall(child, [child.selectionRange])]
                : [];
        };

        await (controller as any).fetchChildrenParallel(
            root,
            'incoming',
            tokenSource.token,
            () => undefined
        );
        await delay(50);

        assert.strictEqual(incomingCalls, 1);
        tokenSource.dispose();
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
    const provider = {
        onMessage: () => new vscode.Disposable(() => undefined),
        postMessage: () => undefined,
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
        tokenSource: new vscode.CancellationTokenSource()
    };
}

function delay(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
