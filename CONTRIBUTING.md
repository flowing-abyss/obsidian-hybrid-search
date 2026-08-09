# Contributing

Thanks for taking an interest. Issues and pull requests are both welcome.

## Getting set up

You need npm and Node.js 20 or newer.

```bash
npm install
npm run build
```

## Before you open a pull request

Run the project checks locally.

```bash
npm run format
npm run build
npm test
npm run lint
npm run knip
```

Add or update tests when behavior changes. See [CLAUDE.md](CLAUDE.md) for checks required by changes to ranking, the database schema, or MCP behavior.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), so use prefixes such as `fix:`, `feat:`, or `docs:`.
