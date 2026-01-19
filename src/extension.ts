import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Cache for parsed files to improve performance
const fileCache = new Map<string, { 
    imports: Map<string, string>; 
    procedures: Map<string, number>;
    reexports: Map<string, { module: string; originalName: string; line: number }>;
    constants: Map<string, number>;
}>();

/**
 * Parse a MASM file to extract imports, procedure definitions, re-exports, and constants
 */
function parseFile(filePath: string): { 
    imports: Map<string, string>; 
    procedures: Map<string, number>;
    reexports: Map<string, { module: string; originalName: string; line: number }>;
    constants: Map<string, number>;
} {
    const cached = fileCache.get(filePath);
    if (cached) {
        return cached;
    }

    const imports = new Map<string, string>();
    const procedures = new Map<string, number>();
    const reexports = new Map<string, { module: string; originalName: string; line: number }>();
    const constants = new Map<string, number>();

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Parse use statements: use $kernel::module::item or use.module or use miden::core::mem
            // Pattern 1: use $kernel::module::item (e.g., use $kernel::constants::MAX_ASSETS)
            // Pattern 2: use $kernel::module (e.g., use $kernel::account)
            // Pattern 3: use miden::path::module (e.g., use miden::core::mem)
            const useMatch = line.match(/^\s*use\s+(?:(\$kernel)::)?([a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)/);
            if (useMatch) {
                const isKernel = useMatch[1] === '$kernel';
                const fullPath = useMatch[2];
                const pathParts = fullPath.split('::');
                
                if (isKernel && pathParts.length >= 2) {
                    // For $kernel::module::item, the module is the first part
                    // e.g., $kernel::constants::MAX_ASSETS -> module is "constants"
                    const moduleName = pathParts[0];
                    imports.set(moduleName, moduleName);
                } else if (pathParts[0] === 'miden' && pathParts.length >= 2) {
                    // For miden::core::mem, store the full path
                    // The last part is the module name for lookup
                    const moduleName = pathParts[pathParts.length - 1];
                    imports.set(moduleName, fullPath);
                } else {
                    // Simple case: use $kernel::module or use .module
                    const moduleName = pathParts[pathParts.length - 1];
                    imports.set(moduleName, fullPath);
                }
            }

            // Parse re-exports: pub use module::original_name->exported_name
            // Example: pub use memory::get_account_nonce->get_nonce
            const reexportMatch = line.match(/^\s*(?:pub\s+)?use\s+([a-zA-Z_][a-zA-Z0-9_]*)::([a-zA-Z_][a-zA-Z0-9_]*)->([a-zA-Z_][a-zA-Z0-9_]*)/);
            if (reexportMatch) {
                const moduleName = reexportMatch[1];
                const originalName = reexportMatch[2];
                const exportedName = reexportMatch[3];
                reexports.set(exportedName, { module: moduleName, originalName, line: i });
                // Also add the module to imports if not already there
                if (!imports.has(moduleName)) {
                    imports.set(moduleName, moduleName);
                }
            }

            // Parse procedure definitions: proc name or pub proc name or export.name
            // MASM syntax: "pub proc get_initial_commitment" or "proc my_proc"
            const procMatch = line.match(/^\s*(?:pub\s+)?proc\s+([a-zA-Z_][a-zA-Z0-9_]*)|^\s*export\.([a-zA-Z_][a-zA-Z0-9_]*)/);
            if (procMatch) {
                const procName = procMatch[1] || procMatch[2];
                if (procName) {
                    procedures.set(procName, i);
                }
            }

            // Parse constant definitions: const NAME = value or pub const NAME = value
            const constMatch = line.match(/^\s*(?:pub\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=/);
            if (constMatch) {
                const constName = constMatch[1];
                constants.set(constName, i);
            }
        }
    } catch (e) {
        // File read error, return empty maps
    }

    const result = { imports, procedures, reexports, constants };
    fileCache.set(filePath, result);
    return result;
}

/**
 * Clear cache for a specific file when it changes
 */
function clearCache(filePath: string) {
    fileCache.delete(filePath);
}

/**
 * Find all .masm files in a directory recursively
 */
