/**
 * Install / uninstall the open-banking-chile agent as a background daemon.
 *
 * macOS  → LaunchAgent plist at ~/Library/LaunchAgents/
 * Linux  → systemd user service at ~/.config/systemd/user/
 *
 * Usage:
 *   npx open-banking-chile install    ← register daemon + start it
 *   npx open-banking-chile uninstall  ← stop + remove daemon
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

const LABEL = "com.open-banking-chile.agent";
const SERVICE_NAME = "open-banking-chile-agent";

// Resolve the node executable and the CLI script from current process
const nodePath = process.execPath;
const cliScript = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "cli.js",
);

// ─── macOS LaunchAgent ────────────────────────────────────────

function launchAgentPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${LABEL}.plist`,
  );
}

function writePlist(): string {
  const logPath = path.join(os.homedir(), "Library", "Logs", `${SERVICE_NAME}.log`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${cliScript}</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${logPath}</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
`;
  const dest = launchAgentPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, plist, "utf8");
  return dest;
}

function installMacOS(): void {
  const plistPath = writePlist();
  console.log(`  Plist creado: ${plistPath}`);

  // Unload first in case an old version is loaded
  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  } catch {
    // Ignore — not loaded yet
  }

  execFileSync("launchctl", ["load", "-w", plistPath]);
  console.log("  Agente iniciado y registrado para arranque automático.");
  console.log("");
  console.log("  Logs: " + path.join(os.homedir(), "Library", "Logs", `${SERVICE_NAME}.log`));
  console.log("  Para detener:   launchctl unload " + plistPath);
  console.log("  Para desinstalar: npx open-banking-chile uninstall");
}

function uninstallMacOS(): void {
  const plistPath = launchAgentPath();
  if (!fs.existsSync(plistPath)) {
    console.log("  El agente no está instalado.");
    return;
  }
  try {
    execFileSync("launchctl", ["unload", "-w", plistPath], { stdio: "ignore" });
  } catch {
    // Already unloaded
  }
  fs.unlinkSync(plistPath);
  console.log("  Agente detenido y desinstalado.");
}

// ─── Linux systemd ────────────────────────────────────────────

function systemdUnitPath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "systemd",
    "user",
    `${SERVICE_NAME}.service`,
  );
}

function writeSystemdUnit(): string {
  const unit = `[Unit]
Description=open-banking-chile local sync agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${nodePath} ${cliScript} serve
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
  const dest = systemdUnitPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, unit, "utf8");
  return dest;
}

function installLinux(): void {
  const unitPath = writeSystemdUnit();
  console.log(`  Servicio creado: ${unitPath}`);

  execFileSync("systemctl", ["--user", "daemon-reload"]);
  execFileSync("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
  console.log("  Agente iniciado y habilitado para arranque automático.");
  console.log("");
  console.log(`  Logs:    journalctl --user -u ${SERVICE_NAME} -f`);
  console.log(`  Estado:  systemctl --user status ${SERVICE_NAME}`);
  console.log("  Para desinstalar: npx open-banking-chile uninstall");
}

function uninstallLinux(): void {
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", SERVICE_NAME], {
      stdio: "ignore",
    });
  } catch {
    // Already stopped / not found
  }
  const unitPath = systemdUnitPath();
  if (fs.existsSync(unitPath)) {
    fs.unlinkSync(unitPath);
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    } catch { /* ignore */ }
  }
  console.log("  Agente detenido y desinstalado.");
}

// ─── Public API ───────────────────────────────────────────────

export function installDaemon(): void {
  console.log("");
  console.log("  Instalando agente como servicio en segundo plano...");
  console.log("");

  if (process.platform === "darwin") {
    installMacOS();
  } else if (process.platform === "linux") {
    installLinux();
  } else {
    console.error(
      "  Windows no está soportado todavía.\n" +
        "  Alternativa: agrega 'npx open-banking-chile serve' al inicio de sesión manualmente.",
    );
    process.exit(1);
  }

  console.log("");
  console.log("  Listo. El agente se iniciará automáticamente al encender tu computador.");
  console.log("  La primera vez abrirá el navegador para autenticación (solo una vez).");
  console.log("");
}

export function uninstallDaemon(): void {
  console.log("");
  console.log("  Desinstalando agente...");

  if (process.platform === "darwin") {
    uninstallMacOS();
  } else if (process.platform === "linux") {
    uninstallLinux();
  } else {
    console.error("  Windows no está soportado.");
    process.exit(1);
  }

  console.log("");
}
