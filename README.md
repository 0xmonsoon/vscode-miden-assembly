# miden-assembly

This VSCode/Cursor extension provides language support for the Miden Assembly language (MASM).

## Features

### Syntax Highlighting
The tmLanguage grammar is comprehensive and includes all VM opcodes supported by Miden.

### Go to Definition (Cmd/Ctrl+Click)
Navigate to definitions by clicking on:

### Hover Information
Hover over procedure names to see their documentation comments.

### Smart Navigation
- Ignores clicks inside string literals (`"..."`)
- Ignores clicks inside comments (`# ...`)

## Limitations

Module resolution uses heuristics optimized for the `miden-base` codebase structure, not the actual MASM assembler resolution rules. It searches common locations like `lib/`, `shared_modules/`, and cargo cache rather than parsing build configuration.

## Installation

### From Source (for Cursor)

```bash
git clone https://github.com/0xmonsoon/vscode-miden-assembly
cd vscode-miden-assembly
npm install
npm run compile

# Install to Cursor's extensions folder
rm -rf ~/.cursor/extensions/dlock.miden-assembly-*
cp -r . ~/.cursor/extensions/dlock.miden-assembly-0.2.0
```

Then reload Cursor: `Cmd+Shift+P` → "Reload Window"

### From Source (for VS Code)

```bash
git clone https://github.com/0xmonsoon/vscode-miden-assembly
cd vscode-miden-assembly
npm install
npm run compile
```

Then press F5 in VS Code to launch the extension in development mode.

### Building VSIX

```bash
npm install -g @vscode/vsce
npm run package
```

This creates a `.vsix` file you can install via `Extensions: Install from VSIX...`

## Requirements

For external dependency navigation (`miden::*` imports), run `cargo fetch` in your Miden project to download dependencies to the cargo cache.


## TODO

- [ ] Find all references
- [ ] Workspace symbol search
