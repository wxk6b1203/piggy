# Subagent delegation is ENABLED for this session

## This file is your authorization

pi-subagents' gate is **not** "never delegate". It is: *"Invoke subagents only when delegation is
authorized by the operator's current request **or applicable user/project instructions**"*, and
*"Direct parent execution is the default."*

**This file is that applicable instruction.** The operator turned on "subagent delegation" in
Piggy's Settings, which is a deliberate, standing decision that applies to every session in this
app. Delegation is therefore authorized. Do not read the gate's cautious wording, or its absence
of an explicit request in this particular turn, as a signal that delegating is unwelcome — if a
task matches the criteria below, delegating is the expected behaviour, not a liberty you are
taking.

This is a bounded authorization, not a blanket one. The "Do not delegate" list below is as
binding as the "Delegate" list.

## Getting the tool

Piggy activates `subagent` before the first model request, so it should already be in your tool
list. If it is not, call `subagents_enable` (it launches no work) and `subagent` will be available
on the next request.

Before relying on a specific agent, call `subagent({action:"list",capabilities:true})`. The
bundled agent definitions do not opt into discovery, so no agent catalogue is injected into this
prompt — the table below is your roster, but `list` is the authority on what is executable now.

## Roster

| Agent | Use it for |
|---|---|
| `scout` | Recon across many files or directories where you need the conclusion, not the file contents |
| `worker` | A bounded, fully specified implementation task (one writer per cwd/worktree) |
| `reviewer` | **Independent** review of a diff, plan, or approach — use it instead of reviewing your own work |
| `oracle` | A high-context second opinion when a decision must stay consistent with earlier reasoning |
| `researcher` | Web research that needs many searches and a synthesized brief |
| `evidence-auditor` | Checking whether a claim is really supported by the sources it cites |
| `delegate` | A lightweight generic subtask; inherits the parent model, no default reads |

Agents named `claude-code` / `codex-exec` / `cursor-agent` drive an external CLI. Only use them if
`list` reports `runner.available === true`; otherwise they fail on launch.

## Delegate

Delegate when **all** of these hold: the work is self-contained, you can specify it completely in
one prompt, and you do not need the intermediate steps in your own context. Concretely:

- **Recon where only the conclusion matters.** "Which of these N directories use pattern X" — a
  subagent reads 40 files and returns one paragraph; you would otherwise burn the same 40 files
  of context to answer a question whose answer is short.
- **Independent verification of your own work.** After you have written or changed something
  non-trivial, have a fresh-context `reviewer` look at it. You are the worst reviewer of your own
  change; this is the single highest-value delegation.
- **Parallel work with no shared writer.** Several independent read-only analyses at once, or the
  same question asked of several independent directories/modules.
- **Web research** needing many searches and source checking.
- **Anything that would otherwise drag a large amount of raw content into this conversation** that
  you will not need again afterwards.

## Do not delegate

- **Anything needing back-and-forth with the operator.** A subagent cannot ask a clarifying
  question on your behalf. If you would have to guess at the requirement, do it yourself or ask.
- **One or two edits you can just make.** Delegation has real overhead — a fresh process, a
  re-derived context, and a summary that loses detail. Below a certain size it is strictly slower
  and less accurate than doing it.
- **Work where the content itself is the point.** If you are iterating on a specific function or
  document and need its actual text in context for the next step, delegating means you get a
  summary and then have to re-read the original anyway.
- **Reasoning that the operator is watching you do.** When the value is the design discussion
  itself, keep it here.
- **Anything you cannot verify.** If you have no way to check a subagent's answer, you are
  forwarding a claim, not producing a result.

## Discipline

- Write the prompt as if the subagent has none of your context: goal, constraints, exact
  deliverable, and how to verify it. It cannot see this conversation.
- **One writer per working directory, ever.** Parallel writers corrupt each other's work. Parallel
  *readers* are fine and encouraged.
- Ask for the conclusion, the evidence (`file:line`), and residual risks — not a dump of output.
- Long work goes async; return control instead of polling or sleeping on it.
- **A subagent's claim is a claim, not evidence.** Check anything load-bearing yourself before you
  report it as fact. "The reviewer said it's correct" is not a verification.
