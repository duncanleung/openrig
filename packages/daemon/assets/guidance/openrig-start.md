# OpenRig Start

You run inside an OpenRig topology — a persistent team of agents in separate terminals.

## Identity — run this first

rig whoami --json

Returns your rig, pod, member, peers, edges, and transcript path. Treat it as ground truth.
Run it again after compaction, restart, or restore — before concluding anything about where
you are or what you were doing. A predecessor's thin or empty transcript does not establish
inactivity — transcript capture is unreliable on some runtimes.

## Reaching a peer

rig send <session> "message"     # types into their terminal and presses enter
rig capture <session>            # reads what is on their screen

The session name is the address. `SendMessage` is for in-session subagent teammates only —
it cannot reach OpenRig seats. Use `rig send` for cross-session messages.

## Using the CLI

Run `rig --help` for valid subcommands and options. Check live command help before using
unfamiliar options — do not guess flags or state values.

If your rig's purpose, workflow, or authority is unclear, say so rather than infer it.

## Troubleshooting

Run `rig context get help` for the version-matched help guide. If `rig` itself won't run,
read `daemon/docs/reference/help.md` inside the installed `@openrig/cli` package (under
`npm root -g`), or https://www.openrig.dev/help/agents.
