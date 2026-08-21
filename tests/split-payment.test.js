import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSplitPayments, normalizeSplitMethod, toPaise } from '../src/utils/split-payment.js'

test('valid split payment: card 60 + cash 20 = 80', () => {
  const result = validateSplitPayments(
    [{ method: 'card', amount: 60 }, { method: 'cash', amount: 20 }],
    80
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.payments, [
    { method: 'card', amount: 60 },
    { method: 'cash', amount: 20 },
  ])
})

test('valid split payment: gpay is normalized to upi', () => {
  const result = validateSplitPayments(
    [{ method: 'gpay', amount: 50 }, { method: 'cash', amount: 30 }],
    80
  )
  assert.equal(result.ok, true)
  assert.equal(result.payments[0].method, 'upi')
})

test('rejects underpayment', () => {
  const result = validateSplitPayments(
    [{ method: 'card', amount: 60 }, { method: 'cash', amount: 10 }],
    80
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /underpays/)
})

test('rejects overpayment', () => {
  const result = validateSplitPayments(
    [{ method: 'card', amount: 60 }, { method: 'cash', amount: 30 }],
    80
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /overpays/)
})

test('rejects a zero-amount portion', () => {
  const result = validateSplitPayments(
    [{ method: 'card', amount: 80 }, { method: 'cash', amount: 0 }],
    80
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /greater than zero/)
})

test('rejects a negative-amount portion', () => {
  const result = validateSplitPayments(
    [{ method: 'card', amount: 90 }, { method: 'cash', amount: -10 }],
    80
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /greater than zero/)
})

test('rejects a payments array that is not exactly length 2', () => {
  assert.equal(validateSplitPayments([{ method: 'card', amount: 80 }], 80).ok, false)
  assert.equal(
    validateSplitPayments(
      [{ method: 'card', amount: 20 }, { method: 'cash', amount: 20 }, { method: 'upi', amount: 40 }],
      80
    ).ok,
    false
  )
})

test('rejects a non-array payments value', () => {
  assert.equal(validateSplitPayments(null, 80).ok, false)
  assert.equal(validateSplitPayments(undefined, 80).ok, false)
  assert.equal(validateSplitPayments('not-an-array', 80).ok, false)
})

test('exact match avoids floating point precision errors (0.1 + 0.2 style)', () => {
  // 33.10 + 46.90 must equal 80.00 exactly in paise, not 79.99999999999999
  const result = validateSplitPayments(
    [{ method: 'card', amount: 33.10 }, { method: 'cash', amount: 46.90 }],
    80
  )
  assert.equal(result.ok, true)
})

test('toPaise converts rupees to integer paise', () => {
  assert.equal(toPaise(80), 8000)
  assert.equal(toPaise(33.1), 3310)
  assert.equal(toPaise(0.1), 10)
})

test('normalizeSplitMethod maps gpay to upi and passes through others', () => {
  assert.equal(normalizeSplitMethod('gpay'), 'upi')
  assert.equal(normalizeSplitMethod('cash'), 'cash')
  assert.equal(normalizeSplitMethod('card'), 'card')
  assert.equal(normalizeSplitMethod('upi'), 'upi')
})
