import { Hono } from "hono"
import { z } from "zod"
import { PORT } from "./config"
import { findProduct, inStock, PRODUCTS } from "./inventory"
import { cartTotal, shippingCost } from "./pricing"

const app = new Hono()

app.get("/health", (c) => c.json({ status: "ok" }))

app.get("/products", (c) => c.json({ products: PRODUCTS }))

app.get("/products/:id", (c) => {
  const product = findProduct(c.req.param("id"))
  return product ? c.json(product) : c.json({ error: "not found" }, 404)
})

const CartSchema = z.object({
  lines: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })),
})

app.post("/cart/total", async (c) => {
  const parsed = CartSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid cart" }, 400)
  const lines = []
  for (const { sku, quantity } of parsed.data.lines) {
    const product = findProduct(sku)
    if (!product) return c.json({ error: `unknown sku ${sku}` }, 400)
    if (!inStock(sku, quantity)) return c.json({ error: `${sku} is out of stock` }, 409)
    lines.push({ sku, unitPrice: product.price, quantity })
  }
  const subtotal = cartTotal(lines)
  return c.json({ subtotal, shipping: shippingCost(subtotal) })
})

export default { port: PORT, fetch: app.fetch }
