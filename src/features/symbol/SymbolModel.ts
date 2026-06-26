import * as vscode from 'vscode';
import { SymbolItem } from '../../shared/common/types';
import { CodeGraphService } from '../../shared/services/CodeGraphService';

export class SymbolModel {
    constructor(private readonly codeGraph: CodeGraphService) {}

    public async getDocumentSymbols(uri: vscode.Uri): Promise<SymbolItem[]> {
        return this.codeGraph.getDocumentSymbols(uri);
    }

    public async getWorkspaceSymbols(query: string): Promise<SymbolItem[]> {
        return this.codeGraph.searchSymbols(query);
    }

    public async getProjectSymbols(): Promise<SymbolItem[]> {
        return this.codeGraph.getProjectSymbols();
    }

    public async findSymbolsByTextSearch(
        query: string,
        token?: vscode.CancellationToken,
        scopePath?: string,
        includePattern?: string,
        excludePattern?: string
    ): Promise<SymbolItem[]> {
        if (!vscode.workspace.getConfiguration('shared').get<boolean>('enableRipgrepFallback', false)) {
            return [];
        }

        const rootPath = scopePath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath || token?.isCancellationRequested) {
            return [];
        }

        const results = await this.codeGraph.searchSymbols(query, 500);
        return results.filter(item => {
            if (token?.isCancellationRequested) {
                return false;
            }

            if (includePattern && item.uri && !item.uri.includes(includePattern.replace(/\*/g, ''))) {
                return false;
            }

            if (excludePattern && item.uri && item.uri.includes(excludePattern.replace(/\*/g, ''))) {
                return false;
            }

            return true;
        }).map(item => ({ ...item, isDeepSearch: true }));
    }
}
