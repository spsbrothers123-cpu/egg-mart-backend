// Pure, DB-free split-payment validation logic — kept separate from
// routes/bills.js so it can be unit tested without a database connection.

export const SPLIT_METHODS = ['cash', 'card', 'upi', 'net_banking', 'gpay']

// 'gpay' is accepted as an input alias for 'upi' so split portions land in
// the same reporting bucket as regular UPI sales instead of fragmenting
// payment-method totals.
export function normalizeSplitMethod(method) {
  return method === 'gpay' ? 'upi' : method
}

// Converts a rupee amount to integer paise for exact comparison — avoids
// binary floating-point rounding errors (0.1 + 0.2 !== 0.3) when validating
// that split payments sum to exactly the bill total.
export function toPaise(amount) {
  return Math.round(Number(amount) * 100)
}

// Validates a raw `payments` array against a bill `total`.
// Returns { ok: true, payments: [...normalized] } on success, or
// { ok: false, error: string } on the first validation failure — exactly
// the shape routes/bills.js needs to translate straight into a 400 response.
export function validateSplitPayments(payments, total) {
  if (!Array.isArray(payments) || payments.length !== 2) {
    return { ok: false, error: 'Split payment requires exactly 2 payment portions' }
  }

  const normalized = payments.map(p => ({
    method: normalizeSplitMethod(p.method),
    amount: Number(p.amount),
  }))

  for (const p of normalized) {
    if (!(p.amount > 0)) {
      return { ok: false, error: 'Each split payment amount must be greater than zero' }
    }
  }

  const paidPaise = normalized.reduce((s, p) => s + toPaise(p.amount), 0)
  const totalPaise = toPaise(total)

  if (paidPaise !== totalPaise) {
    const diff = (paidPaise - totalPaise) / 100
    const error = diff > 0
      ? `Split payment overpays the bill by ₹${diff.toFixed(2)} (bill total ₹${Number(total).toFixed(2)})`
      : `Split payment underpays the bill by ₹${(-diff).toFixed(2)} (bill total ₹${Number(total).toFixed(2)})`
    return { ok: false, error }
  }

  return { ok: true, payments: normalized }
}