function findMasmFiles(dir: string, files: string[] = []): string[] {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                findMasmFiles(fullPath, files);
            } else if (entry.isFile() && entry.name.endsWith('.masm')) {
                files.push(fullPath);
            }
        }
    } catch (e) {
        // Directory read error
    }
    return files;
}

/**
 * Resolve a module path to a file path
 */
function resolveModulePath(currentFile: string, moduleName: string, modulePath: string): string | null {
    const currentDir = path.dirname(currentFile);
    
    // Handle miden:: external imports (e.g., miden::core::mem -> miden-core-lib/asm/mem.masm)
    // Only use cargo cache (always up-to-date after cargo fetch)
    if (modulePath.startsWith('miden::')) {
        const pathParts = modulePath.split('::');
        // miden::core::mem -> ['miden', 'core', 'mem']
        const fileName = pathParts[pathParts.length - 1];
        
        // Build the subdirectory path from middle parts (e.g., 'core' -> nothing special, but 'crypto::hashes' -> 'crypto/hashes')
        const subPath = pathParts.slice(1, -1).join('/');
        
        // Use cargo cache (always up-to-date after cargo fetch)
        const cargoHome = process.env.CARGO_HOME || path.join(process.env.HOME || '', '.cargo');
        const registrySrc = path.join(cargoHome, 'registry', 'src');
        
        try {
            // Find the registry index directory (e.g., index.crates.io-1949cf8c6b5b557f)
            if (fs.existsSync(registrySrc)) {
                const indexDirs = fs.readdirSync(registrySrc);
                for (const indexDir of indexDirs) {
                    const indexPath = path.join(registrySrc, indexDir);
                    // Find the latest miden-core-lib version
                    const entries = fs.readdirSync(indexPath).filter(e => e.startsWith('miden-core-lib-'));
                    if (entries.length > 0) {
                        // Sort to get the latest version
                        entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
                        const latestVersion = entries[0];
                        const cargoPaths = [
                            path.join(indexPath, latestVersion, 'asm', subPath, `${fileName}.masm`),
                            path.join(indexPath, latestVersion, 'asm', `${fileName}.masm`),
                        ];
                        for (const cargoPath of cargoPaths) {
                            if (fs.existsSync(cargoPath)) {
                                return cargoPath;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // Cargo cache not accessible
        }
        
        // No vendor fallback - only use cargo cache
        return null;
    }
    
    // Common locations to search for modules
    const searchPaths = [
        // lib/ subdirectory (kernel modules)
        path.join(currentDir, 'lib', `${moduleName}.masm`),
        // Same directory
        path.join(currentDir, `${moduleName}.masm`),
        // Parent lib/ directory
        path.join(currentDir, '..', 'lib', `${moduleName}.masm`),
        // Parent directory
        path.join(currentDir, '..', `${moduleName}.masm`),
        // shared_modules/ (for account_id, etc.)
        path.join(currentDir, '..', '..', 'shared_modules', `${moduleName}.masm`),
        path.join(currentDir, '..', 'shared_modules', `${moduleName}.masm`),
        path.join(currentDir, 'shared_modules', `${moduleName}.masm`),
    ];

    // Handle nested module paths (e.g., account_id might be in a subdirectory)
    const pathParts = modulePath.split('::');
    if (pathParts.length > 1) {
        searchPaths.push(
            path.join(currentDir, 'lib', ...pathParts.slice(0, -1), `${moduleName}.masm`),
            path.join(currentDir, ...pathParts.slice(0, -1), `${moduleName}.masm`)
        );
    }

    // Search workspace folders for the module
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        for (const folder of workspaceFolders) {
            // Look in common masm directories
            const masmDirs = [
                path.join(folder.uri.fsPath, 'crates', 'miden-protocol', 'asm', 'kernels', 'transaction', 'lib'),
                path.join(folder.uri.fsPath, 'crates', 'miden-protocol', 'asm', 'shared_modules'),
                path.join(folder.uri.fsPath, 'crates', 'miden-standards', 'asm'),
                path.join(folder.uri.fsPath, 'miden-base', 'crates', 'miden-protocol', 'asm', 'kernels', 'transaction', 'lib'),
                path.join(folder.uri.fsPath, 'miden-base', 'crates', 'miden-protocol', 'asm', 'shared_modules'),
                path.join(folder.uri.fsPath, 'miden-base', 'crates', 'miden-standards', 'asm'),
                path.join(folder.uri.fsPath, 'vm', 'crates', 'lib', 'core', 'asm'),
            ];

            for (const masmDir of masmDirs) {
                searchPaths.push(path.join(masmDir, `${moduleName}.masm`));
                // Also check subdirectories
                if (fs.existsSync(masmDir)) {
                    const files = findMasmFiles(masmDir);
                    for (const file of files) {
                        if (path.basename(file, '.masm') === moduleName) {
                            searchPaths.push(file);
                        }
                    }
                }
            }
        }
    }

    // Find the first existing file
    for (const searchPath of searchPaths) {
        const normalizedPath = path.normalize(searchPath);
        if (fs.existsSync(normalizedPath)) {
            return normalizedPath;
        }
    }

    return null;
}

/**
 * Find a constant definition in a file
 */
function findConstantInFile(filePath: string, constantName: string): vscode.Location | null {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Match: const NAME = value or pub const NAME = value
            const constRegex = new RegExp(`^\\s*(?:pub\\s+)?const\\s+${constantName}\\s*=`);
            if (constRegex.test(line)) {
                const uri = vscode.Uri.file(filePath);
                const position = new vscode.Position(i, line.indexOf(constantName));
                return new vscode.Location(uri, position);
            }
        }
    } catch (e) {
        // File read error
    }
    return null;
}

/**
 * Find a procedure definition in a file (handles re-exports)
 */
function findProcedureInFile(filePath: string, procedureName: string, followReexports: boolean = true): vscode.Location | null {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        // First, check for direct procedure definition
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Match: proc name, pub proc name, export.name
            // MASM syntax: "pub proc get_initial_commitment" or "proc my_proc"
            const procRegex = new RegExp(`^\\s*(?:pub\\s+)?proc\\s+${procedureName}\\b|^\\s*export\\.${procedureName}\\b`);
            if (procRegex.test(line)) {
                const uri = vscode.Uri.file(filePath);
                const position = new vscode.Position(i, line.indexOf(procedureName));
                return new vscode.Location(uri, position);
            }
        }

        // If not found and we should follow re-exports, check for re-export
        if (followReexports) {
            const { reexports, imports } = parseFile(filePath);
            const reexport = reexports.get(procedureName);
            if (reexport) {
                // First, return the re-export line itself so user can see it
                // Then they can navigate further if needed
                const uri = vscode.Uri.file(filePath);
                const reexportLine = lines[reexport.line];
                const position = new vscode.Position(reexport.line, reexportLine.indexOf(procedureName));
                return new vscode.Location(uri, position);
            }
        }
    } catch (e) {
        // File read error
    }
    return null;
}

