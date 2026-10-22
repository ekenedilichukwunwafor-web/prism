export interface LedgerRecord {
  sequence: number;
  hash: string;
  closedAt: string;
  transactionCount: number;
  operationCount: number;
  baseFee: number;
  successfulTransactionCount: number;
  failedTransactionCount: number;
}

export interface TransactionRecord {
  hash: string;
  ledger: number;
  createdAt: string;
  sourceAccount: string;
  fee: number;
  operationCount: number;
  successful: boolean;
  memo?: string;
  envelopeXdr: string;
  resultXdr: string;
}

export interface AccountBalance {
  assetType: string;
  assetCode?: string;
  assetIssuer?: string;
  /** Set only for liquidity pool shares, which have no asset code. */
  liquidityPoolId?: string;
  balance: string;
}

export interface AccountRecord {
  id: string;
  sequence: string;
  subentryCount: number;
  lastModifiedLedger: number;
  thresholds: { low: number; med: number; high: number };
  flags: {
    authRequired: boolean;
    authRevocable: boolean;
    authImmutable: boolean;
    authClawbackEnabled: boolean;
  };
  balances: AccountBalance[];
  signerCount: number;
}

export interface ContractEvent {
  id: string;
  contractId: string;
  type: string;
  topic: string[];
  value: string;
  txHash: string;
  ledger: number;
  timestamp: string;
}

export interface StorageEntry {
  key: string;
  value: string;
  durability: "persistent" | "temporary" | "instance";
}

export interface ContractInfo {
  executable: "wasm" | "stellar_asset";
  wasmHash?: string;
  liveUntilLedgerSeq?: number;
  lastModifiedLedgerSeq?: number;
  instanceStorage: StorageEntry[];
  assetDetails?: {
    name?: string;
    symbol?: string;
    decimals?: number;
  };
  creator?: string;
  deploymentLedger?: number;
}

export interface ContractFunctionSpec {
  name: string;
  inputs: { name: string; type: string }[];
  outputs: string[];
}

export interface ContractEventSpec {
  name: string;
  prefixTopics: string[];
  params: { name: string; type: string; location: "topic" | "data" }[];
  dataFormat: "map" | "vec" | "single-value";
  doc?: string;
}

export type ContractTypeDef =
  | { kind: "struct"; name: string; doc?: string; fields: { name: string; type: string }[] }
  | { kind: "union"; name: string; doc?: string; cases: { name: string; types: string[] }[] }
  | { kind: "enum"; name: string; doc?: string; cases: { name: string; value: number }[] }
  | { kind: "error"; name: string; doc?: string; cases: { name: string; value: number }[] };

export interface ContractWasmInfo {
  size: number;
  functions: ContractFunctionSpec[];
  events: ContractEventSpec[];
  types: ContractTypeDef[];
}

export interface SorobanInvocation {
  contractId: string;
  functionName: string;
  args: string[];
}

/** A contract call taken from one operation of a transaction. */
export interface OperationInvocation extends SorobanInvocation {
  operationIndex: number;
}

export interface ResourceUsage {
  instructions: number;
  readBytes: number;
  writeBytes: number;
  resourceFeeStroops: string;
}

export interface InvocationHistoryItem {
  txHash: string;
  ledger: number;
  timestamp: string;
  functionName?: string;
  args?: string[];
  successful: boolean;
}

export type Network = "testnet" | "mainnet";
