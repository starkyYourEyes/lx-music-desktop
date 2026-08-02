const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')
const typescript = require('typescript')
const typescriptEslintParser = require('@typescript-eslint/parser')
const vueParser = require('vue-eslint-parser')
const { createTestStorageRoot } = require('./helpers/test-storage-root.js')
const {
  assertFixturePathsOwned,
  createPhase4DurableFixture,
  seedDurableFiles,
} = require('./helpers/phase4-durable-fixture.js')

const root = path.resolve(__dirname, '../..')
const sourceExtensions = /\.(?:[cm]?[jt]sx?|vue|sql)$/i
const workerBoundaryFiles = [
  'src/main/worker/dbService/modules/index.ts',
  'src/main/worker/dbService/index.ts',
  'src/main/types/db_service.d.ts',
  'src/main/types/worker.d.ts',
]
const workerBoundary = new Set(workerBoundaryFiles)
const unscopedCacheNames = new Set([
  'getMusicUrl',
  'musicUrlSave',
  'musicUrlRemove',
  'musicInfoOtherSourceAdd',
  'musicInfoOtherSourceRemove',
])
const legacyTables = new Set(['lyric', 'music_url', 'music_info_other_source'])
const genericCacheDatabaseApiName = ['get', 'DB'].join('')
const rawLyricOwnerName = ['r', 'aw'].join('')
const editedLyricSqlOwner = 'src/main/worker/dbService/modules/lyric/edited/statements.ts'

const normalizePath = value => value.replaceAll('\\', '/')
const isContained = (basePath, candidate) => {
  const relative = path.relative(basePath, candidate)
  return relative == '' || (relative != '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const readOwnershipInventory = (baseRoot, rootSpecs) => {
  const resolvedBase = fs.realpathSync(baseRoot)
  const records = new Map()
  const visit = (candidate, kind) => {
    const stats = fs.lstatSync(candidate)
    if (stats.isSymbolicLink()) throw new Error(`Ownership scan root contains a link: ${candidate}`)
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
        visit(path.join(candidate, entry.name), kind)
      }
      return
    }
    if (!stats.isFile() || !sourceExtensions.test(candidate)) return
    const file = normalizePath(path.relative(resolvedBase, candidate))
    const record = records.get(file) ?? { file, text: fs.readFileSync(candidate, 'utf8'), kinds: new Set() }
    record.kinds.add(kind)
    records.set(file, record)
  }
  for (const spec of rootSpecs) {
    const candidate = path.resolve(resolvedBase, spec.path)
    if (!isContained(resolvedBase, candidate)) throw new Error(`Ownership scan root escaped: ${spec.path}`)
    visit(candidate, spec.kind)
  }
  return [...records.values()]
    .map(({ file, text, kinds }) => ({ file, text, kinds: [...kinds].sort() }))
    .sort((left, right) => left.file.localeCompare(right.file, 'en'))
}

const ownershipRootSpecs = [
  { kind: 'source', path: 'src' },
  { kind: 'test', path: 'build-config' },
  { kind: 'schema', path: 'src/main/worker/dbService/tables.ts' },
  { kind: 'schema', path: 'src/main/worker/dbService/migrations' },
  { kind: 'schema', path: 'src/main/worker/dbService/modules/lyric/edited/statements.ts' },
  { kind: 'schema', path: 'src/main/migration/cache' },
]
const ownershipInventory = readOwnershipInventory(root, ownershipRootSpecs)

const unwrapExpression = node => {
  while (typescript.isParenthesizedExpression(node) || typescript.isAsExpression(node) ||
    typescript.isTypeAssertionExpression(node) || typescript.isNonNullExpression(node) ||
    typescript.isSatisfiesExpression(node)) node = node.expression
  return node
}

const collectStaticBindings = sourceFile => {
  const bindings = new Map()
  const bindingScope = declaration => {
    for (let node = declaration.parent; node != null; node = node.parent) {
      if (typescript.isSourceFile(node) || typescript.isBlock(node) || typescript.isModuleBlock(node) ||
        typescript.isCaseBlock(node) || typescript.isForStatement(node) || typescript.isForInStatement(node) ||
        typescript.isForOfStatement(node)) return node
    }
    return sourceFile
  }
  const visit = node => {
    if (typescript.isVariableDeclaration(node) && node.initializer && typescript.isIdentifier(node.name) &&
      typescript.isVariableDeclarationList(node.parent) && (node.parent.flags & typescript.NodeFlags.Const) != 0) {
      const candidates = bindings.get(node.name.text) ?? []
      candidates.push({ declaration: node, initializer: node.initializer, scope: bindingScope(node) })
      bindings.set(node.name.text, candidates)
    }
    typescript.forEachChild(node, visit)
  }
  visit(sourceFile)
  return bindings
}

const isDescendantOf = (node, ancestor) => {
  for (let current = node; current != null; current = current.parent) {
    if (current == ancestor) return true
  }
  return false
}

