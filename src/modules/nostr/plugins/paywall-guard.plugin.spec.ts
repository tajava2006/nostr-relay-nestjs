import { createMock } from '@golevelup/ts-jest';
import { ClientContext, MessageType } from '@nostr-relay/common';
import { PaywallService } from '../services/paywall.service';
import { PaywallGuardPlugin } from './paywall-guard.plugin';

const EVENT = { id: 'a'.repeat(64), kind: 1, tags: [['p', 'b'.repeat(64)]] };
const MSG = [MessageType.EVENT, EVENT] as never;

function setup(guardBehavior: Record<string, unknown>, paywallOver: Record<string, unknown> = {}) {
  const sendMessage = jest.fn();
  const ctx = createMock<ClientContext>({ sendMessage });
  const paywall = createMock<PaywallService>({
    getGuard: (() => guardBehavior) as never,
    isStored: (async () => false) as never,
    consumeEnvelope: (() => null) as never,
    releaseEnvelope: jest.fn() as never,
    ...paywallOver,
  });
  return { ctx, sendMessage, plugin: new PaywallGuardPlugin(paywall), paywall };
}

describe('PaywallGuardPlugin', () => {
  it('거부할 때 OK 를 직접 보낸다 — 코어는 next() 안에서만 OK 를 보내므로 안 보내면 클라가 영원히 멈춘다', async () => {
    // 2026-09-05 운영에서 실제로 겪은 버그. 유료 이벤트를 보내면 응답이 아예 없었다.
    const { plugin, ctx, sendMessage } = setup({
      check: async () => ({ kind: 'reject', okMessage: 'payment-required: 1 sat' }),
    });
    const next = jest.fn();

    const res = await plugin.handleMessage(ctx, MSG, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(['OK', EVENT.id, false, 'payment-required: 1 sat']);
    expect(res).toMatchObject({ success: false });
  });

  it('이미 저장된 이벤트는 무과금 duplicate 로 응답하고 과금 판정을 안 한다', async () => {
    const check = jest.fn();
    const { plugin, ctx, sendMessage } = setup({ check }, { isStored: (async () => true) as never });
    const next = jest.fn();

    await plugin.handleMessage(ctx, MSG, next as never);

    expect(check).not.toHaveBeenCalled(); // 돈 판정 자체를 안 한다
    expect(next).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith([
      'OK',
      EVENT.id,
      true,
      'duplicate: already have this event',
    ]);
  });

  it('무과금이면 코어에 넘긴다 — OK 는 코어가 보낸다', async () => {
    const { plugin, ctx, sendMessage } = setup({ check: async () => ({ kind: 'free' }) });
    const next = jest.fn().mockResolvedValue({ messageType: MessageType.EVENT, success: true });

    await plugin.handleMessage(ctx, MSG, next as never);

    expect(next).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled(); // 중복 OK 를 보내면 안 된다
  });

  it('EVENT 가 아닌 메시지는 그대로 흘린다', async () => {
    const { plugin, ctx } = setup({ check: jest.fn() });
    const next = jest.fn().mockResolvedValue(undefined);
    await plugin.handleMessage(ctx, [MessageType.REQ, 'sub'] as never, next as never);
    expect(next).toHaveBeenCalled();
  });

  it('수납 후 저장이 실패하면 원장을 정리한다', async () => {
    const onStorageFailedAfterCollect = jest.fn();
    const { plugin, ctx } = setup(
      { check: async () => ({ kind: 'collected', amountMsat: 1000, refundToken: 'cashuBx' }) },
      { onStorageFailedAfterCollect: onStorageFailedAfterCollect as never },
    );
    const next = jest.fn().mockResolvedValue({ messageType: MessageType.EVENT, success: false });

    await plugin.handleMessage(ctx, MSG, next as never);

    expect(onStorageFailedAfterCollect).toHaveBeenCalledWith(EVENT.id, {
      kind: 'collected',
      amountMsat: 1000,
      refundToken: 'cashuBx',
    });
  });

  it('예외가 나도 봉투를 남기지 않는다 — 남으면 다음 이벤트가 남의 결제를 주워 쓴다', async () => {
    const releaseEnvelope = jest.fn();
    const { plugin, ctx } = setup(
      {
        check: async () => {
          throw new Error('boom');
        },
      },
      { releaseEnvelope: releaseEnvelope as never },
    );

    await expect(plugin.handleMessage(ctx, MSG, jest.fn() as never)).rejects.toThrow('boom');
    expect(releaseEnvelope).toHaveBeenCalledWith(EVENT.id);
  });
});
