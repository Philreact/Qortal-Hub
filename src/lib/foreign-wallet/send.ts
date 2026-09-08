import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import {
  buildForeignWalletSignedTransaction,
  prepareForeignWalletPsbt,
  inspectSignedTransaction,
  type ForeignWalletSignedTransaction,
  createForeignWalletPreviousTransactionCache,
} from './foreign-wallet-transaction';
import {
  planForeignWalletSpend,
  type ForeignWalletSpendPlan,
} from './foreign-wallet-spend-plan';
import {
  normalizeForeignWalletSpendContext,
  getForeignWalletMainnetChainId,
} from './foreign-wallet-spend-context';
import {
  assertForeignWalletContextWithinPolicy,
  assertForeignWalletPlanWithinPolicy,
} from './foreign-wallet-policy-bounds';
import {
  foreignCrypto,
  walletPublicKey,
  walletFingerprint,
  type ForeignWalletCoin,
} from './foreign-wallets';

export class ForeignSendError extends Error {
  constructor(
    public code:
      | 'invalid'
      | 'upgrade'
      | 'changed'
      | 'pending'
      | 'unknown'
      | 'declined',
    public txId?: string
  ) {
    super(code);
  }
}
export type PendingSend = {
  txId: string;
  outpoints: string[];
  rawTransactionHex?: string;
  broadcastBefore?: number;
};
export type SendDependencies = {
  post: (endpoint: string, body: unknown) => Promise<unknown>;
  sign?: (
    plan: ForeignWalletSpendPlan,
    psbt: Uint8Array
  ) => Promise<ForeignWalletSignedTransaction>;
  approveRecovery?: (pending: PendingSend) => Promise<boolean>;
  approve: (plan: ForeignWalletSpendPlan) => Promise<boolean>;
  stillValid: () => Promise<boolean>;
  readPending: () => Promise<PendingSend | null>;
  writePending: (entry: PendingSend | null) => Promise<void>;
};
const busy = new Set<string>();
export function atomicAmount(raw: unknown): bigint {
  // Existing q-apps pass numbers; accept their decimal spelling without multiplying floats.
  const text =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Number(raw.toFixed(8)) === raw
        ? raw.toFixed(8)
        : ''
      : raw;
  if (
    typeof text !== 'string' ||
    !/^(0|[1-9][0-9]*)?(\.[0-9]{1,8})?$/.test(text) ||
    !text ||
    text === '.'
  )
    throw new ForeignSendError('invalid');
  const [whole, decimals = ''] = text.split('.');
  const value =
    BigInt(whole || '0') * 100000000n + BigInt(decimals.padEnd(8, '0'));
  if (value <= 0n || value > 0x7fffffffffffffffn)
    throw new ForeignSendError('invalid');
  return value;
}
export function decimalAmount(value: bigint): string {
  return `${value / 100000000n}.${(value % 100000000n).toString().padStart(8, '0')}`;
}
const snapshot = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

