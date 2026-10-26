import { rpc, encodeMuxedAccountToAddress, type xdr } from "@stellar/stellar-sdk";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { Registry, Counter, Gauge, collectDefaultMetrics } from "prom-client";
import { prisma, findCursor, seedCursor, setCursor, type Db } from "./db.js";
import {
  decodeContractCreation,
  decodeInvocation,
  extractEvents,
  extractInvocationReturnValue,
  extractStorageChanges,
} from "./decode.js";

// ---------------------------------------------------------------------------
// Environment variable validation (#20)
// ---------------------------------------------------------------------------
function requireEnv(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    console.error(`[indexer] fatal: environment variable ${name} is required but not set`);
    process.exit(1);
  }
  return val;
}

function requirePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error(
      `[indexer] fatal: ${name} must be a positive integer, got "${raw}"`
    );
    process.exit(1);
  }
  return n;
}

const RPC_URL = requireEnv("SOROBAN_RPC_URL", "https://soroban-testnet.stellar.org");
const POLL_INTERVAL_MS = requirePositiveInt("POLL_INTERVAL_MS", 5000);
const HEALTH_PORT = requirePositiveInt("HEALTH_PORT", 8080);
const MAX_LEDGER_LAG = requirePositiveInt("HEALTH_MAX_LEDGER_LAG", 60);
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
export const PAGE_LIMIT = 50;

// ---------------------------------------------------------------------------
// Prometheus metrics (#23)
// ---------------------------------------------------------------------------
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const metricLedgersProcessed = new Counter({
  name: "indexer_ledgers_processed_total",
  help: "Total number of ledgers processed by the indexer",
  registers: [metricsRegistry],
});

export const metricRowsWritten = new Counter({
  name: "indexer_rows_written_total",
  help: "Total rows written, partitioned by table",
  labelNames: ["table"] as const,
  registers: [metricsRegistry],
});

export const metricLag = new Gauge({
  name: "indexer_ledger_lag",
  help: "Current lag between the indexer cursor and the network latest ledger",
  registers: [metricsRegistry],
});

export const metricPollErrors = new Counter({
  name: "indexer_poll_errors_total",
  help: "Total number of poll errors encountered",
  registers: [metricsRegistry],
});

export const server = new rpc.Server(RPC_URL, { timeout: 10_000 });

let stopping = false;
let wakeFromSleep = (): void => {};

/** Sleep that a shutdown signal can cut short. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeFromSleep = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/**
 * Delay before the next poll after `failures` consecutive failures: exponential
 * from BACKOFF_BASE_MS, capped at BACKOFF_MAX_MS. Equal jitter draws each delay
 * from the upper half of its step, so the range keeps growing with each failure.
 */
export function backoffDelay(failures: number, random: () => number = Math.random): number {
  const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
  return Math.round(step / 2 + random() * (step / 2));
}

export interface HealthSnapshot {
  cursor: number;
  latestLedger: number;
  lastPollFailed: boolean;
}

/** Unhealthy when the last poll failed or the cursor trails the network by more than maxLag ledgers. */
export function healthReport(snapshot: HealthSnapshot, maxLag: number) {
  const lag = Math.max(0, snapshot.latestLedger - snapshot.cursor);
  const healthy = !snapshot.lastPollFailed && lag <= maxLag;
  return { healthy, ...snapshot, lag };
}

/**
 * The last-processed ledger to seed a fresh cursor with. Without INDEXER_START_LEDGER
 * that is the network's latest ledger. With it, indexing begins at that ledger, which
 * must lie inside the RPC node's retention window or the poll would hit the gap branch.
 */
export function seedLastLedger(
  raw: string | undefined,
  network: { latestLedger: number; oldestLedger: number }
): number {
  if (raw === undefined || raw.trim() === "") return network.latestLedger;
  const start = Number(raw);
  if (!Number.isSafeInteger(start) || start < 1) {
    throw new Error(`INDEXER_START_LEDGER must be a positive integer, got "${raw}"`);
  }
  if (start < network.oldestLedger || start > network.latestLedger) {
    throw new Error(
      `INDEXER_START_LEDGER ${start} is outside the RPC node's retention window ` +
        `(ledgers ${network.oldestLedger}-${network.latestLedger})`
    );
  }
  return start - 1;
}

const health: HealthSnapshot = { cursor: 0, latestLedger: 0, lastPollFailed: false };

function startHealthServer(): Server {
  const httpServer = createServer(async (req, res) => {
    const path = req.url?.split("?")[0];
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (path === "/healthz") {
      const report = healthReport(health, MAX_LEDGER_LAG);
      res.writeHead(report.healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(report));
      return;
    }
    if (path === "/metrics") {
      const metrics = await metricsRegistry.metrics();
      res.writeHead(200, { "content-type": metricsRegistry.contentType });
      res.end(metrics);
      return;
    }
    res.writeHead(404).end();
  });
  httpServer.listen(HEALTH_PORT, () => {
    console.log(
      `[indexer] health endpoint listening on port ${HEALTH_PORT} (GET /healthz, GET /metrics)`
    );
  });
  return httpServer;
}

