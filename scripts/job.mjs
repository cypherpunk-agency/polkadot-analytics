#!/usr/bin/env node
// scripts/job.mjs — the job CLI, and the tier-3 bridge (docs/concept/plan.md §2.5).
//
// The point of this file is what it does NOT contain: no second implementation. It opens the
// same store (server/lib/store.mjs), the same queue (jobs.mjs) and the same engine
// (job-worker.mjs) the production worker runs, against a local SQLite file — a year-long
// backfill on a laptop and the same backfill on the VM are the same code with a different
// ANALYTICS_DATA_DIR. No server needs to be running.
//
// Usage:
//   node scripts/job.mjs enqueue <source> <operation> [key=value ...]
//   node scripts/job.mjs run [id]        run the given job (or drain the queue), foreground;
//                                        progress streams to stderr, the final job to stdout
//   node scripts/job.mjs status <id>
//   node scripts/job.mjs list [state]    state: queued|running|partial|done|failed|gave-up
//   node scripts/job.mjs cancel <id>
//   node scripts/job.mjs retry <id>      reset a gave-up (or failed/partial) job to queued
//
// Values in `key=value` parse as JSON where they can (`days=30` is the number 30, `flag=true`
// a boolean) and stay strings where they cannot. KNOWN DIVERGENCE from the HTTP layer's
// readParams: a param a source declares as `list` is comma-split there (`assets=DOT,USDC` →
// ['DOT','USDC']) but stays the string "DOT,USDC" here, which would mint a second identity.
// Until enqueue consults the source's param schema, pass such values as JSON on the CLI:
// `assets=["DOT","USDC"]`.

import { openStore, defaultDataDir } from '../server/lib/store.mjs'
import { JobQueue } from '../server/lib/jobs.mjs'
import { drainQueue, HostGate } from '../server/lib/job-worker.mjs'

const [command, ...rest] = process.argv.slice(2)

const USAGE = `usage: node scripts/job.mjs <enqueue|run|status|list|cancel|retry> ...
  enqueue <source> <operation> [key=value ...]
  run [id]
  status <id>
  list [state]
  cancel <id>
  retry <id>
The store lives at ANALYTICS_DATA_DIR (default server/data/).`

if (!command) quit(USAGE)

const store = openStore({ dir: defaultDataDir() })
const queue = new JobQueue(store)

try {
  switch (command) {
    case 'enqueue': {
      const [source, operation, ...pairs] = rest
      if (!source || !operation) quit('enqueue needs <source> <operation> [key=value ...]')
      const job = queue.enqueue(source, operation, readPairs(pairs))
      print(job)
      break
    }

    case 'run': {
      const id = rest[0] === undefined ? undefined : jobId(rest[0])
      if (id !== undefined && !queue.get(id)) quit(`No job ${id}.`)
      const results = await drainQueue(store, queue, {
        id,
        gate: new HostGate(),
        onProgress: (job) => process.stderr.write(`${progressLine(job)}\n`),
      })
      if (results === null) {
        // Another live drainer (the server's worker, or another shell) holds the engine lock.
        // Not an error — the work IS being done, just not by us.
        process.stderr.write('Another worker is draining the queue; nothing was run here.\n')
        break
      }
      if (results.length === 0) {
        // Nothing claimable is an answer, not an error — exit 0 on a plain drain, so a cron
        // `job run` over an idle queue does not page anyone. But say WHY (and exit 2) when a
        // specific job was named, because "nothing happened" on a gave-up job reads like a hang.
        const job = id === undefined ? undefined : queue.get(id)
        if (job) quit(`Job ${id} is \`${job.state}\` and not claimable. ${hintFor(job)}`)
        process.stderr.write('Nothing to run.\n')
        break
      }
      for (const job of results) print(job)
      break
    }

    case 'status': {
      const job = queue.get(jobId(rest[0]))
      if (!job) quit(`No job ${rest[0]}.`)
      print({ ...job, coverage: store.coverage(job.source, job.operation, job.params) })
      break
    }

    case 'list': {
      const [state] = rest
      for (const job of queue.list({ state })) {
        console.log(`${String(job.id).padStart(5)}  ${job.state.padEnd(8)}  ${job.source}/${job.operation} ${job.paramsKey}  ${progress(job)}`)
      }
      break
    }

    case 'cancel': {
      const job = queue.cancel(jobId(rest[0]))
      if (!job) quit(`No job ${rest[0]}.`)
      print(job)
      break
    }

    case 'retry': {
      const job = queue.retry(jobId(rest[0]))
      if (!job) quit(`No job ${rest[0]}.`)
      print(job)
      break
    }

    default:
      quit(`Unknown command \`${command}\`.\n${USAGE}`)
  }
} catch (problem) {
  // A refused operation (retry with a live sibling, say) is an answer, not a stack trace.
  quit(problem?.message ?? String(problem))
} finally {
  store.close()
}

/* -------------------------------------------------------------------------- helpers ---- */

function quit(message) {
  console.error(message)
  process.exit(2)
}

function jobId(text) {
  if (!/^\d+$/.test(text ?? '')) quit(`Expected a job id, got \`${text}\`.`)
  return Number(text)
}

function readPairs(pairs) {
  const params = {}
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at < 1) quit(`Parameters are key=value, got \`${pair}\`.`)
    const key = pair.slice(0, at)
    const raw = pair.slice(at + 1)
    try {
      params[key] = JSON.parse(raw)
    } catch {
      params[key] = raw
    }
  }
  return params
}

/** Machine-readable result on stdout — the CLI is scriptable, prose goes to stderr. */
function print(value) {
  console.log(JSON.stringify(value, null, 2))
}

function progress(job) {
  // null units means NOT KNOWABLE — printed as such, never as 0 or 0%.
  if (job.doneUnits === null || job.doneUnits === undefined) return ''
  if (job.totalUnits === null || job.totalUnits === undefined) return `${job.doneUnits} units`
  return `${job.doneUnits}/${job.totalUnits} units`
}

function progressLine(job) {
  const units = progress(job)
  return `[job ${job.id}] ${job.state}${units ? ` ${units}` : ''}${job.error ? ` — ${job.error}` : ''}`
}

function hintFor(job) {
  if (job.state === 'gave-up') return `It spent its ${job.maxAttempts}-attempt budget (${job.error ?? 'no error recorded'}); \`retry ${job.id}\` resets it.`
  if (job.state === 'partial') return `It was cancelled or interrupted; \`retry ${job.id}\` (or enqueueing it again) re-queues it, cursor intact.`
  if (job.state === 'failed') return `Its backoff has not elapsed yet (next attempt at ${job.nextAttemptAt ? new Date(job.nextAttemptAt).toISOString() : 'unknown'}).`
  if (job.state === 'done') return 'It already finished.'
  if (job.state === 'running') return 'Another worker holds its lease.'
  return ''
}
