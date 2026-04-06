#!/usr/bin/env node
/**
 * VeBetterDAO Relayer Node - PRIORITY VOTE MODE (versione definitiva compatibile)
 */

import * as fs from "fs"
import { ThorClient } from "@vechain/sdk-network"
import { Address, HDKey } from "@vechain/sdk-core"
import chalk from "chalk"
import { getNetworkConfig, getNodePool } from "./config"
import { fetchSummary } from "./contracts"
import { runCastVoteCycle, runClaimRewardCycle } from "./relayer"
import { renderSummary, renderCycleResult, logSectionHeader } from "./display"

const SECRETS_DIR = "/run/secrets"
const ALLOWED_SECRETS = new Set(["mnemonic", "relayer_private_key"])

function readSecret(name: string): string | undefined {
  if (!ALLOWED_SECRETS.has(name)) return undefined
  const secretPath = `${SECRETS_DIR}/${name}`
  try {
    return fs.readFileSync(secretPath, "utf8").trim()
  } catch {
    return undefined
  }
}

function getWallet() {
  const mnemonic = process.env.MNEMONIC || readSecret("mnemonic")
  const privateKey = process.env.RELAYER_PRIVATE_KEY || readSecret("relayer_private_key")

  if (privateKey) {
    return { privateKey: privateKey.replace("0x", ""), mnemonic: undefined }
  }
  if (mnemonic) {
    const hdKey = HDKey.fromMnemonic(mnemonic.split(" "))
    const child = hdKey.derive(0)
    return { privateKey: child.privateKey!.toString("hex"), mnemonic }
  }
  throw new Error("❌ Imposta RELAYER_PRIVATE_KEY o MNEMONIC")
}

async function main() {
  const config = getNetworkConfig("mainnet")
  const wallet = getWallet()
  const privateKey = wallet.privateKey
  const walletAddress = Address.of(privateKey).toString()

  // ── Gestione nodi semplice (compatibile con il tuo config.ts) ─────────────────
  const nodes = getNodePool("mainnet")
  let nodeIndex = 0
  let thor = ThorClient.at(nodes[nodeIndex])

  const batchSize = parseInt(process.env.BATCH_SIZE || "150")
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true"
  const pollMs = parseInt(process.env.POLL_INTERVAL_MS || "10000")
  const runOnce = process.env.RUN_ONCE === "1" || process.env.RUN_ONCE === "true"

  let currentRoundVoted = false

  console.log(chalk.bold.green("🚀 VeBetterDAO Relayer Node v1.1.0 - PRIORITY VOTE MODE"))

  while (true) {
    try {
      let summary = await fetchSummary(thor, config, walletAddress)

      const isNewRound = summary.isRoundActive && !currentRoundVoted

      if (isNewRound) {
        logSectionHeader("vote", summary.currentRoundId)
        console.log(chalk.green.bold("🔥 NEW ROUND DETECTED → VOTING PRIORITY MODE (skipping claims)"))
        const voteResult = await runCastVoteCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, console.log)
        renderCycleResult(voteResult).forEach(console.log)
        currentRoundVoted = true
      } else if (summary.isRoundActive) {
        logSectionHeader("vote", summary.currentRoundId)
        const voteResult = await runCastVoteCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, console.log)
        renderCycleResult(voteResult).forEach(console.log)
      } else {
        console.log(chalk.dim("Round not active, skipping cast-vote"))
      }

      if (!isNewRound && summary.previousRoundId > 0) {
        logSectionHeader("claim", summary.previousRoundId)
        const claimResult = await runClaimRewardCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, console.log)
        renderCycleResult(claimResult).forEach(console.log)
      }

      summary = await fetchSummary(thor, config, walletAddress)
      renderSummary(summary)

      if (!summary.isRoundActive) {
        currentRoundVoted = false
      }

      if (runOnce) {
        console.log("Run once complete. Exiting.")
        break
      }

      console.log(chalk.dim(`Next cycle in ${(pollMs / 1000)}s...`))
      await new Promise(r => setTimeout(r, pollMs))

    } catch (err) {
      console.log(chalk.red(`Cycle error: ${err instanceof Error ? err.message : String(err)}`))
      // Rotazione manuale nodo
      nodeIndex = (nodeIndex + 1) % nodes.length
      thor = ThorClient.at(nodes[nodeIndex])
      console.log(chalk.yellow(`→ Switched to node: ${nodes[nodeIndex]}`))
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}

main().catch(console.error)
