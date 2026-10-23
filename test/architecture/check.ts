// Dependency rules and AST acquisition checks follow the upstream architecture-test approach.
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../..');

export async function checkArchitecture(baseDir: string): Promise<string[]> {
  const options = await extractDepcruiseOptions(path.join(root, 'dependency-cruiser.config.cjs'));
  const result = await cruise(['src'], {
    ...options,
    baseDir,
    tsConfig: { fileName: path.join(root, 'tsconfig.json') },
  });
  const graph = result.output as ICruiseResult;
  const violations = graph.summary.violations.map(
    ({ rule, from, to }) => `${rule.name}: ${from} -> ${to}`,
  );
  const program = ts.createProgram(
    graph.modules
      .filter((m) => m.source.startsWith('src/'))
      .map((m) => path.join(baseDir, m.source)),
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      types: [],
    },
  );
  const checker = program.getTypeChecker();
  const canonicalPath = (file: string) => path.resolve(file).replaceAll('\\', '/');
  const dbPath = canonicalPath(path.join(baseDir, 'src/db.ts'));
  function originalSymbol(node: ts.Node): ts.Symbol | undefined {
    let symbol = checker.getSymbolAtLocation(node);
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = node.propertyName ?? node.name;
      if (ts.isIdentifier(name))
        symbol = checker.getPropertyOfType(checker.getTypeAtLocation(node.parent), name.text);
    }
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  }
  function isRawSymbol(node: ts.Node): boolean {
    const symbol = originalSymbol(node);
    return (symbol?.declarations ?? []).some((d) => {
      const file = canonicalPath(d.getSourceFile().fileName);
      if (file === dbPath && symbol?.name === 'getDb') return true;
      return (
        file.includes('/better-sqlite3/') &&
        ['prepare', 'exec', 'transaction'].includes(symbol?.name ?? '')
      );
    });
  }
  // Acquisition, not arbitrary method spelling, proves raw SQLite authority. Named
  // aliases retain their imported name; namespace/star/dynamic acquisition exposes
  // the complete raw module and is deliberately forbidden outside its owner.
  for (const module of graph.modules) {
    if (!module.source.startsWith('src/') || /^src\/(storage\/|db\.ts$)/.test(module.source))
      continue;
    const fileName = path.join(baseDir, module.source);
    const text = ts.sys.readFile(fileName);
    if (text === undefined) continue;
    const source =
      program.getSourceFile(fileName) ??
      ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    const isDb = (node: ts.Node | undefined): boolean =>
      node !== undefined && ts.isStringLiteralLike(node) && /(?:^|\/)db\.[jt]s$/.test(node.text);
    const visit = (node: ts.Node): void => {
      let raw = isRawSymbol(node);
      if (ts.isCallExpression(node)) {
        const called = originalSymbol(node.expression);
        if (
          called?.name === 'openDb' &&
          (called.declarations ?? []).some(
            (d) => canonicalPath(d.getSourceFile().fileName) === dbPath,
          ) &&
          !ts.isExpressionStatement(node.parent)
        )
          raw = true;
      }
      if (ts.isImportDeclaration(node) && isDb(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings;
        raw ||=
          bindings !== undefined &&
          (ts.isNamespaceImport(bindings) ||
            bindings.elements.some((e) => (e.propertyName ?? e.name).text === 'getDb'));
      }
      if (ts.isExportDeclaration(node) && isDb(node.moduleSpecifier)) {
        raw ||=
          !node.exportClause ||
          !ts.isNamedExports(node.exportClause) ||
          node.exportClause.elements.some((e) => (e.propertyName ?? e.name).text === 'getDb');
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        isDb(node.arguments[0])
      )
        raw = true;
      if (raw)
        violations.push(
          `raw-storage-access: ${module.source}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
        );
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}