export async function sendForeignCoin(
  request: {
    coin: ForeignWalletCoin;
    xprv?: string;
    xpub?: string;
    broadcastBefore?: number;
    amount?: unknown;
    recipient: string;
    fee?: unknown;
    sendMax?: boolean;
    payments?: { address: string; value: bigint }[];
  },
  deps: SendDependencies
): Promise<string> {
  request = structuredClone(request);
  const { coin, xprv } = request;
  const xpub = request.xpub ?? walletPublicKey(xprv, coin);
  // Reject private extended keys even if a caller accidentally labels one xpub.
  walletFingerprint(xpub, coin);
  const expectedChainId = getForeignWalletMainnetChainId(coin);
  const lock = `${coin}:${xpub}`;
  // Reject overlapping sends across tabs as well as within this process.
  const run = async () => {
    if (busy.has(lock)) throw new ForeignSendError('pending');
    busy.add(lock);
    try {
      return await execute();
    } finally {
      busy.delete(lock);
    }
  };
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request(lock, { ifAvailable: true }, (held) => {
      if (!held) throw new ForeignSendError('pending');
      return run();
    });
  return run();

  async function execute() {
    const pending = await deps.readPending();
    if (pending) {
      // A timeout is not evidence of failure. Only the exact txid in wallet history
      // clears a reservation; never automatically construct another payment.
      const history = await deps.post(
        `/crosschain/${coin.toLowerCase()}/wallettransactions`,
        xpub
      );
      if (!Array.isArray(history))
        throw new ForeignSendError('pending', pending.txId);
      if (!history.some((tx) => tx?.txHash === pending.txId)) {
        if (
          pending.rawTransactionHex &&
          deps.approveRecovery &&
          (!pending.broadcastBefore || Date.now() < pending.broadcastBefore)
        ) {
          const parsed = inspectSignedTransaction(pending.rawTransactionHex);
          if (
            parsed.txId !== pending.txId ||
            snapshot(parsed.outpoints) !== snapshot(pending.outpoints)
          )
            throw new ForeignSendError('pending', pending.txId);
          if (await deps.approveRecovery(structuredClone(pending))) {
            if (
              !(await deps.stillValid()) ||
              (pending.broadcastBefore && Date.now() >= pending.broadcastBefore)
            )
              throw new ForeignSendError('changed');
            try {
              const ack = await deps.post(
                `/crosschain/${coin.toLowerCase()}/send/broadcast`,
                {
                  expectedChainId,
                  rawTransactionHex: pending.rawTransactionHex,
                }
              );
              if (ack !== pending.txId)
                throw new Error('Unconfirmed broadcast');
            } catch {
              throw new ForeignSendError('unknown', pending.txId);
            }
          }
        }
        // A recovered payment must never be reported as success for a new request.
        throw new ForeignSendError('pending', pending.txId);
      }
    }
    const read = async () => {
      const context = normalizeForeignWalletSpendContext(
        await deps.post(
          `/crosschain/${coin.toLowerCase()}/wallet/public/spend-context`,
          { xpub58: xpub, expectedChainId }
        ),
        coin
      );
      assertForeignWalletContextWithinPolicy(context);
      return context;
    };
    const context = await read();
    if (pending) {
      if (
        context.utxos.some((input) =>
          pending.outpoints.includes(`${input.txHash}:${input.txPos}`)
        )
      )
        throw new ForeignSendError('pending', pending.txId);
      await deps.writePending(null);
    }

    if (request.sendMax && request.amount !== undefined)
      throw new ForeignSendError('invalid');
    const fee =
      request.fee === undefined
        ? context.recommendedFeePerByte
        : atomicAmount(request.fee);
    if (
      fee < context.recommendedFeePerByte ||
      fee > context.recommendedFeePerByte * 10n
    )
      throw new ForeignSendError('invalid');
    const cache = createForeignWalletPreviousTransactionCache();
    const planFor = (state: typeof context) =>
      planForeignWalletSpend({
        coin,
        xpub,
        crypto: foreignCrypto,
        cache,
        utxos: state.utxos,
        feePerByte: fee,
        minimumNonDustOutput: state.minimumNonDustOutput,
        amount: request.sendMax ? undefined : atomicAmount(request.amount),
        sendMax: request.sendMax,
        recipientAddress: request.recipient,
        payments: request.payments,
      });
    const plan = planFor(context);
    assertForeignWalletPlanWithinPolicy({ ...plan, coin });
    const started = Date.now();
    if (!(await deps.approve(structuredClone(plan))))
      throw new ForeignSendError('declined');
    if (!(await deps.stillValid())) throw new ForeignSendError('changed');
    const after = await read();
    if (
      context.recommendedFeePerByte !== after.recommendedFeePerByte ||
      context.minimumNonDustOutput !== after.minimumNonDustOutput ||
      snapshot(planFor(after)) !== snapshot(plan)
    )
      throw new ForeignSendError('changed');
    if (!(await deps.stillValid()) || Date.now() - started > 5 * 60 * 1000)
      throw new ForeignSendError('changed');
    const transaction = {
      coin,
      xpub,
      inputs: plan.inputs,
      outputs: plan.outputs,
      transactionVersion: context.transactionVersion,
    };
    const psbt = prepareForeignWalletPsbt(transaction);
    const signed = deps.sign
      ? await deps.sign(structuredClone(plan), psbt)
      : buildForeignWalletSignedTransaction({ ...transaction, xprv });
    if (
      !(await deps.stillValid()) ||
      Date.now() - started > 300000 ||
      (request.broadcastBefore && Date.now() >= request.broadcastBefore)
    )
      throw new ForeignSendError('changed');
    const decoded = Transaction.fromRaw(hex.decode(signed.rawTransactionHex));
    if (
      hex.encode(decoded.unsignedTx) !==
        hex.encode(Transaction.fromPSBT(psbt).unsignedTx) ||
      decoded.id !== signed.txId
    )
      throw new ForeignSendError('invalid');
    if (
      signed.fee !== plan.fee ||
      signed.transactionSize !== signed.rawTransactionHex.length / 2 ||
      signed.transactionSize > plan.estimatedMaximumSize
    )
      throw new ForeignSendError('invalid');
    // Write before network I/O. Keep even an ambiguous storage failure conservative.
    await deps.writePending({
      txId: signed.txId,
      rawTransactionHex: signed.rawTransactionHex,
      ...(request.broadcastBefore
        ? { broadcastBefore: request.broadcastBefore }
        : {}),
      outpoints: plan.inputs.map((i) => `${i.txHash}:${i.txPos}`),
    });
    // Persistence can take time: recheck immediately before releasing signed bytes.
    if (
      !(await deps.stillValid()) ||
      Date.now() - started > 300000 ||
      (request.broadcastBefore && Date.now() >= request.broadcastBefore)
    )
      throw new ForeignSendError('changed', signed.txId);
    try {
      const result = await deps.post(
        `/crosschain/${coin.toLowerCase()}/send/broadcast`,
        { expectedChainId, rawTransactionHex: signed.rawTransactionHex }
      );
      if (
        typeof result !== 'string' ||
        result.trim().toLowerCase() !== signed.txId
      )
        throw new ForeignSendError('unknown', signed.txId);
    } catch {
      throw new ForeignSendError('unknown', signed.txId);
    }
    // Keep the reservation until wallet history observes this transaction. An
    // acknowledgement can precede propagation to the wallet's read server.
    return signed.txId;
  }
}
