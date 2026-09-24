# Approval Risk Auditor

Read-only auditor for ERC-20 and NFT operator approvals. Returns `approvals[]`,
`risk_flags`, and unsigned `revoke_tx_data[]`. Never accepts or stores keys.

## Entrypoint

`audit-approvals`

```json
{
  "wallet": "0x...",
  "chains": [1, 137],
  "known_pairs": [
    {
      "chainId": 1,
      "token": "0x...",
      "spender": "0x...",
      "kind": "erc20",
      "lastSeenMs": 1700000000000
    }
  ]
}
```

`known_pairs` is optional. When present and `RPC_<chainId>` is set, each pair is
re-checked on-chain (`allowance` / `isApprovedForAll`) before it is returned.
Zeroed allowances are dropped.

## Discovery (match Etherscan Token Approvals)

1. Per chain, query the explorer Token Approval API for `Approval(owner=wallet)`
   and `ApprovalForAll(owner=wallet)`.
2. Dedupe by `token + spender` (ERC-20) or `token + operator` (NFT). Keep the
   latest block / timestamp as `lastSeenMs`.
3. Re-check live state. Drop entries where allowance is 0 or the operator is
   no longer approved.
4. Enrich with `symbol` and, when cheap, a spender label.

RPC log scans are a fallback only; explorer APIs stay closer to the public UI.

## Risk flags

| Flag | Rule |
| --- | --- |
| `unlimited` | ERC-20 `allowance == type(uint256).max` or `>= 10^27` |
| `stale` | Nonzero approval and `now - lastSeen > 180d` |
| `active-allowance` | Nonzero ERC-20 allowance |
| `nft-operator` | `isApprovedForAll == true` |
| `zero-balance-with-allowance` | ERC-20 allowance > 0 and `balanceOf(wallet) == 0` |

## Revoke txs (unsigned; client signs)

- ERC-20: `approve(spender, 0)` to `token`, `value = 0`.
- NFT operator: `setApprovalForAll(operator, false)` to `token`, `value = 0`.

Simulate calldata on a fork before broadcasting. Do not send keys to this
service.

## RPC

Optional env `RPC_<chainId>` (e.g. `RPC_1`) for live re-checks. No default
endpoints are hardcoded.

## x402

Expose `POST /entrypoints/audit-approvals` behind an x402 paywall per agent-kit
docs. Requires a domain and TLS.

## Test

`vitest run` in this directory. Also compare a fixture wallet's top tokens
against the Etherscan Token Approvals UI: unlimited/stale rows must be flagged,
and revoke `data` must decode to `approve(spender, 0)` or
`setApprovalForAll(operator, false)`.
