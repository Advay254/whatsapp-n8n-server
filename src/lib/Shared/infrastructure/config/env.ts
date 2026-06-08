import path from "node:path";
import { config } from "dotenv";
import { expand } from "dotenv-expand";
import { z } from "zod";

expand(
  config({
    path: path.resolve(
      process.cwd(),
      process.env.NODE_ENV === "test" ? ".env.test" : ".env",
    ),
  }),
);

const ZodEnvSchema = z.object({
  NODE_ENV: z.string().min(1).max(12).default("development"),
  PORT: z.string().min(1).max(5).default("9999"),
  API_KEY: z.string(),
  BROADCAST_DELAY_MS: z.string().min(1).max(5).default("1500"),
  /**
   * Optional. PostgreSQL connection string for external session persistence.
   * When set, WhatsApp sessions survive server restarts and redeployments.
   * When omitted, sessions are stored locally (default LocalAuth behaviour).
   *
   * Supported providers: Supabase, Aiven, Neon, Railway, self-hosted PostgreSQL.
   * Example: postgresql://user:password@host:5432/database
   */
  POSTGRES_URL: z.string().url().optional(),
});

const { data: env, error } = ZodEnvSchema.safeParse(process.env);

if (error) {
  console.error("Invalid env:");
  console.error(JSON.stringify(error.flatten().fieldErrors, null, 2));

  process.exit(1);
}

export { env };
