#!/usr/bin/env node
/**
 * VeBetterDAO Relayer Node - VERSIONE STABILE ULTRA-AGGRESSIVA
 * VOTO: 1000ms + batch 100 | CLAIM: 3000ms + batch 250
 */

import * as fs from "fs"
import { ThorClient } from "@vechain/sdk-network"
import { Address } from "@vechain/sdk-core"
import chalk from "chalk"
import { getNetworkConfig, MAINNET_NODES } from "./config"
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

function envBool(key: string, defaultValue = false): boolean {
  const val = process.env[key]?.trim().toLowerCase()
  return val === "1" || val === "true" || (defaultValue && val !== "0" && val !== "false")
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
  console.error(chalk.red("❌ RELAYER_PRIVATE_KEY non impostata"))
  process.exit(1)
}

// ── CONFIG ─────────────────────────────────────
const voteOnly = envBool("VOTE_ONLY", true)
const claimOnly = envBool("CLAIM_ONLY", false)
const batchSize = Math.max(1, parseInt(process.env.BATCH_SIZE || "100", 10))
const dryRun = envBool("DRY_RUN")
const runOnce = envBool("RUN_ONCE")

let pollMs = parseInt(process.env.POLL_INTERVAL_MS || "1000", 10)
if (isNaN(pollMs) || pollMs < 1000) pollMs = 1000

console.log(chalk.green.bold("🚀 VeBetterDAO Relayer Node v1.1.0 - ULTRA AGGRESSIVE"))
console.log(chalk.yellow(`[CONFIG] Modalità: ${voteOnly ? "SOLO VOTO" : claimOnly ? "SOLO CLAIM" : "VOTO+CLAIM"}`))
console.log(chalk.yellow(`[CONFIG] POLL_INTERVAL_MS = ${pollMs} ms`))
console.log(chalk.yellow(`[CONFIG] BATCH_SIZE = ${batchSize}`))

const config = getNetworkConfig(process.env.RELAYER_NETWORK || "mainnet")
const nodes = MAINNET_NODES // array di URL
let currentNodeIndex = 0
let thor = ThorClient.at(nodes[0])

const { walletAddress, privateKey } = getWallet()

let fastModeUntil = 0
let currentRoundVoted = false
let running = true
const activityLog: string[] = []
const MAX_LOG = 200

function log(msg: string) {
  const ts = timestamp()
  const entry = ts + " " + msg
  console.log(entry)
  activityLog.push(entry)
  if (activityLog.length > MAX_LOG) activityLog.shift()
}

function logRaw(msg: string) {
  console.log(msg)
  activityLog.push(msg)
  if (activityLog.length > MAX_LOG) activityLog.shift()
}

function rotateNode() {
  currentNodeIndex = (currentNodeIndex + 1) % nodes.length
  thor = ThorClient.at(nodes[currentNodeIndex])
  log(chalk.yellow(`🔄 Rotating to node: ${nodes[currentNodeIndex]}`))
}

async function main() {
  log(chalk.green.bold("🚀 Starting VeBetterDAO Relayer..."))

  const preFetchInterval = setInterval(() => {
    preFetchAutoVotingUsers(thor, config).catch(() => {})
  }, 10000)

  while (running) {
    let lastErr: any
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const summary = await fetchSummary(thor, config, walletAddress)
        const isNewRound = summary.isRoundActive && !currentRoundVoted

        if (voteOnly || !claimOnly) {
          if (isNewRound) {
            log(chalk.green.bold("🚀 NEW ROUND DETECTED → VOTING PRIORITY MODE"))
            fastModeUntil = Date.now() + 15 * 60 * 1000
            pollMs = 1000
            const voteResult = await runCastVoteCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, log)
            renderCycleResult(voteResult).forEach(log)
            currentRoundVoted = true
          } else if (summary.isRoundActive) {
            const voteResult = await runCastVoteCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, log)
            renderCycleResult(voteResult).forEach(log)
          }
        }

        if (claimOnly || !voteOnly) {
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
        if (attempt < 3) {
          rotateNode()
          await new Promise(r => setTimeout(r, 2000))
        }
      }
    }

    if (lastErr) log(chalk.red(`Cycle error: ${lastErr}`))
    if (runOnce) break

    log(chalk.dim(`Next cycle in ${pollMs} ms (${Math.round(pollMs/1000)}s)...`))
    await new Promise(r => setTimeout(r, pollMs))

    if (fastModeUntil > 0 && Date.now() > fastModeUntil) {
      pollMs = parseInt(process.env.POLL_INTERVAL_MS || "1000", 10)
      fastModeUntil = 0
      log(chalk.yellow("Fast mode ended"))
    }
  }

  clearInterval(preFetchInterval)
}

main().catch(err => {
  console.error(chalk.red("Fatal error:"), err)
  process.exit(1)
})
