# Contributing to CodeGraph Relation

Thanks for helping improve CodeGraph Relation. This project is a VS Code extension that uses an existing CodeGraph index for symbol navigation, relation exploration, and reference lookup.

## Runtime Principles

- CodeGraph is the primary index source.
- Users run `codegraph init` and `codegraph sync` manually.
- The extension must not automatically initialize or rebuild CodeGraph.
- If `.codegraph/` is missing, show a missing/unavailable state.
- Do not reintroduce runtime LSP indexing or the old SQLite symbol database.
- Keep implementation simple and close to existing feature boundaries.

## Development Setup

Prerequisites:

- Node.js
- npm
- Visual Studio Code
- CodeGraph CLI on `PATH`

Setup:

```powershell
git clone https://github.com/acerun/codegraph-relation.git
cd codegraph-relation
npm install
```

For extension debugging:

1. Open this repository in VS Code.
2. Press `F5`.
3. In the Extension Development Host, open a workspace that already has `.codegraph/`, or run `codegraph init` manually in that workspace.

## Project Structure

```text
src/
├── extension.ts
├── features/
│   ├── symbol/
│   ├── relation/
│   ├── reference/
│   └── placeholder/
├── shared/
│   ├── services/CodeGraphService.ts
│   ├── ui/GlobalStatusBar.ts
│   ├── common/
│   └── utils/
├── webview/
└── test/
```

Key files:

- `src/shared/services/CodeGraphService.ts`: central CodeGraph CLI wrapper.
- `src/features/symbol/SymbolModel.ts`: symbol data access.
- `src/features/relation/RelationModel.ts`: relation data access.
- `src/shared/ui/GlobalStatusBar.ts`: CodeGraph readiness and actions.
- `src/webview/features/*`: React webview UIs.

## CodeGraph CLI Contract

Runtime calls should stay centralized in `CodeGraphService`.

Supported calls:

```powershell
codegraph status <path>
codegraph files -p <path> --json
codegraph query <search> -p <path> --json -l <limit>
codegraph node -p <path> -f <file> <file> --symbols-only
codegraph callers <symbol> -p <path> --json -l <limit>
codegraph callees <symbol> -p <path> --json -l <limit>
```

Do not scatter direct CodeGraph process calls through feature controllers or webviews.

## Windows and Path Handling

- Use PowerShell for repository commands.
- Use `vscode.Uri` when communicating with VS Code APIs and webviews.
- Use `fsPath` only for filesystem or CLI operations.
- Convert relative CodeGraph paths with `/` separators when passing file paths to CodeGraph.
- Be careful with Windows command shims such as `codegraph.cmd`.

## Development Commands

```powershell
npm run check-types
npm run lint
npm run compile
```

Packaging:

```powershell
npx @vscode/vsce package
```

Optional tests:

```powershell
npm test
```

`npm test` launches VS Code extension tests and can be affected by local VS Code runner or ESM import-resolution behavior. Always run typecheck, lint, and compile before submitting.

## Documentation

When behavior changes, update:

- `README.md` for user-facing usage
- `SPEC.md` for architecture and feature contracts
- `TEST.md` for manual verification
- `CHANGELOG.md` for release notes

Screenshots used by the README live under `media/Common`.

## Pull Request Checklist

- [ ] The change keeps CodeGraph as the primary runtime source.
- [ ] The extension does not run `codegraph init` or `codegraph sync` without explicit user action.
- [ ] Missing `.codegraph/` is handled gracefully.
- [ ] Typecheck passes.
- [ ] Lint passes.
- [ ] Compile passes.
- [ ] Documentation and tests are updated when behavior changes.

## License

By contributing, you agree that your contributions are licensed under the MIT License.
