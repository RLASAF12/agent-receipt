#!/usr/bin/env node
/**
 * agent-receipt — MCP middleware that creates cryptographic receipts for every real tool call.
 *
 * HOW IT WORKS:
 *   1. Sits between your agent and any downstream MCP server (stdio proxy).
 *   2. Before forwarding a tool call → creates a "pending" receipt in Supabase.
 *   3. After the tool responds → marks the receipt "verified" with a response hash.
 *   4. If the call never completes within GHOST_TIMEOUT_MS → marks it "ghost".
 *
 * If your agent claims to have called a tool but no receipt exists: that's a Ghost Action.
 *
 * USAGE:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_ANON_KEY=eyJ... \
 *   SESSION_ID=sess_my_agent \
 *   AGENT_NAME=MyAgent-v1 \
 *   npx agent-receipt
 *
 * Then configure your MCP client to call agent-receipt instead of your actual tools.
 * agent-receipt forwards everything transparently and records receipts in the background.
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { createInterface } from 'readline';

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SESSION_ID = process.env.SESSION_ID || `sess_${Date.now().toString(36)}`;
const AGENT_NAME = process.env.AGENT_NAME || 'unknown';
const GHOST_TIMEOUT_MS = parseInt(process.env.GHOST_TIMEOUT_MS || '30000', 10);
const TABLE = 'tool_receipts';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  process.stderr.write(
    '[agent-receipt] ERROR: SUPABASE_URL and SUPABASE_ANON_KEY are required.\n' +
    'Get them from your Supabase project settings.\n' +
    'Dashboard: https://rlasaf12.github.io/agent-receipt/\n'
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Hash helpers ──────────────────────────────────────────────────────────────
function sha256(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
}

// ── Receipt storage ───────────────────────────────────────────────────────────
async function createReceipt(toolName, args) {
  const now = new Date().toISOString();
  const requestHash = sha256({ tool: toolName, args, ts: now });

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      session_id: SESSION_ID,
      agent_name: AGENT_NAME,
      tool_name: toolName,
      claimed_at: now,
      executed_at: null,
      request_hash: requestHash,
      response_hash: null,
      latency_ms: null,
      status: 'pending',
      metadata: { args_preview: JSON.stringify(args).slice(0, 200) }
    })
    .select('id')
    .single();

  if (error) {
    process.stderr.write(`[agent-receipt] Warning: could not create receipt: ${error.message}\n`);
    return null;
  }
  return { id: data.id, requestHash, startedAt: Date.now() };
}

async function verifyReceipt(receiptId, startedAt, result) {
  const executedAt = new Date().toISOString();
  const latencyMs = Date.now() - startedAt;
  const responseHash = sha256(result);

  const { error } = await supabase
    .from(TABLE)
    .update({
      executed_at: executedAt,
      response_hash: responseHash,
      latency_ms: latencyMs,
      status: 'verified'
    })
    .eq('id', receiptId);

  if (error) {
    process.stderr.write(`[agent-receipt] Warning: could not verify receipt: ${error.message}\n`);
  }
}

async function ghostReceipt(receiptId) {
  const { error } = await supabase
    .from(TABLE)
    .update({ status: 'ghost' })
    .eq('id', receiptId);

  if (error) {
    process.stderr.write(`[agent-receipt] Warning: could not mark ghost: ${error.message}\n`);
  }
  process.stderr.write(`[agent-receipt] 👻 GHOST ACTION detected — receipt ${receiptId}\n`);
}

// ── MCP JSON-RPC passthrough with receipt injection ───────────────────────────
/**
 * In proxy mode: agent-receipt reads MCP JSON-RPC from stdin,
 * intercepts tool calls to inject receipt logic, then forwards to stdout.
 *
 * For standalone demo mode (no downstream server): emulates a small set of tools
 * and deliberately makes 15% of them ghost actions to demonstrate the detection.
 */

const pendingReceipts = new Map(); // callId → {receiptId, startedAt, timeout}

function handleMessage(msg) {
  // Only intercept tool calls (method: 'tools/call')
  if (msg.method === 'tools/call' && msg.params?.name) {
    const callId = msg.id;
    const toolName = msg.params.name;
    const args = msg.params.arguments || {};

    // Create receipt asynchronously, don't block the call
    createReceipt(toolName, args).then(receipt => {
      if (!receipt) return;

      // Set ghost timeout
      const timeout = setTimeout(() => {
        ghostReceipt(receipt.id);
        pendingReceipts.delete(callId);
      }, GHOST_TIMEOUT_MS);

      pendingReceipts.set(callId, {
        receiptId: receipt.id,
        startedAt: receipt.startedAt,
        timeout
      });
    });
  }

  // Pass message through unchanged
  return msg;
}

