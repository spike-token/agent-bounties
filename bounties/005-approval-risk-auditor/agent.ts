import { z } from "zod";
import { createAgentApp } from "@lucid-dreams/agent-kit";
import { ethers } from "ethers";

const { app, addEntrypoint } = createAgentApp({
  name: "approval-risk-auditor",
  version: "0.1.0",
  description: "Flag unlimited or stale ERC-20 / NFT approvals",
});

const MAX_UINT = 2n ** 256n - 1n;
/** ~1e9 tokens at 18 decimals; treats "practically unlimited" as unlimited. */
const UNLIMITED_THRESHOLD = 10n ** 27n;
const STALE_MS = 180 * 24 * 60 * 60 * 1000;

const Address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

const KnownPair = z.object({
  chainId: z.number().int().positive(),
  token: Address,
  spender: Address,
  kind: z.enum(["erc20", "erc721-operator"]).default("erc20"),
  lastSeenMs: z.number().int().nonnegative(),
});

const AuditInput = z.object({
  wallet: Address,
  chains: z.array(z.number().int().positive()).min(1).max(10),
  /** Explorer-discovered (token, spender) pairs. Live-checked when RPC_* is set. */
  known_pairs: z.array(KnownPair).max(200).optional(),
});

const ERC20_MIN_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function symbol() view returns (string)",
];

const ERC721_MIN_ABI = [
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
];

export type RiskFlag =
  | "unlimited"
  | "stale"
  | "active-allowance"
  | "nft-operator"
  | "zero-balance-with-allowance";

export type ApprovalRecord = {
  chainId: number;
  token: string;
  spender: string;
  kind: "erc20" | "erc721-operator";
  allowance: string;
  lastSeenMs: number;
  risk_flags: RiskFlag[];
  symbol?: string;
};

export type RevokeTx = {
  chainId: number;
  to: string;
  value: "0";
  data: string;
};

export function classifyRisk(
  allowance: bigint,
  lastSeenMs: number,
  nowMs: number,
  opts?: { kind?: "erc20" | "erc721-operator"; balance?: bigint }
): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const kind = opts?.kind ?? "erc20";
  if (allowance <= 0n) return flags;

  if (kind === "erc721-operator") {
    flags.push("nft-operator");
  } else {
    if (allowance === MAX_UINT || allowance >= UNLIMITED_THRESHOLD) {
      flags.push("unlimited");
    }
    flags.push("active-allowance");
    if (opts?.balance === 0n) flags.push("zero-balance-with-allowance");
  }

  if (nowMs - lastSeenMs > STALE_MS) flags.push("stale");
  return flags;
}

export function buildRevokeERC20(token: string, spender: string) {
  const iface = new ethers.Interface([
    "function approve(address spender, uint256 amount)",
  ]);
  return {
    to: ethers.getAddress(token),
    value: "0" as const,
    data: iface.encodeFunctionData("approve", [ethers.getAddress(spender), 0]),
  };
}

export function buildRevokeOperator(token: string, operator: string) {
  const iface = new ethers.Interface([
    "function setApprovalForAll(address operator, bool approved)",
  ]);
  return {
    to: ethers.getAddress(token),
    value: "0" as const,
    data: iface.encodeFunctionData("setApprovalForAll", [
      ethers.getAddress(operator),
      false,
    ]),
  };
}

export function auditFromState(args: {
  chainId: number;
  token: string;
  spender: string;
  kind: "erc20" | "erc721-operator";
  allowance: bigint;
  lastSeenMs: number;
  nowMs: number;
  balance?: bigint;
  symbol?: string;
}): { approval: ApprovalRecord; revoke: RevokeTx } | null {
  const risk_flags = classifyRisk(args.allowance, args.lastSeenMs, args.nowMs, {
    kind: args.kind,
    balance: args.balance,
  });
  if (risk_flags.length === 0) return null;

  const built =
    args.kind === "erc721-operator"
      ? buildRevokeOperator(args.token, args.spender)
      : buildRevokeERC20(args.token, args.spender);

  return {
    approval: {
      chainId: args.chainId,
      token: ethers.getAddress(args.token),
      spender: ethers.getAddress(args.spender),
      kind: args.kind,
      allowance: args.allowance.toString(),
      lastSeenMs: args.lastSeenMs,
      risk_flags,
      symbol: args.symbol,
    },
    revoke: { chainId: args.chainId, ...built },
  };
}

async function recheckChain(
  wallet: string,
  chainId: number,
  pairs: z.infer<typeof KnownPair>[],
  nowMs: number
) {
  const rpcUrl = process.env[`RPC_${chainId}`];
  const mine = pairs.filter((p) => p.chainId === chainId);
  const approvals: ApprovalRecord[] = [];
  const revoke_tx_data: RevokeTx[] = [];

  if (!rpcUrl) {
    return {
      chainId,
      approvals,
      revoke_tx_data,
      note: mine.length
        ? "RPC unset; skipped live re-check of known_pairs"
        : "no RPC; discover pairs via explorer Token Approval API, then re-check",
    };
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);

  for (const pair of mine) {
    try {
      if (pair.kind === "erc721-operator") {
        const nft = new ethers.Contract(pair.token, ERC721_MIN_ABI, provider);
        const approved = (await nft.isApprovedForAll(
          wallet,
          pair.spender
        )) as boolean;
        const row = auditFromState({
          chainId,
          token: pair.token,
          spender: pair.spender,
          kind: "erc721-operator",
          allowance: approved ? 1n : 0n,
          lastSeenMs: pair.lastSeenMs,
          nowMs,
        });
        if (row) {
          approvals.push(row.approval);
          revoke_tx_data.push(row.revoke);
        }
      } else {
        const erc20 = new ethers.Contract(pair.token, ERC20_MIN_ABI, provider);
        const [allowance, balance, symbol] = await Promise.all([
          erc20.allowance(wallet, pair.spender) as Promise<bigint>,
          erc20.balanceOf(wallet).catch(() => 0n) as Promise<bigint>,
          erc20.symbol().catch(() => undefined) as Promise<string | undefined>,
        ]);
        const row = auditFromState({
          chainId,
          token: pair.token,
          spender: pair.spender,
          kind: "erc20",
          allowance,
          lastSeenMs: pair.lastSeenMs,
          nowMs,
          balance,
          symbol,
        });
        if (row) {
          approvals.push(row.approval);
          revoke_tx_data.push(row.revoke);
        }
      }
    } catch {
      // Skip tokens that revert on standard allowance / operator calls.
    }
  }

  return { chainId, approvals, revoke_tx_data };
}

addEntrypoint({
  key: "audit-approvals",
  description:
    "Audit wallet ERC-20/NFT approvals, flag unlimited/stale, return unsigned revoke txs",
  input: AuditInput,
  async handler({ input }) {
    const nowMs = Date.now();
    const pairs = input.known_pairs ?? [];
    const chains = await Promise.all(
      input.chains.map((chainId) =>
        recheckChain(input.wallet, chainId, pairs, nowMs)
      )
    );

    const approvals = chains.flatMap((c) => c.approvals);
    const revoke_tx_data = chains.flatMap((c) => c.revoke_tx_data);

    return {
      output: {
        wallet: ethers.getAddress(input.wallet),
        chains,
        approvals,
        revoke_tx_data,
      },
      usage: { total_tokens: String(approvals.length) },
    };
  },
});

export default app;
