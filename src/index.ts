#!/usr/bin/env node
/**
 * VeBetterDAO Relayer Node - VERSIONE SEPARATA VOTO / CLAIM
 * Supporta VOTE_ONLY e CLAIM_ONLY per massimizzare competitività
 */

import * as fs from "fs"
import { ThorClient } from "@vechain/sdk-network"
import { Address, HDKey } from "@vechain/sdk-core"
import chalk from "chalk"
import { getNetworkConfig, getNodePool } from "./config"
import { fetchSummary, preFetchAutoVotingUsers } from "./contracts"
import { runCastVoteCycle, runClaimRewardCycle } from "./relayer"
import { renderSummary, renderCycleResult, logSectionHeader, timestamp } from "./display"

const SECRETS_DIR = "/run/secrets"
const ALLOWED_SECRETS = new Set(["mnemonic", "relayer_private_key"])

function readSecret(name: string): string | undefined {
  if (!ALLOWED_SECRETS.has(name)) return undefined
  try {
    return fs.readFileSync(`${SECRETS_DIR}/${name}`, "utf-8").trim()
  } catch {
    return undefined
  }
}

function envOrSecret(envKey: string, secretName: string): string | undefined {
  return process.env[envKey]?.trim() || readSecret(secretName)
}

function getWallet(): { walletAddress: string; privateKey: string } {
  const pk = envOrSecret("RELAYER_PRIVATE_KEY", "relayer_private_key")
  if (pk) {
    const clean = pk.startsWith("0x") ? pk.slice(2) : pk
    return {
      walletAddress: Address.ofPrivateKey(Buffer.from(clean, "hex")).toString(),
      privateKey: clean,
    }
  }
  const mnemonic = envOrSecret("MNEMONIC", "mnemonic")
  const words = mnemonic?.split(/\s+/)
  if (!words?.length) {
    console.error(chalk.red("Set MNEMONIC or RELAYER_PRIVATE_KEY"))
    process.exit(1)
  }
  const child = HDKey.fromMnemonic(words).deriveChild(0)
  const raw = child.privateKey!
  return {
    walletAddress: Address.ofPublicKey(child.publicKey as Uint8Array).toString(),
    privateKey: Buffer.from(raw).toString("hex"),
  }
}

function envBool(key: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[key] || "")
}

const activityLog: string[] = []
const MAX_LOG = 200

function log(msg: string) {
  const entry = `${timestamp()} ${msg}`
  activityLog.push(entry)
  if (activityLog.length > MAX_LOG) activityLog.shift()
  console.log(entry)
}

function logRaw(msg: string) {
  activityLog.push(msg)
  if (activityLog.length > MAX_LOG) activityLog.shift()
  console.log(msg)
}

