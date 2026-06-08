/**
 * PostgresStore
 *
 * A PostgreSQL-backed session store for whatsapp-web.js RemoteAuth strategy.
 *
 * Enables persistent WhatsApp sessions across server restarts and redeployments
 * by storing session data in any external PostgreSQL database.
 *
 * Compatible providers (anything with a standard PostgreSQL connection string):
 *   - Supabase  (postgresql://postgres.[ref]:[password]@[host]:5432/postgres)
 *   - Aiven     (postgresql://avnadmin:[password]@[host]:5432/defaultdb?sslmode=require)
 *   - Neon      (postgresql://[user]:[password]@[host]/[db]?sslmode=require)
 *   - Railway   (postgresql://postgres:[password]@[host]:5432/railway)
 *   - Any self-hosted PostgreSQL instance
 *
 * Usage:
 *   The store is automatically selected when the POSTGRES_URL environment
 *   variable is set. No manual table creation is required — the table is
 *   created automatically on first run if it does not already exist.
 *
 * @implements RemoteAuth SessionStore (whatsapp-web.js)
 */

import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";

/** Name of the auto-managed sessions table */
const TABLE_NAME = "wwebjs_sessions";

/** DDL executed once on first connection — idempotent, safe to re-run */
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
    session_id   VARCHAR(255)             NOT NULL PRIMARY KEY,
    session_data TEXT                     NOT NULL,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  );
`;

export class PostgresStore {
  private pool: Pool;
  private ready: Promise<void>;

  /**
   * Initialises the store and ensures the sessions table exists.
   *
   * Table creation is idempotent (CREATE TABLE IF NOT EXISTS) so it is safe
   * to call on every startup without side effects on existing data.
   *
   * @param connectionString - Standard PostgreSQL connection URI.
   *   SSL is enabled automatically for non-localhost connections to support
   *   managed cloud providers that require it.
   *
   * @throws If the database is unreachable or credentials are invalid.
   */
  constructor(connectionString: string) {
    const isLocal =
      connectionString.includes("localhost") ||
      connectionString.includes("127.0.0.1");

    this.pool = new Pool({
      connectionString,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // Run table initialisation once at construction time.
    // All public methods await this promise before executing queries,
    // so callers never need to call an explicit init() method.
    this.ready = this.pool
      .query(CREATE_TABLE_SQL)
      .then(() => {
        console.log(
          "[PostgresStore] Connected. Session table is ready."
        );
      })
      .catch((err) => {
        console.error(
          "[PostgresStore] Failed to initialise session table:",
          err
        );
        throw err;
      });
  }

  // ---------------------------------------------------------------------------
  // RemoteAuth store interface
  // ---------------------------------------------------------------------------

  /**
   * Checks whether a session record exists in the database.
   *
   * Called by RemoteAuth on startup to decide whether to restore an existing
   * session or start a fresh authentication (QR code) flow.
   *
   * @param options.session - The session identifier (clientId).
   * @returns `true` if the session exists, `false` otherwise.
   */
  async sessionExists({ session }: { session: string }): Promise<boolean> {
    await this.ready;

    const result = await this.pool.query<{ session_id: string }>(
      `SELECT session_id FROM ${TABLE_NAME} WHERE session_id = $1 LIMIT 1`,
      [session]
    );

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Persists the session zip file produced by RemoteAuth to the database.
   *
   * RemoteAuth writes a zip archive of the auth folder to `{session}.zip`
   * in the working directory before calling this method. The zip is read,
   * base64-encoded, and upserted into the sessions table.
   *
   * @param options.session - The session identifier (clientId).
   * @throws If the expected zip file is not found on disk.
   */
  async save({ session }: { session: string }): Promise<void> {
    await this.ready;

    const zipPath = path.resolve(`${session}.zip`);

    if (!fs.existsSync(zipPath)) {
      throw new Error(
        `[PostgresStore] Session zip not found at "${zipPath}". ` +
          "Ensure RemoteAuth has completed authentication before saving."
      );
    }

    const sessionData = fs.readFileSync(zipPath).toString("base64");

    await this.pool.query(
      `INSERT INTO ${TABLE_NAME} (session_id, session_data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (session_id)
       DO UPDATE SET
         session_data = EXCLUDED.session_data,
         updated_at   = NOW()`,
      [session, sessionData]
    );

    console.log(`[PostgresStore] Session "${session}" saved to PostgreSQL.`);
  }

  /**
   * Restores a session from the database by writing its zip file to disk.
   *
   * RemoteAuth calls this on startup when `sessionExists` returns `true`.
   * The stored base64 data is decoded and written to `{session}.zip` so
   * whatsapp-web.js can extract it and resume the previous session without
   * requiring a new QR code scan.
   *
   * @param options.session - The session identifier (clientId).
   * @throws If no session data is found for the given identifier.
   */
  async extract({ session }: { session: string }): Promise<void> {
    await this.ready;

    const result = await this.pool.query<{ session_data: string }>(
      `SELECT session_data FROM ${TABLE_NAME} WHERE session_id = $1`,
      [session]
    );

    const row = result.rows[0];

    if (!row?.session_data) {
      throw new Error(
        `[PostgresStore] No session data found for identifier "${session}".`
      );
    }

    const zipPath = path.resolve(`${session}.zip`);
    fs.writeFileSync(zipPath, Buffer.from(row.session_data, "base64"));

    console.log(
      `[PostgresStore] Session "${session}" restored from PostgreSQL.`
    );
  }

  /**
   * Removes a session record from the database.
   *
   * Called by RemoteAuth when the WhatsApp client logs out. After deletion
   * the next startup will trigger a fresh QR code authentication flow.
   *
   * @param options.session - The session identifier (clientId).
   */
  async delete({ session }: { session: string }): Promise<void> {
    await this.ready;

    await this.pool.query(
      `DELETE FROM ${TABLE_NAME} WHERE session_id = $1`,
      [session]
    );

    console.log(
      `[PostgresStore] Session "${session}" removed from PostgreSQL.`
    );
  }

  /**
   * Closes all idle database connections in the pool.
   *
   * Call this when the process is shutting down to allow PostgreSQL to
   * release server-side resources cleanly.
   */
  async close(): Promise<void> {
    await this.pool.end();
    console.log("[PostgresStore] Connection pool closed.");
  }
  }
