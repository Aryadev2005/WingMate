import pg from "pg";

export type Db = pg.Pool;

export function createDb(url: string, max: number): Db {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30000, statement_timeout: 10000 });
  pool.on("error", () => {}); // idle client errors are retried by the pool
  return pool;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan text NOT NULL DEFAULT 'free',
    plan_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE refresh_tokens (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX refresh_tokens_user ON refresh_tokens(user_id);
  CREATE TABLE profiles (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    birth_year int NOT NULL,
    country char(2) NOT NULL,
    situation text NOT NULL,
    interested_in text NOT NULL,
    tone text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL DEFAULT 'New chat',
    summary text NOT NULL DEFAULT '',
    summarized_upto bigint NOT NULL DEFAULT 0,
    message_count int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX conversations_user_updated ON conversations(user_id, updated_at DESC);
  CREATE TABLE messages (
    id bigserial PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('user','assistant')),
    content text NOT NULL,
    safety boolean NOT NULL DEFAULT false,
    model text,
    prompt_tokens int NOT NULL DEFAULT 0,
    completion_tokens int NOT NULL DEFAULT 0,
    cost_micros int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, id);
  `,
  // Reply Lab usage. Stores cost only: screenshots and pasted text are never saved.
  `
  CREATE TABLE assist_events (
    id bigserial PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode text NOT NULL,
    with_image boolean NOT NULL,
    model text,
    prompt_tokens int NOT NULL DEFAULT 0,
    completion_tokens int NOT NULL DEFAULT 0,
    cost_micros int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX assist_events_created ON assist_events(created_at);
  `,
];

/** Applies pending migrations. An advisory lock keeps concurrent replicas from racing. */
export async function migrate(db: Db): Promise<void> {
  const c = await db.connect();
  try {
    await c.query("SELECT pg_advisory_lock(727001)");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz DEFAULT now())");
    const { rows } = await c.query<{ v: number }>("SELECT coalesce(max(version),0)::int AS v FROM schema_migrations");
    for (let i = rows[0].v; i < MIGRATIONS.length; i++) {
      await c.query("BEGIN");
      await c.query(MIGRATIONS[i]);
      await c.query("INSERT INTO schema_migrations(version) VALUES ($1)", [i + 1]);
      await c.query("COMMIT");
    }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    c.release();
  }
}
