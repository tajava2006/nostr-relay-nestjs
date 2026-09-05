import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CashuCollector } from '@nostr-paywall/collectors';
import { takePaymentEnvelope } from '@nostr-paywall/protocol';
import type { PaymentEnvelope } from '@nostr-paywall/protocol';
import {
  PaymentGuard,
  SqlitePaymentRepository,
} from '@nostr-paywall/relay-guard';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Config } from 'src/config';
import { PaywallConfig } from 'src/config/paywall.config';
import { EventRepository } from '../../repositories/event.repository';

/**
 * 유료 발행 배선.
 *
 * 봉투는 `["EVENT", event, payment]` 의 3번째 원소로 오는데, `@nostr-relay/validator` 의
 * EVENT 스키마가 `z.tuple([...2개])` 라 여분 원소를 거부한다. 그래서 **검증 전에** 떼어내
 * 여기 잠깐 보관했다가 플러그인이 꺼내 쓴다.
 */
@Injectable()
export class PaywallService implements OnModuleInit {
  readonly config: PaywallConfig;
  private guard?: PaymentGuard;
  private repository?: SqlitePaymentRepository;

  /**
   * event.id → 봉투. 검증 직전에 심고 처리 직후에 지운다.
   *
   * 한 커넥션의 메시지는 순차 처리되지만 커넥션은 여럿이라 맵으로 둔다.
   * 실패 경로에서 지워지지 않는 걸 막으려고 플러그인이 `finally` 로 거둬간다.
   */
  private readonly pending = new Map<string, PaymentEnvelope>();

  constructor(
    @InjectPinoLogger(PaywallService.name)
    private readonly logger: PinoLogger,
    configService: ConfigService<Config, true>,
    private readonly eventRepository: EventRepository,
  ) {
    this.config = configService.get('paywall', { infer: true });
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) return;
    if (this.config.mints.length === 0) {
      throw new Error(
        'PAYWALL_ENABLED=true 인데 PAYWALL_MINTS 가 비어 있다. 수납할 민트가 없으면 모든 유료 이벤트가 거부된다.',
      );
    }

    this.repository = new SqlitePaymentRepository(this.config.ledgerPath);
    const collector = new CashuCollector({ allowedMints: this.config.mints });
    this.guard = new PaymentGuard({
      terms: this.config.terms,
      collectors: [collector],
      repository: this.repository,
      humanPrice: `${this.config.priceMsat / 1000} sat per event that tags someone`,
    });

    // 부팅 게이트 — 민트가 input_fee_ppk!=0 이면 여기서 던진다.
    // 띄우지 않는 게 맞다: 그 상태로 뜨면 유저 돈만 받고 수납은 실패한다.
    await this.guard.init();

    this.logger.info(
      { mints: this.config.mints, priceMsat: this.config.priceMsat, ledger: this.config.ledgerPath },
      'paywall enabled',
    );
  }

  /** 검증 **전에** 원본 메시지에서 봉투를 떼어낸다. 2원소로 줄인 메시지를 돌려준다. */
  takeEnvelope(data: unknown[]): unknown[] {
    if (!this.config.enabled) return data;
    const split = takePaymentEnvelope(data);
    if (!split) return data;

    const event = split.message[1] as { id?: unknown } | undefined;
    if (split.envelope && event && typeof event.id === 'string') {
      this.pending.set(event.id, split.envelope);
    }
    return split.message;
  }

  consumeEnvelope(eventId: string): PaymentEnvelope | null {
    const envelope = this.pending.get(eventId) ?? null;
    this.pending.delete(eventId);
    return envelope;
  }

  releaseEnvelope(eventId: string): void {
    this.pending.delete(eventId);
  }

  getGuard(): PaymentGuard | undefined {
    return this.guard;
  }

  /**
   * 이미 저장된 이벤트인가.
   *
   * **직접 확인해야 한다.** 릴레이 코어는 중복 검사를 플러그인 *뒤에* 한다
   * (`event.service.ts` — beforeHandleEvent → AUTH → checkEventExists).
   * 그대로 두면 이미 있는 이벤트에 돈을 받게 된다.
   */
  async isStored(eventId: string): Promise<boolean> {
    const found = await this.eventRepository.find({ ids: [eventId], limit: 1 });
    return found.length > 0;
  }

  onApplicationShutdown(): void {
    this.repository?.close();
  }
}
