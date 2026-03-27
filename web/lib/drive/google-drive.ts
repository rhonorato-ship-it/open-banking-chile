/**
 * Google Drive upload service using OAuth2.
 *
 * Required env vars (set in Doppler):
 *   GDRIVE_CLIENT_ID
 *   GDRIVE_CLIENT_SECRET
 *   GDRIVE_REFRESH_TOKEN
 *   GOOGLE_DRIVE_FOLDER_ID
 */

import { Readable } from "node:stream";

export interface DriveUploadResult {
  url: string;
  name: string;
}

async function getDriveClient() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { google } = require("googleapis");

  const oauth2 = new google.auth.OAuth2(
    process.env.GDRIVE_CLIENT_ID,
    process.env.GDRIVE_CLIENT_SECRET,
  );
  oauth2.setCredentials({ refresh_token: process.env.GDRIVE_REFRESH_TOKEN });

  return google.drive({ version: "v3", auth: oauth2 });
}

export function isDriveConfigured(): boolean {
  return !!(
    process.env.GDRIVE_CLIENT_ID &&
    process.env.GDRIVE_CLIENT_SECRET &&
    process.env.GDRIVE_REFRESH_TOKEN &&
    process.env.GOOGLE_DRIVE_FOLDER_ID
  );
}

export async function uploadToDrive(buffer: Buffer, fileName: string): Promise<DriveUploadResult> {
  const drive = await getDriveClient();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID!;
  const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  // Update existing file instead of creating duplicates
  const existing = await drive.files.list({
    q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
    fields: "files(id)",
  });

  let fileId: string;

  if (existing.data.files?.length > 0) {
    fileId = existing.data.files[0].id;
    const stream = Readable.from(buffer);
    await drive.files.update({ fileId, media: { mimeType, body: stream } });
  } else {
    const stream = Readable.from(buffer);
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body: stream },
      fields: "id",
    });
    fileId = res.data.id;
  }

  const meta = await drive.files.get({ fileId, fields: "webViewLink" });
  return { url: meta.data.webViewLink, name: fileName };
}
