#!/usr/bin/env bash
set -euo pipefail

npm run format:check
npm run lint
npm run build
npm test
npm run knip

echo "All checks passed."