const staticBindingForIdentifier = (identifier, bindings) => {
  let selected = null
  for (const candidate of bindings.get(identifier.text) ?? []) {
    if (!isDescendantOf(identifier, candidate.scope)) continue
    const span = candidate.scope.end - candidate.scope.pos
    const selectedSpan = selected == null ? Number.POSITIVE_INFINITY : selected.scope.end - selected.scope.pos
    if (span < selectedSpan || (span == selectedSpan && candidate.declaration.pos > selected.declaration.pos)) {
      selected = candidate
    }
  }
  return selected
}

const staticPropertyName = (name, bindings, seen) => {
  if (typescript.isIdentifier(name) || typescript.isStringLiteralLike(name) || typescript.isNumericLiteral(name)) {
    return name.text
  }
  return typescript.isComputedPropertyName(name) ? staticString(name.expression, bindings, seen) : null
}

const staticString = (input, bindings = new Map(), seen = new Set()) => {
  const node = unwrapExpression(input)
  if (typescript.isStringLiteralLike(node)) return node.text
  if (typescript.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (typescript.isIdentifier(node)) {
    const binding = staticBindingForIdentifier(node, bindings)
    if (binding == null || seen.has(binding.declaration)) return null
    return staticString(binding.initializer, bindings, new Set(seen).add(binding.declaration))
  }
  if (typescript.isBinaryExpression(node) && node.operatorToken.kind == typescript.SyntaxKind.PlusToken) {
    const left = staticString(node.left, bindings, seen)
    const right = staticString(node.right, bindings, seen)
    return left == null || right == null ? null : left + right
  }
  if (typescript.isTemplateExpression(node)) {
    let value = node.head.text
    for (const span of node.templateSpans) {
      const expression = staticString(span.expression, bindings, seen)
      if (expression == null) return null
      value += expression + span.literal.text
    }
    return value
  }
  if (typescript.isPropertyAccessExpression(node) || typescript.isElementAccessExpression(node)) {
    const property = typescript.isPropertyAccessExpression(node)
      ? node.name.text
      : staticString(node.argumentExpression, bindings, seen)
    if (property == null) return null
    let owner = unwrapExpression(node.expression)
    if (typescript.isIdentifier(owner)) {
      const binding = staticBindingForIdentifier(owner, bindings)
      if (binding == null || seen.has(binding.declaration)) return null
      owner = unwrapExpression(binding.initializer)
      seen = new Set(seen).add(binding.declaration)
    }
    if (!typescript.isObjectLiteralExpression(owner)) return null
    for (const candidate of owner.properties) {
      if (!('name' in candidate) || staticPropertyName(candidate.name, bindings, seen) != property) continue
      if (typescript.isPropertyAssignment(candidate)) return staticString(candidate.initializer, bindings, seen)
      if (typescript.isShorthandPropertyAssignment(candidate)) return staticString(candidate.name, bindings, seen)
    }
  }
  return null
}

const staticMemberName = (input, bindings, seen = new Set()) => {
  const node = unwrapExpression(input)
  if (typescript.isIdentifier(node)) {
    const binding = staticBindingForIdentifier(node, bindings)
    if (binding == null || seen.has(binding.declaration)) return null
    return staticMemberName(binding.initializer, bindings, new Set(seen).add(binding.declaration))
  }
  if (typescript.isPropertyAccessExpression(node)) return node.name.text
  if (typescript.isElementAccessExpression(node)) return staticString(node.argumentExpression, bindings, seen)
  return null
}

const staticChannelCandidates = (input, bindings) => new Set([
  staticString(input, bindings),
  staticMemberName(input, bindings),
].filter(value => value != null))

const moduleDescriptor = source => {
  if (source == 'path' || source == 'node:path') return 'module:path'
  if (source == 'os' || source == 'node:os') return 'module:os'
  return `module:${source}`
}

const descriptorsForExpression = (input, aliases, bindings = new Map()) => {
  const node = unwrapExpression(input)
  if (typescript.isIdentifier(node)) return new Set(aliases.get(node.text) ?? [node.text])
  if (typescript.isPropertyAccessExpression(node) || typescript.isElementAccessExpression(node)) {
    const property = typescript.isPropertyAccessExpression(node)
      ? node.name.text
      : staticString(node.argumentExpression, bindings)
    if (property == null) return new Set()
    return new Set([...descriptorsForExpression(node.expression, aliases, bindings)].map(base => `${base}.${property}`))
  }
  if (typescript.isCallExpression(node) && typescript.isIdentifier(node.expression) &&
    node.expression.text == 'require' && node.arguments.length == 1) {
    const source = staticString(node.arguments[0], bindings)
    return source == null ? new Set() : new Set([moduleDescriptor(source)])
  }
  return new Set()
}

const collectAliases = (sourceFile, bindings) => {
  const aliases = new Map()
  const setAlias = (name, descriptors) => {
    if (descriptors.size == 0) return false
    const current = aliases.get(name) ?? new Set()
    const next = new Set([...current, ...descriptors])
    if (next.size == current.size) return false
    aliases.set(name, next)
    return true
  }
  const bind = (binding, descriptors) => {
    if (typescript.isIdentifier(binding)) return setAlias(binding.text, descriptors)
    if (!typescript.isObjectBindingPattern(binding)) return false
    let changed = false
    for (const element of binding.elements) {
      const property = element.propertyName == null
        ? (typescript.isIdentifier(element.name) ? element.name.text : null)
        : staticString(element.propertyName, bindings)
      if (property == null) continue
      const nested = new Set([...descriptors].map(base => `${base}.${property}`))
      changed = bind(element.name, nested) || changed
    }
    return changed
  }
  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    const visit = node => {
      if (typescript.isImportDeclaration(node) && typescript.isStringLiteral(node.moduleSpecifier) && node.importClause) {
        const base = moduleDescriptor(node.moduleSpecifier.text)
        if (node.importClause.name) changed = setAlias(node.importClause.name.text, new Set([base])) || changed
        const bindings = node.importClause.namedBindings
        if (bindings && typescript.isNamespaceImport(bindings)) {
          changed = setAlias(bindings.name.text, new Set([base])) || changed
        } else if (bindings && typescript.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text
            changed = setAlias(element.name.text, new Set([`${base}.${imported}`])) || changed
          }
        }
      } else if (typescript.isVariableDeclaration(node) && node.initializer) {
        changed = bind(node.name, descriptorsForExpression(node.initializer, aliases, bindings)) || changed
      }
      typescript.forEachChild(node, visit)
    }
    visit(sourceFile)
    if (!changed) break
  }
  return aliases
}

