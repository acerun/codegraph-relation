const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(command, args, options = {}) {
  return cp.execFileSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function parseFileSymbols(output, workspaceRoot, filePath) {
  const items = [];
  const symbolLine = /^-\s+`(.+?)`\s+\(([^)]+)\)(?:\s+(.+?))?\s+(?:\u2014|-)\s+:(\d+)/;

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(symbolLine);
    if (!match) {
      continue;
    }

    items.push({
      name: match[1],
      kind: match[2],
      detail: (match[3] || '').trim(),
      line: Number(match[4]),
      filePath: path.join(workspaceRoot, filePath),
    });
  }

  return items;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-relation-smoke-'));

try {
  const sample = [
    'export class Alpha {',
    '  run() {',
    '    return beta();',
    '  }',
    '}',
    '',
    'export function beta() {',
    '  return 1;',
    '}',
  ].join('\n');
  fs.writeFileSync(path.join(tmp, 'sample.ts'), sample);

  run('codegraph', ['init', tmp], { cwd: tmp });
  if (!fs.existsSync(path.join(tmp, '.codegraph'))) {
    throw new Error('codegraph init did not create .codegraph');
  }

  const output = run('codegraph', [
    'node',
    '-p',
    tmp,
    '-f',
    'sample.ts',
    'sample.ts',
    '--symbols-only',
  ], { cwd: tmp });

  const symbols = parseFileSymbols(output, tmp, 'sample.ts');
  const names = symbols.map(symbol => symbol.name);

  if (!names.includes('Alpha') || !names.includes('beta')) {
    throw new Error(`Expected Alpha and beta symbols, got: ${names.join(', ')}`);
  }

  console.log(JSON.stringify({
    workspace: tmp,
    symbolCount: symbols.length,
    names,
  }, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
