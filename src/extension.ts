import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Caches
const fileCache = new Map<string, ParsedFile>();
const moduleCache = new Map<string, string | null>();
const namespaceCache = new Map<string, Map<string, string>>(); // workspaceRoot -> (namespace -> asmDir)

interface ParsedFile {
    imports: Map<string, string>;
    procedures: Map<string, number>;
    reexports: Map<string, { module: string; originalName: string; line: number }>;
    constants: Map<string, number>;
}

/**
 * Parse a MASM file to extract imports, procedures, re-exports, and constants
 */
function parseFile(filePath: string): ParsedFile {
    const cached = fileCache.get(filePath);
    if (cached) return cached;

    const imports = new Map<string, string>();
    const procedures = new Map<string, number>();
    const reexports = new Map<string, { module: string; originalName: string; line: number }>();
    const constants = new Map<string, number>();

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Parse use statements: use path::to::module or use path::to::module->alias
            const useMatch = line.match(/^\s*use\s+([a-zA-Z_$][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)(?:\s*->\s*([a-zA-Z_][a-zA-Z0-9_]*))?/);
            if (useMatch) {
                const fullPath = useMatch[1];
                const alias = useMatch[2]; // optional alias after ->
                const pathParts = fullPath.split('::');
                const moduleName = pathParts[pathParts.length - 1];
                
                // Store under both the module name and the alias (if present)
                imports.set(moduleName, fullPath);
                if (alias) {
                    imports.set(alias, fullPath);
                }
            }

            // Parse re-exports: pub use module::original->exported
            const reexportMatch = line.match(/^\s*(?:pub\s+)?use\s+([a-zA-Z_][a-zA-Z0-9_]*)::([a-zA-Z_][a-zA-Z0-9_]*)->([a-zA-Z_][a-zA-Z0-9_]*)/);
            if (reexportMatch) {
                const [, moduleName, originalName, exportedName] = reexportMatch;
                reexports.set(exportedName, { module: moduleName, originalName, line: i });
                if (!imports.has(moduleName)) {
                    imports.set(moduleName, moduleName);
                }
            }

            // Parse procedure definitions
            const procMatch = line.match(/^\s*(?:pub\s+)?proc\s+([a-zA-Z_][a-zA-Z0-9_]*)|^\s*export\.([a-zA-Z_][a-zA-Z0-9_]*)/);
            if (procMatch) {
                const procName = procMatch[1] || procMatch[2];
                if (procName) procedures.set(procName, i);
            }

            // Parse constant definitions
            const constMatch = line.match(/^\s*(?:pub\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=/);
            if (constMatch) {
                constants.set(constMatch[1], i);
            }
        }
    } catch (e) {}

    const result = { imports, procedures, reexports, constants };
    fileCache.set(filePath, result);
    return result;
}

function clearCache(filePath: string) {
    fileCache.delete(filePath);
    moduleCache.clear();
}

/**
 * Find the project root (directory containing asm/ folder) by walking up from current file
 */
function findProjectRoot(fromFile: string): string | null {
    let currentDir = path.dirname(fromFile);
    const maxDepth = 15;
    
    for (let i = 0; i < maxDepth; i++) {
        const asmDir = path.join(currentDir, 'asm');
        if (fs.existsSync(asmDir) && fs.statSync(asmDir).isDirectory()) {
            return currentDir;
        }
        
        const parent = path.dirname(currentDir);
        if (parent === currentDir) break;
        currentDir = parent;
    }
    
    return null;
}

/**
 * Find the Cargo workspace root (directory containing Cargo.toml with [workspace])
 */
function findWorkspaceRoot(fromFile: string): string | null {
    let currentDir = path.dirname(fromFile);
    const maxDepth = 15;
    
    for (let i = 0; i < maxDepth; i++) {
        const cargoToml = path.join(currentDir, 'Cargo.toml');
        if (fs.existsSync(cargoToml)) {
            try {
                const content = fs.readFileSync(cargoToml, 'utf8');
                if (content.includes('[workspace]')) {
                    return currentDir;
                }
            } catch (e) {}
        }
        
        const parent = path.dirname(currentDir);
        if (parent === currentDir) break;
        currentDir = parent;
    }
    
    return null;
}