const extractVueScripts = (file, text) => {
  const parsed = vueParser.parseForESLint(text, {
    filePath: file,
    sourceType: 'module',
    ecmaVersion: 'latest',
    parser: typescriptEslintParser,
    range: true,
  })
  return parsed.ast.body.map(node => text.slice(node.range[0], node.range[1])).join('\n')
}

const createSourceFile = ({ file, text }) => {
  const script = file.endsWith('.vue') ? extractVueScripts(file, text) : text
  const kind = /\.[cm]?jsx?$/i.test(file) ? typescript.ScriptKind.JS : typescript.ScriptKind.TS
  return typescript.createSourceFile(file, script, typescript.ScriptTarget.Latest, true, kind)
}

const walkAst = (node, visitor) => {
  visitor(node)
  typescript.forEachChild(node, child => walkAst(child, visitor))
}

const descriptorHasName = (descriptors, name) => [...descriptors].some(value => value.split('.').at(-1) == name)
const isRendererBoundary = file => file.startsWith('src/renderer/') || file.startsWith('src/renderer-lyric/') ||
  file.startsWith('src/main/modules/winMain/rendererEvent/') || file.startsWith('src/main/modules/userApi/') ||
  file.startsWith('src/common/')

const hasPathTarget = (node, bindings) => {
  let found = false
  walkAst(node, child => {
    if (typescript.isIdentifier(child) && /(?:path|target)/i.test(child.text)) found = true
    if ((typescript.isPropertyAccessExpression(child) || typescript.isElementAccessExpression(child)) &&
      /(?:path|target)/i.test(typescript.isPropertyAccessExpression(child)
        ? child.name.text
        : staticString(child.argumentExpression, bindings) ?? '')) {
      found = true
    }
  })
  return found
}

const tokenizeSql = sql => {
  const tokens = []
  for (let index = 0; index < sql.length;) {
    const char = sql[index]
    if (/\s/.test(char)) { index++; continue }
    if (char == '-' && sql[index + 1] == '-') {
      index = sql.indexOf('\n', index + 2)
      if (index < 0) break
      continue
    }
    if (char == '/' && sql[index + 1] == '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end < 0) break
      index = end + 2
      continue
    }
    if (char == "'") {
      let value = ''
      index++
      while (index < sql.length) {
        if (sql[index] != "'") { value += sql[index++]; continue }
        if (sql[index + 1] == "'") { value += "'"; index += 2; continue }
        index++
        break
      }
      tokens.push(`string:${value}`)
      continue
    }
    if (char == '"' || char == '`' || char == '[') {
      const close = char == '[' ? ']' : char
      let value = ''
      for (index++; index < sql.length && sql[index] != close; index++) value += sql[index]
      if (index < sql.length) index++
      tokens.push(value)
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index))
    if (word) {
      tokens.push(word[0])
      index += word[0].length
      continue
    }
    tokens.push(char)
    index++
  }
  return tokens
}

const legacySqlReferences = sql => {
  const tokens = tokenizeSql(sql)
  const references = []
  const introducers = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE'])
  for (let index = 0; index < tokens.length; index++) {
    if (!introducers.has(tokens[index].toUpperCase())) continue
    let target = index + 1
    while (target < tokens.length && ['IF', 'NOT', 'EXISTS', 'OR', 'REPLACE', 'ONLY'].includes(tokens[target].toUpperCase())) target++
    if (tokens[target + 1] == '.') target += 2
    const table = tokens[target]?.toLowerCase()
    if (legacyTables.has(table)) references.push(table)
  }
  return { references, ddl: ['CREATE', 'ALTER', 'DROP'].includes(tokens[0]?.toUpperCase()), tokens }
}

