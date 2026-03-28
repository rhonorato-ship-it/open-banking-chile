import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { findChrome, saveScreenshot } from "../utils.js";

export type { Browser, BrowserContext, Page };

export interface BrowserOptions {
  chromePath?: string;
  headful?: boolean;
  /** Force headless mode off (e.g., Banco Estado TLS fingerprinting) */
  forceHeadful?: boolean;
  extraArgs?: string[];
  viewport?: { width: number; height: number };
  /**
   * Override all Chrome launch args (replaces DEFAULT_ARGS + LAMBDA_ARGS).
   * Pass chromium.args from @sparticuz/chromium when running on Vercel/Lambda.
   * When provided, the headless flag must be included in these args.
   */
  launchArgs?: string[];
  /**
   * Path to a Chrome user data directory.
   * Opens Chrome with the user's real profile (cookies, sessions, extensions).
   * Cannot be used with launchArgs (Vercel/Lambda).
   */
  userDataDir?: string;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  debugLog: string[];
  /** Save a named screenshot (noop if screenshots disabled) */
  screenshot: (page: Page, name: string) => Promise<void>;
}

const DEFAULT_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
];

// Required when running Chromium inside a container (Vercel / AWS Lambda)
// without kernel namespace support. Harmless elsewhere.
const LAMBDA_ARGS = ["--single-process", "--no-zygote"];

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Launches a browser session for scraping.
 *
 * Uses Playwright's Chromium driver which natively bypasses bot detection
 * systems such as Cloudflare Turnstile without requiring stealth plugins.
 * Playwright's browser automation protocol (CDP + custom) avoids the
 * fingerprinting vectors that Puppeteer exposes:
 * - No navigator.webdriver leak
 * - No Chrome automation flags (cdc_ variables)
 * - No WebGL/plugin enumeration inconsistencies
 *
 * NOTE -- Lightpanda (https://lightpanda.io) as a future alternative:
 * Lightpanda is a headless browser written in Zig that uses ~10-20x less memory
 * and runs ~10x faster than Chrome. It supports the Chrome DevTools Protocol (CDP),
 * so swapping would only require changing this function to use chromium.connectOverCDP():
 *
 *   const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
 *
 * It is NOT integrated yet because (as of early 2026) it is still in beta and has
 * two blockers for banking scrapers:
 *   1. iframe support is incomplete (BCI and Santander rely on iframes)
 *   2. No cookie import/export API (issue #335) -- breaks session persistence
 * Worth revisiting once it hits v1.0.
 */
export async function launchBrowser(
  options: BrowserOptions,
  saveScreenshots: boolean,
): Promise<BrowserSession> {
  const { chromePath, headful, forceHeadful, extraArgs, viewport, launchArgs, userDataDir } = options;
  const debugLog: string[] = [];

  // Some banks (e.g. BancoEstado) block headless browsers via TLS fingerprinting
  // and require a visible Chrome window. On Linux this needs a display server.
  if (forceHeadful && process.platform === "linux") {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error(
        "Este banco requiere modo headful (Chrome visible) pero no se detectó display.\n" +
          "  Opciones: exporta DISPLAY=:0, usa una sesión con GUI, o configura Xvfb:\n" +
          "  Xvfb: Xvfb :99 -screen 0 1280x900x24 & export DISPLAY=:99",
      );
    }
  }

  const executablePath = findChrome(chromePath);
  if (!executablePath) {
    throw new Error(
      "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath en las opciones.\n" +
        "  Ubuntu/Debian: sudo apt install google-chrome-stable\n" +
        "  macOS: brew install --cask google-chrome",
    );
  }

  // Build launch args
  const isLambda = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

  const effectiveLaunchArgs = launchArgs
    ? ensureStealthArgs(launchArgs)
    : [...DEFAULT_ARGS, ...(isLambda ? LAMBDA_ARGS : []), ...(extraArgs || [])];

  // Determine headless mode
  // When caller provides launchArgs (e.g. @sparticuz/chromium.args), the headless
  // flag is already embedded in those args -- launch in headless mode.
  // Otherwise default to headless unless headful/forceHeadful is requested.
  const isHeadless = launchArgs ? true : !(forceHeadful || headful);

  const browser = await chromium.launch({
    executablePath,
    headless: isHeadless,
    args: effectiveLaunchArgs,
  });

  const vp = viewport || { width: 1280, height: 900 };

  const context = await browser.newContext({
    userAgent: DEFAULT_UA,
    viewport: vp,
    locale: "es-CL",
    // Bypass CSP to allow page.evaluate in strict environments
    bypassCSP: true,
  });

  // Additional stealth overrides. Playwright already handles most fingerprinting
  // vectors natively, but these cover edge cases that some banking bot-detection
  // systems specifically check.
  await context.addInitScript(() => {
    // Belt-and-suspenders: ensure webdriver is false
    Object.defineProperty(navigator, "webdriver", { get: () => false });

    // Simulate non-empty plugin array (headless Chrome reports empty plugins)
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });

    // Override languages to match Chilean locale
    Object.defineProperty(navigator, "languages", {
      get: () => ["es-CL", "es", "en-US", "en"],
    });

    // Fix permissions API inconsistency that headless Chrome exposes
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
        : originalQuery(parameters);
  });

  const page = await context.newPage();

  const doSave = async (p: Page, name: string) =>
    saveScreenshot(p, name, saveScreenshots, debugLog);

  return { browser, context, page, debugLog, screenshot: doSave };
}

/**
 * Ensures that caller-provided launch args (e.g. from @sparticuz/chromium)
 * include the stealth-critical flags. Does not duplicate if already present.
 * Also strips --headless flags since Playwright handles headless mode via
 * its own launch option, not via Chrome args.
 */
function ensureStealthArgs(args: string[]): string[] {
  const result = [...args];
  const stealthFlags = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
  ];
  for (const flag of stealthFlags) {
    if (!result.some((a) => a.startsWith(flag.split("=")[0]))) {
      result.push(flag);
    }
  }
  // Remove --enable-automation if present (conflicts with stealth)
  // Remove --headless flags (Playwright manages headless mode via its launch option)
  return result.filter((a) => a !== "--enable-automation" && !a.startsWith("--headless"));
}
