/**
 * Build a multi-sheet XLSX workbook from the user's movements.
 *
 * Sheets:
 *   1. Movimientos — all transactions
 *   2. Resumen Mensual — monthly aggregation
 *   3. Por Categoría — category totals
 *   4. Por Banco — per-bank totals
 */

// Dynamic import to avoid bundling xlsx at build time
async function getXLSX() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("xlsx") as typeof import("xlsx");
}

export interface MovementRow {
  id: string;
  bank_id: string;
  date: string;
  description: string;
  amount: number;
  category: string;
  isInternalTransfer: boolean;
}

const BANK_NAMES: Record<string, string> = {
  bchile: "Banco Chile", bci: "BCI", bestado: "BancoEstado", bice: "BICE",
  citi: "Citibank", edwards: "Edwards", falabella: "Falabella",
  fintual: "Fintual", itau: "Itaú", mach: "MACH", mercadopago: "MercadoPago",
  racional: "Racional", santander: "Santander", scotiabank: "Scotiabank",
  tenpo: "Tenpo",
};

export async function buildMovementsXlsx(movements: MovementRow[]): Promise<Buffer> {
  const XLSX = await getXLSX();
  const wb = XLSX.utils.book_new();

  // Sheet 1: All movements
  const movementRows = movements.map((m) => ({
    Fecha: m.date,
    Banco: BANK_NAMES[m.bank_id] ?? m.bank_id.toUpperCase(),
    Descripcion: m.description,
    Categoria: m.category,
    Monto: m.amount,
    Transferencia_Interna: m.isInternalTransfer ? "Sí" : "No",
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(movementRows), "Movimientos");

  // Sheet 2: Monthly summary
  const monthlyMap = new Map<string, { spend: number; income: number; count: number }>();
  for (const m of movements) {
    if (m.isInternalTransfer) continue;
    const month = m.date.substring(0, 7);
    const cur = monthlyMap.get(month) ?? { spend: 0, income: 0, count: 0 };
    if (m.amount < 0) cur.spend += Math.abs(m.amount);
    else cur.income += m.amount;
    cur.count += 1;
    monthlyMap.set(month, cur);
  }
  const summaryRows = Array.from(monthlyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, d]) => ({ Mes: month, Gasto: Math.round(d.spend), Ingreso: Math.round(d.income), Neto: Math.round(d.income - d.spend), Movimientos: d.count }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Resumen Mensual");

  // Sheet 3: By category
  const catMap = new Map<string, number>();
  for (const m of movements) {
    if (m.amount >= 0 || m.isInternalTransfer) continue;
    catMap.set(m.category, (catMap.get(m.category) ?? 0) + Math.abs(m.amount));
  }
  const catRows = Array.from(catMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amount]) => ({ Categoria: cat, Gasto_Total: Math.round(amount) }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), "Por Categoria");

  // Sheet 4: By bank
  const bankMap = new Map<string, { spend: number; income: number }>();
  for (const m of movements) {
    if (m.isInternalTransfer) continue;
    const cur = bankMap.get(m.bank_id) ?? { spend: 0, income: 0 };
    if (m.amount < 0) cur.spend += Math.abs(m.amount);
    else cur.income += m.amount;
    bankMap.set(m.bank_id, cur);
  }
  const bankRows = Array.from(bankMap.entries()).map(([bid, d]) => ({
    Banco: BANK_NAMES[bid] ?? bid.toUpperCase(),
    Gasto: Math.round(d.spend),
    Ingreso: Math.round(d.income),
    Neto: Math.round(d.income - d.spend),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bankRows), "Por Banco");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return Buffer.from(buf);
}
