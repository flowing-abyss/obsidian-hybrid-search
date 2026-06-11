#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${OHS_PRE_PUSH_CHANGED_FILES:-}" ]]; then
  changed_files="${OHS_PRE_PUSH_CHANGED_FILES}"
else
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"

  if [[ -z "${upstream}" ]]; then
    echo "Running eval:quality because this branch has no upstream."
    exit 0
  fi

  changed_files="$(git diff --name-only --diff-filter=ACMRTUXB "${upstream}...HEAD")"
fi

if [[ -z "${changed_files}" ]]; then
  echo "Skipping eval:quality because there are no pushed file changes."
  exit 1
fi

should_run=false

while IFS= read -r file; do
  [[ -z "${file}" ]] && continue

  case "${file}" in
    *.md | *.MD)
      case "${file}" in
        fixtures/* | test/fixtures/*)
          should_run=true
          ;;
      esac
      ;;
    *)
      should_run=true
      ;;
  esac
done <<< "${changed_files}"

if [[ "${should_run}" == "true" ]]; then
  echo "Running eval:quality because pushed changes can affect ranking quality."
  exit 0
fi

echo "Skipping eval:quality because pushed changes are markdown-only documentation."
exit 1
