import * as vscode from 'vscode';
import { performDeepSearch } from '../../shared/utils/search';
import { CodeGraphService } from '../../shared/services/CodeGraphService';

export interface DeepCall {
    from: {
        name: string;
        detail: string;
        kind: number;
        uri: vscode.Uri;
        range: vscode.Range;
        selectionRange: vscode.Range;
    };
    fromRanges: vscode.Range[];
    to: {
        name: string;
        detail: string;
        kind: number;
        uri: vscode.Uri;
        range: vscode.Range;
        selectionRange: vscode.Range;
    };
}

export class RelationModel {
    constructor(private readonly codeGraph: CodeGraphService) {}

    public async prepareCallHierarchy(uri: vscode.Uri, position: vscode.Position): Promise<vscode.CallHierarchyItem | undefined> {
        return this.codeGraph.findSymbolAtLocation(uri, position);
    }

    public async findSymbolAtLocation(uri: vscode.Uri, position: vscode.Position): Promise<vscode.CallHierarchyItem | undefined> {
        return this.codeGraph.findSymbolAtLocation(uri, position);
    }

    public async getIncomingCalls(item: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyIncomingCall[]> {
        const callers = await this.codeGraph.getRelationItems(item, 'incoming');
        return callers.map(caller => new vscode.CallHierarchyIncomingCall(caller, [caller.selectionRange]));
    }

    public async getOutgoingCalls(item: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyOutgoingCall[]> {
        const callees = await this.codeGraph.getRelationItems(item, 'outgoing');
        return callees.map(callee => new vscode.CallHierarchyOutgoingCall(callee, [callee.selectionRange]));
    }

    public async getDefinition(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location | undefined> {
        return this.codeGraph.getDefinition(uri, position);
    }

    public async getReferences(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
        return this.codeGraph.getReferences(uri, position);
    }

    public async deepSearch(query: string, rootUri: vscode.Uri): Promise<vscode.Location[]> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(rootUri);
        if (!workspaceFolder) {
            return [];
        }

        return performDeepSearch({
            query,
            cwd: workspaceFolder.uri.fsPath,
            isCaseSensitive: false,
            isWordMatch: true,
            disabledByDefault: true
        });
    }

    public async getDeepIncomingCalls(
        _item?: vscode.CallHierarchyItem,
        _token?: vscode.CancellationToken,
        _filter?: number[]
    ): Promise<DeepCall[]> {
        return [];
    }

    public async getDeepOutgoingCalls(
        _item?: vscode.CallHierarchyItem,
        _token?: vscode.CancellationToken,
        _filter?: number[]
    ): Promise<DeepCall[]> {
        return [];
    }
}
