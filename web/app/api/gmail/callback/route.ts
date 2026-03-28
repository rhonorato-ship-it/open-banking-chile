import { storeGmailToken } from "@/lib/gmail";

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state"); // userId
  const error = url.searchParams.get("error");

  if (error) {
    console.error("[gmail/callback] OAuth error:", error);
    return Response.redirect(`${url.origin}/dashboard?gmail=error`, 302);
  }

  if (!code || !state) {
    return Response.redirect(`${url.origin}/dashboard?gmail=error`, 302);
  }

  try {
    // Exchange authorization code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.AUTH_GOOGLE_ID!,
        client_secret: process.env.AUTH_GOOGLE_SECRET!,
        code,
        grant_type: "authorization_code",
        redirect_uri: `${url.origin}/api/gmail/callback`,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("[gmail/callback] token exchange failed:", tokenRes.status, text);
      return Response.redirect(`${url.origin}/dashboard?gmail=error`, 302);
    }

    const tokenData = (await tokenRes.json()) as GoogleTokenResponse;

    if (!tokenData.refresh_token) {
      console.error("[gmail/callback] no refresh_token received");
      return Response.redirect(`${url.origin}/dashboard?gmail=error`, 302);
    }

    // Encrypt and store the refresh token
    await storeGmailToken(state, tokenData.refresh_token);

    return Response.redirect(`${url.origin}/dashboard?gmail=connected`, 302);
  } catch (e) {
    console.error("[gmail/callback] exception:", e);
    return Response.redirect(`${url.origin}/dashboard?gmail=error`, 302);
  }
}