const commaSeparatedSqlItems = (tokens, openIndex) => {
  if (tokens[openIndex] != '(') return null
  const items = []
  let current = []
  let depth = 0
  for (let index = openIndex + 1; index < tokens.length; index++) {
    const token = tokens[index]
    if (token == '(') { depth++; current.push(token); continue }
    if (token == ')' && depth > 0) { depth--; current.push(token); continue }
    if (token == ')' && depth == 0) return { items: [...items, current], endIndex: index }
    if (token == ',' && depth == 0) { items.push(current); current = []; continue }
    current.push(token)
  }
  return null
}

const hasExclusiveEditedWhere = tokens => {
  const whereIndex = tokens.findIndex(token => token.toUpperCase() == 'WHERE')
  if (whereIndex < 0) return false
  const predicate = tokens.slice(whereIndex + 1)
  if (predicate.some(token => ['NOT', 'OR'].includes(token.toUpperCase()))) return false
  const sourceIndexes = predicate.flatMap((token, index) => token.toLowerCase() == 'source' ? [index] : [])
  return sourceIndexes.length > 0 && sourceIndexes.every(index =>
    predicate[index + 1] == '=' && predicate[index + 2] == 'string:edited',
  )
}

const insertValueRows = (tokens, valuesIndex) => {
  const rows = []
  for (let index = valuesIndex + 1; index < tokens.length;) {
    const row = commaSeparatedSqlItems(tokens, index)
    if (row == null) return null
    rows.push(row.items)
    index = row.endIndex + 1
    if (index == tokens.length || (index == tokens.length - 1 && tokens[index] == ';')) return rows
    if (tokens[index] != ',') return null
    index++
  }
  return null
}

const isEditedLyricSql = ({ references, tokens }) => {
  if (references.length == 0 || references.some(table => table != 'lyric')) return false
  const nonTrailingSemicolon = tokens.findIndex((token, index) => token == ';' && index != tokens.length - 1)
  if (nonTrailingSemicolon >= 0) return false
  const command = tokens[0]?.toUpperCase()
  if (['SELECT', 'UPDATE', 'DELETE'].includes(command)) {
    const whereIndex = tokens.findIndex(token => token.toUpperCase() == 'WHERE')
    if (command == 'UPDATE') {
      const setIndex = tokens.findIndex(token => token.toUpperCase() == 'SET')
      if (setIndex < 0 || whereIndex < 0 || tokens.slice(setIndex + 1, whereIndex)
        .some(token => token.toLowerCase() == 'source')) return false
    }
    return hasExclusiveEditedWhere(tokens)
  }
  if (command != 'INSERT' && command != 'REPLACE') return false
  const valuesIndex = tokens.findIndex(token => token.toUpperCase() == 'VALUES')
  if (valuesIndex < 0) return false
  const columnsOpen = tokens.indexOf('(', tokens.findIndex(token => token.toUpperCase() == 'INTO') + 1)
  const columns = commaSeparatedSqlItems(tokens, columnsOpen)?.items
  const rows = insertValueRows(tokens, valuesIndex)
  if (columns == null || rows == null || rows.length == 0 || rows.some(row => row.length != columns.length)) return false
  const sourceIndex = columns.findIndex(item => item.length == 1 && item[0].toLowerCase() == 'source')
  return sourceIndex >= 0 && rows.every(row =>
    row[sourceIndex].length == 1 && row[sourceIndex][0] == 'string:edited',
  )
}

