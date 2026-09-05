import { createMock } from '@golevelup/ts-jest';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { paywallConfig } from '../../../config/paywall.config';
import { EventRepository } from '../../repositories/event.repository';
import { PaywallService } from './paywall.service';

function service(env: Record<string, unknown>, eventRepository = createMock<EventRepository>()) {
  const config = paywallConfig(env as never);
  return new PaywallService(
    createMock<PinoLogger>(),
    createMock<ConfigService>({ get: jest.fn().mockReturnValue(config) }) as never,
    eventRepository,
  );
}

const EVENT = { id: 'a'.repeat(64), kind: 1, tags: [] };
const ENVELOPE = { v: 1, method: 'cashu', mint: 'https://m', unit: 'sat', token: 'cashuBx' };

describe('PaywallService', () => {
  describe('꺼져 있을 때 — 릴레이 동작이 원래와 같아야 한다', () => {
    it('메시지를 손대지 않는다 (같은 배열 참조 그대로)', () => {
      const s = service({});
      const data = ['EVENT', EVENT, ENVELOPE];
      expect(s.takeEnvelope(data)).toBe(data);
      expect(s.enabled).toBe(false);
    });

    it('onModuleInit 이 아무것도 하지 않는다 — 민트 설정이 없어도 부팅된다', async () => {
      const s = service({});
      await expect(s.onModuleInit()).resolves.toBeUndefined();
      expect(s.getGuard()).toBeUndefined();
    });
  });

  describe('켜져 있을 때', () => {
    const env = { PAYWALL_ENABLED: true, PAYWALL_MINTS: 'https://m' };

    it('3원소 EVENT 에서 봉투를 떼고 2원소를 돌려준다', () => {
      // validator 의 EVENT 스키마가 z.tuple([...2개]) 라 3원소면 거부당한다.
      const s = service(env);
      const out = s.takeEnvelope(['EVENT', EVENT, ENVELOPE]);
      expect(out).toHaveLength(2);
      expect(s.consumeEnvelope(EVENT.id)).toEqual(ENVELOPE);
    });

    it('봉투는 한 번만 꺼내진다 — 남기면 다음 이벤트가 남의 결제를 주워 쓴다', () => {
      const s = service(env);
      s.takeEnvelope(['EVENT', EVENT, ENVELOPE]);
      expect(s.consumeEnvelope(EVENT.id)).not.toBeNull();
      expect(s.consumeEnvelope(EVENT.id)).toBeNull();
    });

    it('2원소 EVENT 는 그대로 통과하고 봉투는 없다', () => {
      const s = service(env);
      const out = s.takeEnvelope(['EVENT', EVENT]);
      expect(out).toHaveLength(2);
      expect(s.consumeEnvelope(EVENT.id)).toBeNull();
    });

    it('EVENT 가 아닌 메시지는 손대지 않는다', () => {
      const s = service(env);
      const req = ['REQ', 'sub1', { kinds: [1] }];
      expect(s.takeEnvelope(req)).toBe(req);
    });

    it('민트가 없으면 부팅을 거부한다 — 그 상태로 뜨면 모든 유료 이벤트가 거부된다', async () => {
      const s = service({ PAYWALL_ENABLED: true });
      await expect(s.onModuleInit()).rejects.toThrow(/PAYWALL_MINTS/);
    });

    it('이미 저장된 이벤트를 판별한다 — 릴레이 코어는 중복 검사를 가드 뒤에 하므로 직접 봐야 한다', async () => {
      const repo = createMock<EventRepository>({
        find: jest.fn().mockResolvedValue([EVENT]) as never,
      });
      const s = service(env, repo);
      await expect(s.isStored(EVENT.id)).resolves.toBe(true);
    });
  });

  describe('설정', () => {
    it('민트 목록은 콤마 구분 + 끝 슬래시 정규화', () => {
      const c = paywallConfig({
        PAYWALL_ENABLED: true,
        PAYWALL_MINTS: ' https://a/ , https://b ,, ',
      } as never);
      expect(c.mints).toEqual(['https://a', 'https://b']);
    });

    it('NIP-11 에 실릴 terms 와 가드가 같은 객체를 본다', () => {
      const c = paywallConfig({ PAYWALL_ENABLED: true, PAYWALL_MINTS: 'https://m' } as never);
      expect(c.terms.rules[0].amount).toBe(c.priceMsat);
      expect(c.terms.methods).toEqual([
        { type: 'cashu', unit: 'sat', mints: ['https://m'] },
      ]);
    });

    it('기본 가격은 1 sat', () => {
      expect(paywallConfig({} as never).priceMsat).toBe(1000);
    });
  });
});
