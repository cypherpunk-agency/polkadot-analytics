---
name: research-and-build
description: The operating method for polkadot-analytics — research an upstream before coding against it, settle inconclusive evidence with a probe rather than an argument, grade what you verified apart from what you inferred, write findings into the knowledge base, and delegate to subagents without letting them collide. Use this for ANY substantive task in this repo: adding or changing a data source, building or altering a dashboard, investigating how a chain/pallet/contract/indexer behaves, checking whether a number is right, or orchestrating several agents at once. Use it even when the request sounds like a quick fix, because the failure mode here is a wrong number that renders perfectly. Skip it only for edits confined to this repo's own code with no upstream involved — a layout tweak, a rename, a refactor.
---

# Research and build

This repo publishes numbers about public chains and states what is wrong with each one. Its
characteristic failure is not a crash — it is **a plausible number, rendered beautifully, that is
wrong by a factor of 10ⁿ**. Everything below exists to make that failure loud instead of quiet.

Read `CLAUDE.md` first; it is short and binding. This skill is *how to work*, not *what is true* —
the facts live in `docs/platform/` and in CLAUDE.md's "Facts worth not re-deriving".

## The shape of a task

**Research → record → build → verify → land.** Not ceremony: each step exists because skipping it
has already cost something here.

Skip straight to *build* only when the task touches nothing outside this repo's own code. The
trigger for the full shape is **an external system**, not the size of the change.

---

## 1. Research before you code against it

Find out how the thing actually behaves before writing anything that depends on it. Documentation
describes intent; chains describe reality, and they disagree often enough that assuming is a bug.

Research that goes straight into an implementation is research nobody can check, and the next task
pays to derive it again. That is the whole reason *record* sits between research and build.

## 2. When the evidence is inconclusive, write the probe

Do not reason harder, and do not stop at "unverified". **Write the smallest script that would
settle the question and run it.** It is almost always cheaper than the argument: several thousand
words of careful inference about what Asset Hub's `ForeignAssets` contains were settled by three
RPC calls in under a minute — and the inference had the count wrong.

This applies to interfaces too. A chart that reasons correctly can still render four of its five
rows as invisible slivers. **Screenshot it.** The render is the probe.

Keep what the probe returned. Paste the real response into the `docs/platform/` note with its date
and the endpoint it came from, the way `docs/platform/hyperbridge.md` does. A probe that settled a
question once is the reproduction for whoever doubts it next.

### A probe tells you WHAT; only source tells you WHY

This distinction is load-bearing and easy to lose.

> "34 keys begin with `02`" is an observation that could be a coincidence of today's registry.
> "The runtime's filter refuses to create any other kind" is a guarantee.

Same fact, completely different confidence — and **only the second is safe to build a
discriminator on.** Probe when the question is what is *there*. Read the runtime source when the
question is what a value *means*, or when a rule has to still hold next month.

## 3. Grade your evidence, and say which grade you have

Agents — including you — report confidently on things they never actually reached. Mark every
claim as one of:

| Grade | Means |
|---|---|
| **verified live** | you called it, today, and here is the response |
| **source-verified** | read out of the runtime/pallet source that defines the behaviour |
| **inferred** | reasoned from the two above. Must be settled before anything ships on it |

"I could not reach it" is a valuable answer and belongs in the report. **Inventing a plausible
response shape is the one unforgivable outcome**, because everything downstream is built on it.

## 4. Write it down, in the right place

| Where | What belongs there |
|---|---|
| `docs/platform/` | how a chain or protocol actually works. The test: can the next person answer the question from this repo without reading a chain? |
| `CLAUDE.md` → "Facts worth not re-deriving" | traps that fail **silently**. One or two sentences: the trap, and why it is quiet |
| `docs/decisions/` | why a choice went the way it did, including what was rejected |
| `docs/concept/plan.md` | what is decided, and what is open |
| `docs/concept/research-queue.md` | questions this task opened and did not answer (see §7) |

**Correct what is already there when it turns out wrong.** Appending a contradiction and leaving
both is worse than either, because the next reader cannot tell which is current. Say in your report
what you corrected.

## 5. Verify before you claim it is done

- **Run the repo's own checks**: `npm run check` and `npm run build`. Both must pass.
- **Call the thing you built** against the real upstream and paste real output.
- **Render the thing you drew** and look at it, in both themes.
- **Reconcile.** Where an identity should hold — segments summing to a supply, a fold from genesis
  matching a live read — assert it and report the residual. A reconciliation failure is the most
  valuable thing you can find; do not paper over it.

Report faithfully. If a step was skipped, say so. If a number did not reconcile, lead with that.

---

## Delegating to subagents

Fan out for anything with independent parts: several upstreams to probe, several dimensions to
review, a task list longer than one context. The orchestrator stays the orchestrator.

### The orchestrator keeps the plan

You hold `docs/concept/plan.md` and the research queue. Subagents report; you decide what that
means and record it. When an agent's finding contradicts the plan, **update the plan** — that is
the job, not an interruption.

### File ownership prevents git races

Several agents committing into one worktree will collide, and `git add -A` from one will sweep up
another's half-written work. So:

- **Give every writing agent a disjoint set of files, and say so explicitly** — including which
  files it must *not* touch. Shared files (`server/sources/index.mjs`, `src/sources/pages.js`,
  `CLAUDE.md`) get exactly one owner per round.