const analyzeOwnershipFiles = files => {
  const findings = []
  const seen = new Set()
  const addFinding = (code, record, node) => {
    const key = `${code}:${record.file}`
    if (seen.has(key)) return
    seen.add(key)
    const sourceFile = node?.getSourceFile?.()
    const line = sourceFile && node ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 : 1
    findings.push({ code, file: record.file, line })
  }
  const inspectSql = (sql, record, node) => {
    const analysis = legacySqlReferences(sql)
    const { references, ddl } = analysis
    if (references.length == 0 || !record.kinds.includes('source')) return
    const migrationOwner = record.file.startsWith('src/main/migration/cache/') ||
      record.file.startsWith('src/main/worker/dbService/migrations/')
    const editedOwner = record.file == editedLyricSqlOwner && isEditedLyricSql(analysis)
    if (migrationOwner || (ddl && record.kinds.includes('schema')) || editedOwner) return
    addFinding('legacy-cache-dml', record, node)
  }
  for (const record of files) {
    if (record.file.endsWith('.sql')) {
      inspectSql(record.text, record)
      continue
    }
    let sourceFile
    try {
      sourceFile = createSourceFile(record)
    } catch {
      addFinding('parse-error', record)
      continue
    }
    if (sourceFile.parseDiagnostics.length > 0) {
      addFinding('parse-error', record, sourceFile)
      continue
    }
    if (!record.kinds.includes('source')) continue
    const bindings = collectStaticBindings(sourceFile)
    const aliases = collectAliases(sourceFile, bindings)
    walkAst(sourceFile, node => {
      if (typescript.isIdentifier(node) || typescript.isPropertyAccessExpression(node) ||
        typescript.isElementAccessExpression(node)) {
        const descriptors = descriptorsForExpression(node, aliases, bindings)
        if (descriptorHasName(descriptors, genericCacheDatabaseApiName)) addFinding('generic-cache-db-api', record, node)
        if (workerBoundary.has(record.file)) {
          for (const name of unscopedCacheNames) {
            if (descriptorHasName(descriptors, name)) addFinding('unscoped-cache-api', record, node)
          }
        }
      }
      if (!typescript.isCallExpression(node)) return
      const callee = descriptorsForExpression(node.expression, aliases, bindings)
      const calleeValues = [...callee]
      const pathCall = calleeValues.some(value => value == 'module:path.join' || value == 'module:path.resolve')
      if (calleeValues.some(value => value == 'module:os.tmpdir')) {
        addFinding('migrated-producer-temp-root', record, node)
      }
      if (pathCall && record.file != 'src/main/utils/storagePaths.ts' &&
        node.arguments.some(argument => staticString(argument, bindings)?.toLowerCase() == 'backups')) {
        addFinding('backup-root-derivation', record, node)
      }
      if (pathCall) {
        const hasCacheRoot = node.arguments.some(argument =>
          [...descriptorsForExpression(argument, aliases, bindings)].some(value => /(?:^|\.)cacheRoot$/i.test(value)),
        )
        const hasUnsupportedOwner = node.arguments.some(argument =>
          /^(?:artwork|audio)$/i.test(staticString(argument, bindings) ?? ''),
        )
        if (hasCacheRoot && hasUnsupportedOwner) addFinding('cache-artwork-audio-target', record, node)
      }
      if (isRendererBoundary(record.file)) {
        const lowerCallees = calleeValues.map(value => value.toLowerCase())
        if (lowerCallees.some(value => value.includes('cachemanager') && value.endsWith('.clearall'))) {
          addFinding('renderer-cache-clear', record, node)
        }
        const isDeletionCall = lowerCallees.some(value =>
          (value.includes('cache') || value.includes('storage')) && (value.includes('delete') || value.includes('remove')),
        )
        if (isDeletionCall && node.arguments.some(argument => hasPathTarget(argument, bindings))) {
          addFinding('renderer-deletion-target', record, node)
        }
        const ipcCall = lowerCallees.some(value => [
          'rendererinvoke',
          'renderersend',
          'invoke',
          'send',
          'mainhandle',
          'mainon',
        ].includes(value.split('.').at(-1)))
        if (ipcCall) {
          const channels = node.arguments.length == 0
            ? new Set()
            : staticChannelCandidates(node.arguments[0], bindings)
          if ([...channels].some(channel => channel != 'clear_cache' &&
            /(?:cache|storage).*clear.*all|clear.*(?:cache|storage).*all/i.test(channel))) {
            addFinding('renderer-cache-clear', record, node)
          }
          const deletionChannel = [...channels].some(channel =>
            /(?:cache|storage).*(?:delete|remove)|(?:delete|remove).*(?:cache|storage)/i.test(channel),
          )
          if (deletionChannel && node.arguments.slice(1).some(argument => hasPathTarget(argument, bindings))) {
            addFinding('renderer-deletion-target', record, node)
          }
        }
      }
      if (calleeValues.some(value => ['prepare', 'exec'].includes(value.split('.').at(-1))) && node.arguments.length > 0) {
        const sql = staticString(node.arguments[0], bindings)
        if (sql != null) inspectSql(sql, record, node)
      }
    })
  }
  return findings.sort((left, right) => left.file.localeCompare(right.file, 'en') || left.code.localeCompare(right.code, 'en'))
}

const ownershipFindings = analyzeOwnershipFiles(ownershipInventory)

