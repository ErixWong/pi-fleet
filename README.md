# pifleet

**English** | [中文](README.zh-CN.md)

> A self-hosted command and communication hub for a personal fleet of AI agents.

pifleet turns a handful of Linux machines — x86 servers, ARM boxes, headless containers —
into one fleet you command from a browser: register hosts, dispatch tasks, review
deliverables, and talk to each device through the agent running on it.

This is a **personal fleet-command tool, not a marketplace**. The focus is dispatching work
to your own devices and communicating with them; any future marketplace/discussion features
are secondary.

---

## What it does

| Capability | Details |
|---|---|
| **Host fleet** | Register heterogeneous hosts with a one-time API key; heartbeat, remote folder browsing, and a request/response control channel |
| **Task dispatch** | Task state machine (`open → claimed → submitted → pending_confirm → done`) with claim, reclaim on timeout, attempts, acceptance and rejection |
| **Deliverables** | Attachments with sha256 dedup, malware-scan worker, in-browser preview (image / PDF / text), account-scoped permissions |
| **Conversations** | Per-device channels: chat with the agent on a specific host |
| **Two agent-facing protocols** | REST v2 for host daemons, MCP2 (`/mcp2`, Streamable HTTP) for pi agents |
| **Web console** | Vue 3 + Bootstrap SPA, served by the same process as the API |
| **Auditability** | Every state change is written to an event table and published through a transactional outbox |

## Architecture

```
👤 Admin (browser)                      ← the only party that issues work
        │ HTTPS  /api/v2
┌───────┴─────────────────────────────────────────┐
│ pifleet platform (single Node process)          │
│   /api/v2 REST · /mcp2 MCP · static Web         │
│   auth (Bearer key → principal + scope)         │
│   service layer: identity / posts / task-flow   │
│                  resources / event-outbox       │
│   workers: outbox · attachment scan · lifecycle │
└───────┬─────────────────────────────────────────┘
        │ daemon polls every 5s (claim / submit / heartbeat)
┌───────┴─────────────────────────────────────────┐
│ Host fleet (heterogeneous, horizontally scalable)│
│   agent-daemon + pi  ← one set per machine      │
└──────────────────────────────────────────────────┘
        MariaDB (state) + local disk (attachment blobs)
```

Full diagram and code mapping: [`docs/design/architecture.md`](docs/design/architecture.md).

**Roles:** the human admin works in the browser; each host runs a `pi-agent` daemon that
polls for work, spawns a pi process per task, and reports deliverables back. Hosts never
self-register — an admin creates the host and hands out its key.

## Quick start

### 1. Platform server

Requirements: **Node.js ≥ 20**, **MariaDB**.

```bash
git clone https://github.com/ErixWong/pi-fleet.git
cd pi-fleet
npm install
npm run build

# configure .env: DB_HOST/DB_PORT/DB_USER/DB_PASSWORD, DB_NAME_NEW, PORT, ATTACHMENTS_ROOT
npm run db-rebuild -- --database erix        # create the schema (25 tables)
ADMIN_USERNAME=admin ADMIN_PASSWORD=... ADMIN_ACCOUNT_NAME=erix \
  npm run create-admin -- --database erix    # create the first admin

npm run platform:start                       # start (platform:start:build builds first)
npm run platform:stop                        # stop
```

The platform serves the API, the MCP endpoint and the web console on `PORT`
(default `3000`; this deployment runs on `3200`).

### 2. Register a device

In the web console: **Hosts → Register host** → copy the **one-time API key** shown
(displayed only once). This creates a `host` principal with `task:read`, `task:claim`
and `task:submit` scopes.

### 3. Install the agent client on the device

```bash
npm install -g pifleet-agent-client

pi-agent setup --url=http://<platform>:3200 --key=<one-time key>
# writes ~/.config/pi-agent/config.json (600) and merges the task-dispatch
# entry into ~/.pi/agent/mcp.json

pi-agent run                    # foreground, for a first check
sudo pi-agent install-service   # systemd service (Restart=always)
```

Verify: the host appears in the web console with a refreshing heartbeat, and a test task
targeting it goes through claim → submit → deliverable review.

Details, sandbox isolation and troubleshooting: [`docs/agent-onboarding.md`](docs/agent-onboarding.md).

## Repository layout

```
src/           platform server: routes/v2, mcp/ (MCP2), service/, db/, workers
web/           Vue 3 web console
client/        pi-agent client + daemon (published as pifleet-agent-client)
scripts/       acceptance suites, db tooling, platform start/stop scripts
docs/          onboarding, architecture, data model, design notes
```

## Tests

```bash
npm run typecheck        # tsc --noEmit
npm run test:unit        # service/id/auth unit tests
npm run test:v2          # MCP2 + REST v2 + events/outbox acceptance (needs a running platform)
npm run test:web         # Playwright web acceptance (needs TEST_USERNAME / TEST_PASSWORD)
npm test                 # all of the above
```

## Documentation

- [`docs/agent-onboarding.md`](docs/agent-onboarding.md) — connect a new device end to end
- [`docs/design/architecture.md`](docs/design/architecture.md) — architecture and code map
- [`docs/design/data-model.md`](docs/design/data-model.md) — schema and ID conventions
- [`AGENTS.md`](AGENTS.md) — repository conventions for contributors/agents

## License

The agent client (`client/`, npm package `pifleet-agent-client`) is MIT licensed.
