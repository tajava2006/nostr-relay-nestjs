import {
  ClientContext,
  Event,
  HandleMessagePlugin,
  HandleMessageResult,
  IncomingMessage,
  MessageType,
  createOutgoingOkMessage,
} from '@nostr-relay/common';
import { okDuplicate } from '@nostr-paywall/protocol';
import { PaywallService } from '../services/paywall.service';

/**
 * 유료 발행 가드.
 *
 * ⚠️ **단축 반환할 때 OK 를 직접 보내야 한다.**
 * 코어는 `ctx.sendMessage(createOutgoingOkMessage(...))` 를 `_handleMessage` **안에서**
 * 호출한다(nostr-relay/core 의 handleEventMessage). 즉 `next()` 를 부르지 않으면
 * 반환값은 그냥 반환값일 뿐 클라에 아무것도 안 나간다 — 클라가 영원히 기다린다.
 * (실측: 유료 이벤트를 보내면 OK 없이 소켓이 그대로 멈췄다.)
 *
 * `BeforeHandleEventPlugin` 이 아니라 이 훅을 쓰는 이유는 `next()` 의 저장 결과를
 * 봐야 **수납 후 저장 실패**를 원장에 정확히 남길 수 있기 때문이다.
 */
export class PaywallGuardPlugin implements HandleMessagePlugin {
  constructor(private readonly paywall: PaywallService) {}

  async handleMessage(
    ctx: ClientContext,
    message: IncomingMessage,
    next: () => Promise<HandleMessageResult>,
  ): Promise<HandleMessageResult> {
    if (message[0] !== MessageType.EVENT) return next();

    const event = message[1] as Event;
    const guard = this.paywall.getGuard();
    if (!guard) return next();

    /** 코어를 건너뛰므로 응답도 우리가 보낸다. */
    const respond = (success: boolean, msg: string): HandleMessageResult => {
      ctx.sendMessage(createOutgoingOkMessage(event.id, success, msg));
      return { messageType: MessageType.EVENT, success, message: msg };
    };

    try {
      // 중복 확인을 **과금보다 먼저** 한다. 코어는 이 검사를 플러그인 뒤에 하므로
      // 여기서 안 하면 이미 저장된 이벤트에 돈을 받게 된다.
      if (await this.paywall.isStored(event.id)) {
        return respond(true, okDuplicate());
      }

      const envelope = this.paywall.consumeEnvelope(event.id);
      const outcome = await guard.check(event, envelope);

      if (outcome.kind === 'reject') {
        return respond(false, outcome.okMessage);
      }

      const result = await next();

      // 수납했는데 저장이 실패했다. 원장을 failed 로 되돌려 자산 상태를 정확히 남긴다.
      //
      // ⚠️ 환불 토큰을 **인밴드로 돌려줄 수는 없다** — 코어가 이미 OK 를 보냈고,
      // 같은 event id 로 OK 를 두 번 보내면 클라가 두 번째를 버린다.
      // proofs 는 원장에 남아 있으므로 운영자가 수동 회수할 수 있다. 크게 로그를 남긴다.
      if (
        outcome.kind === 'collected' &&
        result &&
        result.messageType === MessageType.EVENT &&
        !result.success
      ) {
        await this.paywall.onStorageFailedAfterCollect(event.id, outcome);
      }

      return result;
    } finally {
      // 거부·예외 어느 경로로 빠져나가도 봉투를 남기지 않는다.
      this.paywall.releaseEnvelope(event.id);
    }
  }
}