describe('structured ownership analyzer regressions', () => {
  it('finds prohibited direct, aliased, and computed cache APIs', () => {
    const findings = analyzeOwnershipFiles([{
      file: 'src/main/worker/dbService/modules/index.ts',
      kinds: ['source'],
      text: `
        const direct = worker.${genericCacheDatabaseApiName}
        const computed = worker['get' + 'DB']
        const { musicUrlSave: persist } = worker
        direct(); computed(); persist()
      `,
    }])
    assert.deepEqual(findings.map(({ code }) => code).sort(), [
      'generic-cache-db-api',
      'unscoped-cache-api',
    ])
  })

  it('finds aliased path ownership violations without matching unrelated strings', () => {
    const findings = analyzeOwnershipFiles([{
      file: 'src/main/services/fixture.ts',
      kinds: ['source'],
      text: `
        import * as nodePath from 'node:path'
        import * as nodeOs from 'node:os'
        const combine = nodePath['jo' + 'in']
        const temporary = nodeOs['tmp' + 'dir']
        combine(profileRoot, 'backups')
        combine(cacheRoot, 'artwork')
        temporary()
        const ignored = 'path.join(cacheRoot, "audio") os.tmpdir()'
      `,
    }])
    assert.deepEqual(findings.map(({ code }) => code).sort(), [
      'backup-root-derivation',
      'cache-artwork-audio-target',
      'migrated-producer-temp-root',
    ])
  })

  it('parses both Vue script blocks while ignoring template and comment text', () => {
    const findings = analyzeOwnershipFiles([{
      file: 'src/renderer/views/OwnershipFixture.vue',
      kinds: ['source'],
      text: `
        <template>
          <!-- cacheManager.clearAll() worker.${genericCacheDatabaseApiName}() -->
          <button title="${genericCacheDatabaseApiName}">clearAll</button>
        </template>
        <script>
        const open = worker['get' + 'DB']
        open()
        </script>
        <script setup lang="ts">
        const manager = cacheManager
        manager['clear' + 'All']()
        // storageCacheRemove({ target: externalPath })
        </script>
      `,
    }])
    assert.deepEqual(findings.map(({ code }) => code).sort(), [
      'generic-cache-db-api',
      'renderer-cache-clear',
    ])
  })

  it('walks only explicit source, test, and schema roots', () => {
    const fixture = createTestStorageRoot('ownership-analyzer-roots')
    try {
      for (const directory of ['source', 'test', 'schema', 'generated']) {
        fs.mkdirSync(path.join(fixture.path, directory))
        fs.writeFileSync(path.join(fixture.path, directory, `${directory}.ts`), 'export const value = 1')
      }
      const inventory = readOwnershipInventory(fixture.path, [
        { kind: 'source', path: 'source' },
        { kind: 'test', path: 'test' },
        { kind: 'schema', path: 'schema' },
      ])
      assert.deepEqual(inventory.map(({ file, kinds }) => ({ file, kinds })), [
        { file: 'schema/schema.ts', kinds: ['schema'] },
        { file: 'source/source.ts', kinds: ['source'] },
        { file: 'test/test.ts', kinds: ['test'] },
      ])
    } finally {
      fixture.cleanup()
    }
  })

  it('finds renderer clear and caller-path deletion calls through aliases', () => {
    const findings = analyzeOwnershipFiles([{
      file: 'src/renderer/utils/ownershipFixture.ts',
      kinds: ['source'],
      text: `
        const manager = cacheManager
        const clear = manager['clear' + 'All']
        const remove = storageCache['remove' + 'Entry']
        clear()
        remove({ target: selectedPath })
        rendererInvoke('clear_cache')
        const ignored = 'cacheManager.clearAll() storageCacheRemove(targetPath)'
      `,
    }])
    assert.deepEqual(findings.map(({ code }) => code).sort(), [
      'renderer-cache-clear',
      'renderer-deletion-target',
    ])
  })

  it('rejects Phase 4 clear-all IPC while preserving Chromium clear_cache', () => {
    const findings = analyzeOwnershipFiles([{
      file: 'src/renderer/utils/ipcOwnershipFixture.ts',
      kinds: ['source'],
      text: `
        const invoke = rendererInvoke
        invoke('storage_cache_clear_all')
        rendererInvoke('clear_cache')
      `,
    }])
    assert.deepEqual(findings.map(({ code }) => code), ['renderer-cache-clear'])
  })

  it('finds clear-all IPC through repository event members on renderer and main boundaries', () => {
    const findings = analyzeOwnershipFiles([
      {
        file: 'src/renderer/utils/memberIpcOwnershipFixture.ts',
        kinds: ['source'],
        text: 'rendererInvoke(WIN_MAIN_RENDERER_EVENT_NAME.storage_cache_clear_all)',
      },
      {
        file: 'src/main/modules/winMain/rendererEvent/memberIpcOwnershipFixture.ts',
        kinds: ['source'],
        text: "mainHandle(WIN_MAIN_RENDERER_EVENT_NAME['storage_' + 'cache_clear_all'], resetCache)",
      },
    ])
    assert.deepEqual(findings.map(({ code, file }) => ({ code, file })), [
      {
        code: 'renderer-cache-clear',
        file: 'src/main/modules/winMain/rendererEvent/memberIpcOwnershipFixture.ts',
      },
      {
        code: 'renderer-cache-clear',
        file: 'src/renderer/utils/memberIpcOwnershipFixture.ts',
      },
    ])
  })

  it('resolves const-bound and computed clear-all IPC channels', () => {
    const findings = analyzeOwnershipFiles([
      {
        file: 'src/renderer/utils/constIpcOwnershipFixture.ts',
        kinds: ['source'],
        text: `
          const prefix = 'storage_cache'
          const clearChannel = prefix + '_clear_all'
          rendererInvoke(clearChannel)
        `,
      },
      {
        file: 'src/renderer/utils/computedIpcOwnershipFixture.ts',
        kinds: ['source'],
        text: `
          const channels = { danger: 'cache_clear_all' } as const
          rendererInvoke(channels['dan' + 'ger'])
        `,
      },
    ])
    assert.deepEqual(findings.map(({ code, file }) => ({ code, file })), [
      { code: 'renderer-cache-clear', file: 'src/renderer/utils/computedIpcOwnershipFixture.ts' },
      { code: 'renderer-cache-clear', file: 'src/renderer/utils/constIpcOwnershipFixture.ts' },
    ])
  })

  it('finds caller-provided deletion targets sent through cache IPC', () => {
    const findings = analyzeOwnershipFiles([{
      file: 'src/renderer/utils/deletionIpcOwnershipFixture.ts',
      kinds: ['source'],
      text: "rendererInvoke('storage_cache_delete', { target: selectedPath })",
    }])
    assert.deepEqual(findings.map(({ code }) => code), ['renderer-deletion-target'])
  })

  it('resolves const-bound SQL passed to recognized database APIs', () => {
    const findings = analyzeOwnershipFiles([{
      file: 'src/main/services/constSqlOwnershipFixture.ts',
      kinds: ['source'],
      text: `
        const table = 'music_' + 'url'
        const sql = 'SELECT * FROM ' + table
        db.prepare(sql)
      `,
    }])
    assert.deepEqual(findings.map(({ code }) => code), ['legacy-cache-dml'])
  })

  it('finds schema-qualified legacy tables in database-call SQL', () => {
    const findings = analyzeOwnershipFiles([
      {
        file: 'src/main/services/qualifiedMusicUrlFixture.ts',
        kinds: ['source'],
        text: "db.prepare('SELECT * FROM main.music_url')",
      },
      {
        file: 'src/main/services/qualifiedOtherSourceFixture.ts',
        kinds: ['source'],
        text: 'db.prepare(\'DELETE FROM "main"."music_info_other_source"\')',
      },
    ])
    assert.deepEqual(findings.map(({ code, file }) => ({ code, file })), [
      { code: 'legacy-cache-dml', file: 'src/main/services/qualifiedMusicUrlFixture.ts' },
      { code: 'legacy-cache-dml', file: 'src/main/services/qualifiedOtherSourceFixture.ts' },
    ])
  })

  it('limits schema and edited-lyric owners to their exact allowed SQL', () => {
    const findings = analyzeOwnershipFiles([
      {
        file: 'src/main/worker/dbService/tables.ts',
        kinds: ['source', 'schema'],
        text: "db.prepare('SELECT * FROM music_url')",
      },
      {
        file: 'src/main/worker/dbService/bootstrapFixture.ts',
        kinds: ['source', 'schema'],
        text: "db.exec('CREATE TABLE music_url(id TEXT PRIMARY KEY)')",
      },
      {
        file: 'src/main/worker/dbService/modules/lyric/edited/statements.ts',
        kinds: ['source', 'schema'],
        text: "db.prepare('DELETE FROM music_info_other_source')",
      },
      {
        file: 'src/main/worker/dbService/modules/lyric/edited/statements.ts',
        kinds: ['source', 'schema'],
        text: "db.prepare(\"DELETE FROM lyric WHERE source = 'edited'\")",
      },
    ])
    assert.deepEqual(findings.map(({ code, file }) => ({ code, file })), [
      {
        code: 'legacy-cache-dml',
        file: 'src/main/worker/dbService/modules/lyric/edited/statements.ts',
      },
      { code: 'legacy-cache-dml', file: 'src/main/worker/dbService/tables.ts' },
    ])
  })

  it('resolves const-bound backup path segments', () => {
    const findings = analyzeOwnershipFiles([{
      file: 'src/main/services/constBackupOwnershipFixture.ts',
      kinds: ['source'],
      text: `
        import path from 'node:path'
        const segment = 'back' + 'ups'
        path.join(profileRoot, segment)
      `,
    }])
    assert.deepEqual(findings.map(({ code }) => code), ['backup-root-derivation'])
  })

  it('resolves const-bound cache-root artwork and audio segments', () => {
    const findings = analyzeOwnershipFiles([
      {
        file: 'src/main/services/constArtworkOwnershipFixture.ts',
        kinds: ['source'],
        text: `
          import path from 'node:path'
          const segment = 'art' + 'work'
          path.join(cacheRoot, segment)
        `,
      },
      {
        file: 'src/main/services/constAudioOwnershipFixture.ts',
        kinds: ['source'],
        text: `
          import path from 'node:path'
          const segment = 'au' + 'dio'
          path.join(cacheRoot, segment)
        `,
      },
    ])
    assert.deepEqual(findings.map(({ code, file }) => ({ code, file })), [
      { code: 'cache-artwork-audio-target', file: 'src/main/services/constArtworkOwnershipFixture.ts' },
      { code: 'cache-artwork-audio-target', file: 'src/main/services/constAudioOwnershipFixture.ts' },
    ])
  })

  it('resolves constants in their lexical scope without nested shadow leakage', () => {
    const findings = analyzeOwnershipFiles([
      {
        file: 'src/renderer/utils/dangerousOuterChannelFixture.ts',
        kinds: ['source'],
        text: `
          const channel = 'storage_cache_clear_all'
          const nested = () => { const channel = 'clear_cache'; return channel }
          rendererInvoke(channel)
        `,
      },
      {
        file: 'src/renderer/utils/safeOuterChannelFixture.ts',
        kinds: ['source'],
        text: `
          const channel = 'clear_cache'
          const nested = () => { const channel = 'storage_cache_clear_all'; return channel }
          rendererInvoke(channel)
        `,
      },
      {
        file: 'src/main/services/shadowedBackupFixture.ts',
        kinds: ['source'],
        text: `
          import path from 'node:path'
          const segment = 'backups'
          const nested = () => { const segment = 'logs'; return segment }
          path.join(profileRoot, segment)
        `,
      },
    ])
    assert.deepEqual(findings.map(({ code, file }) => ({ code, file })), [
      { code: 'backup-root-derivation', file: 'src/main/services/shadowedBackupFixture.ts' },
      { code: 'renderer-cache-clear', file: 'src/renderer/utils/dangerousOuterChannelFixture.ts' },
    ])
  })

  it('requires every edited-owner SQL row to remain edited-owned', () => {
    const cases = [
      `db.prepare("DELETE FROM lyric WHERE source = 'edited' OR source = '${rawLyricOwnerName}'")`,
      "db.prepare(\"UPDATE lyric SET source = 'edited'\")",
      `db.prepare("INSERT INTO lyric(source) VALUES ('edited'), ('${rawLyricOwnerName}')")`,
    ]
    const actual = cases.map(text => analyzeOwnershipFiles([{
      file: 'src/main/worker/dbService/modules/lyric/edited/statements.ts',
      kinds: ['source', 'schema'],
      text,
    }]).map(({ code }) => code))
    assert.deepEqual(actual, [
      ['legacy-cache-dml'],
      ['legacy-cache-dml'],
      ['legacy-cache-dml'],
    ])

    const legitimate = analyzeOwnershipFiles([{
      file: 'src/main/worker/dbService/modules/lyric/edited/statements.ts',
      kinds: ['source', 'schema'],
      text: "db.prepare(\"DELETE FROM lyric WHERE source = 'edited'\")",
    }])
    assert.deepEqual(legitimate, [])
  })

  it('checks legacy SQL only for static literals passed to recognized database APIs', () => {
    const findings = analyzeOwnershipFiles([
      {
        file: 'src/main/services/activeCacheQuery.ts',
        kinds: ['source'],
        text: 'db[\'pre\' + \'pare\'](\'SELECT * FROM music_url WHERE id = ?\')',
      },
      {
        file: 'src/main/services/unrelatedString.ts',
        kinds: ['source'],
        text: `
          const text = 'SELECT * FROM music_url'
          log('DELETE FROM music_info_other_source')
          // db.prepare('SELECT * FROM lyric')
          db.prepare('-- SELECT * FROM music_url\\nSELECT 1')
        `,
      },
      {
        file: 'src/main/migration/cache/rawLyrics.ts',
        kinds: ['source', 'schema'],
        text: 'db.prepare(\'SELECT id, text FROM lyric WHERE source = ?\')',
      },
      {
        file: 'src/main/worker/dbService/tables.ts',
        kinds: ['source', 'schema'],
        text: 'db.exec(\'CREATE TABLE music_url(id TEXT PRIMARY KEY)\')',
      },
      {
        file: 'build-config/storage-electron/legacyFixture.test.js',
        kinds: ['test'],
        text: 'db.prepare(\'SELECT * FROM music_info_other_source\')',
      },
    ])
    assert.deepEqual(findings.map(({ code, file }) => ({ code, file })), [{
      code: 'legacy-cache-dml',
      file: 'src/main/services/activeCacheQuery.ts',
    }])
  })
})

