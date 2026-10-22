import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToScVal, rpc, StrKey } from "@stellar/stellar-sdk";

vi.mock("./indexed-db", () => ({
  isIndexerConfigured: vi.fn(),
  getIndexedEvents: vi.fn(),
  getIndexedContract: vi.fn().mockResolvedValue(null),
  getIndexedInvocationReturnValue: vi.fn().mockResolvedValue(null),
  getIndexedInvocations: vi.fn(),
  getIndexedStorageEntries: vi.fn(),
}));

import {
  getContractEvents,
  getContractEventsPage,
  getContractInfo,
  getInvocationHistory,
  getInvocationReturnValue,
  simulateInvocation,
} from "./soroban";
import {
  getIndexedContract,
  getIndexedEvents,
  getIndexedInvocationReturnValue,
  getIndexedInvocations,
  isIndexerConfigured,
} from "./indexed-db";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function rpcEvent(txHash = "tx-1") {
  return {
    id: `event-${txHash}`,
    type: "contract",
    topic: [nativeToScVal("updated", { type: "symbol" })],
    value: nativeToScVal("hello", { type: "string" }),
    txHash,
    ledger: 100,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
  };
}

describe("getContractInfo", () => {
  it("reads and formats contract instance data through RPC", async () => {
    vi.spyOn(rpc.Server.prototype, "getContractData").mockResolvedValue({
      val: {
        contractData: () => ({
          val: () => ({
            instance: () => ({
              executable: () => ({
                switch: () => ({ name: "contractExecutableWasm" }),
                wasmHash: () => Buffer.alloc(32, 1),
              }),
              storage: () => [],
            }),
          }),
        }),
      },
      liveUntilLedgerSeq: 200,
      lastModifiedLedgerSeq: 90,
    } as never);

    const info = await getContractInfo("contract-id");
    expect(info).toMatchObject({
      executable: "wasm",
      wasmHash: "01".repeat(32),
      liveUntilLedgerSeq: 200,
      lastModifiedLedgerSeq: 90,
      instanceStorage: [],
    });
    expect(rpc.Server.prototype.getContractData).toHaveBeenCalledOnce();
  });

  it("returns null when the RPC request fails", async () => {
    vi.spyOn(rpc.Server.prototype, "getContractData").mockRejectedValue(new Error("RPC down"));
    await expect(getContractInfo("contract-id")).resolves.toBeNull();
  });

  it("includes indexed deployment information", async () => {
    vi.mocked(isIndexerConfigured).mockReturnValue(true);
    vi.mocked(getIndexedContract).mockResolvedValue({
      creator: "GCREATOR",
      deploymentLedger: 88,
    });
    vi.spyOn(rpc.Server.prototype, "getContractData").mockResolvedValue({
      val: {
        contractData: () => ({
          val: () => ({
            instance: () => ({
              executable: () => ({
                switch: () => ({ name: "contractExecutableWasm" }),
                wasmHash: () => Buffer.alloc(32, 1),
              }),
              storage: () => [],
            }),
          }),
        }),
      },
    } as never);

    await expect(getContractInfo("contract-id")).resolves.toMatchObject({
      creator: "GCREATOR",
      deploymentLedger: 88,
    });
  });
});

describe("getInvocationReturnValue", () => {
  it("uses the persisted return value without querying pruned RPC history", async () => {
    vi.mocked(getIndexedInvocationReturnValue).mockResolvedValue("stored result");
    const getTransaction = vi.spyOn(rpc.Server.prototype, "getTransaction");

    await expect(getInvocationReturnValue("tx-hash")).resolves.toBe("stored result");
    expect(getTransaction).not.toHaveBeenCalled();
  });
});

