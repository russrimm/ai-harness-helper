#!/usr/bin/env bash

set -euo pipefail

readonly required_files=(
  "README.md"
  "BACKLOG.md"
  "CONTRIBUTING.md"
  "SECURITY.md"
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

require_content "README.md" "discovery-stage repository"
require_content "BACKLOG.md" "## P0 - Decisions required before implementation"
require_content "CONTRIBUTING.md" "## Before writing code"
require_content "SECURITY.md" "## Reporting a vulnerability"

while IFS= read -r -d '' file; do
  [[ -f "$file" ]] || continue
  if grep -Iq . "$file" && grep -InE '[[:blank:]]+$' "$file"; then
    printf 'Trailing whitespace found in: %s\n' "$file" >&2
    errors=1
  fi
done < <(git ls-files --cached --others --exclude-standard -z)

if (( errors != 0 )); then
  exit 1
fi

printf 'Repository baseline checks passed.\n'
