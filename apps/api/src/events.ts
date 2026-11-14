import type { ServerResponse } from 'node:http';
import type { Database } from '@asc/database';
import { readEventsAfter, readSnapshot } from '@asc/jobs';

interface Client {
  response: ServerResponse;
  /** Id of the newest event this client has been sent. */
  cursor: number;
}

export interface EventHubOptions {
  /** How often the event log is checked for new events while clients are connected. */
  pollIntervalMs?: number;
  /** How often a comment line is sent to keep idle connections open. */
  heartbeatIntervalMs?: number;
  /** Reconnection delay suggested to the browser. */
  retryMs?: number;
}

/**
 * Server-Sent Events fan-out.
 *
 * The worker is a separate process, so the API cannot be told about changes
 * directly: it tails the persistent event log (`job_events`, indexed by id)
 * and forwards new rows to every connected browser. Browsers hold one
 * long-lived connection and never poll. While nobody is connected, nothing
 * is read.
 *
 * Nothing here is state: a client that connects or reconnects first receives
 * a snapshot of the current jobs and unread notifications, then events after
 * the snapshot's event id. Killing the API or every browser loses nothing.
 */
export class EventHub {
  private readonly clients = new Set<Client>();
  private pollTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private closed = false;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly retryMs: number;

  constructor(
    private readonly db: Database,
    options: EventHubOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 300;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.retryMs = options.retryMs ?? 2000;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Attach a browser. Sends the snapshot, then streams events until the connection closes. */
  async connect(response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tell reverse proxies (nginx) not to buffer the stream.
      'x-accel-buffering': 'no',
    });
    response.write(`retry: ${this.retryMs}\n\n`);

    const snapshot = await readSnapshot(this.db);
    if (response.destroyed || this.closed) return;
    this.send(response, snapshot.lastEventId, 'snapshot', JSON.stringify(snapshot));

    const client: Client = { response, cursor: snapshot.lastEventId };
    this.clients.add(client);
    response.on('close', () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this.stopTimers();
    });
    this.startTimers();
  }

  /** Close every connection (server shutdown). */
  close(): void {
    this.closed = true;
    this.stopTimers();
    for (const client of this.clients) client.response.end();
    this.clients.clear();
  }

  private send(response: ServerResponse, id: number, event: string, data: string): void {
    response.write(`id: ${id}\nevent: ${event}\ndata: ${data}\n\n`);
  }

  private startTimers(): void {
    this.pollTimer ??= setInterval(() => void this.poll(), this.pollIntervalMs);
    this.heartbeatTimer ??= setInterval(() => {
      for (const client of this.clients) client.response.write(': keep-alive\n\n');
    }, this.heartbeatIntervalMs);
  }

  private stopTimers(): void {
    clearInterval(this.pollTimer);
    clearInterval(this.heartbeatTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
  }

  /** Forward events newer than each client's cursor. One query serves all clients. */
  private async poll(): Promise<void> {
    if (this.polling || this.clients.size === 0) return;
    this.polling = true;
    try {
      const oldest = Math.min(...[...this.clients].map((c) => c.cursor));
      const events = await readEventsAfter(this.db, oldest);
      for (const event of events) {
        for (const client of this.clients) {
          if (event.id <= client.cursor) continue;
          this.send(client.response, event.id, event.type, event.payload);
          client.cursor = event.id;
        }
      }
    } catch {
      // The database was briefly unavailable; the next tick continues from the same cursors.
    } finally {
      this.polling = false;
    }
  }
}
