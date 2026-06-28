# Project Notes for Agents

## Project

- VS Code extension name: `codegraph-relation`
- Version: `1.1.0`
- Publisher: `ytlee`
- Primary index source: CodeGraph CLI
- Users manually run `codegraph init` in the workspace root. The extension must not initialize or rebuild CodeGraph automatically.
- If `.codegraph/` exists at the workspace root, use `codegraph` commands directly.
- If `.codegraph/` is missing, show a missing/unavailable state instead of using LSP.
- Repository: `git@github.com:acerun/codegraph-relation.git`

## Architecture

Feature-based structure under `src/`:

```
src/
├── extension.ts                    # Entry point, registers all providers/commands
├── features/
│   ├── symbol/                     # Symbol Window
│   │   ├── SymbolController.ts
│   │   ├── SymbolModel.ts
│   │   ├── SymbolWebviewProvider.ts
│   │   └── parsing/               # Symbol name parsers (CStyle, Default)
│   ├── relation/                   # Relation Window (Call Hierarchy)
│   │   ├── RelationController.ts
│   │   ├── RelationModel.ts
│   │   ├── RelationWebviewProvider.ts
│   │   └── relationCache.ts       # In-memory relation cache
│   ├── reference/                  # Reference Window
│   │   ├── ReferenceController.ts
│   │   └── ReferenceWebview.ts
│   └── placeholder/
│       └── DisabledWebviewProvider.ts
├── shared/
│   ├── services/
│   │   └── CodeGraphService.ts    # Central CodeGraph CLI wrapper
│   ├── ui/
│   │   └── GlobalStatusBar.ts     # Status bar with indexing progress
│   ├── common/
│   │   ├── types.ts               # Shared types (SymbolItem, etc.)
│   │   └── symbolKinds.ts         # Symbol kind constants
│   └── utils/
│       ├── search.ts              # Deep search (ripgrep fallback)
│       ├── navigation.ts          # File navigation helpers
│       └── general.ts             # General utilities
├── webview/                        # React frontend (compiled to dist/)
│   ├── components/
│   │   ├── symbol/                 # Symbol window React components
│   │   ├── relation/               # Relation window React components
│   │   └── reference/              # Reference window React components
│   ├── vscode-api.ts              # VS Code webview API wrapper
│   └── utils.ts                   # Shared webview utilities
└── test/                           # Test files
    ├── CodeGraphService.test.ts
    ├── GlobalStatusBar.test.ts
    ├── codegraph.integration.test.ts
    └── extension.test.ts
```

## Important Decisions

- LSP indexing has been removed from the runtime path (v1.1.0).
- The old SQLite `SymbolDatabase`, `DatabaseManager`, `SymbolIndexer`, and `LspClient` runtime files were removed.
- `ripgrep` remains bundled through `@vscode/ripgrep`, but fallback text search is disabled by default via `shared.enableRipgrepFallback = false`.
- CodeGraph CLI calls are centralized in `src/shared/services/CodeGraphService.ts`.
- Symbol and Relation models are thin wrappers around `CodeGraphService`.
- Keep comments in code in English.

## CodeGraph CLI Usage

- `codegraph status <path>` checks index health.
- `codegraph query <search> -p <path> --json -l <limit>` returns JSON search results under `node`.
- `codegraph callers <symbol> -p <path> --json -l <limit>` returns `{ symbol, callers }`.
- `codegraph callees <symbol> -p <path> --json -l <limit>` returns `{ symbol, callees }`.
- `codegraph node -p <path> -f <file> <file> --symbols-only` prints a file symbol list that must be parsed from text.
- `codegraph files -p <path> --json` returns list of indexed files with `nodeCount`.

## Configuration

- `shared.codeGraphPath`: CodeGraph CLI command name or path (default: `codegraph`).
- `shared.enableRipgrepFallback`: Enable ripgrep text-search fallback (default: `false`).
- `symbolWindow.enable`: Enable Symbol Window (default: `true`).
- `symbolWindow.splitView`: Split into Current Document + Project Symbols views (default: `false`).
- `symbolWindow.symbolParsing.mode`: Parsing strategy - `auto`, `c-style`, `default` (default: `auto`).
- `relationWindow.enable`: Enable Relation Window (default: `true`).
- `relationWindow.autoSearch`: Auto-search on cursor move (default: `false`).
- `relationWindow.showBothDirections`: Show both callers and callees (default: `false`).
- `referenceWindow.enable`: Enable Reference Window (default: `true`).

## Verification

Use PowerShell commands. This environment expects wrapping:

```powershell
npm run check-types
npm run lint
npm run compile
```

Observed result after the CodeGraph migration:

- `npm run check-types`: passes.
- `npm run lint`: passes.
- `npm run compile`: passes.
- `npm test`: compiles first, then VS Code test runner can fail on the existing compiled-test ESM import resolution for `CStyleParser` and VS Code mutex noise.

## VSIX Packaging

- Latest generated VSIX: `codegraph-relation-1.1.0.vsix` (2.88 MB).
- Generated with:

```powershell
npx @vscode/vsce package
```

## PowerShell/Pitfalls

- `rtk` cannot directly execute PowerShell built-ins such as `Get-Content`; use `proxy powershell -NoProfile -Command "..."`.
- When a PowerShell script uses `$variables`, wrap the whole `-Command` script in single quotes or variables may be expanded by the outer shell before PowerShell sees them.
- Avoid running `codegraph init` in the repo during tests unless the user asked for it. If a temporary `.codegraph/` is created accidentally, remove it before finishing.
