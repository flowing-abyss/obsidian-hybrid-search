#!/usr/bin/env bash
# Synchronize server.json version fields with package.json.
#
# Why this script exists:
#   MCP Registry publisher reads server.json directly and requires the version
#   to be present in two places: server.json#version and
#   server.json#packages[0].version. package.json is the single source of truth
#   for the package version, so this script derives the registry metadata from it.
#
# Usage:
#   bash scripts/sync-server-json.sh

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not installed." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_VERSION="$(jq -r .version "${ROOT}/package.json")"

SERVER_VERSION="$(jq -r .version "${ROOT}/server.json")"
SERVER_PKG_VERSION="$(jq -r '.packages[0].version // empty' "${ROOT}/server.json")"

if [ "${SERVER_VERSION}" = "${PKG_VERSION}" ] && [ "${SERVER_PKG_VERSION}" = "${PKG_VERSION}" ]; then
  echo "server.json is already synchronized to version ${PKG_VERSION}"
  exit 0
fi

jq --arg version "${PKG_VERSION}" '
  .version = $version |
  .packages[0].version = $version
' "${ROOT}/server.json" > "${ROOT}/server.json.tmp"

mv "${ROOT}/server.json.tmp" "${ROOT}/server.json"
echo "Synchronized server.json to version ${PKG_VERSION}"
