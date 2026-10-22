import { describe, expect, it } from "vitest";
import { StrKey, xdr } from "@stellar/stellar-sdk";
import {
  decodeContractCreation,
  decodeInvocation,
  extractEvents,
  extractInvocationReturnValue,
  extractStorageChanges,
  scValToDisplay,
} from "./decode.js";
import createContractV2Fixture from "./fixtures/create-contract-v2.json" with { type: "json" };
import createContractFixture from "./fixtures/create-contract.json" with { type: "json" };
import failedInvokeFixture from "./fixtures/failed-invoke.json" with { type: "json" };
import multiOperationFixture from "./fixtures/multi-operation.json" with { type: "json" };
import successfulInvokeFixture from "./fixtures/successful-invoke.json" with { type: "json" };

interface Fixture {
  description: string;
  hash: string;
  ledger: number;
  status: "SUCCESS" | "FAILED";
  envelopeXdr: string;
  resultMetaXdr: string;
}

/**
 * Testnet envelopes and metas captured from Soroban RPC (`getTransaction`) on
 * 2026-10-22; see src/fixtures/README.md for provenance.
 */
function loadFixture(fixture: Fixture) {
  return {
    ...fixture,
    envelope: xdr.TransactionEnvelope.fromXDR(fixture.envelopeXdr, "base64"),
    meta: xdr.TransactionMeta.fromXDR(fixture.resultMetaXdr, "base64"),
  };
}

describe("scValToDisplay", () => {
  it("decodes a symbol to a plain string", () => {
    expect(scValToDisplay(xdr.ScVal.scvSymbol("Admin"))).toBe("Admin");
  });

  it("renders void as the literal string 'void'", () => {
    expect(scValToDisplay(xdr.ScVal.scvVoid())).toBe("void");
  });

  it("renders a vec as JSON", () => {
    const vec = xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(2)]);
    expect(scValToDisplay(vec)).toBe("[1,2]");
  });

  it("decodes a u128 to a string (bigints aren't JSON-safe)", () => {
    const val = xdr.ScVal.scvU128(
      new xdr.UInt128Parts({ hi: xdr.Uint64.fromString("0"), lo: xdr.Uint64.fromString("1000") })
    );
    expect(scValToDisplay(val)).toBe("1000");
  });

  it("doesn't dump the raw internal struct for a contract instance value", () => {
    // Would previously fall through to JSON.stringify(scValToNative(...)) and
    // print the js-xdr class's internal fields (_maxDepth, _attributes, ...).
    const instance = new xdr.ScContractInstance({
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
      storage: null,
    });
    const val = xdr.ScVal.scvContractInstance(instance);
    expect(scValToDisplay(val)).toBe("(contract instance)");
  });
});

describe("extractInvocationReturnValue", () => {
  it.each([3, 4])("reads a successful Soroban return value from metadata v%s", (version) => {
    const returnValue = xdr.ScVal.scvSymbol("result");
    const ext = new xdr.SorobanTransactionMetaExt(0);
    const transactionMeta =
      version === 3
        ? new xdr.TransactionMeta(
            3,
            new xdr.TransactionMetaV3({
              ext: new xdr.ExtensionPoint(0),
              txChangesBefore: [],
              operations: [],
              txChangesAfter: [],
              sorobanMeta: new xdr.SorobanTransactionMeta({
                ext,
                events: [],
                returnValue,
                diagnosticEvents: [],
              }),
            })
          )
        : new xdr.TransactionMeta(
            4,
            new xdr.TransactionMetaV4({
              ext: new xdr.ExtensionPoint(0),
              txChangesBefore: [],
              operations: [],
              txChangesAfter: [],
              sorobanMeta: new xdr.SorobanTransactionMetaV2({ ext, returnValue }),
              events: [],
              diagnosticEvents: [],
            })
          );

    expect(extractInvocationReturnValue(transactionMeta)).toBe("result");
  });
});

