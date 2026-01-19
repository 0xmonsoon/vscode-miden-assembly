# miden-assembly

This VSCode/Cursor extension provides language support for the Miden Assembly language (MASM).

## Features

### Syntax Highlighting
The tmLanguage grammar is comprehensive and includes all VM opcodes supported by Miden.

### Go to Definition (Cmd/Ctrl+Click)
Navigate to definitions by clicking on imports, procedure calls, and constants.

### Hover Information
Hover over procedure names to see their documentation comments.

### Smart Navigation
- Ignores clicks inside string literals (`"..."`)
- Ignores clicks inside comments (`# ...`)

## Module Resolution

The extension resolves import paths based on [MASM module semantics](https://docs.miden.xyz/next/miden-vm/user_docs/assembly/code_organization):

| Import Pattern | Resolution |
|---------------|------------|
| `miden::X::Y` | Parses `build.rs` → local `asm/` or cargo cache |
| `miden::core::*` | External: cargo cache `miden-core-lib` |
| `std::X::Y` | External: cargo cache `miden-stdlib` |
| `$alias::module` | Relative: `lib/module.masm` |
| `bare_module` | Relative: `./module.masm` |

### How It Works

#### 1. Automatic Namespace Detection from `build.rs`

The extension **parses `build.rs` files** in your workspace to extract namespace definitions:

```rust
// build.rs
const PROTOCOL_LIB_NAMESPACE: &str = "miden::protocol";
const ASM_PROTOCOL_DIR: &str = "protocol";
```

This tells the extension that `miden::protocol::*` imports resolve to `asm/protocol/` in that crate.

#### 2. Resolution Order

For `use miden::X::Y::Z`:

1. **Parse `build.rs`** in all `crates/*/build.rs` files
2. If `miden::X` namespace found → use that crate's `asm/{dir}/Y/Z.masm`
3. If not found → search all `crates/*/asm/X/Y/Z.masm`
4. If still not found → check cargo cache for `miden-X-lib` or `miden-X`

#### 3. Known External Namespaces

These always resolve from cargo cache (never local):
- `miden::core::*` → `miden-core-lib`
- `std::*` → `miden-stdlib`

### Example

Given this workspace structure:
```
my-project/
├── Cargo.toml (workspace)
├── crates/
│   ├── my-protocol/
│   │   ├── build.rs          # defines MYLIB_LIB_NAMESPACE = "miden::mylib"
│   │   └── asm/mylib/
│   │       └── utils.masm
```

The extension will automatically resolve:
```masm
use miden::mylib::utils  # → crates/my-protocol/asm/mylib/utils.masm
```

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

### Building VSIX (for other editors)

```bash
npm install -g @vscode/vsce
npm run package
```

This creates a `.vsix` file you can install via `Extensions: Install from VSIX...`

## Requirements

For external dependency navigation (`miden::core::*`, `std::*`), run `cargo fetch` in your Miden project to download dependencies to the cargo cache.

## References

- [MASM Code Organization](https://docs.miden.xyz/next/miden-vm/user_docs/assembly/code_organization)

## TODO

- [ ] Find all references
- [ ] Workspace symbol search
