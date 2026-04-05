#!/usr/bin/env node
/**
 * VeBetterDAO Relayer Node - Versione ottimizzata
 */
import * as fs from "fs"
import { ThorClient } from "@vechain/sdk-network"
import { Address, HDKey } from "@vechain/sdk-core"
import chalk from "chalk"
import { getNetworkConfig, getNodePool } from "./config"
import { fetchSummary } from "./contracts"
import { runCastVoteCycle, runClaimRewardCycle } from "./relayer"
import { renderSummary, renderCycleResult, logSectionHeader, timestamp } from "./display"

const SECRETS_DIR = "/run/secrets"
const ALLOWED_SECRETS = new Set(["mnemonic", "relayer_private_key"])

function readSecret(name: string): string | undefined {
  if (!ALLOWED_SECRETS.has(name)) return undefined
  const secretPath = `${SECRETS_DIR}/${name}`
  try {
    return fs.readFileSync(secretPath, "utf-8").trim()
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
    console.error(chalk.red("Set MNEMONIC or RELAYER_PRIVATE_KEY (env var or Docker secret)"))
    process.exit(1)
  }
  const child = HDKey.fromMnemonic(words).deriveChild(0)
  const raw = child.privateKey
  if (!raw) {
    console.error(chalk.red("Failed to derive private key from mnemonic"))
    process.exit(1)
  }
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

  const batchSize = Math.max(1, parseInt(process.env.BATCH_SIZE || "50", 10) || 50)
  const dryRun = envBool("DRY_RUN")
  const pollMs = Math.max(60_000, parseInt(process.env.POLL_INTERVAL_MS || "10000", 10) || 10_000)
  const runOnce = envBool("RUN_ONCE")

  const nodePool = nodeUrlOverride ? [nodeUrlOverride] : getNodePool(network)
  let nodeIndex = 0
  let thor = ThorClient.at(config.nodeUrl, { isPollingEnabled: false })

  function rotateNode() {
    if (nodePool.length <= 1) return
    nodeIndex = (nodeIndex + 1) % nodePool.length
    config.nodeUrl = nodePool[nodeIndex]
    thor = ThorClient.at(config.nodeUrl, { isPollingEnabled: false })
    const host = new URL(config.nodeUrl).hostname
    log(chalk.yellow(`Rotating to node: ${host}`))
  }

  let running = true
  let forceExit = false
  const shutdown = () => {
    if (forceExit) process.exit(1)
    forceExit = true
    running = false
    log(chalk.yellow("Shutting down after current operation..."))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  // FIX: Initial summary con retry (risolve il warning "Could not fetch initial summary")
  async function fetchInitialSummary() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const summary = await fetchSummary(thor, config, walletAddress)
        return summary
      } catch (err) {
        if (attempt === 3) throw err
        await new Promise(r => setTimeout(r, 1500))
        rotateNode()
      }
    }
    throw new Error("Failed to fetch initial summary")
  }

  // Show summary immediately on startup
  try {
    const initial = await fetchInitialSummary()
    process.stdout.write("\x1B[2J\x1B[H")
    console.log(renderSummary(initial))
    console.log("")
    console.log(chalk.bold("─── Activity Log ") + "─".repeat(49))
  } catch (err) {
    log(chalk.yellow("Could not fetch initial summary (will retry in cycles)"))
  }

  const CYCLE_RETRIES = nodePool.length
  const CYCLE_RETRY_MS = 3000

  while (running) {
    let lastErr: unknown
    for (let attempt = 1; attempt <= CYCLE_RETRIES; attempt++) {
      try {
        const summary = await fetchSummary(thor, config, walletAddress)

        if (summary.isRoundActive) {
          logRaw(logSectionHeader("vote", summary.currentRoundId))
          const voteResult = await runCastVoteCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, log)
          renderCycleResult(voteResult).forEach(log)
        } else {
          log(chalk.dim("Round not active, skipping cast-vote"))
        }

        logRaw("")
        logRaw(logSectionHeader("claim", summary.previousRoundId))
        const claimResult = await runClaimRewardCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, log)
        renderCycleResult(claimResult).forEach(log)

        // Refresh dashboard
        const updated = await fetchSummary(thor, config, walletAddress)
        process.stdout.write("\x1B[2J\x1B[H")
        console.log(renderSummary(updated))
        console.log("")
        console.log(chalk.bold("─── Activity Log ") + "─".repeat(49))
        for (const entry of activityLog.slice(-30)) console.log(entry)

        lastErr = undefined
        break
      } catch (err) {
        lastErr = err
        if (attempt < CYCLE_RETRIES) {
          log(chalk.yellow(`Cycle attempt ${attempt}/${CYCLE_RETRIES} failed, retrying in ${CYCLE_RETRY_MS / 1000}s...`))
          rotateNode()
          await new Promise(r => setTimeout(r, CYCLE_RETRY_MS))
        }
      }
    }

    if (lastErr) {
      log(chalk.red(`Cycle error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`))
    }

    if (runOnce) {
      log("Run once complete. Exiting.")
      break
    }

    log(chalk.dim(`Next cycle in ${(pollMs / 1000)}s...`))
    await new Promise(r => setTimeout(r, pollMs))
  }
}

main().catch(err => {
  console.error(chalk.red("Fatal error:"), err)
  process.exit(1)
})

//Fix initial summary + miglioramenti avvio
