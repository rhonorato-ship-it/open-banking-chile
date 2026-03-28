import type { Page } from "playwright-core";
import { delay, deduplicateMovements } from "../utils.js";
import type { BankMovement } from "../types.js";

export interface PaginationConfig {
  /** Max pages to iterate (default 25) */
  maxPages?: number;
  /** Delay after clicking next (default 2500ms) */
  delayMs?: number;
  /** Custom next-button text patterns */
  nextTexts?: string[];
}

const DEFAULT_NEXT_TEXTS = ["siguiente", "ver más", "mostrar más"];

function movementSignature(movements: BankMovement[]): string {
  return movements
    .slice(0, 5)
    .map((m) => `${m.date}|${m.description}|${m.amount}`)
    .join("||");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function clickNext(page: Page, texts: string[]): Promise<boolean> {
  return await page.evaluate((txts: string[]) => {
    const candidates = Array.from(document.querySelectorAll("button, a"));
    for (const candidate of candidates) {
      const text = (candidate as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (!text) continue;
      if (!txts.some((t) => text.includes(t))) continue;

      const disabled =
        (candidate as HTMLButtonElement).disabled ||
        candidate.getAttribute("aria-disabled") === "true" ||
        candidate.classList.contains("disabled");
      if (disabled) return false;

      (candidate as HTMLElement).click();
      return true;
    }
    return false;
  }, texts);
}

/**
 * Paginate through movement pages, extracting data from each.
 * Calls extractFn on each page and accumulates results.
 */
export async function paginateAndExtract(
  page: Page,
  extractFn: (page: Page) => Promise<BankMovement[]>,
  debugLog: string[],
  config?: PaginationConfig,
): Promise<BankMovement[]> {
  const maxPages = config?.maxPages ?? 25;
  const delayMs = config?.delayMs ?? 2500;
  const texts = config?.nextTexts ?? DEFAULT_NEXT_TEXTS;
  const allMovements: BankMovement[] = [];
  const extractTimeoutMs = 15_000;
  const clickTimeoutMs = 10_000;
  let hasLastSignature = false;
  let lastSignature = "";
  let stagnantPages = 0;

  for (let i = 0; i < maxPages; i++) {
    let movements: BankMovement[] = [];
    try {
      movements = await withTimeout(extractFn(page), extractTimeoutMs, "movement extraction");
    } catch (error) {
      debugLog.push(
        `  Pagination stopped at page ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }

    const signature = movementSignature(movements);
    if (hasLastSignature && signature === lastSignature) {
      stagnantPages += 1;
      if (stagnantPages >= 2) {
        debugLog.push(`  Pagination stopped: detected repeated page content at page ${i + 1}`);
        break;
      }
    } else {
      stagnantPages = 0;
    }
    lastSignature = signature;
    hasLastSignature = true;

    allMovements.push(...movements);

    let nextClicked = false;
    try {
      nextClicked = await withTimeout(clickNext(page, texts), clickTimeoutMs, "next-page click");
    } catch (error) {
      debugLog.push(
        `  Pagination stopped at page ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }

    if (!nextClicked) break;

    debugLog.push(`  Pagination: loaded page ${i + 2}`);
    await delay(delayMs);
  }

  return deduplicateMovements(allMovements);
}
