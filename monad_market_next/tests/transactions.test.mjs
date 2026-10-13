import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, decodeFunctionData } from 'viem';
import { amountUnits, orderIndexValue, transactionAbi, tradeCall } from '../lib/contracts/transactions.ts';

const address = '0x1111111111111111111111111111111111111111';
const base = { address, side: 'buy', outcome: 'yes', type: 'market', amount: '90', price: 40, minimum: '199.024875', expiry: 'gtc' };

test('market buy preserves six-decimal minimum output and calldata', () => {
  const call = tradeCall(base);
  const data = encodeFunctionData({ abi: transactionAbi, ...call });
  assert.deepEqual(decodeFunctionData({ abi: transactionAbi, data }), { functionName: 'buyUSDCAmount', args: [90000000n, true, 199024875n] });
});
test('NO market sale uses shares and USDC minimum, including explicit zero', () => {
  assert.deepEqual(tradeCall({ ...base, side: 'sell', outcome: 'no', amount: '1.000001', minimum: '0' }).args, [1000001n, false, 0n]);
  assert.throws(() => tradeCall({ ...base, side: 'sell', amount: '0.999999' }));
});
test('limit side, price, expiry and exact minimum match contract', () => {
  const call = tradeCall({ ...base, type: 'limit', side: 'sell', outcome: 'no', amount: '1.000001', expiry: 'hour' }, 1800000000000);
  assert.deepEqual(call.args, [40, 1000001n, 1800003600, false, false]);
  assert.equal(tradeCall({ ...base, type: 'limit' }).args[2], 0);
  for (const price of [0, 100, 1.5, NaN]) assert.throws(() => tradeCall({ ...base, type: 'limit', price }));
  assert.throws(() => tradeCall({ ...base, type: 'limit', amount: '1' }));
});
test('rejects unsafe rounding, missing minimum, invalid buy increments and overflow', () => {
  for (const value of ['0', '-1', '1e6', '1.0000001', '', '79228162514264337593543.950336']) assert.throws(() => amountUnits(value));
  assert.equal(amountUnits('79228162514264337593543.950335'), (1n << 96n) - 1n);
  assert.throws(() => tradeCall({ ...base, amount: '0.01' }));
  assert.throws(() => tradeCall({ ...base, minimum: '' }));
});
test('cancel index remains bigint beyond Number precision and respects uint256', () => {
  assert.equal(orderIndexValue('9007199254740993'), 9007199254740993n);
  assert.equal(orderIndexValue('0'), 0n);
  for (const value of ['-1', '1.2', '', String(1n << 256n)]) assert.throws(() => orderIndexValue(value));
});
