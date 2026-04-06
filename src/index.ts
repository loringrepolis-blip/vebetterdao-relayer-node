#!/usr/bin/env node
/**
 * VeBetterDAO Relayer Node - Versione con PRIORITÀ VOTO
 *
 * Quando si apre un nuovo round: fa SOLO il casting dei voti
 * Solo dopo aver finito il voto passa ai claim del round precedente
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

/**
 * Read a Docker secret file.
 */
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
  const config = getNetworkConfig()
  const { privateKey } = getWallet()
  const thorPool = getNodePool(config.nodeUrl)
  let thor = thorPool.getCurrent()

  const batchSize = parseInt(process.env.BATCH_SIZE || "150")
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true"
  const pollMsDefault = parseInt(process.env.POLL_INTERVAL_MS || "10000")
  const runOnce = process.env.RUN_ONCE === "1" || process.env.RUN_ONCE === "true"

  let lastErr: any
  let pollMs = pollMsDefault
  let currentRoundVoted = false   // ← Nuova logica: priorità voto

  console.log(chalk.bold.green("🚀 VeBetterDAO Relayer Node v1.1.0 - PRIORITY VOTE MODE"))

  while (true) {
    try {
      let summary = await fetchSummary(thor, config, Address.of(getWallet().privateKey).toString())

      // ── NUOVA LOGICA PRIORITÀ VOTO ─────────────────────────────
      const isNewRound = summary.isRoundActive && !currentRoundVoted

      if (isNewRound) {
        logSectionHeader("vote", summary.currentRoundId)
        console.log(chalk.green.bold("🔥 NEW ROUND DETECTED → VOTING PRIORITY MODE (skipping claims)"))
        const voteResult = await runCastVoteCycle(thor, config, Address.of(getWallet().privateKey).toString(), privateKey, batchSize, dryRun, console.log)
        renderCycleResult(voteResult).forEach(console.log)
        currentRoundVoted = true
      } else if (summary.isRoundActive) {
        logSectionHeader("vote", summary.currentRoundId)
        const voteResult = await runCastVoteCycle(thor, config, Address.of(getWallet().privateKey).toString(), privateKey, batchSize, dryRun, console.log)
        renderCycleResult(voteResult).forEach(console.log)
      } else {
        console.log(chalk.dim("Round not active, skipping cast-vote"))
      }

      // Claim solo dopo aver votato o se non è un nuovo round
      if (!isNewRound && summary.previousRoundId > 0) {
        logSectionHeader("claim", summary.previousRoundId)
        const claimResult = await runClaimRewardCycle(thor, config, Address.of(getWallet().privateKey).toString(), privateKey, batchSize, dryRun, console.log)
        renderCycleResult(claimResult).forEach(console.log)
      }

      // Aggiorna summary finale
      summary = await fetchSummary(thor, config, Address.of(getWallet().privateKey).toString())
      renderSummary(summary)

      // Reset flag quando il round finisce
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
      lastErr = err
      console.log(chalk.red(`Cycle error: ${err instanceof Error ? err.message : String(err)}`))
      thor = thorPool.rotate()
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

main().catch(console.error)

//Apply vote-first priority logic - index.ts
