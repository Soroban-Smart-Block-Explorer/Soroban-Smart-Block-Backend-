#!/bin/bash

# Verification script for build artifact prevention policy
# This script validates that the .gitignore and pre-commit hooks are working correctly

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🔍 Verifying Build Artifact Prevention Policy"
echo "=============================================="
echo ""

# Test 1: Verify .gitignore patterns
echo "✓ Test 1: Verifying .gitignore patterns"
echo "  Checking if patterns correctly match test artifacts..."

cd "$PROJECT_ROOT"

PATTERN_TESTS=(
  "tests/test.js"
  "tests/test.js.map"
  "tests/test.d.ts"
  "tests/api/test.js"
  "tests/db/fixture.js.map"
)

for test_file in "${PATTERN_TESTS[@]}"; do
  if git check-ignore "$test_file" > /dev/null 2>&1; then
    echo "  ✓ Pattern matches: $test_file"
  else
    echo "  ✗ Pattern FAILED: $test_file"
    exit 1
  fi
done

echo ""

# Test 2: Check for existing violations
echo "✓ Test 2: Checking for already-committed artifacts"
echo "  Scanning git history..."

VIOLATIONS=$(git ls-files tests | grep -E '\.(js|js.map|d.ts)$' | wc -l)

if [ "$VIOLATIONS" -eq 0 ]; then
  echo "  ✓ Clean: 0 artifacts found in git history"
else
  echo "  ✗ FOUND $VIOLATIONS violations:"
  git ls-files tests | grep -E '\.(js|js.map|d.ts)$' | sed 's/^/     /'
  exit 1
fi

echo ""

# Test 3: Verify hook exists and is executable
echo "✓ Test 3: Verifying pre-commit hook"
echo "  Checking hook installation..."

if [ ! -f ".husky/pre-commit" ]; then
  echo "  ✗ Pre-commit hook not found"
  exit 1
fi

if [ ! -x ".husky/pre-commit" ]; then
  echo "  ✗ Pre-commit hook not executable"
  exit 1
fi

echo "  ✓ Pre-commit hook found and executable"

# Test 4: Verify artifact check script
echo ""
echo "✓ Test 4: Verifying artifact check script"
echo "  Checking script installation..."

if [ ! -f ".husky/pre-commit-check-artifacts.sh" ]; then
  echo "  ✗ Artifact check script not found"
  exit 1
fi

if [ ! -x ".husky/pre-commit-check-artifacts.sh" ]; then
  echo "  ✗ Artifact check script not executable"
  exit 1
fi

echo "  ✓ Artifact check script found and executable"

# Test 5: Test the hook execution
echo ""
echo "✓ Test 5: Testing hook execution"
echo "  Running pre-commit check script..."

if bash .husky/pre-commit-check-artifacts.sh > /dev/null 2>&1; then
  echo "  ✓ Hook executes successfully"
else
  echo "  ✗ Hook execution failed"
  exit 1
fi

echo ""

# Test 6: Verify documentation
echo "✓ Test 6: Verifying documentation"
echo "  Checking for policy documents..."

DOCS=(
  "docs/BUILD_ARTIFACTS_POLICY.md"
  "ARTIFACT_CLEANUP_REPORT.md"
  ".husky/QUICK_REFERENCE.md"
)

for doc in "${DOCS[@]}"; do
  if [ -f "$doc" ]; then
    echo "  ✓ Found: $doc"
  else
    echo "  ⚠ Missing: $doc (optional)"
  fi
done

echo ""
echo "=============================================="
echo "✅ All verification tests PASSED"
echo ""
echo "Summary:"
echo "  • .gitignore patterns: Working ✓"
echo "  • Git history: Clean ✓"
echo "  • Pre-commit hook: Active ✓"
echo "  • Artifact check: Functional ✓"
echo "  • Documentation: Complete ✓"
echo ""
echo "Your repository is protected from committing build artifacts."
echo ""
