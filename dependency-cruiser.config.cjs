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
      from: { path: '^src/indexing/' },
      to: { path: '^src/search/' },
    },
    {
      name: 'search-no-indexing',
      severity: 'error',
      from: { path: '^src/search/' },
      to: { path: '^src/indexing/' },
    },
    {
      name: 'pure-normalization',
      severity: 'error',
      from: { path: '^src/(content/text-normalization|storage/index-state)[.]ts$' },
      to: { path: '.' },
    },
    {
      name: 'pure-extraction',
      severity: 'error',
      from: { path: '^src/content/note-extractor[.]ts$' },
      to: {
        pathNot: [
          '^src/content/text-normalization[.]ts$',
          '^node_modules/gray-matter/',
          '^gray-matter$',
        ],
      },
    },
    {
      name: 'infrastructure-no-transports',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/(transports/|(cli|server)[.]ts$)' },
      to: { path: '^src/(transports/|(cli|server)[.]ts$)' },
    },
    {
      name: 'storage-no-orchestration',
      severity: 'error',
      from: { path: '^src/storage/' },
      to: { path: '^src/(indexing|search|inference)/' },
    },
    {
      name: 'sqlite-acquisition',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/storage/' },
      to: { path: '(^|/)(better-sqlite3|sqlite-vec)(/|$)' },
    },
    {
      name: 'inference-no-application',
      severity: 'error',
      from: { path: '^src/inference/' },
      to: { path: '^src/(indexing|search|storage|vault)/' },
    },
    {
      name: 'content-no-application',
      severity: 'error',
      from: { path: '^src/content/' },
      to: { path: '^src/', pathNot: '^src/(content/|runtime/config[.]ts$)' },
    },
    {
      name: 'runtime-independent',
      severity: 'error',
      from: { path: '^src/runtime/' },
      to: { path: '^src/', pathNot: '^src/runtime/' },
    },
    {
      name: 'contracts-independent',
      severity: 'error',
      from: { path: '^src/contracts/' },
      to: { path: '^src/', pathNot: '^src/(contracts/|content/text-normalization[.]ts$)' },
    },
    {
      name: 'vault-no-application',
      severity: 'error',
      from: { path: '^src/vault/' },
      to: {
        path: '^src/',
        pathNot: '^src/(vault/|runtime/config[.]ts$|storage/vault-locator[.]ts$)',
      },
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
