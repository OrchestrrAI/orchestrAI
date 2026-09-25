export interface Product {
  id: string
  name: string
  price: number
  stock: number
}

export const PRODUCTS: Product[] = [
  { id: "mug", name: "Coffee mug", price: 12.5, stock: 40 },
  { id: "tee", name: "T-shirt", price: 19.99, stock: 0 },
  { id: "cap", name: "Baseball cap", price: 15, stock: 7 },
]

export function findProduct(id: string): Product | undefined {
  return PRODUCTS.find((product) => product.id === id)
}

export function inStock(id: string, quantity = 1): boolean {
  const product = findProduct(id)
  return product !== undefined && product.stock >= quantity
}

/** Products whose stock is at or below the threshold, lowest first. */
export function lowStock(threshold = 10): Product[] {
  return PRODUCTS.filter((product) => product.stock <= threshold).sort((a, b) => a.stock - b.stock)
}
