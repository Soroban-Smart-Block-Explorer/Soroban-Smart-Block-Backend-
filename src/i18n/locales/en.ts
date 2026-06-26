/**
 * English (en) — default / fallback locale.
 * Keys follow dot-notation: <domain>.<key>
 * Placeholders use {name} syntax.
 */
export const en: Record<string, string> = {
  // ── General ──────────────────────────────────────────────────────────────
  'general.not_found': 'Resource not found',
  'general.bad_request': 'Bad request: {reason}',
  'general.internal_error': 'Internal server error',
  'general.unauthorized': 'Unauthorized',
  'general.forbidden': 'Forbidden',
  'general.ok': 'OK',

  // ── Transactions ─────────────────────────────────────────────────────────
  'transaction.not_found': 'Transaction not found',
  'transaction.swap_description':
    'Address {from} swapped {amountIn} {assetIn} → {amountOut} {assetOut}',
  'transaction.transfer_description': 'Address {from} transferred {amount} {asset} to {to}',
  'transaction.mint_description': 'Address {minter} minted {amount} {asset}',
  'transaction.burn_description': 'Address {burner} burned {amount} {asset}',
  'transaction.invoke_description': 'Address {caller} invoked {function} on contract {contract}',
  'transaction.status_success': 'Success',
  'transaction.status_failed': 'Failed',
  'transaction.failure_reason': 'Transaction failed: {reason}',
  'transaction.fee_charged': 'Fee charged: {fee} stroops',

  // ── Contracts ────────────────────────────────────────────────────────────
  'contract.not_found': 'Contract not found',
  'contract.verified': 'Contract {address} is verified',
  'contract.unverified': 'Contract {address} is not verified',
  'contract.deployed': 'Contract deployed at {address} in ledger {ledger}',
  'contract.upgraded': 'Contract {address} upgraded from {oldHash} to {newHash}',

  // ── Tokens ───────────────────────────────────────────────────────────────
  'token.not_found': 'Token not found',
  'token.transfer': '{amount} {symbol} transferred from {from} to {to}',
  'token.mint': '{amount} {symbol} minted to {to}',
  'token.burn': '{amount} {symbol} burned from {from}',
  'token.approval': '{owner} approved {spender} to spend {amount} {symbol}',

  // ── Wallets ──────────────────────────────────────────────────────────────
  'wallet.not_found': 'Wallet not found',
  'wallet.balance': 'Balance: {amount} {asset}',
  'wallet.transaction_count': '{count} transactions found',

  // ── Events ───────────────────────────────────────────────────────────────
  'event.not_found': 'Event not found',
  'event.type_transfer': 'Transfer event on contract {contract}',
  'event.type_swap': 'Swap event on contract {contract}',
  'event.type_mint': 'Mint event on contract {contract}',
  'event.type_burn': 'Burn event on contract {contract}',
  'event.type_custom': 'Custom event "{symbol}" on contract {contract}',

  // ── DEX ──────────────────────────────────────────────────────────────────
  'dex.swap_route': 'Swap {amountIn} {assetIn} → {amountOut} {assetOut} via {pool}',
  'dex.liquidity_added': '{provider} added {amountA} {assetA} + {amountB} {assetB} to pool {pool}',
  'dex.liquidity_removed': '{provider} removed liquidity from pool {pool}',
  'dex.pool_not_found': 'Liquidity pool not found',

  // ── NFT ──────────────────────────────────────────────────────────────────
  'nft.minted': 'NFT #{tokenId} minted to {owner} on contract {contract}',
  'nft.transferred': 'NFT #{tokenId} transferred from {from} to {to}',
  'nft.burned': 'NFT #{tokenId} burned by {owner}',
  'nft.not_found': 'NFT not found',

  // ── Compliance ───────────────────────────────────────────────────────────
  'compliance.sanctioned_sender': 'Sender {address} is on the {list} sanctions list',
  'compliance.sanctioned_receiver': 'Receiver {address} is on the {list} sanctions list',
  'compliance.clean': 'No compliance flags found',
  'compliance.flagged': '{count} compliance flag(s) detected',

  // ── Analytics ────────────────────────────────────────────────────────────
  'analytics.gas_avg': 'Average gas fee: {avg} stroops',
  'analytics.gas_peak': 'Peak gas fee: {peak} stroops',
  'analytics.volume_spike':
    'Volume spike detected on {contract}: {count} transactions (z-score: {zScore})',
  'analytics.no_data': 'No analytics data available for the requested period',

  // ── Alerts ───────────────────────────────────────────────────────────────
  'alert.reentrancy': 'Re-entrancy attack detected on contract {contract} (severity: {severity})',
  'alert.flash_loan': 'Flash loan attack detected in transaction {hash}',
  'alert.volume_spike': 'Unusual volume spike on {contract}',
  'alert.low_balance': 'Treasury wallet {address} balance below threshold',

  // ── i18n system ──────────────────────────────────────────────────────────
  'i18n.key_created': 'Translation key "{key}" created',
  'i18n.translation_added': 'Translation for "{key}" in {language} added',
  'i18n.translation_approved': 'Translation approved by {approver}',
  'i18n.key_not_found': 'Translation key "{key}" not found',
  'i18n.language_not_supported': 'Language "{language}" is not supported. Supported: {supported}',
  'i18n.bulk_seeded': '{count} translation keys seeded successfully',
};
