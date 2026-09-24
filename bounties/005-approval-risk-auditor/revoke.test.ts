import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import {
  auditFromState,
  buildRevokeERC20,
  buildRevokeOperator,
  classifyRisk,
} from "./agent.js";

const MAX = 2n ** 256n - 1n;
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = "0x0000000000000000000000000000000000000001";
const SPENDER = "0x0000000000000000000000000000000000000002";

describe("classifyRisk", () => {
  it("flags unlimited max approval", () => {
    const now = Date.now();
    expect(classifyRisk(MAX, now, now)).toContain("unlimited");
    expect(classifyRisk(MAX, now, now)).toContain("active-allowance");
  });

  it("flags practically unlimited allowances", () => {
    expect(classifyRisk(10n ** 27n, Date.now(), Date.now())).toContain(
      "unlimited"
    );
  });

  it("does not flag a typical finite allowance as unlimited", () => {
    expect(classifyRisk(10n ** 18n, Date.now(), Date.now())).not.toContain(
      "unlimited"
    );
  });

  it("flags stale approval", () => {
    const old = Date.now() - 200 * DAY;
    expect(classifyRisk(1000n, old, Date.now())).toContain("stale");
  });

  it("does not flag zero allowance as stale or active", () => {
    const old = Date.now() - 400 * DAY;
    expect(classifyRisk(0n, old, Date.now())).toEqual([]);
  });

  it("flags nft operators and zero-balance allowances", () => {
    const now = Date.now();
    expect(
      classifyRisk(1n, now, now, { kind: "erc721-operator" })
    ).toContain("nft-operator");
    expect(
      classifyRisk(1000n, now, now, { kind: "erc20", balance: 0n })
    ).toContain("zero-balance-with-allowance");
  });
});

describe("revoke calldata", () => {
  it("builds valid ERC-20 revoke calldata", () => {
    const tx = buildRevokeERC20(TOKEN, SPENDER);
    const iface = new ethers.Interface([
      "function approve(address spender, uint256 amount)",
    ]);
    const decoded = iface.decodeFunctionData("approve", tx.data);
    expect(tx.value).toBe("0");
    expect(decoded[0]).toBe(ethers.getAddress(SPENDER));
    expect(decoded[1].toString()).toBe("0");
  });

  it("builds valid NFT operator revoke calldata", () => {
    const tx = buildRevokeOperator(TOKEN, SPENDER);
    const iface = new ethers.Interface([
      "function setApprovalForAll(address operator, bool approved)",
    ]);
    const decoded = iface.decodeFunctionData("setApprovalForAll", tx.data);
    expect(tx.value).toBe("0");
    expect(decoded[0]).toBe(ethers.getAddress(SPENDER));
    expect(decoded[1]).toBe(false);
  });
});

describe("auditFromState", () => {
  it("drops revoked allowances", () => {
    expect(
      auditFromState({
        chainId: 1,
        token: TOKEN,
        spender: SPENDER,
        kind: "erc20",
        allowance: 0n,
        lastSeenMs: Date.now(),
        nowMs: Date.now(),
      })
    ).toBeNull();
  });

  it("attaches a matching unsigned revoke tx", () => {
    const row = auditFromState({
      chainId: 1,
      token: TOKEN,
      spender: SPENDER,
      kind: "erc20",
      allowance: MAX,
      lastSeenMs: Date.now(),
      nowMs: Date.now(),
    });
    expect(row).not.toBeNull();
    expect(row!.approval.risk_flags).toContain("unlimited");
    expect(row!.revoke.chainId).toBe(1);
    expect(row!.revoke.to).toBe(ethers.getAddress(TOKEN));
    expect(row!.revoke.data).toBe(buildRevokeERC20(TOKEN, SPENDER).data);
  });
});
