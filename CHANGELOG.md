# Change Log

All notable changes to the "miden-assembly" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.2.0]

### Added
- **Go to Definition** (Cmd/Ctrl+Click) support:
  - Navigate to module files from `use` statements
  - Navigate to procedure definitions from `exec.module::proc` calls
  - Navigate to constant definitions from `use $kernel::constants::CONST_NAME`
  - Follow re-export chains (`pub use module::orig->exported`)
  - Resolve external `miden::*` imports from cargo cache (`~/.cargo/registry/src/`)
- **Hover Provider**: Shows procedure documentation on hover
- Smart navigation that ignores clicks in:
  - String literals (`"..."`)
  - Comments (`# ...`)

### Changed
- Updated package.json with activation events and TypeScript build configuration

## [0.1.1]

- Initial release with syntax highlighting
