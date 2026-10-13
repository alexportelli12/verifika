export interface Line {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
}