/**
 * Parse build.rs to extract namespace definitions
 * 
 * Looks for patterns like:
 *   const PROTOCOL_LIB_NAMESPACE: &str = "miden::protocol";
 *   const ASM_PROTOCOL_DIR: &str = "protocol";
 * 
 * Also looks for assemble_library_from_dir calls:
 *   assembler.assemble_library_from_dir(source_dir, "miden::agglayer")?;
 * 
 * Returns a map of namespace -> { crateDir, asmSubDir }
 */
function parseBuildRsNamespaces(workspaceRoot: string): Map<string, { crateDir: string; asmSubDir: string }> {
    if (namespaceCache.has(workspaceRoot)) {
        const cached = namespaceCache.get(workspaceRoot)!;
        // Convert cached format to full format
        const result = new Map<string, { crateDir: string; asmSubDir: string }>();
        for (const [ns, dir] of cached) {
            result.set(ns, { crateDir: '', asmSubDir: dir });
        }
        return result;
    }
    
    const namespaces = new Map<string, { crateDir: string; asmSubDir: string }>();
    const simpleCache = new Map<string, string>();
    
    // Find all build.rs files in the workspace
    const cratesDir = path.join(workspaceRoot, 'crates');
    if (!fs.existsSync(cratesDir)) {
        namespaceCache.set(workspaceRoot, simpleCache);
        return namespaces;
    }
    
    try {
        const crates = fs.readdirSync(cratesDir);
        
        for (const crate of crates) {
            const buildRsPath = path.join(cratesDir, crate, 'build.rs');
            if (!fs.existsSync(buildRsPath)) continue;
            
            try {
                const content = fs.readFileSync(buildRsPath, 'utf8');
                
                // Extract namespace constants: const X_LIB_NAMESPACE: &str = "miden::Y";
                const namespaceRegex = /const\s+(\w+)_LIB_NAMESPACE:\s*&str\s*=\s*"([^"]+)"/g;
                const dirRegex = /const\s+ASM_(\w+)_DIR:\s*&str\s*=\s*"([^"]+)"/g;
                
                const foundNamespaces: { [key: string]: string } = {};
                const foundDirs: { [key: string]: string } = {};
                
                let match;
                while ((match = namespaceRegex.exec(content)) !== null) {
                    // PROTOCOL_LIB_NAMESPACE -> PROTOCOL, miden::protocol
                    foundNamespaces[match[1]] = match[2];
                }
                
                while ((match = dirRegex.exec(content)) !== null) {
                    // ASM_PROTOCOL_DIR -> PROTOCOL, protocol
                    foundDirs[match[1]] = match[2];
                }
                
                // Match them up via constant names
                for (const [key, namespace] of Object.entries(foundNamespaces)) {
                    const asmDir = foundDirs[key];
                    if (asmDir) {
                        namespaces.set(namespace, {
                            crateDir: path.join(cratesDir, crate),
                            asmSubDir: asmDir
                        });
                        
                        // Extract just the last part of namespace for simple cache
                        // "miden::protocol" -> "protocol"
                        const parts = namespace.split('::');
                        if (parts.length >= 2) {
                            simpleCache.set(parts[parts.length - 1], asmDir);
                        }
                    }
                }
                
                // Also look for assemble_library_from_dir calls:
                // assembler.assemble_library_from_dir(source_dir, "miden::agglayer")?;
                // These often have the directory defined as a variable, so we need to trace it
                const assembleRegex = /assemble_library_from_dir\s*\([^,]+,\s*"([^"]+)"\)/g;
                while ((match = assembleRegex.exec(content)) !== null) {
                    const namespace = match[1]; // e.g., "miden::agglayer"
                    if (!namespaces.has(namespace)) {
                        const nsParts = namespace.split('::');
                        const nsLast = nsParts[nsParts.length - 1];
                        
                        // Try to find ASM_*_DIR that's used with this namespace
                        // Look for: source_dir.join(ASM_X_DIR) anywhere in the content
                        let foundDir: string | null = null;
                        for (const [dirKey, dirVal] of Object.entries(foundDirs)) {
                            // Skip NOTE_SCRIPTS and ACCOUNT_COMPONENTS dirs - those are for executables, not libraries
                            if (dirKey.includes('NOTE_SCRIPT') || dirKey.includes('ACCOUNT_COMPONENT')) {
                                continue;
                            }
                            
                            // Check if this dir constant is mentioned before the assemble call
                            const joinPattern = new RegExp(`ASM_${dirKey}_DIR`);
                            if (joinPattern.test(content)) {
                                // If only one non-script/component dir exists, use it
                                if (!foundDir) {
                                    foundDir = dirVal;
                                }
                            }
                        }
                        
                        if (foundDir) {
                            namespaces.set(namespace, {
                                crateDir: path.join(cratesDir, crate),
                                asmSubDir: foundDir
                            });
                            simpleCache.set(nsLast, foundDir);
                        } else {
                            // If no specific dir found, just use the namespace name as the dir
                            // and let the resolution logic search all subdirectories
                            namespaces.set(namespace, {
                                crateDir: path.join(cratesDir, crate),
                                asmSubDir: nsLast
                            });
                            simpleCache.set(nsLast, nsLast);
                        }
                    }
                }
            } catch (e) {}
        }
    } catch (e) {}
    
    namespaceCache.set(workspaceRoot, simpleCache);
    return namespaces;
}