function requestShutdown(signal: NodeJS.Signals): void {
  console.log(`[indexer] ${signal} received, stopping after the current page`);
  stopping = true;
  wakeFromSleep();
}

function sourceAccountOf(envelope: xdr.TransactionEnvelope): string {
  try {
    const tx =
      envelope.switch().name === "envelopeTypeTxFeeBump"
        ? envelope.feeBump().tx().innerTx().v1().tx()
        : envelope.v1().tx();
    return encodeMuxedAccountToAddress(tx.sourceAccount());
  } catch {
    return "";
  }
}

export async function processTransaction(tx: rpc.Api.TransactionInfo, db: Db = prisma): Promise<void> {
  const createdAt = new Date(tx.createdAt * 1000);
  const invocation = decodeInvocation(tx.envelopeXdr);
  const sourceAccount = sourceAccountOf(tx.envelopeXdr);

  if (invocation) {
    // skipDuplicates makes reprocessing a page after a crash-before-cursor-advance safe.
    const invocationResult = await db.invocation.createMany({
      data: [
        {
          txHash: tx.txHash,
          ledger: tx.ledger,
          createdAt,
          contractId: invocation.contractId,
          functionName: invocation.functionName,
          args: invocation.args as object,
          successful: tx.status === "SUCCESS",
          sourceAccount,
          returnValue:
            tx.status === "SUCCESS" ? extractInvocationReturnValue(tx.resultMetaXdr) : null,
        },
      ],
      skipDuplicates: true,
    });
    metricRowsWritten.inc({ table: "invocation" }, invocationResult.count);
  }

  if (tx.status === "SUCCESS" && sourceAccount) {
    const contract = decodeContractCreation(tx.envelopeXdr, tx.resultMetaXdr, sourceAccount);
    if (contract) {
      const contractResult = await db.contract.createMany({
        data: [
          {
            contractId: contract.contractId,
            creator: contract.creator,
            deploymentLedger: tx.ledger,
            deploymentTxHash: tx.txHash,
            createdAt,
          },
        ],
        skipDuplicates: true,
      });
      metricRowsWritten.inc({ table: "contract" }, contractResult.count);
    }
  }

  const changes = extractStorageChanges(tx.resultMetaXdr);
  if (changes.length > 0) {
    const storageResult = await db.storageChange.createMany({
      skipDuplicates: true,
      data: changes.map((c) => ({
        contractId: c.contractId,
        durability: c.durability,
        keyDisplay: c.keyDisplay,
        valueDisplay: c.valueDisplay,
        changeType: c.changeType,
        ledger: tx.ledger,
        txHash: tx.txHash,
        createdAt,
      })),
    });
    metricRowsWritten.inc({ table: "storageChange" }, storageResult.count);
  }

  const events = extractEvents(tx.resultMetaXdr, tx.txHash);
  if (events.length > 0) {
    const eventsResult = await db.contractEventRecord.createMany({
      skipDuplicates: true,
      data: events.map((e) => ({
        eventId: e.eventId,
        contractId: e.contractId,
        type: e.type,
        topic: e.topic,
        value: e.value,
        txHash: tx.txHash,
        ledger: tx.ledger,
        createdAt,
      })),
    });
    metricRowsWritten.inc({ table: "contractEventRecord" }, eventsResult.count);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Where a page leaves the cursor, plus any ledger range the page skipped without indexing. */
export interface PageProgress {
  lastLedger: number;
  paginationCursor: string | null;
  gap?: { fromLedger: number; toLedger: number; reason: string };
}

/** Fetch one transaction page from the persisted ledger and RPC pagination cursor. Writes nothing. */
async function fetchPage(
  cursor: number,
  paginationCursor: string | null,
  latestLedger: number
): Promise<{ transactions: rpc.Api.TransactionInfo[]; progress: PageProgress }> {
  let res;
  try {
    res = paginationCursor
      ? await server.getTransactions({ pagination: { limit: PAGE_LIMIT, cursor: paginationCursor } })
      : await server.getTransactions({ startLedger: cursor + 1, pagination: { limit: PAGE_LIMIT } });
  } catch (err) {
    const message = errorMessage(err);

    // Public RPC is typically a load-balanced pool — a node can briefly lag
    // behind the one that answered our getLatestLedger() call, making it
    // report our very next ledger as "in the future". Transient: don't
    // advance the cursor, just retry on the next poll.
    const oldestMatch = message.match(/oldest ledger:\s*(\d+)/i);
    const latestMatch = message.match(/latest ledger:\s*(\d+)/i);
    if (oldestMatch && Number(oldestMatch[1]) > cursor + 1) {
      console.warn(
        `[indexer] ledger ${cursor + 1} is before the RPC node's retention window (oldest: ${oldestMatch[1]}) — ` +
          `skipping ahead to ${latestLedger}. Some history in the gap was missed.`
      );
      return {
        transactions: [],
        progress: {
          lastLedger: latestLedger,
          paginationCursor: null,
          gap: {
            fromLedger: cursor + 1,
            toLedger: latestLedger,
            reason: `RPC retention: the node's oldest ledger is ${oldestMatch[1]}`,
          },
        },
      };
    }
    if (latestMatch && Number(latestMatch[1]) < cursor + 1) {
      return { transactions: [], progress: { lastLedger: cursor, paginationCursor } };
    }
    throw err;
  }

  if (res.transactions.length === 0) {
    return { transactions: [], progress: { lastLedger: latestLedger, paginationCursor: null } };
  }
  if (res.transactions.length === PAGE_LIMIT && (!res.cursor || res.cursor === paginationCursor)) {
    throw new Error("RPC returned a full page without advancing its transaction cursor");
  }
  return {
    transactions: res.transactions,
    progress: {
      lastLedger: Math.max(cursor, ...res.transactions.map((t) => t.ledger)),
      paginationCursor: res.transactions.length === PAGE_LIMIT ? res.cursor : null,
    },
  };
}

/**
 * Apply one page, its gap record, and its cursor in a single transaction, so the page
 * lands fully or not at all. A failure leaves no new rows and the old cursor in place.
 */
export async function commitPage(
  transactions: rpc.Api.TransactionInfo[],
  progress: PageProgress,
  client: Pick<typeof prisma, "$transaction"> = prisma
): Promise<void> {
  await client.$transaction(
    async (db) => {
      for (const tx of transactions) {
        await processTransaction(tx, db);
      }
      if (progress.gap) {
        await db.indexerGap.create({ data: progress.gap });
      }
      await setCursor(progress.lastLedger, progress.paginationCursor, db);
    },
    { timeout: 30_000 }
  );
}

async function main(): Promise<void> {
  const network = await server.getHealth();
  const existing = await findCursor();
  if (existing && process.env.INDEXER_START_LEDGER) {
    console.warn(
      `[indexer] INDEXER_START_LEDGER is ignored: the cursor already exists at ledger ${existing.lastLedger}`
    );
  }
  const initialCursor =
    existing ?? (await seedCursor(seedLastLedger(process.env.INDEXER_START_LEDGER, network)));
  let cursor = initialCursor.lastLedger;
  let paginationCursor = initialCursor.paginationCursor;
  health.cursor = cursor;
  health.latestLedger = network.latestLedger;
  console.log(`[indexer] starting at ledger ${cursor} (network is at ${network.latestLedger})`);

  const healthServer = startHealthServer();
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);

  let consecutiveFailures = 0;
  while (!stopping) {
    let delayMs = 0;
    try {
      const latestNow = await server.getLatestLedger();
      health.latestLedger = latestNow.sequence;
      if (stopping) break;

      let caughtUp = true;
      if (cursor < latestNow.sequence || paginationCursor) {
        const page = await fetchPage(cursor, paginationCursor, latestNow.sequence);
        const { progress } = page;
        if (
          page.transactions.length > 0 ||
          progress.lastLedger !== cursor ||
          progress.paginationCursor !== paginationCursor
        ) {
          await commitPage(page.transactions, progress);
          cursor = progress.lastLedger;
          paginationCursor = progress.paginationCursor;
          health.cursor = cursor;
          console.log(`[indexer] processed through ledger ${cursor}`);
        }
        caughtUp = cursor >= latestNow.sequence && !paginationCursor;
        if (page.transactions.length > 0) {
          metricLedgersProcessed.inc();
        }
      }
      consecutiveFailures = 0;
      health.lastPollFailed = false;
      metricLag.set(Math.max(0, health.latestLedger - health.cursor));
      delayMs = caughtUp ? POLL_INTERVAL_MS : 0;
    } catch (err) {
      consecutiveFailures++;
      health.lastPollFailed = true;
      metricPollErrors.inc();
      delayMs = backoffDelay(consecutiveFailures);
      console.error(
        `[indexer] poll error (failure ${consecutiveFailures}), retrying in ${delayMs}ms:`,
        err
      );
    }
    if (!stopping) await sleep(delayMs);
  }

  console.log("[indexer] shutting down");
  await setCursor(cursor, paginationCursor);
  healthServer.close();
  await prisma.$disconnect();
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error("[indexer] fatal error:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
