import { google } from "googleapis";
import { Readable } from "stream";

export class GoogleDriveClient {
  private drive: ReturnType<typeof google.drive>;

  constructor() {
    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
    const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

    if (!keyFile && !keyJson) {
      throw new Error(
        "Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path) or GOOGLE_SERVICE_ACCOUNT_KEY (JSON string)"
      );
    }

    let credentials: object | undefined;
    if (!keyFile) {
      try {
        credentials = JSON.parse(keyJson!);
      } catch {
        throw new Error(
          "GOOGLE_SERVICE_ACCOUNT_KEY contains invalid JSON. " +
            "Ensure it is a valid service account key JSON string (not base64-encoded)."
        );
      }
    }

    const auth = keyFile
      ? new google.auth.GoogleAuth({
          keyFile,
          scopes: ["https://www.googleapis.com/auth/drive.file"],
        })
      : new google.auth.GoogleAuth({
          credentials,
          scopes: ["https://www.googleapis.com/auth/drive.file"],
        });

    this.drive = google.drive({ version: "v3", auth });
  }

  /** Find file ID by name within a folder, returns null if not found */
  private async findFile(name: string, folderId: string): Promise<string | null> {
    const res = await this.drive.files.list({
      q: `name='${name}' and '${folderId}' in parents and trashed=false`,
      fields: "files(id)",
      pageSize: 1,
    });
    return res.data.files?.[0]?.id ?? null;
  }

  /** Download a file's text content, returns null if not found */
  async downloadFile(name: string, folderId: string): Promise<string | null> {
    const fileId = await this.findFile(name, folderId);
    if (!fileId) return null;

    const res = await this.drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    return new Promise((resolve, reject) => {
      let data = "";
      (res.data as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
        data += chunk.toString("utf-8");
      });
      (res.data as NodeJS.ReadableStream).on("end", () => resolve(data));
      (res.data as NodeJS.ReadableStream).on("error", reject);
    });
  }

  /** Create or overwrite a file by name in the given folder */
  async uploadOrUpdate(
    name: string,
    content: Buffer,
    mimeType: string,
    folderId: string
  ): Promise<void> {
    const fileId = await this.findFile(name, folderId);
    const media = { mimeType, body: Readable.from(content) };

    if (fileId) {
      await this.drive.files.update({ fileId, media });
    } else {
      await this.drive.files.create({
        requestBody: { name, parents: [folderId] },
        media,
      });
    }
  }
}