/**
 * Find the ultimate source of a procedure (following re-exports)
 */
function findProcedureSource(filePath: string, procedureName: string, visited: Set<string> = new Set()): vscode.Location | null {
    // Prevent infinite loops
    const key = `${filePath}:${procedureName}`;
    if (visited.has(key)) {
        return null;
    }
    visited.add(key);

    const { reexports, imports } = parseFile(filePath);
    
    // Check if this is a re-export
    const reexport = reexports.get(procedureName);
    if (reexport) {
        // Find the source module
        const modulePath = imports.get(reexport.module) || reexport.module;
        const targetFile = resolveModulePath(filePath, reexport.module, modulePath);
        if (targetFile) {
            // Recursively find the original definition
            const sourceLocation = findProcedureSource(targetFile, reexport.originalName, visited);
            if (sourceLocation) {
                return sourceLocation;
            }
            // If not found recursively, try direct lookup
            return findProcedureInFile(targetFile, reexport.originalName, false);
        }
    }

    // Not a re-export, look for direct definition
    return findProcedureInFile(filePath, procedureName, false);
}

/**
 * Definition Provider for MASM files
 */
class MasmDefinitionProvider implements vscode.DefinitionProvider {
    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
        const line = document.lineAt(position.line).text;
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);
        const linePrefix = line.substring(0, wordRange.end.character);
        const lineSuffix = line.substring(wordRange.end.character);

        // Check if the word is inside a comment (# starts a comment in MASM)
        const beforeWord = line.substring(0, wordRange.start.character);
        if (beforeWord.includes('#')) {
            // Inside a comment, don't provide navigation
            return null;
        }

        // Check if the word is inside a string literal (between quotes)
        // Count quotes before the word position - if odd number, we're inside a string
        const doubleQuotesBefore = (beforeWord.match(/"/g) || []).length;
        if (doubleQuotesBefore % 2 === 1) {
            // Inside a string literal, don't provide navigation
            return null;
        }

        // Parse current file for imports
        const { imports } = parseFile(document.uri.fsPath);

        // Pattern 1: use $kernel::module::item or use miden::path::module - jump to module file or constant
        const useMatch = line.match(/^\s*use\s+(?:(\$kernel)::)?([a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)/);
        if (useMatch) {
            const isKernel = useMatch[1] === '$kernel';
            const fullPath = useMatch[2];
            const pathParts = fullPath.split('::');
            
            // Check which part of the path was clicked
            if (pathParts.includes(word)) {
                let moduleName: string;
                let resolvedPath: string;
                
                if (isKernel) {
                    // For $kernel::constants::ITEM, clicking on "constants" navigates to constants.masm
                    // The module is the first part after $kernel
                    moduleName = pathParts[0];
                    resolvedPath = moduleName;
                    
                    // If clicking on a constant name (e.g., ACCOUNT_PROCEDURE_DATA_LENGTH), jump to its definition
                    if (pathParts.length >= 2 && word === pathParts[pathParts.length - 1] && /^[A-Z_][A-Z0-9_]*$/.test(word)) {
                        const targetFile = resolveModulePath(document.uri.fsPath, moduleName, resolvedPath);
                        if (targetFile) {
                            const location = findConstantInFile(targetFile, word);
                            if (location) {
                                return location;
                            }
                        }
                    }
                } else if (pathParts[0] === 'miden') {
                    // For miden::core::mem, clicking on "mem" navigates to mem.masm
                    moduleName = pathParts[pathParts.length - 1];
                    resolvedPath = fullPath;
                } else {
                    moduleName = pathParts[pathParts.length - 1];
                    resolvedPath = fullPath;
                }
                
                const targetFile = resolveModulePath(document.uri.fsPath, moduleName, resolvedPath);
                if (targetFile) {
                    return new vscode.Location(vscode.Uri.file(targetFile), new vscode.Position(0, 0));
                }
            }
        }

        // Pattern 2: exec.module::procedure - jump to procedure in module
        const execMatch = linePrefix.match(/exec\.([a-zA-Z_][a-zA-Z0-9_]*)::([a-zA-Z_][a-zA-Z0-9_]*)$/);
        if (execMatch) {
            const moduleName = execMatch[1];
            const procedureName = execMatch[2];
            
            // Check if we clicked on the module name or procedure name
            if (word === moduleName) {
                // Jump to module file
                const modulePath = imports.get(moduleName) || moduleName;
                const targetFile = resolveModulePath(document.uri.fsPath, moduleName, modulePath);
                if (targetFile) {
                    return new vscode.Location(vscode.Uri.file(targetFile), new vscode.Position(0, 0));
                }
            } else if (word === procedureName) {
                // Jump to procedure definition (following re-exports to find the source)
                const modulePath = imports.get(moduleName) || moduleName;
                const targetFile = resolveModulePath(document.uri.fsPath, moduleName, modulePath);
                if (targetFile) {
                    // Try to find the ultimate source of the procedure
                    const sourceLocation = findProcedureSource(targetFile, procedureName);
                    if (sourceLocation) {
                        return sourceLocation;
                    }
                    // Fallback to direct lookup
                    const location = findProcedureInFile(targetFile, procedureName);
                    if (location) {
                        return location;
                    }
                }
            }
        }

        // Pattern 3: call.procedure or dynexec with procedure reference
        const callMatch = linePrefix.match(/(?:call|dynexec)\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
        if (callMatch && word === callMatch[1]) {
            // Search in current file first
            const location = findProcedureInFile(document.uri.fsPath, word);
            if (location) {
                return location;
            }
        }

        // Pattern 4: Local procedure reference (just a word that matches a procedure in current file)
        const currentFileLocation = findProcedureInFile(document.uri.fsPath, word);
        if (currentFileLocation) {
            return currentFileLocation;
        }

        // Pattern 5: Search all imported modules for the procedure
        for (const [moduleName, modulePath] of imports) {
            const targetFile = resolveModulePath(document.uri.fsPath, moduleName, modulePath);
            if (targetFile) {
                const location = findProcedureInFile(targetFile, word);
                if (location) {
                    return location;
                }
            }
        }

        return null;
    }
}

/**
 * Hover Provider for MASM files - shows procedure signature on hover
 */
class MasmHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const line = document.lineAt(position.line).text;
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        
        if (!wordRange) {
            return null;
        }

        // Check if the word is inside a comment
        const beforeWord = line.substring(0, wordRange.start.character);
        if (beforeWord.includes('#')) {
            return null;
        }

        // Check if the word is inside a string literal
        const doubleQuotesBefore = (beforeWord.match(/"/g) || []).length;
        if (doubleQuotesBefore % 2 === 1) {
            return null;
        }

        const word = document.getText(wordRange);
        const { imports } = parseFile(document.uri.fsPath);

        // Check for exec.module::procedure pattern
        const execMatch = line.match(/exec\.([a-zA-Z_][a-zA-Z0-9_]*)::([a-zA-Z_][a-zA-Z0-9_]*)/);
        if (execMatch && (word === execMatch[1] || word === execMatch[2])) {
            const moduleName = execMatch[1];
            const procedureName = execMatch[2];
            const modulePath = imports.get(moduleName) || moduleName;
            const targetFile = resolveModulePath(document.uri.fsPath, moduleName, modulePath);
            
            if (targetFile && word === procedureName) {
                // Get the procedure documentation
                const doc = getProcedureDocumentation(targetFile, procedureName);
                if (doc) {
                    return new vscode.Hover(new vscode.MarkdownString(doc));
                }
            }
        }

        return null;
    }
}

/**
 * Extract procedure documentation from a file
 */
function getProcedureDocumentation(filePath: string, procedureName: string): string | null {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // MASM syntax: "pub proc get_initial_commitment" or "proc my_proc"
            const procRegex = new RegExp(`^\\s*(?:pub\\s+)?proc\\s+${procedureName}\\b`);
            
            if (procRegex.test(line)) {
                // Look backwards for documentation comments
                const docLines: string[] = [];
                let j = i - 1;
                
                while (j >= 0) {
                    const commentLine = lines[j].trim();
                    if (commentLine.startsWith('#!')) {
                        docLines.unshift(commentLine.substring(2).trim());
                        j--;
                    } else if (commentLine === '' || commentLine.startsWith('#')) {
                        j--;
                    } else {
                        break;
                    }
                }

                if (docLines.length > 0) {
                    return '```\n' + docLines.join('\n') + '\n```';
                }
                
                return `**${procedureName}** in \`${path.basename(filePath)}\``;
            }
        }
    } catch (e) {
        // File read error
    }
    return null;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Miden Assembly extension activated');

    // Register Definition Provider
    const definitionProvider = vscode.languages.registerDefinitionProvider(
        { language: 'masm', scheme: 'file' },
        new MasmDefinitionProvider()
    );

    // Register Hover Provider
    const hoverProvider = vscode.languages.registerHoverProvider(
        { language: 'masm', scheme: 'file' },
        new MasmHoverProvider()
    );

    // Clear cache when files change
    const fileWatcher = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === 'masm') {
            clearCache(e.document.uri.fsPath);
        }
    });

    context.subscriptions.push(definitionProvider, hoverProvider, fileWatcher);
}

export function deactivate() {
    fileCache.clear();
}
