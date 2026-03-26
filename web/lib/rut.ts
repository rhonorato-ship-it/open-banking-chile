/** Strip all formatting characters from a RUT string */
function strip(rut: string): string {
  return rut.replace(/[\s.\-]/g, "").toUpperCase();
}

/** Calculate the expected verifier digit for a RUT body using modulo 11 */
function expectedVerifier(body: string): string {
  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i], 10) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const remainder = 11 - (sum % 11);
  if (remainder === 11) return "0";
  if (remainder === 10) return "K";
  return String(remainder);
}

/** Returns true if the RUT is structurally valid and has a correct verifier digit */
export function isValidRut(rut: string): boolean {
  const clean = strip(rut);
  if (clean.length < 2) return false;

  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);

  if (!/^\d{7,8}$/.test(body)) return false;
  if (!/^\d$/.test(dv) && dv !== "K") return false;

  return expectedVerifier(body) === dv;
}

/**
 * Normalize a RUT to canonical format: XXXXXXXX-X (no dots, with dash).
 * Returns null if the RUT is invalid.
 */
export function normalizeRut(rut: string): string | null {
  if (!isValidRut(rut)) return null;
  const clean = strip(rut);
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
}
