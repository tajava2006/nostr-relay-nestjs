import { defaultRules } from '@nostr-paywall/protocol';
import type { PaymentTerms } from '@nostr-paywall/protocol';
import { Environment } from './environment';

/**
 * 이벤트 단위 유료 발행 설정.
 *
 * 기본 off. 꺼져 있으면 릴레이는 원래대로 동작한다(플러그인도 등록되지 않는다).
 *
 * ⚠️ `ledgerPath` 는 캐시가 아니라 **자산 원장**이다. 수납한 ecash 는 베어러라
 * 이 파일이 유일한 사본이고, 잃으면 걷은 돈이 그대로 증발한다. 백업 대상.
 */
export function paywallConfig(env: Environment) {
  const mints = (env.PAYWALL_MINTS ?? '')
    .split(',')
    .map((m) => m.trim().replace(/\/+$/, ''))
    .filter((m) => m.length > 0);

  const priceMsat = env.PAYWALL_PRICE_MSAT ?? 1000;

  const terms: PaymentTerms = {
    rules: defaultRules(priceMsat),
    methods: mints.length > 0 ? [{ type: 'cashu', unit: 'sat', mints }] : [],
    envelopeInEventMessage: true,
  };

  return {
    enabled: env.PAYWALL_ENABLED ?? false,
    mints,
    priceMsat,
    ledgerPath: env.PAYWALL_LEDGER_PATH ?? './paywall-ledger.db',
    /** NIP-11 문서와 가드가 **같은 객체**를 본다. 두 벌이면 조용히 갈린다. */
    terms,
  };
}

export type PaywallConfig = ReturnType<typeof paywallConfig>;
