import { describe, it, expect } from 'vitest';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { foreignCoins } from './foreign-wallets';
import { validateLocalTradePlan } from './trade-plan';

describe('trade funding validation', () => {
  for (const coin of foreignCoins)
    it(`${coin}: verifies the HTLC, amount, seller and refund deadline`, () => {
      const offer = {
        qortalAtAddress: 'AT',
        receivingAddress: 'QORT',
        expectedForeignAmount: '1',
        tradeTimeout: 60,
        creatorForeignPKH: btoa(
          String.fromCharCode(...new Uint8Array(20).fill(3))
        ),
      };
      const lockTime = Math.floor(Date.now() / 1000) + 3600;
      const time = new Uint8Array(4);
      new DataView(time.buffer).setUint32(0, lockTime, true);
      const redeemScript = `7dada97614${'01'.repeat(20)}87637504${bytesToHex(time)}b16714${'03'.repeat(20)}88a914${'02'.repeat(20)}8768`;
      const prefix = { BTC: 5, LTC: 50, DOGE: 22, DGB: 63, RVN: 122 }[coin];
      const address = base58check(sha256).encode(
        Uint8Array.from([
          prefix,
          ...ripemd160(sha256(hexToBytes(redeemScript))),
        ])
      );
      const plan = {
        atAddress: 'AT',
        receivingAddress: 'QORT',
        amount: '100001000',
        fundingReserve: '1000',
        refundPublicKeyHash: '01'.repeat(20),
        hashOfSecret: '02'.repeat(20),
        redeemScript,
        lockTime,
        address,
      };
      expect(validateLocalTradePlan([plan], [offer], coin, 'QORT')).toEqual([
        { address, value: 100001000n },
      ]);
      for (const changed of [
        { ...plan, amount: '100002000' },
        { ...plan, lockTime: 0 },
        { ...plan, atAddress: 'OTHER' },
        { ...plan, redeemScript: redeemScript.replace('03', '04') },
        { ...plan, receivingAddress: 'OTHER' },
      ]) {
        expect(() =>
          validateLocalTradePlan([changed], [offer], coin, 'QORT')
        ).toThrow();
      }
      expect(() =>
        validateLocalTradePlan(
          [plan],
          [{ ...offer, creatorForeignPKH: btoa('x'.repeat(20)) }],
          coin,
          'QORT'
        )
      ).toThrow();
    });
});
