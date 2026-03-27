const AMOUNT_TOLERANCE_CLP = 5;
const DATE_TOLERANCE_DAYS = 2;

interface MovementRow {
  id: string;
  bank_id: string;
  date: string; // YYYY-MM-DD
  description: string;
  amount: number;
}

function dateDiffDays(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60 * 24);
}

const TRANSFER_HINT = /transferencia|traspaso|desde|hacia|\bgiro\b/i;

/**
 * Returns the set of movement IDs that are part of matched internal transfer pairs.
 * A pair is a debit in one bank matched with a credit of the same amount in a different bank,
 * within DATE_TOLERANCE_DAYS days, where at least one description hints at a transfer.
 */
export function detectInternalTransferIds(rows: MovementRow[]): Set<string> {
  const transferIds = new Set<string>();
  const used = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const left = rows[i];
    if (used.has(left.id) || left.amount >= 0) continue;

    const expected = Math.abs(left.amount);

    for (let j = 0; j < rows.length; j++) {
      if (i === j) continue;
      const right = rows[j];
      if (used.has(right.id) || right.amount <= 0) continue;

      const sameAmount = Math.abs(right.amount - expected) <= AMOUNT_TOLERANCE_CLP;
      const closeDate = dateDiffDays(left.date, right.date) <= DATE_TOLERANCE_DAYS;
      const crossBank = left.bank_id !== right.bank_id;
      const hasHint = TRANSFER_HINT.test(left.description) || TRANSFER_HINT.test(right.description);

      if (sameAmount && closeDate && crossBank && hasHint) {
        transferIds.add(left.id);
        transferIds.add(right.id);
        used.add(left.id);
        used.add(right.id);
        break;
      }
    }
  }

  return transferIds;
}
