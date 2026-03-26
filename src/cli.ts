#!/usr/bin/env node
import { config } from "dotenv";
import { banks, listBanks, getBank } from "./index.js";
import { Spinner } from "./utils.js";
import type { BankMovement } from "./types.js";
config();

// ─── Date helpers ─────────────────────────────────────────────

function parseDMY(date: string): number {
  const [d, m, y] = date.split("-").map(Number);
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return NaN;
  return new Date(y, m - 1, d).getTime();
}

function parseYMD(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return NaN;
  return new Date(y, m - 1, d).getTime();
}

function isValidIsoDate(value?: string): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parseYMD(value));
}

function filterByDate(
  movements: BankMovement[],
  from?: string,
  to?: string
): BankMovement[] {
  if (!from && !to) return movements;
  const fromTs = from ? parseYMD(from) : 0;
  const toTs = to ? parseYMD(to) : Infinity;
  return movements.filter((m) => {
    const ts = parseDMY(m.date);
    return ts >= fromTs && ts <= toTs;
  });
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--") || a.startsWith("-")));

  if (flags.has("--help") || flags.has("-h")) {
    const bankList = listBanks()
      .map((b) => `  ${b.id.padEnd(15)} ${b.name}`)
      .join("\n");
    console.log(`
open-banking-chile — Obtén tus movimientos bancarios como JSON

Uso:
  open-banking-chile --bank <banco> [opciones]
  open-banking-chile --all [opciones]

Bancos disponibles:
${bankList}

Opciones:
  --bank <id>         Banco a consultar (requerido, o usar --all)
  --all               Ejecutar todos los bancos configurados
  --list              Listar bancos disponibles
  --screenshots       Guardar screenshots en ./screenshots/
  --headful           Abrir Chrome visible (para debugging)
  --pretty            Formatear JSON con indentación
  --movements         Solo imprimir movimientos (sin metadata)
  --owner <T|A|B>     Filtro Titular/Adicional para TC (default: B = todos)
  --from <YYYY-MM-DD> Filtrar movimientos desde esta fecha
  --to   <YYYY-MM-DD> Filtrar movimientos hasta esta fecha
  --sync-drive        Sincronizar movimientos con Google Drive
  --help, -h          Mostrar esta ayuda

Variables de entorno:
  <BANCO>_RUT         Tu RUT (ej: FALABELLA_RUT=12345678-9)
  <BANCO>_PASS        Tu clave de internet (ej: FALABELLA_PASS=miclave)
  CHROME_PATH         Ruta al ejecutable de Chrome/Chromium (opcional)

  Google Drive (requerido para --sync-drive):
  GOOGLE_DRIVE_FOLDER_ID          ID de la carpeta de destino en Drive
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE Ruta al archivo JSON de la cuenta de servicio
  GOOGLE_SERVICE_ACCOUNT_KEY      JSON de la cuenta de servicio (string inline)

Ejemplos:
  # Banco Falabella con pretty-print
  FALABELLA_RUT=12345678-9 FALABELLA_PASS=miclave open-banking-chile --bank falabella --pretty

  # Filtrar por rango de fechas
  open-banking-chile --bank falabella --from 2026-01-01 --to 2026-01-31

  # Sincronizar todos los bancos con Google Drive
  open-banking-chile --all --sync-drive

  # Listar bancos disponibles
  open-banking-chile --list

  # Solo movimientos, pipe a jq
  open-banking-chile --bank falabella --movements | jq '.[].description'
`);
    process.exit(0);
  }

  if (flags.has("--list")) {
    console.log("\nBancos disponibles:\n");
    for (const b of listBanks()) {
      console.log(`  ${b.id.padEnd(15)} ${b.name.padEnd(25)} ${b.url}`);
    }
    console.log(`\nTotal: ${listBanks().length} banco(s)`);
    console.log("¿Tu banco no está? ¡Contribuye! Ver CONTRIBUTING.md\n");
    process.exit(0);
  }

  // Parse shared flags
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const fromDate = getArg("--from");
  const toDate = getArg("--to");

  if (fromDate && !isValidIsoDate(fromDate)) {
    console.error(`Error: --from inválido (esperado YYYY-MM-DD): ${fromDate}`);
    process.exit(1);
  }

  if (toDate && !isValidIsoDate(toDate)) {
    console.error(`Error: --to inválido (esperado YYYY-MM-DD): ${toDate}`);
    process.exit(1);
  }

  if (fromDate && toDate && parseYMD(fromDate) > parseYMD(toDate)) {
    console.error("Error: --from no puede ser mayor que --to");
    process.exit(1);
  }

  const ownerVal = getArg("--owner")?.toUpperCase();
  const owner =
    ownerVal === "T" || ownerVal === "A" || ownerVal === "B" ? ownerVal : undefined;

  const isTTY = process.stderr.isTTY;
  const spinner = new Spinner();

  // ── --all mode ───────────────────────────────────────────
  if (flags.has("--all")) {
    const configured = Object.entries(banks).filter(([id]) => {
      const prefix = id.toUpperCase();
      return process.env[`${prefix}_RUT`] && process.env[`${prefix}_PASS`];
    });

    if (configured.length === 0) {
      console.error("Error: No hay bancos configurados. Agrega variables <BANCO>_RUT y <BANCO>_PASS.");
      process.exit(1);
    }

    let totalNew = 0;
    let errors = 0;

    for (const [id, bank] of configured) {
      const prefix = id.toUpperCase();
      const rut = process.env[`${prefix}_RUT`]!;
      const password = process.env[`${prefix}_PASS`]!;

      if (isTTY) {
        spinner.start(`${bank.name}...`);
      } else {
        console.error(`[${id}] Consultando...`);
      }

      const result = await bank.scrape({
        rut,
        password,
        chromePath: process.env.CHROME_PATH,
        saveScreenshots: flags.has("--screenshots"),
        headful: flags.has("--headful"),
        ...(owner && { owner }),
        onProgress: isTTY ? (step) => spinner.update(`${bank.name}: ${step}`) : undefined,
      });

      if (!result.success) {
        if (isTTY) spinner.fail(`${bank.name}: ${result.error}`);
        else console.error(`[${id}] Error: ${result.error}`);
        errors++;
        continue;
      }

      const filtered = filterByDate(result.movements, fromDate, toDate);

      if (flags.has("--sync-drive")) {
        if (isTTY) spinner.update(`${bank.name}: Sincronizando con Google Drive...`);
        else console.error(`[${id}] Sincronizando con Google Drive...`);

        try {
          const { syncBank } = await import("./sync/merger.js");
          const sync = await syncBank(id, filtered);
          totalNew += sync.newMovements;
          if (isTTY) {
            spinner.stop(
              `${bank.name} — ${sync.newMovements} nuevos, ${sync.totalMovements} total en Drive`
            );
          } else {
            console.error(`[${id}] +${sync.newMovements} nuevos → ${sync.totalMovements} total`);
          }
        } catch (err) {
          if (isTTY) spinner.fail(`${bank.name}: Error en Drive — ${(err as Error).message}`);
          else console.error(`[${id}] Error en Drive: ${(err as Error).message}`);
          errors++;
        }
      } else {
        if (isTTY) {
          spinner.stop(`${bank.name} — ${filtered.length} movimiento(s)`);
        }
      }
    }

    if (isTTY && flags.has("--sync-drive")) {
      console.error(`\n✔ Sync completo — ${totalNew} movimientos nuevos en total`);
    }
    process.exit(errors > 0 ? 1 : 0);
  }

  // ── Single bank mode ──────────────────────────────────────
  const bankArg = getArg("--bank");
  if (!bankArg) {
    const available = Object.keys(banks).join(", ");
    console.error(
      `Error: Debes especificar un banco con --bank <id> o usar --all\n` +
        `Bancos disponibles: ${available}\n` +
        `Usa --list para más detalles o --help para ayuda.`
    );
    process.exit(1);
  }

  const bankId = bankArg.trim().toLowerCase();

  const bank = getBank(bankId);
  if (!bank) {
    const available = Object.keys(banks).join(", ");
    const safeBankId = bankArg.replace(/[^a-z0-9]/gi, "").slice(0, 32);
    console.error(
      `Error: Banco "${safeBankId}" no encontrado.\n` +
        `Bancos disponibles: ${available}\n` +
        `Usa --list para más detalles.`
    );
    process.exit(1);
  }

  const prefix = bankId.toUpperCase();
  const rut = process.env[`${prefix}_RUT`];
  const password = process.env[`${prefix}_PASS`];

  if (!rut || !password) {
    console.error(
      `Error: Se requieren las variables ${prefix}_RUT y ${prefix}_PASS\n` +
        `Ejemplo: ${prefix}_RUT=12345678-9 ${prefix}_PASS=miclave open-banking-chile --bank ${bankId}\n` +
        `O copia .env.example a .env y rellena tus datos.`
    );
    process.exit(1);
  }

  if (flags.has("--screenshots")) {
    console.warn(
      "⚠️  --screenshots guarda imágenes y HTML con datos bancarios en ./screenshots/ y ./debug/\n" +
        "   No compartas estos archivos ni los subas a git."
    );
  }

  if (isTTY) {
    spinner.start(`Conectando con ${bank.name}...`);
  } else {
    console.error(`Consultando banco: ${bank.name} (${bankId})...`);
  }

  const result = await bank.scrape({
    rut,
    password,
    chromePath: process.env.CHROME_PATH,
    saveScreenshots: flags.has("--screenshots"),
    headful: flags.has("--headful"),
    ...(owner && { owner }),
    onProgress: isTTY ? (step) => spinner.update(step) : undefined,
  });

  if (!result.success) {
    if (isTTY) spinner.fail(result.error || "Error desconocido");
    else console.error(`Error: ${result.error}`);
    if (result.debug) {
      console.error("\nDebug log:");
      console.error(result.debug);
    }
    process.exit(1);
  }

  const movements = filterByDate(result.movements, fromDate, toDate);

  if (flags.has("--sync-drive")) {
    if (isTTY) spinner.update("Sincronizando con Google Drive...");
    else console.error("Sincronizando con Google Drive...");

    const { syncBank } = await import("./sync/merger.js");
    const sync = await syncBank(bankId, movements);

    if (isTTY) {
      spinner.stop(
        `${bank.name} — ${sync.newMovements} nuevos movimientos, ${sync.totalMovements} total en Drive`
      );
    } else {
      console.error(`+${sync.newMovements} nuevos → ${sync.totalMovements} total en Drive`);
    }
  } else if (isTTY) {
    const count = movements.length;
    spinner.stop(
      `${bank.name} — ${count} movimiento${count !== 1 ? "s" : ""} obtenido${count !== 1 ? "s" : ""}`
    );
  }

  const indent = flags.has("--pretty") ? 2 : undefined;
  const output = { ...result, movements };

  if (flags.has("--movements")) {
    console.log(JSON.stringify(movements, null, indent));
  } else {
    const { screenshot: _, ...rest } = output;
    console.log(JSON.stringify(rest, null, indent));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
