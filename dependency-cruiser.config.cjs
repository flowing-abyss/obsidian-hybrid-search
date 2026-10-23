// Adapted from flowing-abyss/obsidian-abyss-tasks@551c44c3dd4335df37d9b7bc37011c4623cc3632.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: {
        circular: true,
        preCompilationOnly: false,
        viaOnly: { dependencyTypesNot: ['type-only'] },
      },
    },
    {
      name: 'no-unlisted-dependencies',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg'] },
    },
    {
      name: 'indexer-independent',
      severity: 'error',
      from: { path: '^src/indexer[.]ts$' },
      to: { path: '^src/searcher[.]ts$' },
    },
    {
      name: 'pure-normalization',
      severity: 'error',
      from: { path: '^src/(text-normalization|index-state)[.]ts$' },
      to: { path: '.' },
    },
    {
      name: 'pure-extraction',
      severity: 'error',
      from: { path: '^src/note-extractor[.]ts$' },
      to: {
        pathNot: ['^src/text-normalization[.]ts$', '^node_modules/gray-matter/', '^gray-matter$'],
      },
    },
    {
      name: 'infrastructure-no-transports',
      severity: 'error',
      from: {
        path: '^src/',
        pathNot:
          '^src/(cli|mcp-runtime|server|mcp-http-server|mcp-stdio-server|mcp-supervisor|stdio-server)[.]ts$',
      },
      to: {
        path: '^src/(cli|mcp-runtime|server|mcp-http-server|mcp-stdio-server|mcp-supervisor|stdio-server)[.]ts$',
      },
    },
    {
      name: 'storage-no-orchestration',
      severity: 'error',
      from: { path: '^src/(storage/|db[.]ts$)' },
      to: { path: '^src/(indexer|searcher)[.]ts$' },
    },
    {
      name: 'sqlite-acquisition',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/(storage/|db[.]ts$)' },
      to: { path: '(^|/)(better-sqlite3|sqlite-vec)(/|$)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    moduleSystems: ['es6'],
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: 'specify',
    enhancedResolveOptions: { conditionNames: ['types', 'import', 'node', 'default'] },
  },
};
