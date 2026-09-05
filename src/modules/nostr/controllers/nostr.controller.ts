import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Config } from '../../../config';

@Controller()
@ApiExcludeController()
export class NostrController {
  private readonly relayInfoDoc: {
    name: string;
    version: string;
    description: string;
    pubkey?: string;
    contact?: string;
    software: string;
    git_commit_sha?: string;
    supported_nips: number[];
    limitation: {
      max_message_length: number;
      max_subscriptions: number;
      max_filters: number;
      max_limit: number;
      max_subid_length: number;
      max_event_tags: number;
      max_content_length: number;
      min_pow_difficulty: number;
      auth_required: boolean;
      payment_required: boolean;
      restricted_writes: boolean;
      created_at_lower_limit?: number;
      created_at_upper_limit?: number;
    };
    retention: [{ time: null }];
    // 유료 발행일 때만. 클라는 payment-required 를 받은 뒤 이 문서를 lazy fetch 한다.
    fees?: { publication: unknown[] };
    payment_v1?: {
      envelope_in_event_message: boolean;
      methods: unknown[];
    };
  };

  constructor(configService: ConfigService<Config, true>) {
    const relayInfo = configService.get('relayInfo', { infer: true });
    const limitConfig = configService.get('limit', { infer: true });
    const supported_nips = [1, 2, 4, 11, 13, 22, 26, 28, 40];

    const hostname = configService.get('hostname', { infer: true });
    if (hostname) {
      supported_nips.push(42);
    }

    const paywall = configService.get('paywall', { infer: true });

    const meiliSearchConfig = configService.get('meiliSearch', { infer: true });
    if (meiliSearchConfig.apiKey && meiliSearchConfig.host) {
      supported_nips.push(50);
    }

    this.relayInfoDoc = {
      name: relayInfo.name,
      version: relayInfo.version,
      description: relayInfo.description,
      pubkey: relayInfo.pubkey,
      contact: relayInfo.contact,
      software: relayInfo.software,
      git_commit_sha: relayInfo.gitCommitSha,
      supported_nips,
      limitation: {
        max_message_length: 128 * 1024, // 128 KB
        max_subscriptions: limitConfig.maxSubscriptionsPerClient,
        max_filters: 10,
        max_limit: 1000,
        max_subid_length: 128,
        max_event_tags: 2000,
        max_content_length: 102400,
        min_pow_difficulty: limitConfig.minPowDifficulty,
        auth_required: false,
        payment_required: paywall.enabled,
        restricted_writes: paywall.enabled,
        created_at_lower_limit: limitConfig.createdAtLowerLimit,
        created_at_upper_limit: limitConfig.createdAtUpperLimit,
      },
      retention: [{ time: null }],
    };

    // 조건·수단을 기계가 읽을 수 있게 싣는다. **가드와 같은 terms 객체**라 갈릴 수 없다.
    // 아무도 NIP-11 을 선제적으로 읽지 않지만, payment-required 를 받은 뒤엔 읽는다 —
    // 웹소켓과 같은 URL 이라 별도 엔드포인트도 필요 없다.
    if (paywall.enabled) {
      this.relayInfoDoc.fees = { publication: paywall.terms.rules };
      this.relayInfoDoc.payment_v1 = {
        envelope_in_event_message: paywall.terms.envelopeInEventMessage,
        methods: paywall.terms.methods,
      };
    }
  }

  @Get()
  root(@Req() req: Request, @Res() res: Response) {
    if (req.headers.accept === 'application/nostr+json') {
      return res
        .setHeader('content-type', 'application/nostr+json')
        .status(HttpStatus.OK)
        .send(this.relayInfoDoc);
    }

    return res
      .status(HttpStatus.OK)
      .send(
        `Please use a Nostr client to connect. Powered by nostr-relay-nestjs. version: ${this.relayInfoDoc.version} (${this.relayInfoDoc.git_commit_sha})`,
      );
  }
}