async function main() {
  const network = process.env.RELAYER_NETWORK || "mainnet"
  const nodeUrlOverride = process.env.NODE_URL?.trim()
  const config = getNetworkConfig(network, nodeUrlOverride)
  const { walletAddress, privateKey } = getWallet()

  const batchSize = Math.max(1, parseInt(process.env.BATCH_SIZE || "150", 10))
  const dryRun = envBool("DRY_RUN")
  const runOnce = envBool("RUN_ONCE")

  // ── MODALITÀ SEPARATE ─────────────────────────────
  const voteOnly = envBool("VOTE_ONLY")
  const claimOnly = envBool("CLAIM_ONLY")
  if (voteOnly && claimOnly) {
    console.error(chalk.red("ERRORE: non puoi attivare sia VOTE_ONLY che CLAIM_ONLY"))
    process.exit(1)
  }
  const mode = voteOnly ? "SOLO VOTO" : claimOnly ? "SOLO CLAIM" : "VOTO + CLAIM"
  console.log(chalk.green.bold(`\n🚀 Relayer avviato in modalità: ${mode}`))

  // ── POLLING INTERVAL DA ENV (rispetta Railway) ─────────────────────────────
  let pollMs = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10)
  if (isNaN(pollMs) || pollMs < 1000) pollMs = 15000

  let fastModeUntil = 0
  let currentRoundVoted = false

  const nodePool = nodeUrlOverride ? [nodeUrlOverride] : getNodePool(network)
  let nodeIndex = 0
  let thor = ThorClient.at(config.nodeUrl, { isPollingEnabled: false })

  function rotateNode() {
    if (nodePool.length <= 1) return
    nodeIndex = (nodeIndex + 1) % nodePool.length
    config.nodeUrl = nodePool[nodeIndex]
    thor = ThorClient.at(config.nodeUrl, { isPollingEnabled: false })
    log(chalk.yellow(`Rotating to node: ${new URL(config.nodeUrl).hostname}`))
  }

  let running = true

  // Pre-fetch cache (sempre attivo)
  const PRE_FETCH_INTERVAL = 10000
  const preFetchInterval = setInterval(async () => {
    if (!running) return
    try {
      await preFetchAutoVotingUsers(thor, config.xAllocationVotingAddress, log)
    } catch {}
  }, PRE_FETCH_INTERVAL)

  // FIX iniziale
  let initialSummary = null
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      initialSummary = await fetchSummary(thor, config, walletAddress)
      break
    } catch {
      if (attempt < 5) {
        rotateNode()
        await new Promise(r => setTimeout(r, 1200))
      }
    }
  }
  if (initialSummary) {
    process.stdout.write("\x1B[2J\x1B[H")
    console.log(renderSummary(initialSummary))
  }

  while (running) {
    let lastErr: unknown
    for (let attempt = 1; attempt <= nodePool.length; attempt++) {
      try {
        const summary = await fetchSummary(thor, config, walletAddress)
        const isNewRound = summary.isRoundActive && !currentRoundVoted

        // ── VOTO ─────────────────────────────
        if (!claimOnly) {
          if (isNewRound) {
            logRaw(logSectionHeader("vote", summary.currentRoundId))
            console.log(chalk.green.bold("🔥 NEW ROUND DETECTED → VOTING PRIORITY MODE"))
            const voteResult = await runCastVoteCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, log)
            renderCycleResult(voteResult).forEach(log)
            currentRoundVoted = true

            if (fastModeUntil === 0) {
              fastModeUntil = Date.now() + 15 * 60 * 1000
              pollMs = 2000
              log(chalk.green.bold("🚀 FAST MODE (2s polling for 15 min)"))
            }
          } else if (summary.isRoundActive) {
            logRaw(logSectionHeader("vote", summary.currentRoundId))
            const voteResult = await runCastVoteCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, log)
            renderCycleResult(voteResult).forEach(log)
          }
        }

        // ── CLAIM ─────────────────────────────
        if (!voteOnly) {
          if (!isNewRound && summary.previousRoundId > 0) {
            logRaw(logSectionHeader("claim", summary.previousRoundId))
            const claimResult = await runClaimRewardCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, log)
            renderCycleResult(claimResult).forEach(log)
          }
        }

        const updated = await fetchSummary(thor, config, walletAddress)
        process.stdout.write("\x1B[2J\x1B[H")
        console.log(renderSummary(updated))
        console.log(chalk.bold("─── Activity Log ") + "─".repeat(49))
        activityLog.slice(-30).forEach(l => console.log(l))

        lastErr = undefined
        break
      } catch (err) {
        lastErr = err
        if (attempt < nodePool.length) {
          rotateNode()
          await new Promise(r => setTimeout(r, 2000))
        }
      }
    }

    if (lastErr) log(chalk.red(`Cycle error: ${lastErr}`))
    if (runOnce) break

    log(chalk.dim(`Next cycle in ${Math.round(pollMs/1000)}s...`))
    await new Promise(r => setTimeout(r, pollMs))

    if (!running) break
  }

  clearInterval(preFetchInterval)
}

main().catch(err => {
  console.error(chalk.red("Fatal error:"), err)
  process.exit(1)
})

//Clean: rimosso DEBUG + pollMs pronto per 1500ms
