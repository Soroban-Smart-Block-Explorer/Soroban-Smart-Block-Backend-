#!/bin/bash

# Pre-commit Hook: Prevent committing compiled test artifacts
# This script prevents accidentally committing .js, .js.map, .d.ts files
# that are generated from .ts sources in the tests/ directory.

set -e

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

# Check for compiled test artifacts
COMPILED_ARTIFACTS=$(echo "$STAGED_FILES" | grep -E 'tests/.*\.(js|js.map|d.ts)$' || true)

if [ -n "$COMPILED_ARTIFACTS" ]; then
  echo "❌ COMMIT BLOCKED: Compiled test artifacts detected in staging area"
  echo ""
  echo "The following files should NOT be committed (they are generated):"
  echo "$COMPILED_ARTIFACTS" | sed 's/^/   /'
  echo ""
  echo "Allowed files in tests/:"
  echo "   ✓ *.ts     (TypeScript source files)"
  echo "   ✗ *.js     (Compiled JavaScript — auto-generated)"
  echo "   ✗ *.js.map (Source maps — auto-generated)"
  echo "   ✗ *.d.ts   (Type declarations — auto-generated)"
  echo ""
  echo "Fix this by unstaging the artifacts:"
  echo "   git reset HEAD $COMPILED_ARTIFACTS"
  echo ""
  exit 1
fi

# All good
exit 0
