/**
 * Session cookie persistence for scrapers.
 *
 * Stores cookies in ~/.cache/open-banking-chile/cookies/{bankId}.json
 * so that subsequent runs reuse an existing authenticated session,
 * avoiding 2FA challenges on banks that use device-recognition (e.g. MercadoPago).
 *
 * On Vercel / serverless the cache dir lives in /tmp (ephemeral) -- cookies are
 * available within a warm function instance but not across cold starts.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import type { BrowserContext } from "playwright-core";

function getCookieDir(): string {
  // Vercel / Lambda: /tmp is the only writable directory
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return join(tmpdir(), "open-banking-chile", "cookies");
  }
  return join(homedir(), ".cache", "open-banking-chile", "cookies");
}

function cookiePath(bankId: string): string {
  return join(getCookieDir(), `${bankId}.json`);
}

export async function loadCookies(context: BrowserContext, bankId: string): Promise<boolean> {
  const path = cookiePath(bankId);
  if (!existsSync(path)) return false;
  try {
    const raw = await readFile(path, "utf-8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return false;
    await context.addCookies(cookies);
    return true;
  } catch {
    return false;
  }
}

export async function saveCookies(context: BrowserContext, bankId: string): Promise<void> {
  try {
    const dir = getCookieDir();
    await mkdir(dir, { recursive: true });
    const cookies = await context.cookies();
    await writeFile(cookiePath(bankId), JSON.stringify(cookies, null, 2), "utf-8");
  } catch {
    // Non-fatal -- cookie saving is best-effort
  }
}

export async function clearCookies(bankId: string): Promise<void> {
  const path = cookiePath(bankId);
  if (existsSync(path)) {
    const { unlink } = await import("fs/promises");
    await unlink(path).catch(() => {});
  }
}
