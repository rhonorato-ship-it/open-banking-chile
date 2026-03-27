/**
 * One-time script to get a Google Drive OAuth2 refresh token.
 * Usage: doppler run --project open-banking-chile --config dev -- node scripts/gdrive-auth.mjs
 */

import http from "node:http";
import { google } from "googleapis";

const clientId = process.env.GDRIVE_CLIENT_ID;
const clientSecret = process.env.GDRIVE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET must be set");
  process.exit(1);
}

const PORT = 3434; // change to any port already in your Google Cloud Console redirect URIs
const REDIRECT_URI = `http://localhost:${PORT}`;

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/drive.file"],
});

console.log("\nOpen this URL in your browser:\n");
console.log(authUrl);
console.log("\nWaiting for callback on http://localhost:" + PORT + " ...\n");

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT_URI).searchParams.get("code");
  if (!code) { res.end("No code"); return; }

  res.end("<h2>Done! Check your terminal for the refresh token.</h2>");
  server.close();

  const { tokens } = await oauth2.getToken(code);
  console.log("✓ Refresh token:\n");
  console.log(tokens.refresh_token);
  console.log("\nAdd it to Doppler:");
  console.log(`  doppler secrets set GDRIVE_REFRESH_TOKEN="${tokens.refresh_token}" --project open-banking-chile --config dev`);
  console.log(`  doppler secrets set GDRIVE_REFRESH_TOKEN="${tokens.refresh_token}" --project open-banking-chile --config prd`);
});

server.listen(PORT);
