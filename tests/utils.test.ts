import { describe, it, expect } from "vitest";
import {
  formatRut,
  parseChileanAmount,
  normalizeDate,
  normalizeInstallments,
  normalizeOwner,
  deduplicateMovements,
} from "../src/utils.js";
import { MOVEMENT_SOURCE } from "../src/types.js";
import { toCSV, parseCSV } from "../src/sync/formatter.js";

describe("formatRut", () => {
  it("formats a clean RUT string", () => {
    expect(formatRut("123456789")).toBe("12.345.678-9");
  });
  it("handles already-formatted RUT by stripping then reformatting", () => {
    expect(formatRut("12.345.678-9")).toBe("12.345.678-9");
  });
  it("formats short RUT", () => {
    expect(formatRut("99999990")).toBe("9.999.999-0");
  });
  it("preserves K verifier digit", () => {
    expect(formatRut("123456780K")).toBe("123.456.780-K");
  });
});

describe("parseChileanAmount", () => {
  it("parses a positive amount with thousand separators", () => {
    expect(parseChileanAmount("$1.234.567")).toBe(1234567);
  });
  it("parses a negative amount", () => {
    expect(parseChileanAmount("-$50.000")).toBe(-50000);
  });
  it("parses zero", () => {
    expect(parseChileanAmount("$0")).toBe(0);
  });
  it("truncates decimals (CLP has no cents)", () => {
    // parseInt ignores decimal portion — correct for CLP
    expect(parseChileanAmount("$1.234,56")).toBe(1234);
  });
  it("handles empty string", () => {
    expect(parseChileanAmount("")).toBe(0);
  });
  it("handles plain number string", () => {
    expect(parseChileanAmount("50000")).toBe(50000);
  });
});

describe("normalizeDate", () => {
  it("normalizes dd/mm/yyyy", () => {
    expect(normalizeDate("9/3/2026")).toBe("09-03-2026");
  });
  it("normalizes dd.mm.yyyy", () => {
    expect(normalizeDate("09.03.2026")).toBe("09-03-2026");
  });
  it("normalizes dd-mm-yyyy (already normalized)", () => {
    expect(normalizeDate("09-03-2026")).toBe("09-03-2026");
  });
  it("normalizes dd/mm/yy (2-digit year)", () => {
    expect(normalizeDate("09/03/26")).toBe("09-03-2026");
  });
  it("normalizes dd/mm (assumes current year)", () => {
    const year = new Date().getFullYear();
    expect(normalizeDate("09/03")).toBe(`09-03-${year}`);
  });
  it("normalizes '9 mar 2026' text format", () => {
    expect(normalizeDate("9 mar 2026")).toBe("09-03-2026");
  });
  it("normalizes '15 ago 2025' text format", () => {
    expect(normalizeDate("15 ago 2025")).toBe("15-08-2025");
  });
  it("returns unknown format unchanged", () => {
    expect(normalizeDate("unknown")).toBe("unknown");
  });
});

describe("normalizeInstallments", () => {
  it("pads single-digit installments", () => {
    expect(normalizeInstallments("1/3")).toBe("01/03");
  });
  it("leaves already-padded installments unchanged", () => {
    expect(normalizeInstallments("02/06")).toBe("02/06");
  });
  it("handles undefined", () => {
    expect(normalizeInstallments(undefined)).toBeUndefined();
  });
  it("returns unknown format unchanged", () => {
    expect(normalizeInstallments("abc")).toBe("abc");
  });
});

describe("normalizeOwner", () => {
  it("maps 'Titular' to 'titular'", () => {
    expect(normalizeOwner("Titular")).toBe("titular");
  });
  it("maps 'ADICIONAL' to 'adicional'", () => {
    expect(normalizeOwner("ADICIONAL")).toBe("adicional");
  });
  it("is case-insensitive", () => {
    expect(normalizeOwner("titular")).toBe("titular");
    expect(normalizeOwner("adicional")).toBe("adicional");
  });
  it("defaults to titular for unknown value with owner", () => {
    expect(normalizeOwner("something")).toBe("titular");
  });
  it("returns undefined for undefined input", () => {
    expect(normalizeOwner(undefined)).toBeUndefined();
  });
});

describe("deduplicateMovements", () => {
  const base = {
    date: "01-03-2026",
    description: "Compra supermercado",
    amount: -15000,
    balance: 100000,
    source: MOVEMENT_SOURCE.account,
  };

  it("removes exact duplicates", () => {
    const result = deduplicateMovements([base, base, base]);
    expect(result).toHaveLength(1);
  });

  it("keeps movements that differ by amount", () => {
    const result = deduplicateMovements([base, { ...base, amount: -20000 }]);
    expect(result).toHaveLength(2);
  });

  it("keeps movements that differ by date", () => {
    const result = deduplicateMovements([base, { ...base, date: "02-03-2026" }]);
    expect(result).toHaveLength(2);
  });

  it("preserves original order", () => {
    const a = { ...base, amount: -1000 };
    const b = { ...base, amount: -2000 };
    const result = deduplicateMovements([a, b]);
    expect(result[0].amount).toBe(-1000);
    expect(result[1].amount).toBe(-2000);
  });

  it("handles empty array", () => {
    expect(deduplicateMovements([])).toEqual([]);
  });
});

describe("CSV formula injection prevention", () => {
  const base = {
    date: "01-03-2026",
    amount: -15000,
    balance: 100000,
    source: MOVEMENT_SOURCE.account,
  };

  const injectionVectors = ["=CMD|'/C calc'!A0", "+1-2", "-1+2", "@SUM(A1)", "\tDATA", "\rDATA"];

  for (const vector of injectionVectors) {
    it(`prefixes formula-trigger cell: ${JSON.stringify(vector)}`, () => {
      const csv = toCSV([{ ...base, description: vector }]);
      const rows = csv.split("\n");
      // The description column (index 1) must not start with the injection char
      const descCell = rows[1].split(";")[1];
      expect(descCell.startsWith("'")).toBe(true);
    });
  }

  it("round-trips movements through CSV without data loss", () => {
    const movements = [
      { ...base, description: "Compra supermercado", installments: "01/03" },
      { ...base, description: "Abono nómina", amount: 500000, balance: 600000 },
    ];
    const csv = toCSV(movements);
    const parsed = parseCSV(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].description).toBe("Compra supermercado");
    expect(parsed[0].amount).toBe(-15000);
    expect(parsed[1].amount).toBe(500000);
  });

  it("round-trips description with semicolons", () => {
    const m = { ...base, description: "Pago; cuota; mensual" };
    const parsed = parseCSV(toCSV([m]));
    expect(parsed[0].description).toBe("Pago; cuota; mensual");
  });

  it("round-trips description with double quotes", () => {
    const m = { ...base, description: 'Pago "especial"' };
    const parsed = parseCSV(toCSV([m]));
    expect(parsed[0].description).toBe('Pago "especial"');
  });
});
