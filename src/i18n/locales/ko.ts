/**
 * Korean (ko) translation dictionary.
 * Placeholders use {name} syntax — must match the English keys exactly.
 */
export const ko: Record<string, string> = {
  // ── General ──────────────────────────────────────────────────────────────
  'general.not_found': '리소스를 찾을 수 없습니다',
  'general.bad_request': '잘못된 요청: {reason}',
  'general.internal_error': '내부 서버 오류',
  'general.unauthorized': '인증되지 않음',
  'general.forbidden': '접근 금지',
  'general.ok': '확인',

  // ── Transactions ─────────────────────────────────────────────────────────
  'transaction.not_found': '트랜잭션을 찾을 수 없습니다',
  'transaction.swap_description':
    '주소 {from}이(가) {amountIn} {assetIn} → {amountOut} {assetOut}을(를) 스왑했습니다',
  'transaction.transfer_description':
    '주소 {from}이(가) {to}에게 {amount} {asset}을(를) 전송했습니다',
  'transaction.mint_description': '주소 {minter}이(가) {amount} {asset}을(를) 발행했습니다',
  'transaction.burn_description': '주소 {burner}이(가) {amount} {asset}을(를) 소각했습니다',
  'transaction.invoke_description':
    '주소 {caller}이(가) 컨트랙트 {contract}에서 {function}을(를) 호출했습니다',
  'transaction.status_success': '성공',
  'transaction.status_failed': '실패',
  'transaction.failure_reason': '트랜잭션 실패: {reason}',
  'transaction.fee_charged': '수수료 청구: {fee} stroops',

  // ── Contracts ────────────────────────────────────────────────────────────
  'contract.not_found': '컨트랙트를 찾을 수 없습니다',
  'contract.verified': '컨트랙트 {address}이(가) 검증되었습니다',
  'contract.unverified': '컨트랙트 {address}이(가) 검증되지 않았습니다',
  'contract.deployed': '컨트랙트가 레저 {ledger}의 {address}에 배포되었습니다',
  'contract.upgraded': '컨트랙트 {address}이(가) {oldHash}에서 {newHash}로 업그레이드되었습니다',

  // ── Tokens ───────────────────────────────────────────────────────────────
  'token.not_found': '토큰을 찾을 수 없습니다',
  'token.transfer': '{from}에서 {to}로 {amount} {symbol} 전송됨',
  'token.mint': '{to}에게 {amount} {symbol} 발행됨',
  'token.burn': '{from}에서 {amount} {symbol} 소각됨',
  'token.approval': '{owner}이(가) {spender}에게 {amount} {symbol} 사용 승인',

  // ── Wallets ──────────────────────────────────────────────────────────────
  'wallet.not_found': '지갑을 찾을 수 없습니다',
  'wallet.balance': '잔액: {amount} {asset}',
  'wallet.transaction_count': '{count}개의 트랜잭션 발견',

  // ── Events ───────────────────────────────────────────────────────────────
  'event.not_found': '이벤트를 찾을 수 없습니다',
  'event.type_transfer': '컨트랙트 {contract}의 전송 이벤트',
  'event.type_swap': '컨트랙트 {contract}의 스왑 이벤트',
  'event.type_mint': '컨트랙트 {contract}의 발행 이벤트',
  'event.type_burn': '컨트랙트 {contract}의 소각 이벤트',
  'event.type_custom': '컨트랙트 {contract}의 커스텀 이벤트 "{symbol}"',

  // ── DEX ──────────────────────────────────────────────────────────────────
  'dex.swap_route': '{pool}을(를) 통해 {amountIn} {assetIn} → {amountOut} {assetOut} 스왑',
  'dex.liquidity_added':
    '{provider}이(가) 풀 {pool}에 {amountA} {assetA} + {amountB} {assetB} 추가',
  'dex.liquidity_removed': '{provider}이(가) 풀 {pool}에서 유동성 제거',
  'dex.pool_not_found': '유동성 풀을 찾을 수 없습니다',

  // ── NFT ──────────────────────────────────────────────────────────────────
  'nft.minted': 'NFT #{tokenId}이(가) 컨트랙트 {contract}에서 {owner}에게 발행됨',
  'nft.transferred': 'NFT #{tokenId}이(가) {from}에서 {to}로 전송됨',
  'nft.burned': 'NFT #{tokenId}이(가) {owner}에 의해 소각됨',
  'nft.not_found': 'NFT를 찾을 수 없습니다',

  // ── Compliance ───────────────────────────────────────────────────────────
  'compliance.sanctioned_sender': '발신자 {address}이(가) {list} 제재 목록에 있습니다',
  'compliance.sanctioned_receiver': '수신자 {address}이(가) {list} 제재 목록에 있습니다',
  'compliance.clean': '컴플라이언스 플래그가 없습니다',
  'compliance.flagged': '{count}개의 컴플라이언스 플래그 감지됨',

  // ── Analytics ────────────────────────────────────────────────────────────
  'analytics.gas_avg': '평균 가스 수수료: {avg} stroops',
  'analytics.gas_peak': '최대 가스 수수료: {peak} stroops',
  'analytics.volume_spike': '{contract}에서 거래량 급증 감지: {count}건 (z-점수: {zScore})',
  'analytics.no_data': '요청한 기간에 대한 분석 데이터가 없습니다',

  // ── Alerts ───────────────────────────────────────────────────────────────
  'alert.reentrancy': '컨트랙트 {contract}에서 재진입 공격 감지됨 (심각도: {severity})',
  'alert.flash_loan': '트랜잭션 {hash}에서 플래시 론 공격 감지됨',
  'alert.volume_spike': '{contract}에서 비정상적인 거래량 급증',
  'alert.low_balance': '재무 지갑 {address}의 잔액이 임계값 미만입니다',

  // ── i18n system ──────────────────────────────────────────────────────────
  'i18n.key_created': '번역 키 "{key}" 생성됨',
  'i18n.translation_added': '{language}의 "{key}" 번역이 추가됨',
  'i18n.translation_approved': '{approver}에 의해 번역 승인됨',
  'i18n.key_not_found': '번역 키 "{key}"를 찾을 수 없습니다',
  'i18n.language_not_supported': '"{language}" 언어는 지원되지 않습니다. 지원 언어: {supported}',
  'i18n.bulk_seeded': '{count}개의 번역 키가 성공적으로 시드됨',
};
