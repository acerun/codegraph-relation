import * as assert from 'assert';
import * as vscode from 'vscode';
import { SymbolController } from '../features/symbol/SymbolController.js';
import { RelationController } from '../features/relation/RelationController.js';
import { CodeGraphService } from '../shared/services/CodeGraphService.js';
import { RelationWebviewProvider } from '../features/relation/RelationWebviewProvider.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RelationItemView from '../webview/features/relation/RelationItemView.js';

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
        assert.strictEqual(updatedChildren[0].hasChildren, true);
        assert.strictEqual(updatedChildren[0].children, undefined);

        await waitFor(() => incomingCalls === 2);
        releasePrefetch();
        await waitFor(() => updatedChildren[0].hasChildrenKnown === true);

        assert.strictEqual(updatedChildren[0].hasChildren, false);
        assert.strictEqual(updatedChildren[0].children, undefined);
        assert.ok(messages.some(message =>
            message.command === 'updateNodeAvailability' &&
            message.itemId === updatedChildren[0].id &&
            message.hasChildren === false
        ));
        tokenSource.dispose();
        controller.dispose();
    });

    test('resumes interrupted relation availability probes', async () => {
        const { controller, model, root, child, tokenSource } = createRelationHarness();
        model.getIncomingCalls = async (item: vscode.CallHierarchyItem) => item.name === root.name
            ? [new vscode.CallHierarchyIncomingCall(child, [child.selectionRange])]
            : [];
        let probeCalls = 0;
        let firstProbeStarted = false;
        let releaseFirstProbe!: () => void;
        const firstProbeGate = new Promise<void>(resolve => { releaseFirstProbe = resolve; });
        model.hasCalls = async () => {
            probeCalls++;
            if (probeCalls === 1) {
                firstProbeStarted = true;
                await firstProbeGate;
            }
            return false;
        };

        let rootChildren: any[] = [];
        await (controller as any).fetchInitialChildren(
            root,
            'incoming',
            tokenSource.token,
            (children: any[]) => { rootChildren = children; }
        );
        await waitFor(() => firstProbeStarted);
        tokenSource.cancel();

        assert.strictEqual(rootChildren[0].children, undefined);
        assert.strictEqual(rootChildren[0].hasChildren, true);
        assert.strictEqual(rootChildren[0].hasChildrenKnown, undefined);

        const resumeTokenSource = new vscode.CancellationTokenSource();
        try {
            (controller as any).resumePendingPrefetch(resumeTokenSource.token);
            await waitFor(() => rootChildren[0].hasChildrenKnown === true, 200);

            assert.strictEqual(rootChildren[0].hasChildren, false);
            assert.strictEqual(probeCalls, 2);
        } finally {
            releaseFirstProbe();
            resumeTokenSource.dispose();
            tokenSource.dispose();
            controller.dispose();
        }
    });

    test('suppresses auto search while preview navigation is in progress', async () => {
        const { controller, root } = createRelationHarness();

        await (controller as any).handleMessage({
            command: 'preview',
            uri: root.uri.toString(),
            range: root.range
        });

        assert.strictEqual((controller as any).isJumping, true);
        clearTimeout((controller as any).jumpTimeout);
        controller.dispose();
    });

    test('yields to interaction before probing every relation child', async () => {
        const { controller, model, root, tokenSource } = createRelationHarness();
        const children = Array.from({ length: 24 }, (_, index) => new vscode.CallHierarchyItem(
            vscode.SymbolKind.Function,
            `child${index}`,
            '',
            vscode.Uri.file(`C:/repo/child${index}.ts`),
            root.range,
            root.selectionRange
        ));
        let probeCalls = 0;
        let releaseProbes!: () => void;
        const probeGate = new Promise<void>(resolve => { releaseProbes = resolve; });
        model.getIncomingCalls = async (item: vscode.CallHierarchyItem) => {
            if (item.name === root.name) {
                return children.map(child => new vscode.CallHierarchyIncomingCall(child, [child.selectionRange]));
            }
            probeCalls++;
            await probeGate;
            return [];
        };

        await (controller as any).fetchInitialChildren(
            root,
            'incoming',
            tokenSource.token,
            () => undefined
        );
        await delay(0);

        assert.ok(probeCalls <= 1, `started ${probeCalls} probes before yielding`);
        tokenSource.cancel();
        releaseProbes();
        tokenSource.dispose();
        controller.dispose();
    });

    test('does not let a slow relation probe block sibling availability', async () => {
        const { controller, model, root, tokenSource } = createRelationHarness();
        const slowChild = new vscode.CallHierarchyItem(
            vscode.SymbolKind.Function,
            'aSlowChild',
            '',
            vscode.Uri.file('C:/repo/aSlowChild.ts'),
            root.range,
            root.selectionRange
        );
        const fastLeaf = new vscode.CallHierarchyItem(
            vscode.SymbolKind.Function,
            'bFastLeaf',
            '',
            vscode.Uri.file('C:/repo/bFastLeaf.ts'),
            root.range,
            root.selectionRange
        );
        let slowProbeStarted = false;
        let releaseSlowProbe!: () => void;
        const slowProbeGate = new Promise<void>(resolve => { releaseSlowProbe = resolve; });
        model.getIncomingCalls = async (item: vscode.CallHierarchyItem) => {
            if (item.name === root.name) {
                return [slowChild, fastLeaf].map(child =>
                    new vscode.CallHierarchyIncomingCall(child, [child.selectionRange]));
            }
            if (item.name === slowChild.name) {
                slowProbeStarted = true;
                await slowProbeGate;
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

        try {
            await waitFor(() => slowProbeStarted);
            await waitFor(() => rootChildren.find(item => item.name === fastLeaf.name)?.hasChildrenKnown === true, 200);
            assert.strictEqual(rootChildren.find(item => item.name === fastLeaf.name)?.hasChildren, false);
        } finally {
            tokenSource.cancel();
            releaseSlowProbe();
            tokenSource.dispose();
            controller.dispose();
        }
    });

    test('uses lightweight availability when full child loads are slow', async () => {
        const { controller, model, root, tokenSource } = createRelationHarness();
        const children = ['aSlowChild', 'bSlowChild', 'cFastLeaf'].map(name =>
            new vscode.CallHierarchyItem(
                vscode.SymbolKind.Function,
                name,
                '',
                vscode.Uri.file(`C:/repo/${name}.ts`),
                root.range,
                root.selectionRange
            ));
        const slowChildren = new Set(children.slice(0, 2).map(child => child.name));
        let fullChildLoads = 0;
        let releaseSlowProbes!: () => void;
        const slowProbeGate = new Promise<void>(resolve => { releaseSlowProbes = resolve; });
        model.getIncomingCalls = async (item: vscode.CallHierarchyItem) => {
            if (item.name === root.name) {
                return children.map(child => new vscode.CallHierarchyIncomingCall(child, [child.selectionRange]));
            }
            if (slowChildren.has(item.name)) {
                fullChildLoads++;
                await slowProbeGate;
            }
            return [];
        };
        model.hasCalls = async (item: vscode.CallHierarchyItem) => item.name !== 'cFastLeaf';

        let rootChildren: any[] = [];
        await (controller as any).fetchInitialChildren(
            root,
            'incoming',
            tokenSource.token,
            (items: any[]) => { rootChildren = items; }
        );

        try {
            await waitFor(() => rootChildren.every(item => item.hasChildrenKnown === true), 200);
            assert.strictEqual(rootChildren.find(item => item.name === 'cFastLeaf')?.hasChildren, false);
            assert.strictEqual(fullChildLoads, 0);
        } finally {
            tokenSource.cancel();
            releaseSlowProbes();
            tokenSource.dispose();
            controller.dispose();
        }
    });

    test('shows a chevron only when relation children are confirmed', () => {
        const range = new vscode.Range(0, 0, 0, 4);
        const item = {
            id: 'unknown',
            name: 'main',
            detail: '',
            kind: vscode.SymbolKind.Function,
            uri: vscode.Uri.file('C:/repo/main.ts').toString(),
            range,
            selectionRange: range,
            hasChildren: true
        };
        const props = {
            item,
            direction: 'incoming',
            selectedId: null,
            onSelect: () => undefined,
            onExpand: () => undefined,
            onJump: () => undefined
        } as const;

        const collapsedMarkup = renderToStaticMarkup(React.createElement(RelationItemView, props));
        const expandedMarkup = renderToStaticMarkup(React.createElement(RelationItemView, { ...props, expanded: true }));
        const expandedKnownMarkup = renderToStaticMarkup(React.createElement(RelationItemView, {
            ...props,
            expanded: true,
            item: { ...item, hasChildrenKnown: true }
        }));
        const branchMarkup = renderToStaticMarkup(React.createElement(RelationItemView, {
            ...props,
            item: { ...item, children: [{ ...item, id: 'child', hasChildren: false }] }
        }));
        const leafMarkup = renderToStaticMarkup(React.createElement(RelationItemView, {
            ...props,
            item: { ...item, hasChildren: false, children: [] }
        }));

        assert.match(collapsedMarkup, /codicon-ellipsis/);
        assert.doesNotMatch(collapsedMarkup, /codicon-chevron-right/);
        assert.doesNotMatch(collapsedMarkup, /codicon-loading/);
        assert.match(expandedMarkup, /codicon-loading/);
        assert.doesNotMatch(expandedMarkup, /codicon-chevron-right/);
        assert.match(expandedKnownMarkup, /codicon-loading/);
        assert.doesNotMatch(expandedKnownMarkup, /codicon-chevron-right/);
        assert.match(branchMarkup, /codicon-chevron-right/);
        assert.doesNotMatch(branchMarkup, /codicon-ellipsis|codicon-loading/);
        assert.match(leafMarkup, /expand-icon[^\"]*hidden/);
        assert.doesNotMatch(leafMarkup, /codicon-loading/);
    });

    test('probes the next level after expanding relation children', async () => {
        const { controller, model, root, child, tokenSource } = createRelationHarness();
        const grandchild = new vscode.CallHierarchyItem(
            vscode.SymbolKind.Function,
            'grandchild',
            '',
            vscode.Uri.file('C:/repo/grandchild.ts'),
            child.range,
            child.selectionRange
        );
        const greatGrandchild = new vscode.CallHierarchyItem(
            vscode.SymbolKind.Function,
            'greatGrandchild',
            '',
            vscode.Uri.file('C:/repo/greatGrandchild.ts'),
            grandchild.range,
            grandchild.selectionRange
        );
        const nextGeneration = new vscode.CallHierarchyItem(
            vscode.SymbolKind.Function,
            'nextGeneration',
            '',
            vscode.Uri.file('C:/repo/nextGeneration.ts'),
            greatGrandchild.range,
            greatGrandchild.selectionRange
        );
        model.getIncomingCalls = async (item: vscode.CallHierarchyItem) => {
            if (item.name === root.name) {
                return [new vscode.CallHierarchyIncomingCall(child, [child.selectionRange])];
            }
            if (item.name === child.name) {
                return [new vscode.CallHierarchyIncomingCall(grandchild, [grandchild.selectionRange])];
            }
            if (item.name === grandchild.name) {
                return [new vscode.CallHierarchyIncomingCall(greatGrandchild, [greatGrandchild.selectionRange])];
            }
            if (item.name === greatGrandchild.name) {
                return [new vscode.CallHierarchyIncomingCall(nextGeneration, [nextGeneration.selectionRange])];
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
        await waitFor(() => rootChildren[0]?.hasChildrenKnown === true);

        const childRelation = rootChildren[0];
        assert.strictEqual(childRelation.hasChildren, true);
        assert.strictEqual(childRelation.children, undefined);

        (controller as any).cancellationTokenSource = tokenSource;
        await (controller as any).resolveHierarchy(childRelation.id, 'incoming');
        assert.strictEqual(childRelation.children.length, 1);
        const grandchildRelation = childRelation.children[0];
        await waitFor(() => grandchildRelation.hasChildrenKnown === true);

        assert.strictEqual(grandchildRelation.hasChildren, true);
        assert.strictEqual(grandchildRelation.children, undefined);

        await (controller as any).resolveHierarchy(grandchildRelation.id, 'incoming');
        assert.strictEqual(grandchildRelation.children.length, 1);
        const greatGrandchildRelation = grandchildRelation.children[0];
        await waitFor(() => greatGrandchildRelation.hasChildrenKnown === true);

        assert.strictEqual(greatGrandchildRelation.hasChildren, true);
        assert.strictEqual(greatGrandchildRelation.children, undefined);
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
    model.hasCalls = async (
        item: vscode.CallHierarchyItem,
        direction: 'incoming' | 'outgoing',
        kinds: number[]
    ) => {
        const calls = direction === 'incoming'
            ? await model.getIncomingCalls(item)
            : await model.getOutgoingCalls(item);
        return calls.some((call: vscode.CallHierarchyIncomingCall | vscode.CallHierarchyOutgoingCall) => {
            const kind = direction === 'incoming'
                ? (call as vscode.CallHierarchyIncomingCall).from.kind
                : (call as vscode.CallHierarchyOutgoingCall).to.kind;
            return kinds.length === 0 || kinds.includes(kind);
        });
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
