import type { ScrapeResult, ScraperOptions } from "../types.js";

export type ApiScrapeFn = (
  options: ScraperOptions,
  debugLog: string[],
) => Promise<ScrapeResult>;

/**
 * Browser-free scraper runner for banks/services with REST APIs.
 * Mirrors runScraper() lifecycle but uses fetch() instead of Puppeteer.
 */
export async function runApiScraper(
  bankId: string,
  options: ScraperOptions,
  scrapeFn: ApiScrapeFn,
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

  try {
    return await scrapeFn(options, debugLog);
  } catch (error) {
    return {
      success: false,
      bank: bankId,
      movements: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
      debug: debugLog.join("\n"),
    };
  }
}
