import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodeGraphService } from '../shared/services/CodeGraphService.js';

function runCodeGraph(args: string[], cwd: string) {
    cp.execFileSync('codegraph', args, {
        cwd,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

suite('CodeGraphService Integration Suite', () => {
    test('loads symbols from a real CodeGraph index', async function () {
        this.timeout(15000);
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-relation-vscode-'));

        try {
            const samplePath = path.join(workspace, 'sample.ts');
            fs.writeFileSync(samplePath, [
                'export class Alpha {',
                '  run() { return beta(); }',
                '}',
                'export function beta() { return 1; }'
            ].join('\n'));

            runCodeGraph(['init', workspace], workspace);

            const service = new CodeGraphService(workspace);
            const symbols = await service.getDocumentSymbols(vscode.Uri.file(samplePath));
            const names = symbols.map(symbol => symbol.name);

            assert.ok(names.includes('Alpha'), `Expected Alpha in ${names.join(', ')}`);
            assert.ok(names.includes('beta'), `Expected beta in ${names.join(', ')}`);

            const projectSymbols = await service.getProjectSymbols();
            const projectNames = projectSymbols.map(symbol => symbol.name);
            assert.ok(projectNames.includes('Alpha'), `Expected Alpha in project symbols: ${projectNames.join(', ')}`);
            assert.ok(projectNames.includes('beta'), `Expected beta in project symbols: ${projectNames.join(', ')}`);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });
});
