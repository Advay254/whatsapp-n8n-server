import qrcode from "qrcode-terminal";
import type { Client as WhatsAppWebClient } from "whatsapp-web.js";
import pkg from "whatsapp-web.js";
import { env } from "@/lib/Shared/infrastructure/config/env";
import { PostgresStore } from "@/lib/Whatsapp/infrastructure/stores/PostgresStore";
import { WhatsappClientIsNotReadyError } from "@/lib/Whatsapp/domain/exceptions/WhatsappClientIsNotReadyError";

const { Client, LocalAuth, RemoteAuth } = pkg;

/** Shared Puppeteer launch flags required for containerised environments. */
const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  "--single-process",
  "--disable-gpu",
];

let client: WhatsAppWebClient;
let isReady = false;
let initializationPromise: Promise<void> | null = null;
let currentQrCode: string | null = null;
let connectionStatus:
  | "initializing"
  | "qr"
  | "authenticating"
  | "ready"
  | "disconnected" = "disconnected";

/**
 * Builds the appropriate authentication strategy based on configuration.
 *
 * - If `POSTGRES_URL` is set: uses RemoteAuth backed by PostgresStore,
 *   enabling session persistence across restarts and redeployments.
 * - Otherwise: falls back to LocalAuth (default behaviour, stores session
 *   on the local filesystem at `./.wwebjs_auth`).
 *
 * @returns A configured whatsapp-web.js auth strategy instance.
 */
function buildAuthStrategy() {
  if (env.POSTGRES_URL) {
    console.log(
      "[WhatsappClient] POSTGRES_URL detected — using RemoteAuth with PostgresStore."
    );

    const store = new PostgresStore(env.POSTGRES_URL);

    // Gracefully close the DB pool when the process exits.
    process.on("SIGINT", () => store.close().finally(() => process.exit(0)));
    process.on("SIGTERM", () => store.close().finally(() => process.exit(0)));

    return new RemoteAuth({
      clientId: "whatsapp-n8n-server",
      store,
      /**
       * How often (ms) RemoteAuth backs up the session to the store
       * while the client is running. Defaults to 5 minutes.
       */
      backupSyncIntervalMs: 300_000,
    });
  }

  console.log(
    "[WhatsappClient] No POSTGRES_URL set — using LocalAuth (filesystem)."
  );

  return new LocalAuth({
    clientId: "whatsapp-n8n-server",
    dataPath: "./.wwebjs_auth",
  });
}

export const getWhatsAppClient = async (): Promise<
  InstanceType<typeof Client>
> => {
  if (!initializationPromise) {
    initializationPromise = new Promise<void>((resolve) => {
      client = new Client({
        authStrategy: buildAuthStrategy(),
        puppeteer: { args: PUPPETEER_ARGS },
      });

      client.on("qr", (qr) => {
        console.log("Scan the QR code to log in:");
        qrcode.generate(qr, { small: true });
        currentQrCode = qr;
        connectionStatus = "qr";
      });

      client.on("ready", () => {
        console.log("WhatsApp client is ready!");
        try {
          client.setBackgroundSync(true);
        } catch (syncError) {
          console.warn(
            "Failed to sync chat history:",
            syncError instanceof Error ? syncError.message : String(syncError)
          );
        }
        isReady = true;
        currentQrCode = null;
        connectionStatus = "ready";
        resolve();
      });

      client.on("authenticated", () => {
        console.log("Client authenticated!");
        connectionStatus = "authenticating";
      });

      client.on("disconnected", async (reason) => {
        console.log("Client was disconnected:", reason);
        isReady = false;
        currentQrCode = null;
        connectionStatus = "disconnected";
        initializationPromise = null;
      });

      client.on("auth_failure", (msg) => {
        console.error("Authentication failure:", msg);
        isReady = false;
        currentQrCode = null;
        connectionStatus = "disconnected";
        initializationPromise = null;
      });

      client.initialize();
    });
  }

  await initializationPromise;

  if (!isReady)
    throw new WhatsappClientIsNotReadyError("WhatsApp client is not ready");

  return client;
};

export const getQrCode = (): string | null => currentQrCode;
export const getConnectionStatus = (): string => connectionStatus;
export const initializeClient = (): void => {
  if (!initializationPromise) getWhatsAppClient().catch(console.error);
};
