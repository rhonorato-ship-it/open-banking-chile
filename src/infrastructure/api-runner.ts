import type { ScrapeResult, ScraperOptions } from "../types.js";

export type ApiScrapeFn = (
  options: ScraperOptions,
  debugLog: string[],
) => Promise<ScrapeResult>;

/** Default timeout for API scrapers: 240s (leaves 60s headroom under Vercel's 300s limit) */
const DEFAULT_TIMEOUT_MS = 240_000;

/**
 * Browser-free scraper runner for banks/services with REST APIs.
 * Handles credential validation, error wrapping, and hard timeout.
 * No browser lifecycle (no launch, no logout, no cleanup).
 */
export async function runApiScraper(
  bankId: string,
  options: ScraperOptions,
  scrapeFn: ApiScrapeFn,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ScrapeResult> {
  const { rut, password } = options;

  if (!rut || !password) {
    return {
      success: false,
      bank: bankId,
      movements: [],
      error: "Debes proveer credenciales (email/RUT y clave).",
    };
  }

  const debugLog: string[] = [];

  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const scrapePromise = scrapeFn(options, debugLog);

    const timeoutPromise = new Promise<ScrapeResult>((_, reject) => {
      timerId = setTimeout(() => reject(new Error(`Timeout: el scraper no respondió en ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    });

    return await Promise.race([scrapePromise, timeoutPromise]);
  } catch (error) {
    return {
      success: false,
      bank: bankId,
      movements: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
      debug: debugLog.join("\n"),
    };
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}
