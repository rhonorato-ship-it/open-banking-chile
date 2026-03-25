import type { BankMovement } from "../types.js";
import { deduplicateMovements } from "../utils.js";
import {
  toCSV,
  toCombinedCSV,
  toXLSX,
  toCombinedXLSX,
  parseCSV,
  parseCombinedCSV,
  type MovementWithBank,
} from "./formatter.js";
import { GoogleDriveClient } from "./drive.js";

const COMBINED_CSV = "movimientos.csv";
const COMBINED_XLSX = "movimientos.xlsx";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface SyncResult {
  newMovements: number;
  totalMovements: number;
}

function sortByDate(date: string): number {
  const [d, m, y] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Valid Google Drive resource IDs: alphanumeric + underscore + hyphen, 10-200 chars */
const FOLDER_ID_RE = /^[a-zA-Z0-9_-]{10,200}$/;

/** Valid bank IDs: lowercase alphanumeric only (matches registry keys) */
const BANK_ID_RE = /^[a-z0-9]+$/;

export async function syncBank(
  bankId: string,
  newMovements: BankMovement[]
): Promise<SyncResult> {
  if (!BANK_ID_RE.test(bankId)) {
    throw new Error(`Invalid bank ID: "${bankId.slice(0, 32)}"`);
  }

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID not set");
  if (!FOLDER_ID_RE.test(folderId)) {
    throw new Error("GOOGLE_DRIVE_FOLDER_ID has an invalid format");
  }

  const client = new GoogleDriveClient();

  // ── Per-bank files ────────────────────────────────────────
  const existingCSV = await client.downloadFile(`${bankId}.csv`, folderId);
  const existing = existingCSV ? parseCSV(existingCSV) : [];
  const merged = deduplicateMovements([...newMovements, ...existing]);
  merged.sort((a, b) => sortByDate(b.date) - sortByDate(a.date));
  const newCount = Math.max(0, merged.length - existing.length);

  await client.uploadOrUpdate(
    `${bankId}.csv`,
    Buffer.from(toCSV(merged), "utf-8"),
    "text/csv",
    folderId
  );
  await client.uploadOrUpdate(`${bankId}.xlsx`, await toXLSX(merged), XLSX_MIME, folderId);

  // ── Combined files ────────────────────────────────────────
  const existingCombinedCSV = await client.downloadFile(COMBINED_CSV, folderId);
  const otherBanks: MovementWithBank[] = existingCombinedCSV
    ? parseCombinedCSV(existingCombinedCSV).filter((m) => m.bank !== bankId)
    : [];

  const combined: MovementWithBank[] = [
    ...otherBanks,
    ...merged.map((m) => ({ ...m, bank: bankId })),
  ];
  combined.sort((a, b) => sortByDate(b.date) - sortByDate(a.date));

  await client.uploadOrUpdate(
    COMBINED_CSV,
    Buffer.from(toCombinedCSV(combined), "utf-8"),
    "text/csv",
    folderId
  );
  await client.uploadOrUpdate(
    COMBINED_XLSX,
    await toCombinedXLSX(combined),
    XLSX_MIME,
    folderId
  );

  return { newMovements: newCount, totalMovements: merged.length };
}
