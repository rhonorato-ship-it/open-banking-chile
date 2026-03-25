import ExcelJS from "exceljs";
import type { BankMovement } from "../types.js";

export type MovementWithBank = BankMovement & { bank: string };

// ─── CSV ──────────────────────────────────────────────────────

const PER_BANK_HEADERS = ["fecha", "descripcion", "monto", "saldo", "origen", "titular", "cuotas"];
const COMBINED_HEADERS = ["banco", ...PER_BANK_HEADERS];

const FORMULA_CHARS = new Set(["=", "+", "-", "@", "\t", "\r"]);

function escapeCSV(value: string): string {
  // Prefix formula-trigger characters to prevent CSV injection in spreadsheet apps
  let safe = value;
  if (safe.length > 0 && FORMULA_CHARS.has(safe[0])) {
    safe = `'${safe}`;
  }
  if (safe.includes(";") || safe.includes('"') || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function movementToRow(m: BankMovement): string[] {
  return [
    m.date,
    m.description,
    String(m.amount),
    String(m.balance ?? ""),
    m.source,
    m.owner ?? "",
    m.installments ?? "",
  ];
}

export function toCSV(movements: BankMovement[]): string {
  const lines = [
    PER_BANK_HEADERS.join(";"),
    ...movements.map((m) => movementToRow(m).map(escapeCSV).join(";")),
  ];
  return lines.join("\n");
}

export function toCombinedCSV(movements: MovementWithBank[]): string {
  const lines = [
    COMBINED_HEADERS.join(";"),
    ...movements.map((m) => [m.bank, ...movementToRow(m)].map(escapeCSV).join(";")),
  ];
  return lines.join("\n");
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ";" && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/** Strip leading formula-injection prefix "'" before parsing numbers */
const parseNum = (s: string) => parseInt(s.startsWith("'") ? s.slice(1) : s, 10) || 0;

function rowToMovement(cols: string[], offset = 0): BankMovement {
  const source = cols[offset + 4] as BankMovement["source"];
  const owner = cols[offset + 5] as BankMovement["owner"];
  const installments = cols[offset + 6];
  return {
    date: cols[offset + 0],
    description: cols[offset + 1],
    amount: parseNum(cols[offset + 2]),
    balance: parseNum(cols[offset + 3]),
    source,
    ...(owner ? { owner } : {}),
    ...(installments ? { installments } : {}),
  };
}

export function parseCSV(csv: string): BankMovement[] {
  const lines = csv.trim().split("\n").slice(1); // skip header
  return lines.filter(Boolean).map((line) => rowToMovement(parseCSVLine(line)));
}

export function parseCombinedCSV(csv: string): MovementWithBank[] {
  const lines = csv.trim().split("\n").slice(1); // skip header
  return lines.filter(Boolean).map((line) => {
    const cols = parseCSVLine(line);
    return { bank: cols[0], ...rowToMovement(cols, 1) };
  });
}

// ─── XLSX ─────────────────────────────────────────────────────

const PER_BANK_COLUMNS = [
  { header: "Fecha", key: "date", width: 12 },
  { header: "Descripción", key: "description", width: 40 },
  { header: "Monto", key: "amount", width: 14 },
  { header: "Saldo", key: "balance", width: 14 },
  { header: "Origen", key: "source", width: 22 },
  { header: "Titular", key: "owner", width: 10 },
  { header: "Cuotas", key: "installments", width: 8 },
];

export async function toXLSX(movements: BankMovement[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Movimientos");
  ws.columns = PER_BANK_COLUMNS as ExcelJS.Column[];
  ws.getRow(1).font = { bold: true };
  movements.forEach((m) => ws.addRow(m));
  return wb.xlsx.writeBuffer() as Promise<Buffer>;
}

export async function toCombinedXLSX(movements: MovementWithBank[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Movimientos");
  ws.columns = [
    { header: "Banco", key: "bank", width: 12 },
    ...PER_BANK_COLUMNS,
  ] as ExcelJS.Column[];
  ws.getRow(1).font = { bold: true };
  movements.forEach((m) => ws.addRow(m));
  return wb.xlsx.writeBuffer() as Promise<Buffer>;
}
