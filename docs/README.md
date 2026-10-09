# TraceQuest documentation

[Product overview and screenshots](../README.md)

## Start here

| Goal | Guide |
| --- | --- |
| Install, try the demo, or fix an empty session list | [Installation and local setup](installation.md) |
| Search, render, export, import or summarise sessions | [CLI reference](cli-reference.md) |
| Collect recordings from other machines and deploy a read-only hub | [Hub deployment](hub-deployment.md) |
| Understand network access and protect recordings | [Security](../SECURITY.md) |

## For your coding agent

Read [AGENTS.md](../AGENTS.md) before changing the project. It defines the repo's
facts workflow; the `domain` section of `.facts` defines its vocabulary.
Then read the relevant guide rather than guessing commands or source layouts:

- [Command options and examples](cli-reference.md#cli-usage)
- [Session sources and discovery paths](cli-reference.md#supported-sources)
- [Live runs, API endpoints and environment variables](cli-reference.md#launching-agent-runs)
- [Hub configuration, access and scheduled collection](hub-deployment.md)
- [Contributing, development and releases](../CONTRIBUTING.md)
- [Test harnesses](../tests/README.md) and [synthetic CLI example verification](../tests/standup-handoff-smoke.md)

## UI development

Start with the [UI guidelines](ui-guidelines.md): who uses tracequest, the five
jobs, the information architecture and the states every screen handles. The
[design system](design-system.md) holds the tokens, components and themes, and
`node scripts/design-specimen.mjs` renders every component in dark and light.
[Screenshot and recording examples](ui-examples/) show the Runs, session,
compare, insights and usage views.
