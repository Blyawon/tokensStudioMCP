/**
 * Local WebSocket bridge between the MCP server and the Figma companion
 * plugin. The MCP is the WS server (long-lived, started on demand); the
 * plugin connects in as the WS client because Figma's plugin sandbox can
 * only initiate outbound connections.
 *
 * Only ONE plugin connection is accepted at a time — extras are closed
 * with a clear reason. This avoids the ambiguity of "which Figma file am
 * I writing to?" when the user has two windows open.
 */

import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  AnyFrame,
  DEFAULT_BRIDGE_PORT,
  type HelloFrame,
  type Method,
  type RequestFrame,
  type ResponseFrame,
  type TargetShape,
  SCHEMAS,
} from "./protocol.js";

/**
 * Per-request context passed to server handlers. `progress` emits a
 * ProgressFrame correlated to the original request id — the plugin UI's
 * uiRequest hook fires `onProgress` callbacks for these without resolving
 * its pending promise. Long-running handlers should call this to keep the
 * UI from looking frozen.
 */
export interface ServerHandlerContext {
  progress(info: { current: number; total: number; message?: string }): void;
}

/**
 * Server-side handler for plugin-initiated requests. Each registered
 * handler gets the parsed params (already validated against the method's
 * SCHEMAS entry) and returns a result that's sent back as a ResponseFrame.
 */
export type ServerHandler = (
  params: unknown,
  ctx: ServerHandlerContext
) => Promise<unknown> | unknown;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: Method;
}

export interface BridgeStatus {
  running: boolean;
  port: number | null;
  connected: boolean;
  fileKey: string | null;
  fileName: string | null;
  pluginVersion: string | null;
  /** ISO timestamp of last successful request — useful for diagnostics. */
  lastActivityAt: string | null;
  pinnedTarget: TargetShape | null;
}

class Bridge {
  private wss: WebSocketServer | null = null;
  private port: number = DEFAULT_BRIDGE_PORT;
  private socket: WebSocket | null = null;
  private hello: HelloFrame | null = null;
  private pending = new Map<string, PendingRequest>();
  private handlers = new Map<Method, ServerHandler>();
  private lastActivityAt: Date | null = null;
  private _pinnedTarget: TargetShape | null = null;

  get pinnedTarget(): TargetShape | null {
    return this._pinnedTarget;
  }

  set pinnedTarget(t: TargetShape | null) {
    this._pinnedTarget = t;
  }

  /**
   * Register a handler for plugin-initiated requests. The plugin's UI
   * iframe (e.g. the Settings tab's Test button) sends a request frame;
   * the matching handler runs server-side and the result goes back as a
   * response frame. Registration is idempotent — last call wins.
   */
  register(method: Method, handler: ServerHandler): void {
    this.handlers.set(method, handler);
  }

