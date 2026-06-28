# CodeGraph Relation Specification

## 1. Overview

**Extension name:** `codegraph-relation`

**Goal:** provide Source Insight-style symbol, relation, and reference navigation in VS Code by using an existing CodeGraph index.

**Runtime rule:** the extension is a UI client for CodeGraph. Users own the index and run `codegraph init` or `codegraph sync` manually. The extension must not initialize, rebuild, or maintain an LSP/SQLite index by itself.

## 2. User-Facing Features

### Symbol Window

- Shows symbols from the active document.
- Uses `codegraph node -p <root> -f <file> <file> --symbols-only`.
- Supports local filtering and highlighted query terms.
- Supports C-style/default display cleanup through `symbolWindow.symbolParsing.mode`.

### Project Symbols

- Searches workspace symbols through `codegraph query <query> -p <root> --json -l <limit>`.
- Supports CodeGraph relevance ranking, partial-name matching, fuzzy/approximate terms, and close remembered names.
- Sorts exact matches before weaker matches when possible.
- When the query is empty, displays symbols from indexed `main.*` files first. If no main file exists, displays symbols from the first indexed files.
- Uses `codegraph files -p <root> --json` to select default files and `codegraph node --symbols-only` to read their symbols.

### Relation Window

- Shows incoming calls through `codegraph callers <symbol> -p <root> --json -l <limit>`.
- Shows outgoing calls through `codegraph callees <symbol> -p <root> --json -l <limit>`.
- Supports single-direction and both-directions display.
- Supports manual refresh and optional cursor-driven auto search.
- Keeps a short-lived in-memory relation cache to reduce repeated relation queries.
- May combine CodeGraph relation results with optional ripgrep fallback only when fallback is enabled.

### Reference Window

- Opens as a webview panel in the editor area.
- Performs explicit lookup from the editor context menu, Relation Window toolbar, or keybinding.
- Uses CodeGraph symbol resolution plus optional text fallback.
- Does not update automatically on cursor movement.

### Global Status Bar

- Shows `CodeGraph: Ready`, `CodeGraph: Missing`, or error/progress states.
- Clicking opens actions for `codegraph init` and `codegraph sync`.
- Runs CodeGraph commands only after explicit user action.

### Auto Sync

- Controlled by `shared.autoSyncOnSave`.
- Enabled by default.
- When enabled, saved, created, deleted, or renamed files schedule a debounced `codegraph sync`.
- The default debounce delay is 30000ms.
- Auto sync only schedules while a CodeGraph Relation side-bar view is visible; switching to Explorer or another activity bar container suppresses automatic sync.
- Auto sync only runs when an existing `.codegraph/` index is available.
- Auto sync must never run `codegraph init` or any full rebuild command.
- Only one sync may run at a time; additional file events are ignored while a sync is active.

## 3. Architecture

```text
src/
├── extension.ts
├── features/
│   ├── symbol/
│   │   ├── SymbolController.ts
│   │   ├── SymbolModel.ts
│   │   ├── SymbolWebviewProvider.ts
│   │   └── parsing/
│   ├── relation/
│   │   ├── RelationController.ts
│   │   ├── RelationModel.ts
│   │   ├── RelationWebviewProvider.ts
│   │   └── relationCache.ts
│   ├── reference/
│   │   ├── ReferenceController.ts
│   │   └── ReferenceWebview.ts
│   └── placeholder/
├── shared/
│   ├── services/
│   │   └── CodeGraphService.ts
│   ├── ui/
│   │   └── GlobalStatusBar.ts
│   ├── common/
│   └── utils/
└── webview/
    ├── components/
    └── features/
```

### CodeGraphService

`CodeGraphService` is the only runtime wrapper around the CodeGraph CLI.

Responsibilities:

- detect the nearest `.codegraph/` root
- run `status`, `init`, `sync`, `query`, `files`, `node`, `callers`, and `callees`
- map CodeGraph JSON/text output into VS Code `SymbolItem`, `CallHierarchyItem`, and `Location` data
- keep Windows command execution compatible with `codegraph.cmd`
- parse streaming progress percentages for the status bar

### Models

- `SymbolModel` is a thin wrapper around `CodeGraphService`.
- `RelationModel` is a thin wrapper around `CodeGraphService` plus optional fallback search.
- Runtime LSP indexing, SQLite database indexing, and internal file watching are not part of the architecture.

## 4. Data Flow

### Activation

1. Extension activates for contributed views.
2. `CodeGraphService` is created with the workspace root.
3. Controllers and webview providers are registered according to settings.
4. `GlobalStatusBar` checks `codegraph status` when `.codegraph/` exists.

### Current Document Symbols

1. Active editor changes or Symbol Window refreshes.
2. Controller asks `SymbolModel.getDocumentSymbols(uri)`.
3. `CodeGraphService` resolves the nearest CodeGraph root and runs `codegraph node --symbols-only`.
4. Parsed symbols are posted to the webview.