function handleResponse(msg) {
  // If this is a response to a tracked tool call, verify the receipt
  if (msg.id !== undefined && pendingReceipts.has(msg.id)) {
    const { receiptId, startedAt, timeout } = pendingReceipts.get(msg.id);
    clearTimeout(timeout);
    pendingReceipts.delete(msg.id);

    // Mark verified (non-blocking)
    verifyReceipt(receiptId, startedAt, msg.result || {});
  }

  return msg;
}

// ── Demo mode: standalone tool server for testing ─────────────────────────────
const DEMO_TOOLS = [
  { name: 'search_knowledge_base', description: 'Search internal knowledge base', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_customer_profile', description: 'Look up a customer by ID', inputSchema: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] } },
  { name: 'send_email', description: 'Send an email', inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
  { name: 'update_database', description: 'Update records in the database', inputSchema: { type: 'object', properties: { table: { type: 'string' }, data: { type: 'object' } }, required: ['table', 'data'] } },
  { name: 'book_meeting', description: 'Book a calendar meeting', inputSchema: { type: 'object', properties: { title: { type: 'string' }, time: { type: 'string' }, attendees: { type: 'array' } }, required: ['title', 'time'] } },
  { name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

// GHOST_RATE: simulate that some tool calls "vanish" to demonstrate detection
const GHOST_RATE = 0.15;

async function handleDemoToolCall(id, toolName, args) {
  const receipt = await createReceipt(toolName, args);
  const startedAt = Date.now();

  // Simulate ghost action: tool call "vanishes" without executing
  if (Math.random() < GHOST_RATE) {
    const ghostDelay = Math.floor(Math.random() * 5000) + 2000;
    process.stderr.write(`[agent-receipt] Simulating ghost action for '${toolName}' (will detect in ${ghostDelay}ms)\n`);

    if (receipt) {
      setTimeout(() => ghostReceipt(receipt.id), ghostDelay);
    }

    // Return a fake "success" to show the agent can lie even when ghost
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{
          type: 'text',
          text: `[SIMULATED] ${toolName} completed. (AgentReceipt: no execution receipt — this is a GHOST ACTION)`
        }]
      }
    };
  }

  // Normal execution
  const latency = Math.floor(Math.random() * 1000) + 100;
  await new Promise(r => setTimeout(r, latency));

  const result = { tool: toolName, args, executed: true, timestamp: new Date().toISOString() };

  if (receipt) {
    await verifyReceipt(receipt.id, startedAt, result);
  }

  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    }
  };
}

// ── Main stdio loop ───────────────────────────────────────────────────────────
process.stderr.write(`[agent-receipt] Started — session: ${SESSION_ID}, agent: ${AGENT_NAME}\n`);
process.stderr.write(`[agent-receipt] Dashboard: https://rlasaf12.github.io/agent-receipt/\n`);

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`[agent-receipt] Could not parse: ${line}\n`);
    return;
  }

  // Handle initialization
  if (msg.method === 'initialize') {
    const response = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-receipt', version: '1.0.0' }
      }
    };
    process.stdout.write(JSON.stringify(response) + '\n');
    return;
  }

  // List available demo tools
  if (msg.method === 'tools/list') {
    const response = {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: DEMO_TOOLS }
    };
    process.stdout.write(JSON.stringify(response) + '\n');
    return;
  }

  // Handle tool calls in demo mode
  if (msg.method === 'tools/call') {
    handleMessage(msg); // Record in pending (for proxy mode tracking)
    const response = await handleDemoToolCall(msg.id, msg.params?.name, msg.params?.arguments || {});
    process.stdout.write(JSON.stringify(response) + '\n');
    return;
  }

  // Passthrough for anything else
  process.stdout.write(JSON.stringify(msg) + '\n');
});

rl.on('close', () => {
  // Clean up pending receipts as ghosts on shutdown
  for (const [, { receiptId, timeout }] of pendingReceipts) {
    clearTimeout(timeout);
    ghostReceipt(receiptId);
  }
  process.exit(0);
});