  /**
   * Idempotent — calling `start()` twice is fine. Returns the same promise
   * the first call returned (in case both calls happen before binding
   * finishes).
   */
  private startPromise: Promise<void> | null = null;
  start(port = DEFAULT_BRIDGE_PORT): Promise<void> {
    if (this.wss) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.port = port;
    this.startPromise = new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port });
      wss.once("listening", () => {
        this.wss = wss;
        resolve();
      });
      wss.once("error", (err) => {
        this.startPromise = null;
        reject(err);
      });
      wss.on("connection", (ws) => this.handleConnection(ws));
    });
    return this.startPromise;
  }

  private handleConnection(ws: WebSocket): void {
    if (this.socket && this.socket.readyState === ws.OPEN) {
      // Reject extra connections rather than silently switching, so the
      // user notices their second Figma window can't both drive writes.
      ws.close(1008, "Another Figma plugin instance is already connected.");
      return;
    }
    this.socket = ws;
    this.hello = null;

    ws.on("message", (data) => this.handleMessage(data.toString("utf8")));
    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = null;
        this.hello = null;
        this._pinnedTarget = null;
        // Reject all in-flight requests — the plugin is gone.
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("Plugin disconnected before the request completed."));
          this.pending.delete(id);
        }
      }
    });
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Drop garbage — the plugin always sends JSON.
    }
    const frame = AnyFrame.safeParse(parsed);
    if (!frame.success) return;
    const f = frame.data;

    if (f.kind === "hello") {
      this.hello = f;
      return;
    }
    if (f.kind === "response") {
      this.resolvePending(f);
      return;
    }
    if (f.kind === "request") {
      this.handleIncomingRequest(f).catch(() => {
        // handleIncomingRequest is responsible for sending an error response
        // — if it threw before that, we've already lost the request id, so
        // there's nothing useful to do here.
      });
      return;
    }
  }

  /**
   * Plugin sent us a request — validate, dispatch to the registered
   * handler, send the response. Bad params / unknown method / handler
   * exceptions all become structured error response frames so the UI can
   * show them.
   */
  private async handleIncomingRequest(req: RequestFrame): Promise<void> {
    const handler = this.handlers.get(req.method);
    if (!handler) {
      this.sendResponse({
        kind: "response",
        id: req.id,
        error: { message: `No server handler for '${req.method}'.` },
      });
      return;
    }
    const schema = SCHEMAS[req.method].params;
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      this.sendResponse({
        kind: "response",
        id: req.id,
        error: {
          message: `Bad params for '${req.method}': ${parsed.error.message}`,
        },
      });
      return;
    }
    const ctx: ServerHandlerContext = {
      progress: (info) =>
        this.sendFrame({
          kind: "progress",
          id: req.id,
          current: info.current,
          total: info.total,
          message: info.message,
        }),
    };
    try {
      const result = await handler(parsed.data, ctx);
      this.lastActivityAt = new Date();
      this.sendResponse({ kind: "response", id: req.id, result });
    } catch (err) {
      this.sendResponse({
        kind: "response",
        id: req.id,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private sendResponse(frame: ResponseFrame): void {
    this.sendFrame(frame);
  }

  private sendFrame(frame: ResponseFrame | { kind: "progress"; id: string; current: number; total: number; message?: string }): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  private resolvePending(f: ResponseFrame): void {
    const p = this.pending.get(f.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(f.id);
    if (f.error) {
      p.reject(new Error(f.error.message));
      return;
    }
    const schema = SCHEMAS[p.method].result;
    const validated = schema.safeParse(f.result);
    if (!validated.success) {
      p.reject(
        new Error(
          `Bridge response for ${p.method} failed schema validation: ${validated.error.message}`
        )
      );
      return;
    }
    this.lastActivityAt = new Date();
    p.resolve(validated.data);
  }

  /**
   * Send a request to the connected plugin. Throws synchronously if no
   * plugin is connected so callers can give a clear error to the user
   * before doing any other work.
   */
  request<T = unknown>(
    method: Method,
    params: unknown,
    opts: { timeoutMs?: number } = {}
  ): Promise<T> {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      return Promise.reject(
        new Error(
          "Figma plugin is not connected. Open the 'Tokens Studio MCP Bridge' " +
            "plugin in Figma (Plugins → Development) and make sure its UI shows " +
            "'Connected', then retry."
        )
      );
    }

    const id = randomUUID();
    const frame: RequestFrame = { kind: "request", id, method, params };
    const timeoutMs = opts.timeoutMs ?? 3_600_000;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge request '${method}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      });
      this.socket!.send(JSON.stringify(frame));
    });
  }

  status(): BridgeStatus {
    return {
      running: this.wss != null,
      port: this.wss ? this.port : null,
      connected: this.socket != null && this.socket.readyState === this.socket.OPEN,
      fileKey: this.hello?.fileKey ?? null,
      fileName: this.hello?.fileName ?? null,
      pluginVersion: this.hello?.pluginVersion ?? null,
      lastActivityAt: this.lastActivityAt?.toISOString() ?? null,
      pinnedTarget: this._pinnedTarget,
    };
  }

  isConnected(): boolean {
    return this.socket != null && this.socket.readyState === this.socket.OPEN;
  }

  /** Test/teardown hook — production callers don't need this. */
  async stop(): Promise<void> {
    const wss = this.wss;
    if (!wss) return;
    this.wss = null;
    this.startPromise = null;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

let SINGLETON: Bridge | null = null;
export function getBridge(): Bridge {
  if (!SINGLETON) SINGLETON = new Bridge();
  return SINGLETON;
}