/**
 * Find the ASM directory for a namespace by parsing build.rs files
 */
function findNamespaceAsmDir(workspaceRoot: string, namespace: string): { crateDir: string; asmSubDir: string } | null {
    const namespaces = parseBuildRsNamespaces(workspaceRoot);
    
    // Try full namespace first (e.g., "miden::protocol")
    if (namespaces.has(namespace)) {
        return namespaces.get(namespace)!;
    }
    
    // Try with miden:: prefix
    const withPrefix = `miden::${namespace}`;
    if (namespaces.has(withPrefix)) {
        return namespaces.get(withPrefix)!;
    }
    
    return null;
}

/**
 * Try to find a module file - checks both direct file and mod.masm in directory
 * e.g., for "faucets", tries: faucets.masm, faucets/mod.masm
 */
function tryModulePaths(basePath: string, subPath: string): string | null {
    // Try direct file path first
    const directPath = path.join(basePath, subPath);
    if (fs.existsSync(directPath)) {
        return directPath;
    }
    
    // Try as directory with mod.masm
    const modPath = path.join(basePath, subPath.replace(/\.masm$/, ''), 'mod.masm');
    if (fs.existsSync(modPath)) {
        return modPath;
    }
    
    return null;
}

/**
 * Search for a file in cargo cache for a specific crate
 */
function searchCargoCache(crateName: string, subPath: string): string | null {
    const cargoHome = process.env.CARGO_HOME || path.join(process.env.HOME || '', '.cargo');
    const registrySrc = path.join(cargoHome, 'registry', 'src');
    
    try {
        if (!fs.existsSync(registrySrc)) return null;
        
        const indexDirs = fs.readdirSync(registrySrc);
        
        for (const indexDir of indexDirs) {
            const indexPath = path.join(registrySrc, indexDir);
            let entries: string[];
            try {
                entries = fs.readdirSync(indexPath).filter(e => e.startsWith(crateName + '-'));
            } catch { continue; }
            
            if (entries.length > 0) {
                // Sort to get the latest version
                entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
                
                for (const version of entries) {
                    const asmDir = path.join(indexPath, version, 'asm');
                    const result = tryModulePaths(asmDir, subPath);
                    if (result) return result;
                }
            }
        }
    } catch (e) {}
    
    return null;
}