- **Prefer read-only agents.** Research and probing need no writes at all: have them report, and
  write the results yourself. This removes the whole class of problem.
- **Stage explicitly.** `git add <paths>`, never `git add -A`, while another agent is running.
- **Sequence what cannot be split.** A page cannot be built before the module whose payload it
  renders. Waiting one round beats merging two half-modules.

**⚠️ Instructing agents to stage narrowly is not sufficient, and this has already gone wrong.**
Two agents finished within seconds of each other; one ran a sweeping `git add` in the window
between the other's `git add` and its `git commit`, and swept up 640 lines of a module it knew
nothing about. The content survived — `git` does not lose staged bytes — but the commit message
did: a module landed inside a commit describing something else entirely, and the reasoning that
would have explained it was gone from the history.

The staging window is a race and no amount of instruction closes it. Two fixes actually work:

- **Have writing agents NOT commit at all.** They report; the orchestrator stages and commits.
  This is the default worth reaching for — it removes the race entirely, and it puts the commit
  message in the hands of whoever can see how the pieces fit.
- **Give agents `isolation: "worktree"`** when they must commit, so each has its own index.

If a race does happen: **do not rewrite the other agent's commit to fix it.** Amending an
in-flight commit to recover a message is a worse risk than a mislabelled one. Note it, make sure
the reasoning survives somewhere durable — a module header, a `docs/platform/` note — and move on.
History is the cheapest of the things that could have been lost.

### Never block on a background process you do not own

An agent waiting on a long job is the most expensive mistake in this file, because it looks like
diligence. On 2026-08-21 one spent **two and a half hours across nine `Bash` calls of 16–20
minutes each**, sleeping while `scripts/job.mjs run` filled the store in a separate process. The
drain ran at exactly the same rate throughout. The sleeps bought nothing at all; they spent the
agent's turns and its context, and none of it reached the repo.

Two rules, and the second matters more:

- **A background process runs whether or not you watch it.** If you need a progress number, take
  one short reading and carry on. Never sleep in a loop for something you did not spawn in the
  foreground.
- **Know what "done" means before you wait for it.** That agent was waiting for a complete
  backfill, and this store is **demand-driven by design** — `docs/decisions/0006` fills it from
  reads, `0012` renders partial coverage with a coverage bar rather than a spinner, and `0014`
  warms and resumes the queue at boot. A complete store was never a precondition for shipping.
  It was waiting for a state the architecture specifically says you do not have to wait for.

The useful inversion: **partial coverage is the state a real visitor meets on a cold store**, so
verifying the page against it is worth more than verifying the warm case. The thing the agent was
waiting to avoid was the thing most worth testing.

The orchestrator's share of this: say in the brief what "enough" looks like, and name any decision
that landed *after* the agent was briefed. This one could not have known about `0014`.

### Briefing an agent well

Hand over everything you already know so it does not re-derive it: storage prefixes you computed,
counts you observed, byte offsets you decoded, the traps in its path. Then state the standard —
what "verified" means, and that unreachable is a valid answer.

Name the deliverable, the files it owns, the files it must not touch, and what its report must
contain. Ask it to say **what it recorded and where**, not only what it found.

### Subagent context is destroyed

When an agent finishes, everything it learned and did not write into the repo is gone — not merely
un-shared. The next agent pays to derive it again. So a subagent that finds something worth knowing
**writes it down as part of the task**, and its report says where.

---

## 6. Landing it

Commit in coherent units with a message that explains *why*, including what was verified and what
did not hold up. This repo's history is part of its documentation.

Push to the working branch. Merge to `main` when a piece is genuinely done — checks passing, output
verified against the real upstream, findings recorded.

---

## 7. Surface new research directions — do not absorb them

Almost every task here opens questions it does not answer. Those are the raw material of the next
round, and they decay fast: an unrecorded question is either re-derived later at full cost, or
silently dropped along with whatever it would have unlocked.

So when a task turns up a question it will not answer:

1. **Add it to `docs/concept/research-queue.md`** — the question, why it matters, what it would
   unblock, a rough cost, and whether anything is currently blocked on it.
2. **Tell the user, in the report.** Do not bury it. They are choosing what to parallelise, and a
   question they can see is a research thread they can start now instead of next week.

Distinguish the two kinds, because they route differently:

- **Blocking** — something cannot be built correctly until this is settled. Say so plainly and
  say what is stalled.
- **Opening** — nothing is blocked, but a new capability becomes reachable if this is answered.
  These are the ones that get lost, and they are often where the leverage is.

A question you *answered* on the way past goes into the knowledge base (§4), not the queue. The
queue is for what is still open.

---

## Environment notes

**Node's `fetch` does not read `HTTPS_PROXY`.** In this sandbox it fails with `403 Host not in
allowlist`, which reads exactly like an egress denial and will send you chasing the wrong thing.
Run scripts with `NODE_USE_ENV_PROXY=1`. `curl` works with no special handling — so `curl`
succeeding while Node fails is this, not a blocked host. It is a sandbox artifact: **never change
repo code because of it.**

A genuine `403`/`407` from the proxy is an organization policy denial. Report the blocked host;
do not retry it or route around it.

**Scratch files go in the scratchpad directory**, never in the repo — a stray file at the repo root
collides with another agent's `git add`.
