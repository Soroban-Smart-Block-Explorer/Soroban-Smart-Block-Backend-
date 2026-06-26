/**
 * Spanish (es) translation dictionary.
 * Placeholders use {name} syntax — must match the English keys exactly.
 */
export const es: Record<string, string> = {
  // ── General ──────────────────────────────────────────────────────────────
  'general.not_found': 'Recurso no encontrado',
  'general.bad_request': 'Solicitud incorrecta: {reason}',
  'general.internal_error': 'Error interno del servidor',
  'general.unauthorized': 'No autorizado',
  'general.forbidden': 'Prohibido',
  'general.ok': 'OK',

  // ── Transactions ─────────────────────────────────────────────────────────
  'transaction.not_found': 'Transacción no encontrada',
  'transaction.swap_description':
    'La dirección {from} intercambió {amountIn} {assetIn} → {amountOut} {assetOut}',
  'transaction.transfer_description': 'La dirección {from} transfirió {amount} {asset} a {to}',
  'transaction.mint_description': 'La dirección {minter} acuñó {amount} {asset}',
  'transaction.burn_description': 'La dirección {burner} quemó {amount} {asset}',
  'transaction.invoke_description':
    'La dirección {caller} invocó {function} en el contrato {contract}',
  'transaction.status_success': 'Exitoso',
  'transaction.status_failed': 'Fallido',
  'transaction.failure_reason': 'La transacción falló: {reason}',
  'transaction.fee_charged': 'Comisión cobrada: {fee} stroops',

  // ── Contracts ────────────────────────────────────────────────────────────
  'contract.not_found': 'Contrato no encontrado',
  'contract.verified': 'El contrato {address} está verificado',
  'contract.unverified': 'El contrato {address} no está verificado',
  'contract.deployed': 'Contrato desplegado en {address} en el ledger {ledger}',
  'contract.upgraded': 'Contrato {address} actualizado de {oldHash} a {newHash}',

  // ── Tokens ───────────────────────────────────────────────────────────────
  'token.not_found': 'Token no encontrado',
  'token.transfer': '{amount} {symbol} transferido de {from} a {to}',
  'token.mint': '{amount} {symbol} acuñado para {to}',
  'token.burn': '{amount} {symbol} quemado de {from}',
  'token.approval': '{owner} autorizó a {spender} a gastar {amount} {symbol}',

  // ── Wallets ──────────────────────────────────────────────────────────────
  'wallet.not_found': 'Billetera no encontrada',
  'wallet.balance': 'Saldo: {amount} {asset}',
  'wallet.transaction_count': '{count} transacciones encontradas',

  // ── Events ───────────────────────────────────────────────────────────────
  'event.not_found': 'Evento no encontrado',
  'event.type_transfer': 'Evento de transferencia en el contrato {contract}',
  'event.type_swap': 'Evento de intercambio en el contrato {contract}',
  'event.type_mint': 'Evento de acuñación en el contrato {contract}',
  'event.type_burn': 'Evento de quema en el contrato {contract}',
  'event.type_custom': 'Evento personalizado "{symbol}" en el contrato {contract}',

  // ── DEX ──────────────────────────────────────────────────────────────────
  'dex.swap_route': 'Intercambio de {amountIn} {assetIn} → {amountOut} {assetOut} vía {pool}',
  'dex.liquidity_added': '{provider} añadió {amountA} {assetA} + {amountB} {assetB} al pool {pool}',
  'dex.liquidity_removed': '{provider} retiró liquidez del pool {pool}',
  'dex.pool_not_found': 'Pool de liquidez no encontrado',

  // ── NFT ──────────────────────────────────────────────────────────────────
  'nft.minted': 'NFT #{tokenId} acuñado para {owner} en el contrato {contract}',
  'nft.transferred': 'NFT #{tokenId} transferido de {from} a {to}',
  'nft.burned': 'NFT #{tokenId} quemado por {owner}',
  'nft.not_found': 'NFT no encontrado',

  // ── Compliance ───────────────────────────────────────────────────────────
  'compliance.sanctioned_sender': 'El remitente {address} está en la lista de sanciones {list}',
  'compliance.sanctioned_receiver':
    'El destinatario {address} está en la lista de sanciones {list}',
  'compliance.clean': 'No se encontraron indicadores de cumplimiento',
  'compliance.flagged': '{count} indicador(es) de cumplimiento detectado(s)',

  // ── Analytics ────────────────────────────────────────────────────────────
  'analytics.gas_avg': 'Comisión de gas promedio: {avg} stroops',
  'analytics.gas_peak': 'Comisión de gas máxima: {peak} stroops',
  'analytics.volume_spike':
    'Pico de volumen detectado en {contract}: {count} transacciones (z-score: {zScore})',
  'analytics.no_data': 'No hay datos de análisis disponibles para el período solicitado',

  // ── Alerts ───────────────────────────────────────────────────────────────
  'alert.reentrancy':
    'Ataque de reentrada detectado en el contrato {contract} (gravedad: {severity})',
  'alert.flash_loan': 'Ataque de préstamo flash detectado en la transacción {hash}',
  'alert.volume_spike': 'Pico de volumen inusual en {contract}',
  'alert.low_balance': 'El saldo de la billetera de tesorería {address} está por debajo del umbral',

  // ── i18n system ──────────────────────────────────────────────────────────
  'i18n.key_created': 'Clave de traducción "{key}" creada',
  'i18n.translation_added': 'Traducción para "{key}" en {language} añadida',
  'i18n.translation_approved': 'Traducción aprobada por {approver}',
  'i18n.key_not_found': 'Clave de traducción "{key}" no encontrada',
  'i18n.language_not_supported':
    'El idioma "{language}" no está soportado. Soportados: {supported}',
  'i18n.bulk_seeded': '{count} claves de traducción sembradas exitosamente',
};
