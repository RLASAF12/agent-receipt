# 👻 AgentReceipt

**MCP middleware that creates a cryptographic receipt for every real tool call — ghost actions leave no trace.**

---

## What Is It?

AgentReceipt sits between your AI agent and any MCP tool server. Every time your agent calls a tool, AgentReceipt:

1. Creates a **pending receipt** in Supabase (SHA256 hash of the request)
2. Forwards the call to the real tool
3. On response → marks the receipt **verified** (with response hash + latency)
4. If no response arrives within `GHOST_TIMEOUT_MS` → marks it **ghost**

If your agent claims it called a tool but **no receipt exists**, that's a **Ghost Action** — the agent fabricated the result.

---

## Why It Exists

AI agents lie. Not always intentionally — sometimes the model hallucinates a tool response, a network call silently fails, or the tool times out and the agent invents a plausible result anyway. This is called a **Ghost Action**: the agent says "I sent the email / updated the database / booked the meeting" — but it never happened.

Ghost Actions are invisible without external verification. AgentReceipt makes them visible.

This is **different from**:
- **Prompt injection** (AgentSentinel catches that)
- **Human approval gates** (AgentGate does that)
- **Agent handoff tracking** (AgentBaton does that)

AgentReceipt is the only tool that verifies whether a specific tool call *actually executed* with a cryptographic receipt.

---

## Quick Start

### 1. Set up Supabase

Create a table in any Supabase project:

```sql
create table tool_receipts (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  agent_name text not null,
  tool_name text not null,
  claimed_at timestamptz not null default now(),
  executed_at timestamptz,
  request_hash text not null,
  response_hash text,
  latency_ms int,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'ghost')),
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- Enable public reads (receipts are audit evidence, not secrets)
alter table tool_receipts enable row level security;
create policy "public read" on tool_receipts for select using (true);
```

Enable Realtime for the table in your Supabase dashboard.

### 2. Install

```bash
npm install -g agent-receipt
# or run directly:
npx agent-receipt
```

### 3. Configure your MCP client

```json
{
  "mcpServers": {
    "your-tools": {
      "command": "npx",
      "args": ["agent-receipt"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_ANON_KEY": "eyJ...",
        "SESSION_ID": "sess_my_agent",
        "AGENT_NAME": "MyAgent-v1",
        "GHOST_TIMEOUT_MS": "30000"
      }
    }
  }
}
```

### 4. Open the dashboard

Live receipt feed → [rlasaf12.github.io/agent-receipt](https://rlasaf12.github.io/agent-receipt/)

Or point the dashboard at your own Supabase project by editing the `SUPABASE_URL` and `SUPABASE_KEY` constants in `dashboard/index.html`.

---

## File Structure

```
agent-receipt/
├── src/
│   └── server.js          # MCP stdio proxy with receipt injection + demo mode
├── dashboard/
│   └── index.html         # GitHub Pages dashboard (Supabase realtime)
├── .github/
│   └── workflows/
│       └── pages.yml      # Auto-deploy dashboard to GitHub Pages on push
├── package.json
└── README.md
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | ✅ | — | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ | — | Supabase publishable anon key |
| `SESSION_ID` | — | `sess_<timestamp>` | Identifies this agent session |
| `AGENT_NAME` | — | `unknown` | Label for the agent (appears in dashboard) |
| `GHOST_TIMEOUT_MS` | — | `30000` | How long to wait before marking a call ghost (ms) |

---

## Demo Mode

Run without any downstream MCP server to see the receipt system in action:

```bash
SUPABASE_URL=https://beseparjuerxjygszlta.supabase.co \
SUPABASE_ANON_KEY=eyJ... \
SESSION_ID=demo_$(date +%s) \
AGENT_NAME=DemoAgent \
npx agent-receipt
```

Demo mode includes 6 built-in tools and a **15% ghost rate** — some calls will appear to succeed but leave no verified receipt, exposing the detection mechanism.

---

## Ghost Action Examples (from live demo data)

| Agent | Tool | Claimed | Reality |
|-------|------|---------|---------|
| SupportBot-v2 | `send_email` | "Your refund is confirmed" | Email never sent — ghost |
| DataPipeline-prod | `update_database` | "839 records upserted" | DB never touched — ghost |
| ScheduleBot-alpha | `book_meeting` | "Q3 Planning scheduled" | Calendar untouched — ghost |

These are the exact failure modes AgentReceipt catches.

---

## How Receipt Hashes Work

**Request hash:** `SHA256({ tool: toolName, args, ts: claimedAt })`
→ Uniquely identifies *what* the agent claimed to call, *with what arguments*, *when*

**Response hash:** `SHA256(actualResult)`
→ Proves the result returned by the real tool — any discrepancy between what the agent reports and what the tool actually returned is detectable

If a ghost action occurs, the `response_hash` column stays `null`. No hash = no execution.

---

## Related Tools

| Tool | What it does |
|------|-------------|
| [AgentGate](https://github.com/RLASAF12/agent-gate) | Requires human approval before tool execution |
| [AgentSentinel](https://github.com/RLASAF12/agent-sentinel) | Guards against prompt injection in MCP tool responses |
| [AgentBaton](https://github.com/RLASAF12/agent-baton) | Tracks state handoffs between agent steps |

---

## Built by

[Harel Asaf](https://harelasaf.com) · AI Operator at Elementor · Building the infrastructure layer for trustworthy AI agents.
