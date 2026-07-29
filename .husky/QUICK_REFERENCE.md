# Pre-commit Hook Quick Reference

## What This Hook Does

✅ **Prevents committing:**
- `tests/**/*.js` (compiled JavaScript)
- `tests/**/*.js.map` (source maps)
- `tests/**/*.d.ts` (TypeScript declarations)

✅ **Checks automatically on commit**

---

## If You See This Error

```
❌ COMMIT BLOCKED: Compiled test artifacts detected in staging area

The following files should NOT be committed (they are generated):
   tests/auth.test.js
   tests/auth.test.js.map
```

### Fix It

```bash
# Option 1: Unstage the files
git reset HEAD tests/auth.test.js tests/auth.test.js.map

# Option 2: Remove locally if you don't need them
rm tests/auth.test.js tests/auth.test.js.map

# Then commit normally
git add <your-actual-changes>
git commit -m "your message"
```

---

## What Can Be Committed from tests/

| File Type | Commit? | Why |
|-----------|---------|-----|
| `*.ts` (source) | ✅ Yes | This is the source code |
| `*.test.ts` | ✅ Yes | Test source code |
| `*.js` (compiled) | ❌ No | Auto-generated |
| `*.js.map` | ❌ No | Auto-generated |
| `*.d.ts` | ❌ No | Auto-generated |

---

## How to Bypass (Dangerous!)

Only if you absolutely know what you're doing:

```bash
git commit --no-verify
# ⚠️ This skips ALL pre-commit checks
# Only use in emergencies
```

---

## Questions?

See: `docs/BUILD_ARTIFACTS_POLICY.md`
