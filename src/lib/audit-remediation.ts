/**
 * Automated Remediation Engine
 *
 * For auto-fixable AuditFindings, generates:
 *   1. Concrete remediation code (Rust/Soroban patch)
 *   2. Explanation of what changed and why
 *   3. A unified diff suitable for a pull request
 *   4. Optional PR metadata (title, body, branch name)
 *
 * Supported remediation types:
 *   reentrancy_guard    — wraps state-mutating functions with a re-entrancy lock
 *   access_control      — adds admin-only / owner check to privileged functions
 *   dependency_update   — bumps a vulnerable dependency in Cargo.toml
 *   overflow_check      — wraps arithmetic with checked_add / checked_sub / checked_mul
 *   sanctions_gate      — adds sanctions screening call before transfer execution
 *   timelock_addition   — wraps upgrade authority with a time-lock delay
 *   source_verification — generates a verification submission script
 *
 * Non-fixable findings return isAutoFixable=false with manual guidance only.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type RemediationType =
  | 'reentrancy_guard'
  | 'access_control'
  | 'dependency_update'
  | 'overflow_check'
  | 'sanctions_gate'
  | 'timelock_addition'
  | 'source_verification'
  | 'manual_only';

export interface RemediationResult {
  findingId: string;
  findingTitle: string;
  findingSeverity: string;
  isAutoFixable: boolean;
  remediationType: RemediationType;
  // Code patches
  patchFiles: PatchFile[];
  unifiedDiff: string;
  // PR metadata
  pr: PullRequestMeta;
  // Explanation
  explanation: string;
  steps: string[];
  estimatedEffort: 'minutes' | 'hours' | 'days';
  references: string[];
  // Warnings
  warnings: string[];
  generatedAt: string;
}

export interface PatchFile {
  path: string; // relative file path in the project
  originalCode: string; // the section being replaced (for diff)
  patchedCode: string; // the replacement
  description: string;
}

export interface PullRequestMeta {
  title: string;
  branch: string; // e.g. "fix/reentrancy-guard-swap-CAuditId"
  body: string;
  labels: string[];
  commitMsg: string;
}

// ── Category → remediation type mapping ──────────────────────────────────────

const FINDING_TO_REMEDIATION: Record<string, RemediationType> = {
  'CWE-841': 'reentrancy_guard', // reentrancy
  'CWE-284': 'access_control', // improper access control
  'CWE-285': 'access_control', // improper authorization
  'CWE-190': 'overflow_check', // integer overflow
  'CWE-191': 'overflow_check', // integer underflow
  'CWE-20': 'access_control', // improper input validation
};

function inferRemediationType(finding: {
  cweId?: string | null;
  title: string;
  category: string;
  severity: string;
}): RemediationType {
  if (finding.cweId) {
    const mapped = FINDING_TO_REMEDIATION[finding.cweId];
    if (mapped) return mapped;
  }
  const title = finding.title.toLowerCase();
  const cat = finding.category.toLowerCase();

  if (/reentrancy|drain|re-?entr/.test(title)) return 'reentrancy_guard';
  if (/access\s*control|unauthorized|privilege/.test(title)) return 'access_control';
  if (/overflow|underflow|arithmetic/.test(title)) return 'overflow_check';
  if (/upgrade.*authority|single.?key/.test(title)) return 'timelock_addition';
  if (/sanction|ofac|compliance/.test(title)) return 'sanctions_gate';
  if (/dependency|supply.?chain|crate/.test(title)) return 'dependency_update';
  if (/source.*(not|un).*verif/.test(title)) return 'source_verification';
  if (cat === 'governance') return 'timelock_addition';
  if (cat === 'compliance') return 'sanctions_gate';

  return 'manual_only';
}

// ── Code patch generators ─────────────────────────────────────────────────────

function genReentrancyGuard(contractAddress: string, funcName: string): PatchFile[] {
  const storageKey = `REENTRANCY_GUARD_${funcName.toUpperCase().replace(/\W/g, '_')}`;
  return [
    {
      path: 'src/lib.rs',
      originalCode: `// [REMEDIATION TARGET]\npub fn ${funcName}(`,
      patchedCode: `// ── Reentrancy guard ────────────────────────────────────────────────────\n// Storage key used as a mutex; panics if called recursively.\nconst ${storageKey}: Symbol = symbol_short!("${funcName.slice(0, 9)}_lk");\n\nfn check_reentrancy(env: &Env) {\n    if env.storage().instance().has(&${storageKey}) {\n        panic!("reentrancy: reentrant call to ${funcName} is not allowed");\n    }\n    env.storage().instance().set(&${storageKey}, &true);\n}\n\nfn clear_reentrancy(env: &Env) {\n    env.storage().instance().remove(&${storageKey});\n}\n\npub fn ${funcName}(`,
      description: `Add reentrancy mutex to ${funcName} via instance storage flag`,
    },
    {
      path: 'src/lib.rs',
      originalCode: `    // [FUNCTION BODY START — ${funcName}]`,
      patchedCode: `    check_reentrancy(&env);\n    // [FUNCTION BODY START — ${funcName}]`,
      description: 'Lock at function entry',
    },
    {
      path: 'src/lib.rs',
      originalCode: `    // [FUNCTION BODY END — ${funcName}]`,
      patchedCode: `    // [FUNCTION BODY END — ${funcName}]\n    clear_reentrancy(&env);`,
      description: 'Clear lock at function exit (before any early returns too)',
    },
  ];
}

function genAccessControl(ownerField: string, funcName: string): PatchFile[] {
  return [
    {
      path: 'src/lib.rs',
      originalCode: `// [REMEDIATION TARGET — access control]\npub fn ${funcName}(`,
      patchedCode: `// ── Access control guard ────────────────────────────────────────────────\nfn require_admin(env: &Env) {\n    let admin: Address = env.storage().instance()\n        .get(&Symbol::new(env, "${ownerField}"))\n        .expect("admin not initialised");\n    admin.require_auth();\n}\n\npub fn ${funcName}(`,
      description: `Add require_admin() check to ${funcName}`,
    },
    {
      path: 'src/lib.rs',
      originalCode: `    // [FUNCTION BODY START — ${funcName}]`,
      patchedCode: `    require_admin(&env);\n    // [FUNCTION BODY START — ${funcName}]`,
      description: 'Enforce admin auth at function entry',
    },
  ];
}

function genOverflowCheck(funcName: string): PatchFile[] {
  return [
    {
      path: 'src/lib.rs',
      originalCode: `// [REMEDIATION TARGET — overflow]\npub fn ${funcName}(`,
      patchedCode: `// ── Checked arithmetic helpers ──────────────────────────────────────────\n// Replace a + b with checked_add(a, b); panics on overflow instead of\n// wrapping silently (the default in release Wasm without overflow-checks).\nfn checked_add(a: i128, b: i128) -> i128 {\n    a.checked_add(b).expect("arithmetic overflow in ${funcName}")\n}\nfn checked_sub(a: i128, b: i128) -> i128 {\n    a.checked_sub(b).expect("arithmetic underflow in ${funcName}")\n}\nfn checked_mul(a: i128, b: i128) -> i128 {\n    a.checked_mul(b).expect("arithmetic overflow (mul) in ${funcName}")\n}\n\npub fn ${funcName}(`,
      description: `Replace raw arithmetic with checked_add/sub/mul in ${funcName}`,
    },
  ];
}

function genTimelockAddition(contractAddress: string): PatchFile[] {
  return [
    {
      path: 'src/lib.rs',
      originalCode: `// [REMEDIATION TARGET — timelock]\npub fn upgrade(`,
      patchedCode: `// ── Upgrade timelock (48-hour minimum delay) ─────────────────────────────\nconst TIMELOCK_DELAY_LEDGERS: u32 = 17280; // ~48 h at 5-s ledger close time\nconst PENDING_UPGRADE_KEY: Symbol = symbol_short!("upg_pend");\n\n/// Queue an upgrade. The new WASM hash is stored with a "not before" ledger.\npub fn queue_upgrade(env: Env, new_wasm_hash: BytesN<32>) {\n    let admin: Address = env.storage().instance()\n        .get(&Symbol::new(&env, "admin")).expect("admin not set");\n    admin.require_auth();\n    let execute_after = env.ledger().sequence() + TIMELOCK_DELAY_LEDGERS;\n    env.storage().instance().set(&PENDING_UPGRADE_KEY, &(new_wasm_hash, execute_after));\n}\n\npub fn upgrade(`,
      description: 'Replace immediate upgrade with 48-hour queued timelock pattern',
    },
    {
      path: 'src/lib.rs',
      originalCode: `    // [FUNCTION BODY START — upgrade]`,
      patchedCode: `    // Timelock enforcement\n    let (pending_hash, execute_after): (BytesN<32>, u32) = env\n        .storage().instance().get(&PENDING_UPGRADE_KEY)\n        .expect("no upgrade queued — call queue_upgrade first");\n    if env.ledger().sequence() < execute_after {\n        panic!("timelock: upgrade not yet executable (queued until ledger {})", execute_after);\n    }\n    env.storage().instance().remove(&PENDING_UPGRADE_KEY);\n    // [FUNCTION BODY START — upgrade]`,
      description: 'Enforce timelock at upgrade execution',
    },
  ];
}

function genSanctionsGate(funcName: string): PatchFile[] {
  return [
    {
      path: 'src/lib.rs',
      originalCode: `// [REMEDIATION TARGET — sanctions]\npub fn ${funcName}(`,
      patchedCode: `// ── Sanctions screening gate ─────────────────────────────────────────────\n// In production, replace the placeholder list with a call to an on-chain\n// oracle contract that maintains an up-to-date OFAC/EU sanctions list.\nconst SANCTIONS_ORACLE: Symbol = symbol_short!("sanct_ora");\n\nfn require_not_sanctioned(env: &Env, address: &Address) {\n    // If a sanctions oracle contract is registered, delegate to it.\n    if let Some(oracle_id) = env.storage().persistent().get::<Symbol, Address>(&SANCTIONS_ORACLE) {\n        let is_sanctioned: bool = env.invoke_contract(\n            &oracle_id,\n            &Symbol::new(env, "is_sanctioned"),\n            soroban_sdk::vec![env, address.to_val()],\n        );\n        if is_sanctioned { panic!("transfer blocked: sanctioned address"); }\n    }\n}\n\npub fn ${funcName}(`,
      description: `Add sanctions screening gate to ${funcName}`,
    },
    {
      path: 'src/lib.rs',
      originalCode: `    // [FUNCTION BODY START — ${funcName}]`,
      patchedCode: `    require_not_sanctioned(&env, &from);\n    require_not_sanctioned(&env, &to);\n    // [FUNCTION BODY START — ${funcName}]`,
      description: 'Screen sender and recipient before transfer execution',
    },
  ];
}

function genDependencyUpdate(finding: { title: string }): PatchFile[] {
  // Extract crate name from finding title if possible
  const crateMatch = finding.title
    .match(/\b([a-z][a-z0-9_-]+)\b/g)
    ?.find(
      (w) =>
        !['the', 'a', 'an', 'in', 'of', 'for', 'and', 'or', 'with', 'that', 'this'].includes(w),
    );
  const crateName = crateMatch ?? 'vulnerable-crate';

  return [
    {
      path: 'Cargo.toml',
      originalCode: `${crateName} = "*"`,
      patchedCode: `# Updated to resolve security advisory — pin to latest patched version.\n${crateName} = "{ version = ">= 0.0.0", features = [] }" # TODO: replace with exact patched version`,
      description: `Pin ${crateName} to a patched version`,
    },
    {
      path: 'Cargo.lock',
      originalCode: '# [AUTO-GENERATED — run cargo update]',
      patchedCode:
        '# Run: cargo update -p ' + crateName + '\n# Then commit the updated Cargo.lock.',
      description: `Regenerate lockfile after updating ${crateName}`,
    },
  ];
}

function genSourceVerification(contractAddress: string): PatchFile[] {
  return [
    {
      path: 'scripts/verify.sh',
      originalCode: '',
      patchedCode: `#!/bin/bash
# Auto-generated source verification script
# Run this after setting CONTRACT_ADDRESS and ARCHIVE_PATH env vars.
set -euo pipefail

CONTRACT_ADDRESS="${contractAddress}"
ARCHIVE_PATH="${'{'}ARCHIVE_PATH:-dist/contract.tar.gz{'}'}"
API_BASE="${'{'}API_BASE:-https://explorer.soroban.network{'}'}"

echo "Submitting source archive for verification..."
RESPONSE=$(curl -sX POST "$API_BASE/api/v1/verify" \\
  -F "archive=@$ARCHIVE_PATH" \\
  -F "contractAddress=$CONTRACT_ADDRESS" \\
  -F "toolchain=soroban-cli@latest")

JOB_ID=$(echo "$RESPONSE" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
echo "Verification job submitted: $JOB_ID"
echo "Poll: $API_BASE/api/v1/verify/$JOB_ID"
`,
      description: 'Script to submit source archive for on-chain WASM hash verification',
    },
  ];
}

// ── Unified diff builder ──────────────────────────────────────────────────────

function buildUnifiedDiff(patches: PatchFile[]): string {
  const parts: string[] = [];
  for (const p of patches) {
    if (!p.originalCode && !p.patchedCode) continue;
    parts.push(`--- a/${p.path}`);
    parts.push(`+++ b/${p.path}`);
    parts.push(
      `@@ -1,${p.originalCode.split('\n').length} +1,${p.patchedCode.split('\n').length} @@`,
    );
    for (const line of p.originalCode.split('\n')) parts.push(`-${line}`);
    for (const line of p.patchedCode.split('\n')) parts.push(`+${line}`);
    parts.push('');
  }
  return parts.join('\n');
}

// ── PR metadata builder ───────────────────────────────────────────────────────

function buildPrMeta(
  remType: RemediationType,
  finding: { id: string; title: string; severity: string },
  contractAddress: string,
): PullRequestMeta {
  const shortAddr = contractAddress.slice(0, 10);
  const branchMap: Record<RemediationType, string> = {
    reentrancy_guard: `fix/reentrancy-guard-${finding.id.slice(0, 8)}`,
    access_control: `fix/access-control-${finding.id.slice(0, 8)}`,
    dependency_update: `fix/dependency-update-${finding.id.slice(0, 8)}`,
    overflow_check: `fix/overflow-check-${finding.id.slice(0, 8)}`,
    sanctions_gate: `fix/sanctions-gate-${finding.id.slice(0, 8)}`,
    timelock_addition: `fix/timelock-upgrade-${finding.id.slice(0, 8)}`,
    source_verification: `chore/source-verification-${shortAddr}`,
    manual_only: `fix/manual-${finding.id.slice(0, 8)}`,
  };

  const titleMap: Record<RemediationType, string> = {
    reentrancy_guard: `fix: add reentrancy guard to vulnerable function`,
    access_control: `fix: enforce access control on privileged function`,
    dependency_update: `fix: update vulnerable dependency`,
    overflow_check: `fix: replace raw arithmetic with checked operations`,
    sanctions_gate: `fix: add sanctions screening gate to transfer`,
    timelock_addition: `fix: add 48-hour timelock to upgrade authority`,
    source_verification: `chore: add source verification script`,
    manual_only: `fix: address ${finding.severity} security finding`,
  };

  const body = [
    `## Automated Remediation`,
    ``,
    `**Finding:** ${finding.title}`,
    `**Severity:** ${finding.severity.toUpperCase()}`,
    `**Finding ID:** \`${finding.id}\``,
    `**Contract:** \`${contractAddress}\``,
    ``,
    `### What changed`,
    titleMap[remType],
    ``,
    `### Review checklist`,
    `- [ ] Review all changed files carefully`,
    `- [ ] Run \`cargo test\` and ensure no regressions`,
    `- [ ] Re-run the automated audit after merging`,
    `- [ ] Update CHANGELOG`,
    ``,
    `_Generated by Soroban Smart Block Explorer Audit Platform_`,
  ].join('\n');

  return {
    title: titleMap[remType],
    branch: branchMap[remType],
    body,
    labels: ['security', 'automated-remediation', finding.severity],
    commitMsg: `${titleMap[remType]} (finding ${finding.id.slice(0, 8)})`,
  };
}

// ── Main remediation generator ────────────────────────────────────────────────

export function generateRemediation(finding: {
  id: string;
  title: string;
  severity: string;
  category: string;
  description: string;
  detail?: string | null;
  cweId?: string | null;
  txHash?: string | null;
  contractAddress: string;
}): RemediationResult {
  const remType = inferRemediationType(finding);
  const isAutoFixable = remType !== 'manual_only';

  // Infer a function name from the finding title for code generation
  const funcMatch = finding.title.match(
    /\b(swap|transfer|withdraw|deposit|upgrade|mint|burn|borrow|repay)\b/i,
  );
  const funcName = funcMatch?.[1]?.toLowerCase() ?? 'target_function';
  const ownerField = 'admin';

  let patches: PatchFile[] = [];

  if (isAutoFixable) {
    switch (remType) {
      case 'reentrancy_guard':
        patches = genReentrancyGuard(finding.contractAddress, funcName);
        break;
      case 'access_control':
        patches = genAccessControl(ownerField, funcName);
        break;
      case 'overflow_check':
        patches = genOverflowCheck(funcName);
        break;
      case 'timelock_addition':
        patches = genTimelockAddition(finding.contractAddress);
        break;
      case 'sanctions_gate':
        patches = genSanctionsGate(funcName);
        break;
      case 'dependency_update':
        patches = genDependencyUpdate(finding);
        break;
      case 'source_verification':
        patches = genSourceVerification(finding.contractAddress);
        break;
    }
  }

  const unifiedDiff = buildUnifiedDiff(patches);
  const pr = buildPrMeta(remType, finding, finding.contractAddress);

  // Explanations + steps + references per type
  const EXPLANATIONS: Record<
    RemediationType,
    {
      explanation: string;
      steps: string[];
      effort: 'minutes' | 'hours' | 'days';
      refs: string[];
      warnings: string[];
    }
  > = {
    reentrancy_guard: {
      explanation:
        'The function modifies contract state before completing all external calls, enabling a re-entrant attacker to call it repeatedly before the state update finalises. The patch introduces an instance-storage mutex that panics on re-entry.',
      steps: [
        'Apply the generated patch to src/lib.rs',
        'Add check_reentrancy() at the START of every state-mutating function',
        'Add clear_reentrancy() at every exit path (including early returns)',
        'Run cargo test to verify no regressions',
        'Re-submit to the audit platform to confirm the finding is resolved',
      ],
      effort: 'hours',
      refs: ['https://use.ink/docs/basics/reentrancy', 'CWE-841'],
      warnings: [
        'Ensure clear_reentrancy() is called on ALL return paths including panics — consider using a drop guard pattern in production.',
      ],
    },
    access_control: {
      explanation:
        'Privileged operations are callable by any address without authentication. The patch adds a require_admin() helper that reads the admin address from instance storage and calls require_auth().',
      steps: [
        'Apply the generated patch',
        'Ensure the admin address is initialised in your __constructor or init function',
        'Call require_admin(&env) at the start of every privileged function',
        'Test with a non-admin address to confirm the auth check fires',
      ],
      effort: 'hours',
      refs: ['https://soroban.stellar.org/docs/learn/authorization-guide', 'CWE-284'],
      warnings: [
        'Store the admin address in persistent storage if it needs to survive TTL expiry.',
      ],
    },
    overflow_check: {
      explanation:
        'Raw integer arithmetic in Soroban Wasm does not panic on overflow in release builds — it wraps silently. The patch replaces +/−/* with checked_add/checked_sub/checked_mul helpers that panic on overflow.',
      steps: [
        'Replace all arithmetic operators in the flagged function with the checked_ helpers',
        'Enable RUSTFLAGS=-C overflow-checks=on in your CI for debug builds',
        'Add property-based tests covering boundary values (i128::MAX, 0, negative)',
      ],
      effort: 'hours',
      refs: ['https://doc.rust-lang.org/std/primitive.i128.html#method.checked_add', 'CWE-190'],
      warnings: [
        'checked_* helpers panic — ensure your contract handles the panic gracefully from the caller perspective.',
      ],
    },
    timelock_addition: {
      explanation:
        'The upgrade authority is controlled by a single key with no delay, allowing immediate code changes. The patch adds a 48-hour (17 280 ledger) queued-upgrade pattern.',
      steps: [
        'Deploy the patched contract',
        'Update your upgrade workflow: call queue_upgrade() → wait 48 h → call upgrade()',
        'Store the new queue_upgrade entry point in your admin documentation',
        'Consider adding a cancellation function for emergency governance',
      ],
      effort: 'days',
      refs: ['https://soroban.stellar.org/docs/learn/contract-lifecycle#upgrading-contracts'],
      warnings: [
        'The 48-hour delay applies to ALL upgrades including emergency patches — add an emergency bypass with stricter multi-sig if needed.',
      ],
    },
    sanctions_gate: {
      explanation:
        'Transfer functions do not screen addresses against sanctions lists, creating compliance exposure. The patch adds an oracle-delegated screening gate.',
      steps: [
        'Deploy or register a sanctions oracle contract',
        'Set the oracle address via env.storage().persistent().set(&SANCTIONS_ORACLE, &oracle_id)',
        'Apply the patch to add require_not_sanctioned() calls',
        'Test with a mock oracle returning both true and false',
      ],
      effort: 'days',
      refs: [
        'https://home.treasury.gov/policy-issues/financial-sanctions/sanctions-programs-and-country-information',
      ],
      warnings: [
        'The oracle contract itself must be kept up-to-date. Consider a time-to-live on the sanctions list cache.',
      ],
    },
    dependency_update: {
      explanation:
        'A dependency with a known vulnerability is in use. Pin it to the latest patched version in Cargo.toml and regenerate Cargo.lock.',
      steps: [
        'Identify the patched version from the advisory (check crates.io or RustSec)',
        'Update Cargo.toml as shown in the diff',
        'Run: cargo update -p <crate-name>',
        'Run cargo audit to confirm the advisory is resolved',
        'Run cargo test',
      ],
      effort: 'minutes',
      refs: ['https://rustsec.org/', 'https://crates.io/'],
      warnings: [
        'If the patched version introduces breaking API changes, a code migration may be required.',
      ],
    },
    source_verification: {
      explanation:
        'Source code has not been verified against the on-chain WASM hash. The generated script automates archive submission to the explorer verification API.',
      steps: [
        'Build your contract: cargo build --target wasm32-unknown-unknown --release',
        'Package your sources: tar -czf dist/contract.tar.gz src/ Cargo.toml',
        'Run: ARCHIVE_PATH=dist/contract.tar.gz bash scripts/verify.sh',
        'Poll the returned job ID until status = verified',
      ],
      effort: 'minutes',
      refs: ['/api/v1/verify'],
      warnings: ['Ensure the toolchain version matches what was used for the on-chain deployment.'],
    },
    manual_only: {
      explanation:
        'This finding requires manual expert remediation — no automated patch is available.',
      steps: [
        'Review the finding detail and recommendation carefully',
        'Engage a qualified Soroban smart contract auditor',
        'Implement the fix following the recommendation',
        'Re-run the audit to confirm resolution',
      ],
      effort: 'days',
      refs: [],
      warnings: [
        'Do not mark this finding as resolved without a verified code fix or documented exception.',
      ],
    },
  };

  const meta = EXPLANATIONS[remType];

  return {
    findingId: finding.id,
    findingTitle: finding.title,
    findingSeverity: finding.severity,
    isAutoFixable,
    remediationType: remType,
    patchFiles: patches,
    unifiedDiff,
    pr,
    explanation: meta.explanation,
    steps: meta.steps,
    estimatedEffort: meta.effort,
    references: meta.refs,
    warnings: meta.warnings,
    generatedAt: new Date().toISOString(),
  };
}
