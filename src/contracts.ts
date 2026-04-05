import { ThorClient } from "@vechain/sdk-network"
import { ABIContract, Hex } from "@vechain/sdk-core"
import { LogFn } from "./types"
import {
  XAllocationVoting__factory,
  VoterRewards__factory,
  RelayerRewardsPool__factory,
} from "@vechain/vebetterdao-contracts/typechain-types"
import { NetworkConfig, RelayerSummary } from "./types"

const xavAbi = ABIContract.ofAbi(XAllocationVoting__factory.abi)
const rrpAbi = ABIContract.ofAbi(RelayerRewardsPool__factory.abi)
const vrAbi = ABIContract.ofAbi(VoterRewards__factory.abi)

const CALL_RETRIES = 3
const CALL_RETRY_MS = 500
const MAX_EVENTS = 5000   // OTTIMIZZAZIONE: aumentato per fetch più veloci

// ── Helper per chiamate ─────────────────────────────────────
async function call(thor: ThorClient, address: string, abi: any, method: string, args: any[] = []): Promise<any[]> {
  for (let attempt = 1; attempt <= CALL_RETRIES; attempt++) {
    try {
      const res = await thor.contracts.executeCall(address, abi.getFunction(method), args)
      if (!res.success) {
        throw new Error(`Call ${method} reverted: ${res.result?.errorMessage || "unknown"}`)
      }
      return res.result?.array ?? []
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isRevert = msg.includes("reverted")
      if (isRevert || attempt === CALL_RETRIES) throw err
      await new Promise((r) => setTimeout(r, CALL_RETRY_MS * attempt))
    }
  }
  throw new Error("Unreachable")
}

// ── XAllocationVoting reads ─────────────────────────────────
export async function getCurrentRoundId(thor: ThorClient, addr: string): Promise<number> {
  const r = await call(thor, addr, xavAbi, "currentRoundId")
  return Number(r[0])
}

export async function getRoundSnapshot(thor: ThorClient, addr: string, roundId: number): Promise<number> {
  const r = await call(thor, addr, xavAbi, "roundSnapshot", [roundId])
  return Number(r[0])
}

export async function getRoundDeadline(thor: ThorClient, addr: string, roundId: number): Promise<number> {
  const r = await call(thor, addr, xavAbi, "roundDeadline", [roundId])
  return Number(r[0])
}

export async function hasVoted(thor: ThorClient, addr: string, roundId: number, user: string): Promise<boolean> {
  const r = await call(thor, addr, xavAbi, "hasVoted", [roundId, user])
  return Boolean(r[0])
}

// ── RelayerRewardsPool reads ────────────────────────────────
export async function getEarlyAccessBlocks(thor: ThorClient, addr: string): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "getEarlyAccessBlocks")
  return BigInt(r[0])
}

export async function getPreferredRelayersForUsers(
  thor: ThorClient,
  poolAddress: string,
  users: string[],
  log?: LogFn,
): Promise<Map<string, string>> {
  // ... (questa funzione rimane invariata - è già ottimizzata)
  const result = new Map<string, string>()
  if (users.length === 0) return result
  const fn = rrpAbi.getFunction("getPreferredRelayer")
  const BATCH = 150
  for (let i = 0; i < users.length; i += BATCH) {
    const chunk = users.slice(i, i + BATCH)
    const clauses = chunk.map((user) => ({
      to: poolAddress,
      value: "0x0",
      data: fn.encodeData([user]).toString(),
    }))
    const results = await thor.transactions.simulateTransaction(clauses)
    for (let j = 0; j < results.length; j++) {
      const sim = results[j]
      if (!sim || sim.reverted || !sim.data || sim.data === "0x") continue
      try {
        const decoded = fn.decodeOutputAsArray(Hex.of(sim.data))
        const addr = (decoded[0] as string).toLowerCase()
        if (addr !== "0x0000000000000000000000000000000000000000") {
          result.set(chunk[j].toLowerCase(), addr)
        }
      } catch {}
    }
  }
  return result
}

// ── CACHE PREVENTIVA DEGLI AUTO-VOTING USERS ─────────────────────
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const autoVotingCache = {
  userState: new Map<string, boolean>(),
  lastBlock: -1,
  loaded: false,
}

function getCachePath(): string {
  const p = require("path") as typeof import("path")
  return p.join(process.cwd(), ".auto-voting-cache.json")
}

function loadCacheFromDisk(): void {
  if (autoVotingCache.loaded) return
  autoVotingCache.loaded = true
  try {
    const fs = require("fs") as typeof import("fs")
    const raw = fs.readFileSync(getCachePath(), "utf-8")
    const data = JSON.parse(raw)
    if (typeof data.lastBlock === "number" && data.users) {
      for (const [addr, enabled] of Object.entries(data.users)) {
        autoVotingCache.userState.set(addr, enabled as boolean)
      }
      autoVotingCache.lastBlock = data.lastBlock
    }
  } catch {}
}

function saveCacheToDisk(): void {
  const data = {
    lastBlock: autoVotingCache.lastBlock,
    users: Object.fromEntries(autoVotingCache.userState),
  }
  try {
    const fs = require("fs") as typeof import("fs")
    fs.writeFileSync(getCachePath(), JSON.stringify(data), "utf-8")
  } catch {}
}

export async function getAutoVotingUsers(
  thor: ThorClient,
  contractAddress: string,
  toBlock: number,
): Promise<string[]> {
  loadCacheFromDisk()

  const event = xavAbi.getEvent("AutoVotingToggled") as any
  const topics = event.encodeFilterTopicsNoNull({})

  if (toBlock < autoVotingCache.lastBlock) {
    autoVotingCache.userState.clear()
    autoVotingCache.lastBlock = -1
  }

  const fromBlock = autoVotingCache.lastBlock >= 0 ? autoVotingCache.lastBlock + 1 : 0

  if (fromBlock <= toBlock) {
    let offset = 0
    while (true) {
      const logs = await thor.logs.filterEventLogs({
        range: { unit: "block" as const, from: fromBlock, to: toBlock },
        options: { offset, limit: MAX_EVENTS },
        order: "asc",
        criteriaSet: [{ criteria: { address: contractAddress, topic0: topics[0] }, eventAbi: event }],
      })

      for (const log of logs) {
        const decoded = event.decodeEventLog({
          topics: log.topics.map((t: string) => Hex.of(t)),
          data: Hex.of(log.data),
        })
        autoVotingCache.userState.set(decoded.args.account as string, decoded.args.enabled as boolean)
      }

      if (logs.length < MAX_EVENTS) break
      offset += MAX_EVENTS
    }

    autoVotingCache.lastBlock = toBlock
    saveCacheToDisk()
  }

  const activeUsers = [...autoVotingCache.userState.entries()]
    .filter(([, enabled]) => enabled)
    .map(([addr]) => addr)

  return activeUsers
}

// ── Altre funzioni (invariate) ─────────────────────────────────────
export async function getAlreadySkippedVotersForRound(...) { ... }   // lascia invariata
export async function getAlreadyClaimedForRound(...) { ... }       // lascia invariata
export async function getPreferredRelayerUserCount(...) { ... }     // lascia invariata
export async function fetchSummary(...) { ... }                     // lascia invariata
