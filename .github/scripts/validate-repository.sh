#!/usr/bin/env bash

set -euo pipefail

readonly required_files=(
  "README.md"
  "BACKLOG.md"
  "CONTRIBUTING.md"
  "SECURITY.md"
  "package.json"
  "package-lock.json"
)

errors=0

for file in "${required_files[@]}"; do
  if [[ ! -s "$file" ]]; then
    printf 'Required file is missing or empty: %s\n' "$file" >&2
    errors=1
  fi
done

require_content() {
  local file="$1"
  local content="$2"

  if [[ -f "$file" ]] && ! grep -Fq -- "$content" "$file"; then
    printf 'Required section is missing from %s: %s\n' "$file" "$content" >&2
    errors=1
  fi
}

require_content "README.md" "# AI Harness Helper"
require_content "BACKLOG.md" "## P0 - Decisions still required"
require_content "CONTRIBUTING.md" "## Before writing code"
require_content "SECURITY.md" "## Reporting a vulnerability"
require_content "package.json" "\"workspaces\""

tracked_files="$(mktemp)"
trap 'rm -f "$tracked_files"' EXIT
if ! git ls-files --cached --others --exclude-standard -z >"$tracked_files" 2>/dev/null; then
  find . -path './.git' -prune -o -path './node_modules' -prune -o -type f -print0 >"$tracked_files"
fi

while IFS= read -r -d '' file; do
  [[ -f "$file" ]] || continue
  if grep -Iq . "$file" && grep -InE '[[:blank:]]+$' "$file"; then
    printf 'Trailing whitespace found in: %s\n' "$file" >&2
    errors=1
  fi
done <"$tracked_files"

if (( errors != 0 )); then
  exit 1
fi

printf 'Repository baseline checks passed.\n'
