# Build Artifacts Policy

**Status:** ✅ Compliant  
**Last Updated:** July 28, 2026

---

## Overview

This document establishes policies for managing compiled artifacts (`.js`, `.js.map`, `.d.ts` files) generated from TypeScript sources.

---

## Current State

### ✅ What's Working

1. **`.gitignore` Patterns** — Correctly configured
   ```
   tests/**/*.js
   tests/**/*.js.map
   tests/**/*.d.ts
   ```

2. **Git Verification** — All patterns validated and working
   ```
   ✓ tests/**/*.js → matches any .js file under tests/
   ✓ tests/**/*.js.map → matches source maps
   ✓ tests/**/*.d.ts → matches TypeScript declaration files
   ```

3. **No Violations** — No compiled files currently tracked in git
   ```
   $ git ls-files tests | grep -E "\.(js|js.map|d.ts)$"
   (no output = no violations)
   ```

4. **Pre-commit Hook** — Husky + lint-staged active
   ```
   .husky/pre-commit → npx lint-staged
   lint-staged config → *.ts files only
   ```

---

## Recommended Enhancements

### 1. Explicit Pre-commit Validation Hook

Add a dedicated check to explicitly block compiled files:

**File:** `.husky/pre-commit` (enhanced)

```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# 1. Check for compiled test artifacts
echo "🔍 Checking for compiled test artifacts..."
if git diff --cached --name-only | grep -E 'tests/.*\.(js|js.map|d.ts)$'; then
  echo "❌ BLOCKED: Compiled test artifacts detected in staging"
  echo "   These should be .gitignored. Run: git reset HEAD <files>"
  exit 1
fi

# 2. Run lint-staged (existing)
npx lint-staged

# 3. Ensure .gitignore patterns are valid
echo "✓ Pre-commit checks passed"
```

### 2. Enhanced `.gitignore`

Add comments for clarity and future maintainers:

```gitignore
# Build artifacts
node_modules/
dist/
dist-esm/

# Environment & logs
.env
*.log

# Test compilation artifacts (should never be committed)
# - .js files from compiled .ts
# - .js.map source maps
# - .d.ts TypeScript declarations
tests/**/*.js
tests/**/*.js.map
tests/**/*.d.ts

# Temporary build files
*.bak
node/
```

### 3. Developer Documentation

Create a quick reference for developers:

**File:** `.husky/README.md` or `DEVELOPMENT.md`

```markdown
## Build Artifacts

### What Gets Compiled

- TypeScript files (`*.ts`) → JavaScript (`*.js`)
- Source maps generated (`*.js.map`)
- Declaration files generated (`*.d.ts`)

### What Should Never Be Committed

Compiled artifacts from `tests/` directory:
- ❌ `tests/**/*.js`
- ❌ `tests/**/*.js.map`
- ❌ `tests/**/*.d.ts`

### Why?

1. **Repo Bloat** — Duplicates source code, increases clone time
2. **Merge Conflicts** — Changes to .ts conflict with .js in git history
3. **Staleness** — Compiled versions can fall out of sync with sources
4. **CI Consistency** — Builds should compile on CI, not use cached artifacts

### If You Accidentally Commit Compiled Files

```bash
# Remove from staging
git reset HEAD tests/**/*.js tests/**/*.js.map tests/**/*.d.ts

# Remove locally (if needed)
rm -rf tests/**/*.js tests/**/*.js.map tests/**/*.d.ts

# Verify with
git check-ignore -v tests/test.js
```

### Verify Patterns Work

```bash
# Check that .gitignore correctly matches artifacts
git check-ignore -v tests/test.js tests/test.js.map tests/test.d.ts

# Output should show matches:
# .gitignore:X:tests/**/*.js    tests/test.js
# .gitignore:Y:tests/**/*.js.map    tests/test.js.map
# .gitignore:Z:tests/**/*.d.ts    tests/test.d.ts
```
```

### 4. Pre-commit Hook Installation Check

Add a verification step in the README:

```markdown
## First-Time Setup

```bash
# Install pre-commit hooks
npm install

# Verify hooks are installed
ls -la .husky/pre-commit
# Should output: pre-commit (executable)

# Test the hook manually
npm run build:tests
git add tests/  # This should be blocked by pre-commit
# Expected: ❌ BLOCKED: Compiled test artifacts detected in staging
```
```

---

## Implementation Checklist

- [x] ✅ Verify `.gitignore` patterns are correct
- [x] ✅ Confirm no compiled files in git history
- [x] ✅ Verify patterns work with `git check-ignore`
- [ ] → Enhance `.husky/pre-commit` with explicit validation
- [ ] → Update `.gitignore` with comments
- [ ] → Add developer documentation to DEVELOPMENT.md
- [ ] → Test hook with `npm run build && git add tests/`
- [ ] → Document in CONTRIBUTING.md

---

## Testing the Policy

### Test 1: Verify Patterns Work
```bash
cd /workspaces/Soroban-Smart-Block-Backend-
git check-ignore -v tests/test.js tests/test.js.map tests/test.d.ts
# Expected: all matched
```

### Test 2: Ensure No Tracked Files
```bash
git ls-files tests | grep -E '\.(js|js.map|d.ts)$'
# Expected: (empty output)
```

### Test 3: Simulate Commit Prevention
```bash
# Create a test file
touch tests/fake.test.js

# Stage it (pre-commit hook should block)
git add tests/fake.test.js
git commit -m "test"
# Expected: Pre-commit hook blocks this

# Cleanup
rm tests/fake.test.js
```

---

## Monitoring

### Quarterly Reviews

1. **Audit** — Check for accidentally committed artifacts
   ```bash
   git log --all --name-only | grep -E 'tests/.*\.(js|js.map|d.ts)$'
   ```

2. **Hook Status** — Verify hooks are installed
   ```bash
   test -x .husky/pre-commit && echo "✓ Pre-commit hook active" || echo "❌ Missing"
   ```

3. **Coverage** — Ensure patterns cover new test directories
   ```bash
   # If new test dirs added, update patterns
   ```

---

## References

- [Git Check-Ignore Documentation](https://git-scm.com/docs/git-check-ignore)
- [Husky Documentation](https://typicode.github.io/husky/)
- [Git .gitignore Pattern Documentation](https://git-scm.com/docs/gitignore)

---

**Policy Owner:** Engineering Team  
**Last Review:** July 28, 2026  
**Next Review:** October 28, 2026