describe("extractEvents", () => {
  const txHash = "ab".repeat(32);
  const contractIdBytes = Buffer.alloc(32, 1);
  const contractEvent = new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    // js-xdr takes a Buffer for the Hash-typed contract id at runtime (see decode.ts).
    contractId: contractIdBytes as unknown as xdr.ContractId,
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [xdr.ScVal.scvSymbol("transfer")],
        data: xdr.ScVal.scvU32(7),
      })
    ),
  });
  const expected = [
    {
      eventId: `${txHash}-0-0`,
      contractId: StrKey.encodeContract(contractIdBytes),
      type: "contract",
      topic: ["transfer"],
      value: "7",
    },
  ];

  it("reads Soroban events from transaction meta v3", () => {
    const meta = new xdr.TransactionMeta(
      3,
      new xdr.TransactionMetaV3({
        ext: new xdr.ExtensionPoint(0),
        txChangesBefore: [],
        operations: [],
        txChangesAfter: [],
        sorobanMeta: new xdr.SorobanTransactionMeta({
          ext: new xdr.SorobanTransactionMetaExt(0),
          events: [contractEvent],
          returnValue: xdr.ScVal.scvVoid(),
          diagnosticEvents: [],
        }),
      })
    );

    expect(extractEvents(meta, txHash)).toEqual(expected);
  });

  it("reads per-operation Soroban events from transaction meta v4", () => {
    const meta = new xdr.TransactionMeta(
      4,
      new xdr.TransactionMetaV4({
        ext: new xdr.ExtensionPoint(0),
        txChangesBefore: [],
        operations: [
          new xdr.OperationMetaV2({
            ext: new xdr.ExtensionPoint(0),
            changes: [],
            events: [contractEvent],
          }),
        ],
        txChangesAfter: [],
        sorobanMeta: new xdr.SorobanTransactionMetaV2({
          ext: new xdr.SorobanTransactionMetaExt(0),
          returnValue: xdr.ScVal.scvVoid(),
        }),
        events: [],
        diagnosticEvents: [],
      })
    );

    expect(extractEvents(meta, txHash)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Fixture-based tests: real testnet envelopes and metas.
// ---------------------------------------------------------------------------

const successfulInvoke = loadFixture(successfulInvokeFixture as Fixture);
const failedInvoke = loadFixture(failedInvokeFixture as Fixture);
const createContract = loadFixture(createContractFixture as Fixture);
const createContractV2 = loadFixture(createContractV2Fixture as Fixture);
const multiOperation = loadFixture(multiOperationFixture as Fixture);

describe("scValToDisplay (testnet fixtures)", () => {
  it("renders the Soroban return value of a real invocation", () => {
    const returnValue = successfulInvoke.meta.v4().sorobanMeta()!.returnValue()!;
    expect(scValToDisplay(returnValue)).toBe('["1493531","1472284"]');
  });
});

describe("decodeInvocation (testnet fixtures)", () => {
  it("decodes the contract, function and args of a successful invoke", () => {
    expect(decodeInvocation(successfulInvoke.envelope)).toEqual({
      contractId: "CBXZBQ6NW3TGPGLTR4JCG2VPVWFLCCHKDW75NJIXYXV7CJLNUO64VTFC",
      functionName: "deposit_liquidity_and_collateral",
      args: [
        "1",
        "GB6YNCUDIPIFCXHXUTE3F54GFYGFMHUK6ZR5LLXD36TZTYC2DK2WYQ3U",
        "2",
        "1493531",
        '{"id":0,"seed1":null,"seed2":null,"tag":0}',
      ],
    });
  });

  it("still decodes the invocation of a failed transaction", () => {
    expect(failedInvoke.status).toBe("FAILED");
    const decoded = decodeInvocation(failedInvoke.envelope);
    expect(decoded?.contractId).toBe("CD4KFB23CQLJ47RIPESVBTQ444R75M6QVEZULWXHHFYYZT7SS2VGXOPW");
    expect(decoded?.functionName).toBe("write_prices");
    expect(decoded?.args).toEqual([
      "GBV54BUAQBFAS6WIRKGURXXCMXWALH4OYBCYE75VBHROJLEKJ4LOZTFB",
      '["BTC"]',
      expect.stringContaining("425443"),
    ]);
  });

  it("returns null for a multi-operation transaction with no host-function op", () => {
    expect(decodeInvocation(multiOperation.envelope)).toBeNull();
  });

  it("returns null for contract-creation host functions", () => {
    expect(decodeInvocation(createContract.envelope)).toBeNull();
    expect(decodeInvocation(createContractV2.envelope)).toBeNull();
  });
});

describe("extractInvocationReturnValue (testnet fixtures)", () => {
  it("decodes the return value of a successful invocation", () => {
    expect(extractInvocationReturnValue(successfulInvoke.meta)).toBe('["1493531","1472284"]');
  });

  it("returns null when the transaction failed", () => {
    expect(extractInvocationReturnValue(failedInvoke.meta)).toBeNull();
  });

  it("returns the new contract address for a creation", () => {
    expect(extractInvocationReturnValue(createContract.meta)).toBe(
      "CCJKICDXTNUHZBFYYLMGSDAW6FD23DS5UBWYMBC2ECYFSX3EGSSW6G5B"
    );
  });
});

describe("decodeContractCreation (testnet fixtures)", () => {
  it("decodes a createContract host function", () => {
    expect(decodeContractCreation(createContract.envelope, createContract.meta, "GCREATOR")).toEqual({
      contractId: "CCJKICDXTNUHZBFYYLMGSDAW6FD23DS5UBWYMBC2ECYFSX3EGSSW6G5B",
      creator: "GCREATOR",
    });
  });

  it("decodes a createContractV2 host function", () => {
    expect(decodeContractCreation(createContractV2.envelope, createContractV2.meta, "GCREATOR")).toEqual({
      contractId: "CBUZIAY2CBUCCRRRJBUANPTOQEF42YETHVG44N34NZ7XIUQ6L7DBV56D",
      creator: "GCREATOR",
    });
  });

  it("returns null for an ordinary invocation and for a failed transaction", () => {
    expect(decodeContractCreation(successfulInvoke.envelope, successfulInvoke.meta, "GCREATOR")).toBeNull();
    expect(decodeContractCreation(failedInvoke.envelope, failedInvoke.meta, "GCREATOR")).toBeNull();
  });
});

describe("extractStorageChanges (testnet fixtures)", () => {
  it("extracts every entry change of a successful invocation", () => {
    const changes = extractStorageChanges(successfulInvoke.meta);
    expect(changes).toHaveLength(16);
    expect(changes.map((change) => change.changeType)).toEqual([
      "state",
      "state",
      "state",
      "state",
      "updated",
      "updated",
      "updated",
      "updated",
      "state",
      "updated",
      "state",
      "updated",
      "state",
      "updated",
      "state",
      "updated",
    ]);
  });

  it("expands instance entries into one row per storage key plus the wasm hash", () => {
    const instanceChanges = extractStorageChanges(successfulInvoke.meta).filter(
      (change) => change.durability === "instance"
    );
    expect(instanceChanges).toHaveLength(8);
    expect(instanceChanges.every((change) => change.contractId === "CDH4BTGP7GRDFO6Y24AP4RP34NMC3V2RXTTUA4ABCFRMFEYWR6AG6GK6")).toBe(
      true
    );
    expect(instanceChanges[0]).toEqual({
      contractId: "CDH4BTGP7GRDFO6Y24AP4RP34NMC3V2RXTTUA4ABCFRMFEYWR6AG6GK6",
      durability: "instance",
      keyDisplay: "__wasm_hash__",
      valueDisplay: "a5f6b06ca8fb10a7f3d12ba5fae3361f04a242054757080cf14c375b88e1c898",
      changeType: "state",
    });
  });

  it("decodes persistent contract data keys and values", () => {
    const changes = extractStorageChanges(successfulInvoke.meta);
    expect(changes[9]).toMatchObject({
      contractId: "CBXZBQ6NW3TGPGLTR4JCG2VPVWFLCCHKDW75NJIXYXV7CJLNUO64VTFC",
      durability: "persistent",
      keyDisplay: '["Reserve",1,2]',
      valueDisplay: expect.stringContaining('"available":"9462586167919"'),
      changeType: "updated",
    });
    expect(changes[6]).toMatchObject({
      contractId: "CDH4BTGP7GRDFO6Y24AP4RP34NMC3V2RXTTUA4ABCFRMFEYWR6AG6GK6",
      durability: "instance",
      keyDisplay: '["Metadata"]',
      changeType: "updated",
    });
  });

  it("collapses a created contract's instance storage into its created rows", () => {
    expect(extractStorageChanges(createContract.meta)).toEqual([
      {
        contractId: "CCJKICDXTNUHZBFYYLMGSDAW6FD23DS5UBWYMBC2ECYFSX3EGSSW6G5B",
        durability: "instance",
        keyDisplay: "METADATA",
        valueDisplay:
          '{"decimal":7,"name":"KEUR:GDA44W6ZQ7TI65ZZ5E3TOHBEQXSKIBTNFFY5N4XVLQBA3AUQW2B3GLUU","symbol":"KEUR"}',
        changeType: "created",
      },
      {
        contractId: "CCJKICDXTNUHZBFYYLMGSDAW6FD23DS5UBWYMBC2ECYFSX3EGSSW6G5B",
        durability: "instance",
        keyDisplay: '["Admin"]',
        valueDisplay: "GDA44W6ZQ7TI65ZZ5E3TOHBEQXSKIBTNFFY5N4XVLQBA3AUQW2B3GLUU",
        changeType: "created",
      },
      {
        contractId: "CCJKICDXTNUHZBFYYLMGSDAW6FD23DS5UBWYMBC2ECYFSX3EGSSW6G5B",
        durability: "instance",
        keyDisplay: '["AssetInfo"]',
        valueDisplay:
          '["AlphaNum4",{"asset_code":"KEUR","issuer":"c1ce5bd987e68f7739e937371c2485e4a4066d2971d6f2f55c020d8290b683b3"}]',
        changeType: "created",
      },
    ]);
  });

  it("records only the wasm hash when a V2 creation has no instance storage", () => {
    expect(extractStorageChanges(createContractV2.meta)).toEqual([
      {
        contractId: "CBUZIAY2CBUCCRRRJBUANPTOQEF42YETHVG44N34NZ7XIUQ6L7DBV56D",
        durability: "instance",
        keyDisplay: "__wasm_hash__",
        valueDisplay: "c1a650506f7c20c8f4d16aae73f894f302cd011d7ef33adef572f20b34f7653e",
        changeType: "created",
      },
    ]);
  });

  it("yields no contract-data changes for a failed transaction", () => {
    expect(extractStorageChanges(failedInvoke.meta)).toEqual([]);
  });

  it("ignores non-contract-data ledger changes across multiple operations", () => {
    // The three operations only touch account/sponsorship ledger entries.
    expect(extractStorageChanges(multiOperation.meta)).toEqual([]);
  });
});

describe("extractEvents (testnet fixtures)", () => {
  it("extracts contract events with topics and values from a successful invocation", () => {
    const events = extractEvents(successfulInvoke.meta, successfulInvoke.hash);
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.eventId)).toEqual([
      `${successfulInvoke.hash}-0-0`,
      `${successfulInvoke.hash}-0-1`,
      `${successfulInvoke.hash}-0-2`,
      `${successfulInvoke.hash}-0-3`,
    ]);
    expect(events[0]).toEqual({
      eventId: `${successfulInvoke.hash}-0-0`,
      contractId: "CBVJ6GYJJ55ALTHN32OJEFGUZWWTMDFGIBCM42SPYQ4GWLKX2XARAP2N",
      type: "contract",
      topic: [
        "transfer",
        "GB6YNCUDIPIFCXHXUTE3F54GFYGFMHUK6ZR5LLXD36TZTYC2DK2WYQ3U",
        "CBXZBQ6NW3TGPGLTR4JCG2VPVWFLCCHKDW75NJIXYXV7CJLNUO64VTFC",
        "SOL:GAGVZMODPYFTULIVSY3RGFADIC5LF4LLSN37N4MFWGNZ57TYBXL2LQQX",
      ],
      value: "1493531",
    });
    expect(events[1]?.topic[0]).toBe("mint");
    expect(events[2]?.value).toBe('["1493531","1472284"]');
  });

  it("extracts no events from a failed transaction", () => {
    expect(extractEvents(failedInvoke.meta, failedInvoke.hash)).toEqual([]);
  });

  it("extracts no events from a multi-operation transaction without Soroban events", () => {
    expect(extractEvents(multiOperation.meta, multiOperation.hash)).toEqual([]);
  });
});