/**
 * Resolve an import path to a file path based on the import semantics
 * 
 * Resolution rules (based on https://docs.miden.xyz/next/miden-vm/user_docs/assembly/code_organization):
 * 
 * 1. miden::X::Y::Z        → Parse build.rs for namespace definitions, then:
 *    - If namespace defined in build.rs → use that crate's asm/ directory
 *    - If miden::core::* → External miden-core-lib in cargo cache
 *    - Otherwise → try local asm/X/, then cargo cache
 * 2. std::X::Y             → External miden-stdlib in cargo cache
 * 3. $alias::module        → Relative to current file's lib/ directory
 * 4. bare_module           → Same directory as current file
 */
function resolveModulePath(currentFile: string, moduleName: string, importPath: string): string | null {
    const cacheKey = `${currentFile}:${importPath}`;
    if (moduleCache.has(cacheKey)) {
        return moduleCache.get(cacheKey) || null;
    }
    
    const currentDir = path.dirname(currentFile);
    const parts = importPath.split('::');
    let result: string | null = null;
    
    // Rule 1: miden::namespace::path
    if (parts[0] === 'miden' && parts.length >= 3) {
        const namespace = parts[1];
        const subParts = parts.slice(2);
        const fileName = subParts[subParts.length - 1] + '.masm';
        const subDir = subParts.slice(0, -1).join('/');
        const subPath = subDir ? `${subDir}/${fileName}` : fileName;
        
        // Known external namespaces that ONLY resolve from cargo cache
        const externalNamespaces: { [key: string]: string } = {
            'core': 'miden-core-lib',
        };
        
        if (externalNamespaces[namespace]) {
            // Known external namespace: only search cargo cache
            result = searchCargoCache(externalNamespaces[namespace], subPath);
        } else {
            // Try to find namespace definition from build.rs
            const workspaceRoot = findWorkspaceRoot(currentFile);
            if (workspaceRoot) {
                const fullNamespace = `miden::${namespace}`;
                const nsInfo = findNamespaceAsmDir(workspaceRoot, fullNamespace);
                
                if (nsInfo) {
                    // Found in build.rs - use the exact crate and directory
                    const baseDir = path.join(nsInfo.crateDir, 'asm', nsInfo.asmSubDir);
                    result = tryModulePaths(baseDir, subPath);
                    
                    // If not found at expected path, search all subdirectories under asm/
                    if (!result) {
                        const asmDir = path.join(nsInfo.crateDir, 'asm');
                        if (fs.existsSync(asmDir)) {
                            try {
                                const subdirs = fs.readdirSync(asmDir);
                                for (const subdir of subdirs) {
                                    const subdirPath = path.join(asmDir, subdir);
                                    if (fs.statSync(subdirPath).isDirectory()) {
                                        result = tryModulePaths(subdirPath, subPath);
                                        if (result) break;
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                }
                
                // If not found via build.rs, search all crates
                if (!result) {
                    const cratesDir = path.join(workspaceRoot, 'crates');
                    if (fs.existsSync(cratesDir)) {
                        try {
                            const crates = fs.readdirSync(cratesDir);
                            for (const crate of crates) {
                                // First try direct namespace match
                                const namespaceDir = path.join(cratesDir, crate, 'asm', namespace);
                                result = tryModulePaths(namespaceDir, subPath);
                                if (result) break;
                                
                                // Then search all subdirectories
                                const asmDir = path.join(cratesDir, crate, 'asm');
                                if (fs.existsSync(asmDir)) {
                                    const subdirs = fs.readdirSync(asmDir);
                                    for (const subdir of subdirs) {
                                        const subdirPath = path.join(asmDir, subdir);
                                        if (fs.statSync(subdirPath).isDirectory()) {
                                            result = tryModulePaths(subdirPath, subPath);
                                            if (result) break;
                                        }
                                    }
                                    if (result) break;
                                }
                            }
                        } catch (e) {}
                    }
                }
            }
            
            // Also try local project root
            if (!result) {
                const projectRoot = findProjectRoot(currentFile);
                if (projectRoot) {
                    const localPath = path.join(projectRoot, 'asm', namespace, subPath);
                    if (fs.existsSync(localPath)) {
                        result = localPath;
                    }
                }
            }
            
            // Fallback to cargo cache for unknown namespaces
            if (!result) {
                result = searchCargoCache(`miden-${namespace}-lib`, subPath) ||
                         searchCargoCache(`miden-${namespace}`, subPath);
            }
        }
    }
    // Rule 2: std::X::Y (standard library)
    else if (parts[0] === 'std' && parts.length >= 2) {
        const subParts = parts.slice(1);
        const fileName = subParts[subParts.length - 1] + '.masm';
        const subDir = subParts.slice(0, -1).join('/');
        const subPath = subDir ? `${subDir}/${fileName}` : fileName;
        
        result = searchCargoCache('miden-stdlib', subPath);
    }
    // Rule 4: $alias::module (kernel or other build-time alias)
    else if (parts[0].startsWith('$')) {
        const aliasName = parts[0].substring(1); // Remove $
        const subParts = parts.slice(1);
        const fileName = subParts[subParts.length - 1] + '.masm';
        
        // For $kernel, the lib/ directory relative to current file is the kernel library
        // Search in lib/ directories walking up from current file
        let searchDir = currentDir;
        const maxDepth = 5;
        
        for (let i = 0; i < maxDepth; i++) {
            const libDir = path.join(searchDir, 'lib');
            if (fs.existsSync(libDir)) {
                const targetPath = path.join(libDir, fileName);
                if (fs.existsSync(targetPath)) {
                    result = targetPath;
                    break;
                }
            }
            
            // Also check shared_modules (copied to lib/ at build time)
            const sharedDir = path.join(searchDir, '..', 'shared_modules');
            if (fs.existsSync(sharedDir)) {
                const targetPath = path.join(sharedDir, fileName);
                if (fs.existsSync(targetPath)) {
                    result = targetPath;
                    break;
                }
            }
            
            const parent = path.dirname(searchDir);
            if (parent === searchDir) break;
            searchDir = parent;
        }
    }
    // Rule 5: Bare module name (relative import)
    else if (parts.length === 1) {
        const fileName = moduleName + '.masm';
        
        // Search relative to current file
        const searchPaths = [
            path.join(currentDir, fileName),
            path.join(currentDir, 'lib', fileName),
            path.join(currentDir, '..', fileName),
            path.join(currentDir, '..', 'lib', fileName),
        ];
        
        for (const searchPath of searchPaths) {
            if (fs.existsSync(searchPath)) {
                result = path.normalize(searchPath);
                break;
            }
        }
    }
    
    moduleCache.set(cacheKey, result);
    return result;
}

/**
 * Find a constant definition in a file
 */
function findConstantInFile(filePath: string, constantName: string): vscode.Location | null {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const constRegex = new RegExp(`^\\s*(?:pub\\s+)?const\\s+${constantName}\\s*=`);
            if (constRegex.test(lines[i])) {
                return new vscode.Location(
                    vscode.Uri.file(filePath),
                    new vscode.Position(i, lines[i].indexOf(constantName))
                );
            }
        }
    } catch (e) {}
    return null;
}

/**
 * Find a procedure definition in a file
 */
function findProcedureInFile(filePath: string, procedureName: string): vscode.Location | null {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const procRegex = new RegExp(`^\\s*(?:pub\\s+)?proc\\s+${procedureName}\\b|^\\s*export\\.${procedureName}\\b`);
            if (procRegex.test(lines[i])) {
                return new vscode.Location(
                    vscode.Uri.file(filePath),
                    new vscode.Position(i, lines[i].indexOf(procedureName))
                );
            }
        }

        // Check for re-export
        const { reexports } = parseFile(filePath);
        const reexport = reexports.get(procedureName);
        if (reexport) {
            return new vscode.Location(
                vscode.Uri.file(filePath),
                new vscode.Position(reexport.line, lines[reexport.line].indexOf(procedureName))
            );
        }
    } catch (e) {}
    return null;
}

/**
 * Find the ultimate source of a procedure (following re-exports)
 */
function findProcedureSource(filePath: string, procedureName: string, visited: Set<string> = new Set()): vscode.Location | null {
    const key = `${filePath}:${procedureName}`;
    if (visited.has(key)) return null;
    visited.add(key);

    const { reexports, imports } = parseFile(filePath);
    const reexport = reexports.get(procedureName);
    
    if (reexport) {
        const importPath = imports.get(reexport.module) || reexport.module;
        const targetFile = resolveModulePath(filePath, reexport.module, importPath);
        if (targetFile) {
            const sourceLocation = findProcedureSource(targetFile, reexport.originalName, visited);
            if (sourceLocation) return sourceLocation;
            
            // Try direct lookup
            try {
                const content = fs.readFileSync(targetFile, 'utf8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const procRegex = new RegExp(`^\\s*(?:pub\\s+)?proc\\s+${reexport.originalName}\\b`);
                    if (procRegex.test(lines[i])) {
                        return new vscode.Location(
                            vscode.Uri.file(targetFile),
                            new vscode.Position(i, lines[i].indexOf(reexport.originalName))
                        );
                    }
                }
            } catch (e) {}
        }
    }

    // Look for direct definition
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const procRegex = new RegExp(`^\\s*(?:pub\\s+)?proc\\s+${procedureName}\\b`);
            if (procRegex.test(lines[i])) {
                return new vscode.Location(
                    vscode.Uri.file(filePath),
                    new vscode.Position(i, lines[i].indexOf(procedureName))
                );
            }
        }
    } catch (e) {}

    return null;
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
        
        if (!wordRange) return null;

        const word = document.getText(wordRange);
        const beforeWord = line.substring(0, wordRange.start.character);
        const linePrefix = line.substring(0, wordRange.end.character);

        // Skip comments and strings
        if (beforeWord.includes('#')) return null;
        if ((beforeWord.match(/"/g) || []).length % 2 === 1) return null;

        const { imports } = parseFile(document.uri.fsPath);

        // Pattern 1: use statement - navigate to module or constant
        // Handles: use path::to::module, use path::to::module->alias, use path::CONSTANT
        const useMatch = line.match(/^\s*use\s+([a-zA-Z_$][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)(?:\s*->\s*([a-zA-Z_][a-zA-Z0-9_]*))?/);
        if (useMatch) {
            const fullPath = useMatch[1];
            const alias = useMatch[2];
            const pathParts = fullPath.split('::');
            
            // If clicking on the alias, navigate to the module
            if (alias && word === alias) {
                const moduleName = pathParts[pathParts.length - 1];
                const targetFile = resolveModulePath(document.uri.fsPath, moduleName, fullPath);
                if (targetFile) {
                    return new vscode.Location(vscode.Uri.file(targetFile), new vscode.Position(0, 0));
                }
            }
            
            if (pathParts.includes(word)) {
                // If clicking on CONSTANT_NAME (all caps), find the constant
                if (/^[A-Z_][A-Z0-9_]*$/.test(word) && word === pathParts[pathParts.length - 1]) {
                    // Find the module (second to last part or first part after prefix)
                    const moduleName = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : pathParts[0];
                    const modulePath = pathParts.slice(0, -1).join('::');
                    const targetFile = resolveModulePath(document.uri.fsPath, moduleName, modulePath);
                    if (targetFile) {
                        const location = findConstantInFile(targetFile, word);
                        if (location) return location;
                    }
                }
                
                // Navigate to module file
                const moduleName = pathParts[pathParts.length - 1];
                const targetFile = resolveModulePath(document.uri.fsPath, moduleName, fullPath);
                if (targetFile) {
                    return new vscode.Location(vscode.Uri.file(targetFile), new vscode.Position(0, 0));
                }
            }
        }

        // Pattern 2: exec.module::procedure or call.module::procedure
        const execMatch = linePrefix.match(/(?:exec|call)\.([a-zA-Z_][a-zA-Z0-9_]*)::([a-zA-Z_][a-zA-Z0-9_]*)$/);
        if (execMatch) {
            const moduleName = execMatch[1];
            const procedureName = execMatch[2];
            const importPath = imports.get(moduleName) || moduleName;
            const targetFile = resolveModulePath(document.uri.fsPath, moduleName, importPath);
            
            if (targetFile) {
                if (word === moduleName) {
                    return new vscode.Location(vscode.Uri.file(targetFile), new vscode.Position(0, 0));
                } else if (word === procedureName) {
                    const sourceLocation = findProcedureSource(targetFile, procedureName);
                    if (sourceLocation) return sourceLocation;
                    const location = findProcedureInFile(targetFile, procedureName);
                    if (location) return location;
                }
            }
        }
        
        // Pattern 2b: call.local_procedure (no module prefix)
        const callLocalMatch = linePrefix.match(/call\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
        if (callLocalMatch && !linePrefix.includes('::')) {
            const procedureName = callLocalMatch[1];
            // Search in current file first
            const localLocation = findProcedureInFile(document.uri.fsPath, procedureName);
            if (localLocation) return localLocation;
            
            // Then search in imported modules
            for (const [moduleName, importPath] of imports) {
                const targetFile = resolveModulePath(document.uri.fsPath, moduleName, importPath);
                if (targetFile) {
                    const location = findProcedureInFile(targetFile, procedureName);
                    if (location) return location;
                }
            }
        }

        // Pattern 3: Local procedure reference
        const currentFileLocation = findProcedureInFile(document.uri.fsPath, word);
        if (currentFileLocation) return currentFileLocation;

        // Pattern 4: Search imported modules
        for (const [moduleName, importPath] of imports) {
            const targetFile = resolveModulePath(document.uri.fsPath, moduleName, importPath);
            if (targetFile) {
                const location = findProcedureInFile(targetFile, word);
                if (location) return location;
            }
        }

        return null;
    }
}

/**
 * Hover Provider for MASM files
 */
class MasmHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const line = document.lineAt(position.line).text;
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        
        if (!wordRange) return null;

        const beforeWord = line.substring(0, wordRange.start.character);
        if (beforeWord.includes('#')) return null;
        if ((beforeWord.match(/"/g) || []).length % 2 === 1) return null;

        const word = document.getText(wordRange);
        const { imports } = parseFile(document.uri.fsPath);

        const execMatch = line.match(/(?:exec|call)\.([a-zA-Z_][a-zA-Z0-9_]*)::([a-zA-Z_][a-zA-Z0-9_]*)/);
        if (execMatch && word === execMatch[2]) {
            const moduleName = execMatch[1];
            const importPath = imports.get(moduleName) || moduleName;
            const targetFile = resolveModulePath(document.uri.fsPath, moduleName, importPath);
            
            if (targetFile) {
                const doc = getProcedureDocumentation(targetFile, word);
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
            const procRegex = new RegExp(`^\\s*(?:pub\\s+)?proc\\s+${procedureName}\\b`);
            
            if (procRegex.test(lines[i])) {
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
    } catch (e) {}
    return null;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Miden Assembly extension activated');

    const definitionProvider = vscode.languages.registerDefinitionProvider(
        { language: 'masm', scheme: 'file' },
        new MasmDefinitionProvider()
    );

    const hoverProvider = vscode.languages.registerHoverProvider(
        { language: 'masm', scheme: 'file' },
        new MasmHoverProvider()
    );

    const fileWatcher = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === 'masm') {
            clearCache(e.document.uri.fsPath);
        }
    });

    context.subscriptions.push(definitionProvider, hoverProvider, fileWatcher);
}

export function deactivate() {
    fileCache.clear();
    moduleCache.clear();
}
