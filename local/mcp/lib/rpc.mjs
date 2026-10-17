// MCP transport: JSON-RPC 2.0 over stdio, one message per line, no dependencies.
// stdout carries protocol messages only. The method handlers are in server.mjs.

import { createInterface } from 'node:readline';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];

// JSON-RPC error codes. Tools use them only for bad arguments (INVALID_PARAMS); any
// other tool failure is a normal result with isError set, so the agent sees why.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export class StdioServer {
  // Methods in `serialize` run one at a time. Others answer at once, so a ping is
  // not stuck behind a long analysis.
  constructor({ handlers, onLog = () => {}, serialize = [], onClose = () => {} }) {
    this.handlers = handlers;
    this.onLog = onLog;
    this.serialize = new Set(serialize);
    this.onClose = onClose;
    this.queue = Promise.resolve();
  }

  send(msg) {
    // Writes even after stdin has closed, so a request in flight still gets its
    // answer. A write that throws (broken pipe) is logged, not rethrown.
    try {
      process.stdout.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      this.onLog(`could not write to stdout: ${e.message}`);
    }
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async handle(msg) {
    // A message without an id (or with a null id) is a notification: it gets no reply,
    // not even on error.
    const isNotification = msg.id === undefined || msg.id === null;
    const handler = this.handlers[msg.method];

    if (!handler) {
      if (isNotification) return;             // ignored, as the spec requires
      this.send({
        jsonrpc: '2.0', id: msg.id,
        error: { code: METHOD_NOT_FOUND, message: `Unknown method "${msg.method}".` }
      });
      return;
    }

    try {
      const result = await handler(msg.params || {}, msg);
      if (!isNotification) this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? {} });
    } catch (err) {
      if (isNotification) { this.onLog(`notification ${msg.method} failed: ${err.message}`); return; }
      const code = err instanceof RpcError ? err.code : INTERNAL_ERROR;
      const error = { code, message: err.message || String(err) };
      if (err instanceof RpcError && err.data !== undefined) error.data = err.data;
      this.send({ jsonrpc: '2.0', id: msg.id, error });
    }
  }

  start(input = process.stdin) {
    const rl = createInterface({ input, crlfDelay: Infinity });

    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        this.send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Invalid JSON.' } });
        return;
      }
      if (Array.isArray(msg)) {
        // the 2025-06-18 spec has no batches
        this.send({
          jsonrpc: '2.0', id: null,
          error: { code: INVALID_REQUEST, message: 'Batched requests are not supported.' }
        });
        return;
      }
      if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        this.send({
          jsonrpc: '2.0', id: msg?.id ?? null,
          error: { code: INVALID_REQUEST, message: 'Not a JSON-RPC 2.0 request.' }
        });
        return;
      }
      if (this.serialize.has(msg.method)) {
        // queued: two analyses at once could run out of memory
        this.queue = this.queue.then(() => this.handle(msg));
      } else {
        this.handle(msg);
      }
    });

    // stdin closing means shut down, once the queued calls have finished.
    rl.on('close', () => {
      this.queue.then(() => this.onClose(), () => this.onClose());
    });
    return this;
  }
}
