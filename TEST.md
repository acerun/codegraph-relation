# Test Plan for CodeGraph Relation

This plan verifies the current CodeGraph-based runtime. Run all terminal commands from the workspace root.

## 1. Environment

- [ ] Install CodeGraph and verify `codegraph --version`.
- [ ] Open a workspace with a real source project.
- [ ] Run `codegraph init` manually.
- [ ] Verify `.codegraph/` exists at the workspace root.
- [ ] Verify the VS Code status bar shows `CodeGraph: Ready`.
- [ ] Click the status bar item and verify actions for `codegraph init` and `codegraph sync`.

## 2. Missing or Stale Graph

- [ ] Open a workspace without `.codegraph/`.
- [ ] Verify Symbol, Relation, and Reference views show an unavailable or empty state without crashing.
- [ ] Verify the status bar shows `CodeGraph: Missing`.
- [ ] Set `shared.codeGraphPath` to an invalid command and verify the error is reported.
- [ ] Restore `shared.codeGraphPath` to `codegraph`.

## 3. Symbol Window

- [ ] Open a source file with functions/classes.
- [ ] Verify Current Document lists symbols from the active file.
- [ ] Type in the Current Document search box.
- [ ] Verify matching symbols remain visible and parent nodes expand when children match.
- [ ] Clear the search box and verify the full current-file outline returns.
- [ ] Double-click a symbol and verify the editor jumps to its location.
- [ ] Use `Ctrl+Shift+O` and verify the Current Document search box is focused.
- [ ] Switch between two files and verify the list updates to the active file.

## 4. Project Symbols

- [ ] Use `Ctrl+T` with a word selected in the editor.
- [ ] Verify Project Symbols is focused, filled with the selected word, and searched.
- [ ] Search `main`.
- [ ] Verify entry-point or `main.*` related symbols appear when present.
- [ ] Search a partial name such as `set ref`.
- [ ] Try an approximate spelling or pronunciation-close term for a known symbol.
- [ ] Verify CodeGraph can return relevant approximate/fuzzy matches such as `setReferenceController` when indexed.
- [ ] Search a known exact symbol and verify exact matches rank near the top.
- [ ] Clear the project query.
- [ ] Verify default symbols from indexed `main.*` files appear when available.
- [ ] In a workspace without `main.*`, verify default project symbols still show from indexed files.
- [ ] Toggle symbol kind filters and verify results are filtered without losing the current query.
- [ ] Click Refresh and verify the current query is rerun.

## 5. Split View

- [ ] Enable `symbolWindow.splitView`.
- [ ] Verify Current Document and Project Symbols appear as separate views.
- [ ] Verify each view has its own search box and refresh action.
- [ ] Disable `symbolWindow.splitView` and verify the single Symbol Window mode returns.

## 6. Relation Window

- [ ] Place the cursor on a function or method with known callers.
- [ ] Press `Shift+Alt+H`.
- [ ] Verify Incoming Calls shows caller results from CodeGraph.
- [ ] Toggle direction.
- [ ] Verify Outgoing Calls shows callee results from CodeGraph.
- [ ] Double-click a relation result and verify editor navigation.
- [ ] Enable `relationWindow.showBothDirections`.
- [ ] Verify callers and callees are displayed as separate groups.
- [ ] Enable `relationWindow.autoExpandBothDirections` and verify both groups expand automatically.
- [ ] Enable `relationWindow.autoSearch`, move the cursor to another symbol, and verify the relation tree updates.
- [ ] Disable `relationWindow.autoSearch` and verify manual search is required again.

## 7. Reference Window

- [ ] Place the cursor on a symbol with references.
- [ ] Press `Shift+Alt+F12`.
- [ ] Verify Reference Window opens in the editor area.
- [ ] Verify references are grouped and include code context.
- [ ] Use `F2` and `F1` to navigate next/previous reference.
- [ ] Double-click or press Enter on a reference and verify editor navigation.
- [ ] Trigger Lookup References from the editor context menu and verify the same window updates.

## 8. Optional Ripgrep Fallback

- [ ] Keep `shared.enableRipgrepFallback` disabled.
- [ ] Verify normal symbol and relation flows still use CodeGraph.
- [ ] Enable `shared.enableRipgrepFallback`.
- [ ] Search references for a plain text occurrence not represented as a CodeGraph relation.
- [ ] Verify fallback text results can appear where supported.
- [ ] Disable the setting again after the test.

## 9. Settings and Enablement

- [ ] Keep default `shared.autoSyncOnSave` enabled in a workspace with `.codegraph/`.
- [ ] Save, create, rename, or delete a source file.
- [ ] Verify `codegraph sync` runs after the default 30000ms debounce delay.
- [ ] Verify the views refresh after sync completes.
- [ ] Switch the Activity Bar to Explorer.
- [ ] Save a source file and verify automatic `codegraph sync` is not started.
- [ ] Move back to CodeGraph Relation and verify later file changes can trigger automatic sync again.
- [ ] Disable `shared.autoSyncOnSave` and save a file.
- [ ] Verify no automatic `codegraph sync` is started.
- [ ] Open a workspace without `.codegraph/`, enable `shared.autoSyncOnSave`, and save a file.
- [ ] Verify the extension does not run `codegraph init` automatically.
- [ ] Disable `symbolWindow.enable` and verify Symbol views are hidden.
- [ ] Disable `relationWindow.enable` and verify Relation Window is hidden.
- [ ] Disable both Symbol and Relation windows and verify the placeholder/foolproof view appears.
- [ ] Re-enable both settings.
- [ ] Disable `referenceWindow.enable` and verify reference commands are unavailable or blocked.
- [ ] Re-enable `referenceWindow.enable`.

## 10. Visual Verification

- [ ] Compare the main side bar layout with `media/Common/window.png`.
- [ ] Compare the ready status bar state with `media/Common/status.png`.
- [ ] Compare the status quick pick with `media/Common/status_list.png`.
- [ ] Test Light, Dark, and High Contrast themes.
- [ ] Verify long symbol names do not overlap toolbar controls or filters.

## 11. Developer Verification

Use PowerShell:

```powershell
npm run check-types
npm run lint
npm run compile
```

Optional:

```powershell
npm test
```

Known note: `npm test` may be affected by VS Code test runner environment issues. Typecheck, lint, and compile are the required baseline.
