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

Start with [UI style guidelines](ui-style-design-guidelines.md) and
[information architecture](ui-information-architecture-guidelines.md).
The style guide links the detailed interaction, density, diagnostics and theming
rules. Use the [design review template](ui-design-review-note-template.md) when a
change needs a review note. [Screenshot and recording examples](ui-examples/) show
the browser, session detail, comparison, insights and usage views.