describe("getContractEvents", () => {
  it("uses indexed events when the indexer is configured", async () => {
    vi.mocked(isIndexerConfigured).mockReturnValue(true);
    vi.mocked(getIndexedEvents).mockResolvedValue({
      items: [
        {
          eventId: "indexed-1",
          type: "contract",
          topic: ["updated"],
          value: "hello",
          txHash: "tx-indexed",
          ledger: 123,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      nextCursor: null,
    });
    const rpcSpy = vi.spyOn(rpc.Server.prototype, "getLatestLedger");

    await expect(getContractEvents("contract-id", 3)).resolves.toEqual([
      {
        id: "indexed-1",
        contractId: "contract-id",
        type: "contract",
        topic: ["updated"],
        value: "hello",
        txHash: "tx-indexed",
        ledger: 123,
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(getIndexedEvents).toHaveBeenCalledWith("contract-id", { limit: 3 });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("returns a cursor for the next page when the indexer has more events", async () => {
    vi.mocked(isIndexerConfigured).mockReturnValue(true);
    vi.mocked(getIndexedEvents).mockResolvedValue({ items: [], nextCursor: "next-page" });

    await expect(getContractEventsPage("contract-id", { limit: 2 })).resolves.toEqual({
      items: [],
      nextCursor: "next-page",
      error: null,
    });
  });

  it("never continues the RPC fallback, which holds only its retention window", async () => {
    vi.mocked(isIndexerConfigured).mockReturnValue(false);
    const rpcSpy = vi.spyOn(rpc.Server.prototype, "getLatestLedger");

    await expect(
      getContractEventsPage("contract-id", { limit: 2, before: { ledger: 5, id: "row" } })
    ).resolves.toEqual({ items: [], nextCursor: null, error: null });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("queries RPC and formats the event list when no indexer is configured", async () => {
    vi.mocked(isIndexerConfigured).mockReturnValue(false);
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
      sequence: 20_000,
    } as never);
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue({
      events: [rpcEvent()],
    } as never);

    await expect(getContractEvents("contract-id", 4)).resolves.toMatchObject([
      {
        id: "event-tx-1",
        contractId: "contract-id",
        topic: ["updated"],
        value: "hello",
        txHash: "tx-1",
      },
    ]);
    expect(getIndexedEvents).not.toHaveBeenCalled();
  });

  it("keeps an RPC failure separate from a genuinely empty result", async () => {
    vi.mocked(isIndexerConfigured).mockReturnValue(false);
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockRejectedValue(new Error("RPC down"));

    await expect(getContractEventsPage("contract-id", { limit: 2 })).resolves.toEqual({
      items: [],
      nextCursor: null,
      error: "RPC down",
    });

    vi.mocked(rpc.Server.prototype.getLatestLedger).mockResolvedValue({ sequence: 10 } as never);
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue({ events: [] } as never);
    await expect(getContractEventsPage("contract-id", { limit: 2 })).resolves.toEqual({
      items: [],
      nextCursor: null,
      error: null,
    });
  });

  it("returns an empty list when the RPC call fails or returns no events", async () => {
    vi.mocked(isIndexerConfigured).mockReturnValue(false);
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockRejectedValue(new Error("RPC down"));
    await expect(getContractEvents("contract-id")).resolves.toEqual([]);

    vi.mocked(rpc.Server.prototype.getLatestLedger).mockResolvedValue({ sequence: 10 } as never);
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue({ events: [] } as never);
    await expect(getContractEvents("contract-id")).resolves.toEqual([]);
  });
});

describe("getInvocationHistory", () => {
  it("uses indexed invocations when the indexer is configured", async () => {
    vi.mocked(isIndexerConfigured).mockReturnValue(true);
    vi.mocked(getIndexedInvocations).mockResolvedValue({
      items: [
        {
          txHash: "indexed-tx",
          ledger: 123,
          createdAt: "2026-01-01T00:00:00Z",
          functionName: "increment",
          args: [1, true],
          successful: true,
          sourceAccount: "GABC",
        },
      ],
      nextCursor: null,
    });
    const rpcSpy = vi.spyOn(rpc.Server.prototype, "getLatestLedger");

    await expect(getInvocationHistory("contract-id", 2)).resolves.toEqual([
      {
        txHash: "indexed-tx",
        ledger: 123,
        timestamp: "2026-01-01T00:00:00Z",
        functionName: "increment",
        args: ["1", "true"],
        successful: true,
      },
    ]);
    expect(getIndexedInvocations).toHaveBeenCalledWith("contract-id", { limit: 2 });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("derives unique recent transactions from RPC events", async () => {
    vi.mocked(isIndexerConfigured).mockReturnValue(false);
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
      sequence: 20_000,
    } as never);
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue({
      events: [rpcEvent(), rpcEvent(), rpcEvent("tx-2")],
    } as never);
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as never);

    await expect(getInvocationHistory("contract-id")).resolves.toEqual([]);
    expect(rpc.Server.prototype.getTransaction).toHaveBeenCalledTimes(2);
    expect(getIndexedInvocations).not.toHaveBeenCalled();
  });
});

describe("simulateInvocation", () => {
  it("reports an RPC failure as an unsuccessful simulation", async () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockRejectedValue(
      new Error("RPC unavailable")
    );

    await expect(simulateInvocation(contractId, "hello", [])).resolves.toEqual({
      success: false,
      error: "RPC unavailable",
    });
    expect(rpc.Server.prototype.simulateTransaction).toHaveBeenCalledOnce();
  });
});
