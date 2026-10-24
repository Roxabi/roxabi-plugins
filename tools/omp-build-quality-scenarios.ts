import { extname } from 'node:path'
import { parse } from '@babel/parser'
import {
  type File,
  isArrowFunctionExpression,
  isAssignmentExpression,
  isCallExpression,
  isExportAllDeclaration,
  isExportDefaultDeclaration,
  isExportNamedDeclaration,
  isExportSpecifier,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isImportDefaultSpecifier,
  isImportNamespaceSpecifier,
  isImportSpecifier,
  isMemberExpression,
  isObjectPattern,
  isObjectProperty,
  isStringLiteral,
  isVariableDeclarator,
  type Node,
  traverseFast,
} from '@babel/types'

type Bindings = { tests: Set<string>; assertions: Set<string> }

const testModules: Record<string, true> = { vitest: true, 'node:test': true, 'bun:test': true }
const assertionModules: Record<string, true> = { 'node:assert': true, 'node:assert/strict': true }
const javascriptExtensions: Record<string, true> = {
  '.ts': true,
  '.tsx': true,
  '.mts': true,
  '.cts': true,
  '.js': true,
  '.jsx': true,
  '.mjs': true,
  '.cjs': true,
}

function moduleName(node: Node): string | null {
  if (!isStringLiteral(node)) return null
  return node.value
}

function isModuleExports(node: Node): boolean {
  if (!isMemberExpression(node) || !isIdentifier(node.object) || node.object.name !== 'module') return false
  if (isIdentifier(node.property)) return node.property.name === 'exports'
  return isStringLiteral(node.property) && node.property.value === 'exports'
}

function isCommonJsExport(node: Node): boolean {
  if (!isAssignmentExpression(node) || !isMemberExpression(node.left)) return false
  return (
    isModuleExports(node.left) ||
    isModuleExports(node.left.object) ||
    (isIdentifier(node.left.object) && node.left.object.name === 'exports')
  )
}

function isRuntimeNamedExport(node: Node): boolean {
  if (!isExportNamedDeclaration(node) || node.exportKind === 'type') return false
  return (
    node.declaration !== null ||
    node.specifiers.some((specifier) => isExportSpecifier(specifier) && specifier.exportKind !== 'type')
  )
}

function isRuntimeExport(node: Node): boolean {
  if (isExportDefaultDeclaration(node) || isCommonJsExport(node)) return true
  if (isExportAllDeclaration(node)) return node.exportKind !== 'type'
  return isRuntimeNamedExport(node)
}

function hasRuntimeExport(file: File): boolean {
  let found = false
  traverseFast(file.program, (node) => {
    if (isRuntimeExport(node)) found = true
  })
  return found
}

function importBindingName(specifier: Node): string | null {
  if (!isImportSpecifier(specifier) && !isImportDefaultSpecifier(specifier) && !isImportNamespaceSpecifier(specifier))
    return null
  return isIdentifier(specifier.local) ? specifier.local.name : null
}

function addImportSpecifier(module: string, specifier: Node, bindings: Bindings): void {
  if (module in testModules && isImportSpecifier(specifier) && isIdentifier(specifier.imported)) {
    if (specifier.imported.name === 'it' || specifier.imported.name === 'test') bindings.tests.add(specifier.local.name)
    if (specifier.imported.name === 'expect') bindings.assertions.add(specifier.local.name)
  }
  const assertion = module in assertionModules ? importBindingName(specifier) : null
  if (assertion !== null) bindings.assertions.add(assertion)
}

function addImportDeclaration(node: Node, bindings: Bindings): void {
  if (!isImportDeclaration(node)) return
  const module = moduleName(node.source)
  if (module === null) return
  for (const specifier of node.specifiers) addImportSpecifier(module, specifier, bindings)
}

function addImportBindings(file: File, bindings: Bindings): void {
  traverseFast(file.program, (node) => {
    if (isImportDeclaration(node)) addImportDeclaration(node, bindings)
  })
}

function requireModule(node: Node): string | null {
  if (!isCallExpression(node) || !isIdentifier(node.callee) || node.callee.name !== 'require') return null
  const [argument] = node.arguments
  return argument === undefined ? null : moduleName(argument)
}

