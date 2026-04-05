#!/usr/bin/env node
/**
 * VeBetterDAO Relayer Node - Versione definitiva (pulita)
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

  const batchSize = Math.max(1, parseInt(process.env.BATCH_SIZE || "120", 10))
  const dryRun = envBool("DRY_RUN")
  const runOnce = envBool("RUN_ONCE")

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
  let pollMs = 15000          // polling normale
  let fastModeUntil = 0       // timestamp per fast mode

  process.on("SIGINT", () => { running = false; log(chalk.yellow("Shutting down...")) })
  process.on("SIGTERM", () => { running = false; log(chalk.yellow("Shutting down...")) })

  // FIX DEFINITIVO: fetch iniziale molto più robusto e silenzioso
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

  // Dashboard iniziale (senza warning giallo se fallisce)
  if (initialSummary) {
    process.stdout.write("\x1B[2J\x1B[H")
    console.log(renderSummary(initialSummary))
  } else {
    console.log(chalk.dim("Initial summary not available yet (will load in first cycle)"))
  }

  while (running) {
    const isFastMode = Date.now() < fastModeUntil

    let lastErr: unknown
    for (let attempt = 1; attempt <= nodePool.length; attempt++) {
      try {
        const summary = await fetchSummary(thor, config, walletAddress)

        // Attiva fast mode all'inizio di un nuovo round
        if (summary.isRoundActive && fastModeUntil === 0) {
          fastModeUntil = Date.now() + 15 * 60 * 1000
          pollMs = 4000
          log(chalk.green.bold("🚀 NEW ROUND DETECTED → FAST MODE (4s polling for 15 min)"))
        }

        if (summary.isRoundActive) {
          logRaw(logSectionHeader("vote", summary.currentRoundId))
          const voteResult = await runCastVoteCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, log)
          renderCycleResult(voteResult).forEach(log)
        } else {
          log(chalk.dim("Round not active, skipping cast-vote"))
          if (fastModeUntil > 0 && Date.now() > fastModeUntil) {
            fastModeUntil = 0
            pollMs = 15000
            log(chalk.yellow("Fast mode ended"))
          }
        }

        logRaw(logSectionHeader("claim", summary.previousRoundId))
        const claimResult = await runClaimRewardCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, log)
        renderCycleResult(claimResult).forEach(log)

        // Refresh dashboard
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
  }
}

main().catch(err => {
  console.error(chalk.red("Fatal error:"), err)
  process.exit(1)
})

//Final fix - initial summary pulito e robusto
