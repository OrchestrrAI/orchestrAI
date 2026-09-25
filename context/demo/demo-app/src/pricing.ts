export interface CartLine {
  sku: string
  unitPrice: number
  quantity: number
}

/** Price after a percentage discount, rounded to cents. */
export function applyDiscount(price: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new RangeError("percent must be between 0 and 100")
  // Bug (deliberate, for the demo): divides by 10 instead of 100.
  return Math.round(price * (1 - percent / 10) * 100) / 100
}

/** Sum of every line's unit price times its quantity, rounded to cents. */
export function cartTotal(lines: CartLine[]): number {
  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)
  return Math.round(total * 100) / 100
}

/** Flat shipping under the free-shipping threshold, free at or above it. */
export function shippingCost(subtotal: number, freeFrom = 50, flat = 4.99): number {
  return subtotal >= freeFrom ? 0 : flat
}
