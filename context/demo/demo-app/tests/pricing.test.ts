import { describe, expect, test } from "bun:test"
import { applyDiscount, cartTotal, shippingCost } from "../src/pricing"

describe("pricing", () => {
  test("cart total multiplies price by quantity", () => {
    expect(cartTotal([{ sku: "mug", unitPrice: 12.5, quantity: 2 }, { sku: "cap", unitPrice: 15, quantity: 1 }])).toBe(40)
  })

  test("shipping is free from 50", () => {
    expect(shippingCost(50)).toBe(0)
    expect(shippingCost(49.99)).toBe(4.99)
  })

  test("a discount outside 0-100 is rejected", () => {
    expect(() => applyDiscount(10, 120)).toThrow(RangeError)
  })

  test("a 10% discount takes 10% off", () => {
    expect(applyDiscount(20, 10)).toBe(18)
  })
})
