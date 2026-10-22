# Testnet transaction fixtures

Envelopes and transaction metas captured from Stellar testnet on 2026-10-22 via
Soroban RPC `getTransaction` (`https://soroban-testnet.stellar.org`). Each file
holds the base64 `envelopeXdr` and `resultMetaXdr` exactly as the RPC returned
them, plus the transaction hash, ledger and final status for reference:

`https://horizon-testnet.stellar.org/transactions/<hash>`

| File                     | What it covers                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ |
| `successful-invoke.json` | Successful `invokeHostFunction` (SAC deposit into a lending pool): return value, 16 storage changes including expanded instance entries, and 4 contract events. |
| `failed-invoke.json`     | Failed `invokeHostFunction` (oracle `write_prices` rejected): invocation is still decodable, but there is no return value, no storage change and no event. |
| `create-contract.json`   | Successful `createContract` host function whose instance has storage entries.  |
| `create-contract-v2.json`| Successful `createContractV2` host function whose instance only has a wasm hash. |
| `multi-operation.json`   | Successful three-operation (sponsorship) transaction: exercises decoders over multiple operations, none of which is a host function. |

These files are decoded by `src/decode.test.ts`; refresh them only if the
decoders' expected output intentionally changes.
