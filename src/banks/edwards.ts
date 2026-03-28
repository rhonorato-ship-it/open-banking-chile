import type { BankScraper, ScraperOptions, ScrapeResult } from "../types.js";
import { runApiScraper } from "../infrastructure/api-runner.js";
// Edwards shares the same portal and REST API as Banco de Chile.
// Import bchile's default export and delegate to it, only changing id/name.
import bchile from "./bchile.js";

async function scrapeEdwards(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  // Delegate to bchile — same portal, same API, same login
  const result = await bchile.scrape(options);
  // Rebrand the result
  return { ...result, bank: "edwards" };
}

const edwards: BankScraper = {
  id: "edwards",
  name: "Banco Edwards",
  url: "https://portalpersonas.bancochile.cl",
  mode: "api",
  scrape: (options) => runApiScraper("edwards", options, scrapeEdwards),
};

export default edwards;
