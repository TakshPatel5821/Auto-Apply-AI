// ─── Gmail OAuth2 client + token lifecycle ───────────────────────────────────
// Single-user (userId="local"), localhost-first. We use the official Gmail API
// with the READ-ONLY scope — enough to pull OTP codes and scan incoming mail; we
// keep our own sync cursor instead of needing modify rights. The per-user refresh
// token is encrypted at rest with the same AES-256-GCM helper as ATS/LinkedIn
// creds (security/crypto.ts) and is never logged.

import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "@/lib/security/crypto";

const USER_ID = "local";

// Derive the OAuth2 client type from googleapis itself — importing it from the
// standalone `google-auth-library` resolves to a *different* copy (googleapis
// nests its own), which TS treats as incompatible.
type GoogleOAuth2Client = InstanceType<typeof google.auth.OAuth2>;

// Read-only is all we need (no send / no modify). Keep the scope minimal.
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export function getRedirectUri(): string {
  return process.env.GMAIL_OAUTH_REDIRECT || "http://localhost:3000/api/gmail/oauth/callback";
}

// Build an OAuth2 client from the app's Google Cloud credentials (env). Throws a
// clear error if they're missing so the UI can tell the user to set them up.
export function getOAuthClient(): GoogleOAuth2Client {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Gmail not configured — set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (Google Cloud OAuth client)."
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
}

// Consent URL the "Connect Gmail" button redirects to. access_type=offline +
// prompt=consent guarantees Google returns a refresh token we can persist.
export function getAuthUrl(): string {
  return getOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

// Exchange the OAuth callback code for tokens, persist the (encrypted) refresh
// token + the connected address. Returns the connected Gmail address.
export async function exchangeCodeForTokens(code: string): Promise<{ address: string }> {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Read the connected account's email so the UI can show which inbox is linked.
  const profile = await google
    .gmail({ version: "v1", auth: client })
    .users.getProfile({ userId: "me" });
  const address = profile.data.emailAddress || "";

  const data: Record<string, unknown> = {
    gmailAddress: address,
    gmailConnectedAt: new Date(),
  };
  // Google only returns a refresh token on the first consent (or with
  // prompt=consent). Only overwrite when present so a re-consent without one
  // doesn't wipe a working token.
  if (tokens.refresh_token) {
    data.encGmailRefreshToken = encryptSecret(tokens.refresh_token);
  }

  await prisma.userSettings.upsert({
    where: { userId: USER_ID },
    update: data,
    create: { userId: USER_ID, ...data },
  });

  return { address };
}

// Build an authed Gmail client from the stored refresh token. Returns null if
// Gmail isn't connected. The OAuth2 client auto-refreshes access tokens; we also
// persist any rotated refresh token Google hands back via the `tokens` event.
export async function getAuthedGmail(): Promise<gmail_v1.Gmail | null> {
  const s = await prisma.userSettings.findUnique({ where: { userId: USER_ID } });
  const refreshToken = decryptSecret(s?.encGmailRefreshToken);
  if (!refreshToken) return null;

  let client: GoogleOAuth2Client;
  try {
    client = getOAuthClient();
  } catch {
    return null; // client id/secret not configured
  }
  client.setCredentials({ refresh_token: refreshToken });

  client.on("tokens", (tokens) => {
    if (tokens.refresh_token) {
      prisma.userSettings
        .update({
          where: { userId: USER_ID },
          data: { encGmailRefreshToken: encryptSecret(tokens.refresh_token) },
        })
        .catch(() => {});
    }
  });

  return google.gmail({ version: "v1", auth: client });
}

export interface GmailStatus {
  connected: boolean;
  configured: boolean; // client id/secret present
  address: string | null;
  connectedAt: Date | null;
  lastSyncAt: Date | null;
}

export async function gmailStatus(): Promise<GmailStatus> {
  const s = await prisma.userSettings.findUnique({ where: { userId: USER_ID } });
  return {
    connected: !!s?.encGmailRefreshToken,
    configured: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET),
    address: s?.gmailAddress || null,
    connectedAt: s?.gmailConnectedAt || null,
    lastSyncAt: s?.gmailLastSyncAt || null,
  };
}

// Disconnect: best-effort token revoke at Google, then clear the stored token.
export async function disconnectGmail(): Promise<void> {
  const s = await prisma.userSettings.findUnique({ where: { userId: USER_ID } });
  const refreshToken = decryptSecret(s?.encGmailRefreshToken);
  if (refreshToken) {
    try {
      const client = getOAuthClient();
      client.setCredentials({ refresh_token: refreshToken });
      await client.revokeToken(refreshToken);
    } catch {
      /* revoke is best-effort — still clear locally below */
    }
  }
  await prisma.userSettings
    .update({
      where: { userId: USER_ID },
      data: {
        encGmailRefreshToken: null,
        gmailAddress: null,
        gmailConnectedAt: null,
        gmailLastSyncAt: null,
      },
    })
    .catch(() => {});
}
