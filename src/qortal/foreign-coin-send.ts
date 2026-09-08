import { readBoundedWalletResponse } from './wallet-response';
import { foreignWalletOutputAddress } from '../lib/foreign-wallet/foreign-wallet-transaction';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import i18n from 'i18next';
import {
  createEndpoint,
  getKeyPair,
  getSaveWallet,
} from '../background/background';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  decimalAmount,
  ForeignSendError,
  sendForeignCoin,
  type PendingSend,
} from '../lib/foreign-wallet/send';
import {
  walletPublicKey,
  type ForeignWalletCoin,
} from '../lib/foreign-wallet/foreign-wallets';

export class LocalWalletError extends Error {
  constructor(code: string, txId = '') {
    super(i18n.t(`question:local_send.${code}`, { txId }));
  }
}

/** The app's private key is used only by the local signer, never by post(). */
export async function sendLocalForeignCoin(
  data: Record<string, any>,
  approve: (payload: any) => Promise<any>,
  payments?: { address: string; value: bigint }[],
  validateIntent?: () => Promise<void>,
  approveRecovery: (payload: any) => Promise<any> = approve
) {
  try {
    if (
      window.appStorage &&
      (!window.foreignWalletJournal || !window.foreignWalletSigner)
    )
      throw new ForeignSendError('upgrade');
    const coin = data.coin as ForeignWalletCoin;
    const keys = await getKeyPair();
    const wallet = await getSaveWallet();
    const xprv = keys[`${coin.toLowerCase()}PrivateKey`];
    const xpub = window.foreignWalletSigner
      ? await window.foreignWalletSigner.publicKey(coin)
      : walletPublicKey(xprv, coin);
    if (
      window.foreignWalletSigner &&
      keys[`${coin.toLowerCase()}PublicKey`] !== xpub
    )
      throw new ForeignSendError('changed');
    const endpoint = await createEndpoint(
      `/crosschain/${coin.toLowerCase()}/wallet/public/spend-context`
    );
    const fingerprint = bytesToHex(sha256(new TextEncoder().encode(xpub)));
    let pendingTxId: string;
    const storageKey = `foreign-send-v1:${coin}:${fingerprint}`;
    const stillValid = async () => {
      try {
        await validateIntent?.();
        return (
          (await getSaveWallet()).address0 === wallet.address0 &&
          (window.foreignWalletSigner
            ? (await window.foreignWalletSigner.publicKey(coin)) === xpub &&
              (await getKeyPair())[`${coin.toLowerCase()}PublicKey`] === xpub
            : (await getKeyPair())[`${coin.toLowerCase()}PrivateKey`] ===
              xprv) &&
          (await createEndpoint(
            `/crosschain/${coin.toLowerCase()}/wallet/public/spend-context`
          )) === endpoint
        );
      } catch {
        return false;
      }
    };
    return await sendForeignCoin(
      {
        coin,
        xprv: window.foreignWalletSigner ? undefined : xprv,
        xpub,
        broadcastBefore: data.broadcastBefore,
        amount: data.amount,
        recipient: data.recipient || data.destinationAddress,
        fee: data.fee,
        sendMax: data.sendMax === true,
        payments,
      },
      {
        stillValid,
        sign: window.foreignWalletSigner
          ? async (plan, psbt) => {
              const result = await window.foreignWalletSigner.sign(
                {
                  coin,
                  xpub,
                  inputs: plan.inputs,
                  outputs: plan.outputs,
                  psbtHex: hex.encode(psbt),
                },
                i18n.language
              );
              if (!result.signed || result.error)
                throw new ForeignSendError(result.error || 'invalid');
              return result.signed;
            }
          : undefined,
        approveRecovery: async (pending) => {
          const tx = Transaction.fromRaw(hex.decode(pending.rawTransactionHex));
          const outputs = Array.from(
            { length: tx.outputsLength },
            (_, index) => {
              const output = tx.getOutput(index);
              return `${decimalAmount(output.amount)} ${coin} → ${foreignWalletOutputAddress(output.script, coin)}`;
            }
          ).join('\n');
          return (
            await approveRecovery({
              text1: i18n.t('question:local_send.recovery'),
              text2: pending.txId,
              text3: outputs,
              confirmCheckbox: true,
            })
          ).accepted;
        },
        readPending: async () => {
          const raw = window.foreignWalletJournal
            ? await window.foreignWalletJournal.get(storageKey)
            : localStorage.getItem(storageKey);
          if (raw === null || raw === undefined) return null;
          const value = JSON.parse(raw);
          if (
            !value ||
            !/^[a-f0-9]{64}$/.test(value.txId) ||
            !Array.isArray(value.outpoints) ||
            value.outpoints.length < 1 ||
            value.outpoints.length > 1000 ||
            value.outpoints.some(
              (p: unknown) =>
                typeof p !== 'string' || !/^[a-f0-9]{64}:[0-9]{1,10}$/.test(p)
            ) ||
            (value.rawTransactionHex !== undefined &&
              (typeof value.rawTransactionHex !== 'string' ||
                value.rawTransactionHex.length > 400000 ||
                !/^(?:[a-f0-9]{2})+$/.test(value.rawTransactionHex))) ||
            (value.broadcastBefore !== undefined &&
              (!Number.isSafeInteger(value.broadcastBefore) ||
                value.broadcastBefore <= 0))
          )
            throw new ForeignSendError('pending');
          pendingTxId = value.txId;
          return value as PendingSend;
        },
        writePending: async (entry) => {
          if (window.foreignWalletJournal) {
            if (entry)
              await window.foreignWalletJournal.set(
                storageKey,
                JSON.stringify(entry)
              );
            else
              await window.foreignWalletJournal.delete(storageKey, pendingTxId);
          } else if (entry)
            localStorage.setItem(storageKey, JSON.stringify(entry));
          else localStorage.removeItem(storageKey);
        },
        post: async (path, body) => {
          if (!(await stillValid())) throw new ForeignSendError('changed');
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 90000);
          try {
            const response = await fetch(await createEndpoint(path), {
              method: 'POST',
              headers: {
                'Content-Type':
                  typeof body === 'string' ? 'text/plain' : 'application/json',
              },
              body: typeof body === 'string' ? body : JSON.stringify(body),
              signal: controller.signal,
            });
            if (response.status === 404 || response.status === 405)
              throw new ForeignSendError('upgrade');
            if (!response.ok) throw new ForeignSendError('invalid');
            const text = await readBoundedWalletResponse(
              response,
              20 * 1024 * 1024
            );
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          } finally {
            clearTimeout(timeout);
          }
        },
        approve: async (plan) =>
          (
            await approve({
              text1: i18n.t('question:permission.send_coins', {
                postProcess: 'capitalizeFirstChar',
              }),
              text2: i18n.t('question:to_recipient', {
                recipient: plan.recipientAddress,
                postProcess: 'capitalizeFirstChar',
              }),
              highlightedText: `${decimalAmount(plan.amount)} ${coin}`,
              foreignFee: `${decimalAmount(plan.fee)} ${coin}`,
              confirmCheckbox: true,
            })
          ).accepted,
      }
    );
  } catch (error) {
    const code = error instanceof ForeignSendError ? error.code : 'invalid';
    throw new LocalWalletError(
      code,
      error instanceof ForeignSendError ? error.txId || '' : ''
    );
  }
}
