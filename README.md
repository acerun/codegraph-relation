# CodeGraph Relation

A Visual Studio Code extension for browsing symbols, relations, and references from an existing [CodeGraph](https://colbymchenry.github.io/codegraph/reference/cli/) index.

## Requirements

This extension is a UI on top of the `codegraph` CLI — it does not bundle or install it. **If `codegraph` is not already installed, install it first** by following the official guide:

> 📦 **Install CodeGraph:** https://colbymchenry.github.io/codegraph/getting-started/installation/

After installing, verify the CLI is on your `PATH`:

```powershell
codegraph --version
```

If the command is not found, either add CodeGraph to your `PATH` or set `shared.codeGraphPath` to its full path (see [Shared Settings](#shared-settings)).

Then, in the workspace:

- Run `codegraph init` manually in the workspace root before using the extension.
- The extension only uses CodeGraph when the workspace root contains `.codegraph/`.

The extension does not start or maintain an LSP-based index. If the graph is missing or stale, run CodeGraph yourself:

```powershell
codegraph init
codegraph sync
codegraph status
```

## Features

- **Symbol Window**: current-file symbol outline and project-wide symbol search backed by `codegraph node` and `codegraph query`.
- **Relation Window**: incoming and outgoing relation exploration backed by `codegraph callers` and `codegraph callees`.
- **Reference Window**: lightweight reference list using CodeGraph symbols, with optional text-search fallback.
- **Status Bar**: shows whether `.codegraph/` is available in the workspace root.

## Basic Usage

1. [Install the `codegraph` CLI](https://colbymchenry.github.io/codegraph/getting-started/installation/) if you don't have it yet, and confirm `codegraph --version` works.
2. Open a workspace.
3. In the workspace root, run `codegraph init`.
4. Open the CodeGraph Relation activity bar view.
5. Use `Ctrl+Shift+O` for current-file symbols and `Ctrl+T` for project symbol search.
6. Use `Shift+Alt+H` to refresh relations for the symbol under the cursor.
7. Use `Shift+Alt+F12` to look up references.

## Configuration

### Window Enablement

- `symbolWindow.enable`: enable the Symbol Window.
- `relationWindow.enable`: enable the Relation Window.
- `referenceWindow.enable`: enable the Reference Window.

### Shared Settings

- `shared.codeGraphPath`: CodeGraph CLI command name or path. Default: `codegraph`.
- `shared.enableRipgrepFallback`: enable ripgrep text-search fallback. Default: `false`.

Ripgrep is still bundled for optional fallback behavior, but CodeGraph is the primary source of symbol and relation data.

### Symbol Window

- `symbolWindow.splitView`: split Current Document and Project Symbols into separate views.
- `symbolWindow.enableHighlighting`: highlight query matches in symbol names.
- `symbolWindow.symbolParsing.mode`: retained for UI compatibility.

### Relation Window

- `relationWindow.autoSearch`: automatically refresh relations as the cursor moves.
- `relationWindow.showBothDirections`: show callers and callees side by side.
- `relationWindow.autoExpandBothDirections`: auto-expand both direction groups.
- `relationWindow.enableDeepSearch`: retained for compatibility; ripgrep fallback remains disabled unless `shared.enableRipgrepFallback` is enabled.

## Commands

- **Refresh**: reloads symbols or relations from the current CodeGraph index.
- **Rebuild Symbol Index (Incremental)**: prompts you to run `codegraph sync`.
- **Rebuild Symbol Index (Full)**: prompts you to run `codegraph init`.
- **Lookup References**: searches references for the current symbol.
- **Next/Previous Reference**: navigates through the Reference Window results.

## Notes

- This extension intentionally does not call `codegraph init` automatically. Index ownership stays with the user.
- If results look stale, run `codegraph sync` or `codegraph init` in the workspace root.
- If `.codegraph/` is absent, views show a missing/timeout state instead of falling back to LSP.

## Development

```powershell
npm ci
npm run check-types
npm run lint
npm run compile
```

`npm test` launches VS Code extension tests. In this workspace, the runner may fail on the existing ESM import resolution for compiled tests; `check-types`, `lint`, and `compile` are the reliable verification loop for this change.