describe('Phase 4 whole-source ownership gate', () => {
  it('exposes no generic or unscoped cache database API across production and worker boundaries', () => {
    assert.deepEqual(new Set(ownershipInventory.flatMap(({ kinds }) => kinds)), new Set(['source', 'test', 'schema']))
    const prohibited = new Set(['parse-error', 'generic-cache-db-api', 'unscoped-cache-api'])
    assert.deepEqual(ownershipFindings.filter(({ code }) => prohibited.has(code)), [])
  })

  it('keeps authoritative legacy cache SQL in the schema, edited-lyric repository, and sole migration owners', () => {
    assert.deepEqual(ownershipFindings.filter(({ code }) => code == 'legacy-cache-dml'), [])
  })

  it('keeps backup roots, temp roots, renderer deletion authority, and cache-manager UI wiring inside their owners', () => {
    const pathAndRendererCodes = new Set([
      'backup-root-derivation',
      'migrated-producer-temp-root',
      'cache-artwork-audio-target',
      'renderer-cache-clear',
      'renderer-deletion-target',
    ])
    assert.deepEqual(ownershipFindings.filter(({ code }) => pathAndRendererCodes.has(code)), [])
  })

  it('keeps every generated installed and portable fixture path inside its owned direct child', () => {
    for (const layout of ['installed', 'portable']) {
      const fixture = createPhase4DurableFixture({ layout })
      try {
        seedDurableFiles(fixture, layout == 'portable' ? { profileRoot: fixture.legacyProfileRoot } : undefined)
        assert.equal(path.dirname(fixture.root), fs.realpathSync(process.env.LX_TEST_STORAGE_ROOT))
        assertFixturePathsOwned(fixture)
      } finally {
        fixture.cleanup()
      }
    }
  })
})