### Project Search

1. User enters a query in Project Symbols.
2. Empty query calls `getProjectSymbols()` for default `main.*` symbols.
3. Non-empty query calls `searchSymbols(query)`.
4. CodeGraph relevance scores are preserved on results.
5. Results are sorted, filtered by kind, and posted to the webview.

### Relation Search

1. User triggers manual search or auto search fires on cursor movement.
2. Controller resolves the symbol at the current location.
3. Incoming mode calls `codegraph callers`; outgoing mode calls `codegraph callees`.
4. Both-directions mode requests both groups.
5. Results are cached and rendered as relation nodes.

### Reference Lookup

1. User explicitly triggers lookup.
2. Controller resolves the current symbol.
3. Reference search uses the resolved name and optional text fallback.
4. Reference Window displays grouped results with code context.

## 5. Search Semantics

CodeGraph query behavior is the primary search behavior. The extension should describe it as graph-backed, relevance-ranked, and tolerant of partial or approximate names. The extension must not promise exact phonetic algorithms unless CodeGraph exposes that as a documented contract.

Extension-level sorting rules:

- exact name match first
- starts-with match second
- CodeGraph score next when available
- stable name/path ordering after relevance

Empty project search:

- prefer indexed files whose basename matches `main.<ext>`
- otherwise use the alphabetically first indexed files with symbols
- cap the default display to the configured/default project symbol limit

## 6. Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `shared.codeGraphPath` | `codegraph` | CodeGraph CLI command or full path. |
| `shared.enableRipgrepFallback` | `false` | Enables optional ripgrep text-search fallback. |
| `shared.autoSyncOnSave` | `true` | Runs debounced `codegraph sync` after file changes when `.codegraph/` exists and a CodeGraph Relation side-bar view is visible. |
| `shared.autoSyncDebounceMs` | `30000` | Delay before automatic sync runs after file changes. |
| `symbolWindow.enable` | `true` | Enables Symbol Window. |
| `symbolWindow.splitView` | `false` | Splits current document and project symbols. |
| `symbolWindow.enableHighlighting` | `true` | Highlights search terms in symbol names. |
| `symbolWindow.symbolParsing.mode` | `auto` | Symbol display parsing mode. |
| `relationWindow.enable` | `true` | Enables Relation Window. |
| `relationWindow.autoSearch` | `false` | Auto-search relations on cursor movement. |
| `relationWindow.showBothDirections` | `false` | Shows callers and callees together. |
| `relationWindow.autoExpandBothDirections` | `false` | Expands both relation groups automatically. |
| `relationWindow.enableDeepSearch` | `true` | Compatibility setting for optional relation fallback. |
| `referenceWindow.enable` | `true` | Enables Reference Window. |

Removed runtime concepts:

- `shared.enableDatabaseMode`
- `shared.indexingBatchSize`
- `shared.database.cacheSizeMB`
- internal SQLite symbol database
- internal LSP client/indexer

## 7. Commands and Keybindings

| Command | Keybinding | Behavior |
| --- | --- | --- |
| `symbol-window.refresh` | - | Refresh current symbol view or rerun project search. |
| `symbol-window.toggleMode` | - | Toggle Current Document and Project Symbols when split view is off. |
| `symbol-window.focusProjectSearch` | `Ctrl+T` | Focus project search and seed from selection/word under cursor. |
| `symbol-window.focusCurrentSearch` | `Ctrl+Shift+O` | Focus current-document search. |
| `symbol-window.deepSearch` | - | Optional compatibility command for text fallback. |
| `symbol-window.rebuildIndex` | - | Prompt/run `codegraph sync`. |
| `symbol-window.rebuildIndexFull` | - | Prompt/run `codegraph init`. |
| `relation-window.manualSearch` | `Shift+Alt+H` | Search relations for the current symbol. |
| `relation-window.toggleDirection` | - | Toggle callers/callees. |
| `relation-window.lookupReference` | `Shift+Alt+F12` | Open references for current symbol. |
| `relation-window.jumpToDefinition` | - | Jump to related definition where available. |
| `reference-window.prev` | `F1` | Previous reference. |
| `reference-window.next` | `F2` | Next reference. |

## 8. Error States

- Missing `.codegraph/`: show unavailable state and `CodeGraph: Missing`.
- CodeGraph CLI not found: show command failure and suggest `shared.codeGraphPath`.
- Stale graph: user runs `codegraph sync` or `codegraph init`.
- Unsupported URI or file outside graph root: return empty results without crashing.
- Failed relation/reference lookup: preserve the last useful UI state when possible.

## 9. Verification

Use PowerShell in this repository.

```powershell
npm run check-types
npm run lint
npm run compile
```

`npm test` compiles first and runs VS Code extension tests. Existing VS Code runner or ESM import-resolution issues may be environment-specific; typecheck, lint, and compile are the expected baseline verification loop.
