import { Pool, type PoolConfig } from "pg";
import { takePage, type HistoryPage, type PageRequest } from "./history-cursor";

let pool: Pool | undefined;

/** pg's own defaults, pinned here so the pool behaves the same across pg upgrades. */
const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

type EnvLike = Record<string, string | undefined>;

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * `DATABASE_SSL` turns on TLS for managed Postgres. `no-verify` encrypts without
 * validating the server certificate, for providers whose CA is not in Node's
 * trust store. Unset means no TLS, which is what local compose uses.
 */
function parseSsl(raw: string | undefined): PoolConfig["ssl"] {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "false") return undefined;
  if (value === "true") return true;
  if (value === "no-verify") return { rejectUnauthorized: false };
  throw new Error(`DATABASE_SSL must be "true", "false" or "no-verify", got ${JSON.stringify(raw)}`);
}

/** Build the pool's config from an environment, defaulting to pg's values. */
export function poolConfigFromEnv(env: EnvLike): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    max: parsePositiveInt("DATABASE_POOL_MAX", env.DATABASE_POOL_MAX, DEFAULT_POOL_MAX),
    idleTimeoutMillis: parsePositiveInt(
      "DATABASE_IDLE_TIMEOUT_MS",
      env.DATABASE_IDLE_TIMEOUT_MS,
      DEFAULT_IDLE_TIMEOUT_MS
    ),
    ssl: parseSsl(env.DATABASE_SSL),
  };
}

/** Whether a Postgres-backed indexer is configured for this deployment (see indexer/). */
export function isIndexerConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function getPool(): Pool {
  if (!pool) pool = new Pool(poolConfigFromEnv(process.env));
  return pool;
}

export interface IndexedInvocation {
  txHash: string;
  ledger: number;
  createdAt: string;
  functionName: string;
  args: unknown;
  successful: boolean;
  sourceAccount: string;
}

/** The stored return value for a transaction, when the indexer has one. */
export async function getIndexedInvocationReturnValue(txHash: string): Promise<string | null> {
  if (!isIndexerConfigured()) return null;
  const { rows } = await getPool().query(
    `SELECT "returnValue" FROM "Invocation" WHERE "txHash" = $1`,
    [txHash]
  );
  return rows[0]?.returnValue ?? null;
}

/**
 * One page of a contract's invocation history since the indexer started, newest
 * first. `before` continues from the cursor a previous page returned.
 */
export async function getIndexedInvocations(
  contractId: string,
  { limit, before }: PageRequest
): Promise<HistoryPage<IndexedInvocation>> {
  if (!isIndexerConfigured()) return { items: [], nextCursor: null };
  const { rows } = await getPool().query(
    `SELECT id, "txHash", ledger, "createdAt", "functionName", args, successful, "sourceAccount"
     FROM "Invocation"
     WHERE "contractId" = $1
       AND ($2::int IS NULL OR (ledger, id) < ($2::int, $3::text))
     ORDER BY ledger DESC, id DESC
     LIMIT $4`,
    [contractId, before?.ledger ?? null, before?.id ?? null, limit + 1]
  );
  const page = takePage(rows, limit);
  return {
    items: page.rows.map((r) => ({
      txHash: r.txHash,
      ledger: r.ledger,
      createdAt: r.createdAt.toISOString(),
      functionName: r.functionName,
      args: r.args,
      successful: r.successful,
      sourceAccount: r.sourceAccount,
    })),
    nextCursor: page.nextCursor,
  };
}

export interface IndexedContract {
  creator: string;
  deploymentLedger: number;
}

export async function getIndexedContract(contractId: string): Promise<IndexedContract | null> {
  if (!isIndexerConfigured()) return null;
  const { rows } = await getPool().query(
    `SELECT creator, "deploymentLedger" FROM "Contract" WHERE "contractId" = $1`,
    [contractId]
  );
  if (!rows[0]) return null;
  return {
    creator: rows[0].creator,
    deploymentLedger: rows[0].deploymentLedger,
  };
}

export interface IndexedEvent {
  eventId: string;
  type: string;
  topic: string[];
  value: string;
  txHash: string;
  ledger: number;
  createdAt: string;
}

/**
 * One page of a contract's event history since the indexer started, newest
 * first. `before` continues from the cursor a previous page returned.
 */
export async function getIndexedEvents(
  contractId: string,
  { limit, before }: PageRequest
): Promise<HistoryPage<IndexedEvent>> {
  if (!isIndexerConfigured()) return { items: [], nextCursor: null };
  const { rows } = await getPool().query(
    `SELECT id, "eventId", type, topic, value, "txHash", ledger, "createdAt"
     FROM "ContractEventRecord"
     WHERE "contractId" = $1
       AND ($2::int IS NULL OR (ledger, id) < ($2::int, $3::text))
     ORDER BY ledger DESC, id DESC
     LIMIT $4`,
    [contractId, before?.ledger ?? null, before?.id ?? null, limit + 1]
  );
  const page = takePage(rows, limit);
  return {
    items: page.rows.map((r) => ({
      eventId: r.eventId,
      type: r.type,
      topic: r.topic,
      value: r.value,
      txHash: r.txHash,
      ledger: r.ledger,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

export interface IndexedStorageEntry {
  durability: string;
  keyDisplay: string;
  valueDisplay: string;
  ledger: number;
}

/**
 * Every storage key the indexer has ever seen for this contract, at its
 * most recent known value — the full-enumeration capability plain RPC
 * access can't provide at all. Only reflects activity since the indexer
 * started (forward-only, no historical backfill).
 */
export async function getIndexedStorageEntries(contractId: string): Promise<IndexedStorageEntry[]> {
  if (!isIndexerConfigured()) return [];
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (durability, "keyDisplay")
       durability, "keyDisplay", "valueDisplay", ledger, "changeType"
     FROM "StorageChange"
     WHERE "contractId" = $1 AND "changeType" != 'state'
     ORDER BY durability, "keyDisplay", ledger DESC`,
    [contractId]
  );
  return rows
    .filter((r) => r.changeType !== "removed")
    .map((r) => ({
      durability: r.durability,
      keyDisplay: r.keyDisplay,
      valueDisplay: r.valueDisplay,
      ledger: r.ledger,
    }));
}

export interface IndexedGap {
  fromLedger: number;
  toLedger: number;
  reason: string;
  createdAt: string;
}

/**
 * Ledger ranges the live indexer skipped without indexing (see indexer's
 * IndexerGap). Gaps apply to every contract, so this is not keyed by contract.
 */
export async function getIndexedGaps(): Promise<IndexedGap[]> {
  if (!isIndexerConfigured()) return [];
  const { rows } = await getPool().query(
    `SELECT "fromLedger", "toLedger", reason, "createdAt"
     FROM "IndexerGap"
     ORDER BY "fromLedger"`
  );
  return rows.map((r) => ({
    fromLedger: r.fromLedger,
    toLedger: r.toLedger,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
}
