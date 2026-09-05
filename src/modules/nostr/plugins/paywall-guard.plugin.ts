import {
  ClientContext,
  Event,
  HandleMessagePlugin,
  HandleMessageResult,
  IncomingMessage,
  MessageType,
} from '@nostr-relay/common';
import { okDuplicate } from '@nostr-paywall/protocol';
import { PaywallService } from '../services/paywall.service';

/**
 * 유료 발행 가드.
 *
 * `BeforeHandleEventPlugin` 이 아니라 `HandleMessagePlugin` 을 쓰는 이유:
 * 저장 결과(`next()` 의 반환)를 봐야 **저장 실패 시 환불**을 할 수 있다.
 * 전자는 저장 전에 반환하고 끝이라 돈만 받고 이벤트는 없는 상태를 막을 방법이 없다.
 */
export class PaywallGuardPlugin implements HandleMessagePlugin {
  constructor(private readonly paywall: PaywallService) {}

  async handleMessage(
    _ctx: ClientContext,
    message: IncomingMessage,
    next: () => Promise<HandleMessageResult>,
  ): Promise<HandleMessageResult> {
    if (message[0] !== MessageType.EVENT) return next();

    const event = message[1] as Event;
    const guard = this.paywall.getGuard();
    if (!guard) return next();

    try {
      // 중복 확인을 **과금보다 먼저** 한다. 릴레이 코어는 이 검사를 플러그인 뒤에 하므로
      // 여기서 안 하면 이미 저장된 이벤트에 돈을 받게 된다.
      if (await this.paywall.isStored(event.id)) {
        return { messageType: MessageType.EVENT, success: true, message: okDuplicate() };
      }

      const envelope = this.paywall.consumeEnvelope(event.id);
      const outcome = await guard.check(event, envelope);

      if (outcome.kind === 'reject') {
        return {
          messageType: MessageType.EVENT,
          success: false,
          message: outcome.okMessage,
        };
      }

      const result = await next();

      // 수납했는데 저장이 실패했다 → 받은 걸 돌려준다. 이 경로가 없으면
      // "결제 외 모든 거부 사유를 먼저 검사한다"는 순서가 말뿐이 된다.
      if (
        outcome.kind === 'collected' &&
        result &&
        result.messageType === MessageType.EVENT &&
        !result.success
      ) {
        const message = await guard.onStorageFailed(event.id, outcome.refundToken);
        return { ...result, message };
      }

      return result;
    } finally {
      // 거부·예외 어느 경로로 빠져나가도 봉투를 남기지 않는다.
      this.paywall.releaseEnvelope(event.id);
    }
  }
}
