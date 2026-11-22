import { formatTotal, TAX } from "./util";

export interface Order {
  id: string;
  total: number;
}

export function createOrder(id: string, total: number): Order {
  const withTax = total * (1 + TAX);
  console.log(formatTotal(withTax));
  return { id, total: withTax };
}

export function describeOrder(order: Order): string {
  if (order.total > 100) {
    return `large ${formatTotal(order.total)}`;
  }
  return formatTotal(order.total);
}