function addRequiredTestBindings(id: Node, bindings: Bindings): void {
  if (!isObjectPattern(id)) return
  for (const property of id.properties) {
    if (!isObjectProperty(property) || !isIdentifier(property.key) || !isIdentifier(property.value)) continue
    if (property.key.name === 'it' || property.key.name === 'test') bindings.tests.add(property.value.name)
    if (property.key.name === 'expect') bindings.assertions.add(property.value.name)
  }
}

function addRequireAssertions(id: Node, bindings: Bindings): void {
  if (isIdentifier(id)) {
    bindings.assertions.add(id.name)
    return
  }
  if (!isObjectPattern(id)) return
  for (const property of id.properties) {
    if (isObjectProperty(property) && isIdentifier(property.value)) bindings.assertions.add(property.value.name)
  }
}

function addRequireBinding(module: string, id: Node, bindings: Bindings): void {
  if (module in assertionModules) addRequireAssertions(id, bindings)
  if (module in testModules) addRequiredTestBindings(id, bindings)
}

function addRequireDeclaration(node: Node, bindings: Bindings): void {
  if (!isVariableDeclarator(node) || node.init === null || node.init === undefined) return
  const module = requireModule(node.init)
  if (module !== null) addRequireBinding(module, node.id, bindings)
}

function addRequireBindings(file: File, bindings: Bindings): void {
  traverseFast(file.program, (node) => {
    if (isVariableDeclarator(node)) addRequireDeclaration(node, bindings)
  })
}

function calleeName(node: Node): string | null {
  let current = node
  while (true) {
    if (isCallExpression(current)) {
      current = current.callee
      continue
    }
    if (isMemberExpression(current)) {
      current = current.object
      continue
    }
    return isIdentifier(current) ? current.name : null
  }
}

function hasAssertion(node: Node, assertions: Set<string>): boolean {
  let found = false
  traverseFast(node, (child) => {
    if (isCallExpression(child) && assertions.has(calleeName(child.callee) ?? '')) found = true
  })
  return found
}

function isTestCall(node: Node, bindings: Bindings): boolean {
  if (!isCallExpression(node) || !bindings.tests.has(calleeName(node.callee) ?? '')) return false
  return node.arguments.some((argument) => {
    if (!isArrowFunctionExpression(argument) && !isFunctionExpression(argument)) return false
    return hasAssertion(argument.body, bindings.assertions)
  })
}

function isPythonScenario(source: string): boolean {
  if (source.includes("'''") || source.includes('"""')) return false
  return (
    /^\s*(?:async\s+)?def test_[A-Za-z_]\w*\s*\(/m.test(source) &&
    /^\s*(?:assert\b|self\.assert[A-Za-z_]\w*\s*\()/m.test(source)
  )
}

export function isScenario(path: string, source: string): boolean {
  const extension = extname(path)
  const pythonShebang = /^#!.*\bpython(?:3)?\b/.test(source)
  const shellShebang = /^#!.*\b(?:bash|sh)\b/.test(source)
  if (extension === '.py' || pythonShebang) return isPythonScenario(source)
  if (extension === '.sh' || extension === '.bash' || shellShebang) {
    return /^\s*(?:assert|expect)_[A-Za-z_]\w*\b(?!\s*\(\s*\)\s*\{)/m.test(source)
  }
  if (!(extension in javascriptExtensions)) return false
  try {
    const file = parse(source, {
      sourceType: extension === '.cjs' ? 'commonjs' : 'unambiguous',
      plugins: extension === '.tsx' || extension === '.jsx' ? ['typescript', 'jsx'] : ['typescript'],
    })
    if (hasRuntimeExport(file)) return false
    const bindings: Bindings = { tests: new Set(), assertions: new Set() }
    addImportBindings(file, bindings)
    addRequireBindings(file, bindings)
    if (bindings.tests.size === 0 || bindings.assertions.size === 0) return false
    let found = false
    traverseFast(file.program, (node) => {
      if (isTestCall(node, bindings)) found = true
    })
    return found
  } catch {
    return false
  }
}
