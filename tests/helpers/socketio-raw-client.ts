import WebSocket from 'ws';

/**
 * Minimal Engine.IO v4 / socket.io v5 client over `ws`.
 *
 * `socket.io-client` is not a dependency of this project and the shipped
 * `client-dist` bundles are browser ESM, so a route-level test that needs two
 * genuinely separate authenticated sockets speaks the wire protocol directly.
 * That is enough for delivery-scoping assertions: connect, name the namespace,
 * answer pings, and record inbound events.
 *
 * Wire shapes used here:
 *   `0{...}`            engine.io OPEN
 *   `2` / `3`           engine.io PING / PONG
 *   `40` / `40{...}`    socket.io CONNECT to the default namespace / ACK
 *   `42["name",data]`   socket.io EVENT
 */

export interface RawSocketIoEvent {
  name: string;
  payload: unknown;
}

export interface RawSocketIoClient {
  readonly events: readonly RawSocketIoEvent[];
  /** Every payload received for `name`, in arrival order. */
  payloads(name: string): unknown[];
  received(name: string): boolean;
  waitFor(name: string, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Connect and resolve once the server has acknowledged the namespace, so a
 * caller that immediately triggers a server-side emit cannot race the join.
 */
export function connectRawSocketIo(
  port: number,
  cookie: string,
  timeoutMs = 4_000,
): Promise<RawSocketIoClient> {
  return new Promise((resolvePromise, rejectPromise) => {
    const events: RawSocketIoEvent[] = [];
    const waiters: Array<{ name: string; resolve(payload: unknown): void }> = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`,
      { headers: { Cookie: cookie } },
    );

    const settleTimer = setTimeout(() => {
      socket.close();
      rejectPromise(new Error('timed out connecting the raw socket.io client'));
    }, timeoutMs);

    const client: RawSocketIoClient = {
      events,
      payloads(name) {
        return events.filter((event) => event.name === name).map((event) => event.payload);
      },
      received(name) {
        return events.some((event) => event.name === name);
      },
      waitFor(name, waitMs = 3_000) {
        const existing = events.find((event) => event.name === name);
        if (existing) return Promise.resolve(existing.payload);
        return new Promise((resolveEvent, rejectEvent) => {
          const timer = setTimeout(
            () => rejectEvent(new Error(`timed out waiting for socket.io event "${name}"`)),
            waitMs,
          );
          waiters.push({
            name,
            resolve: (payload) => {
              clearTimeout(timer);
              resolveEvent(payload);
            },
          });
        });
      },
      close() {
        clearTimeout(settleTimer);
        return new Promise((resolveClose) => {
          if (socket.readyState === WebSocket.CLOSED) return resolveClose();
          socket.once('close', () => resolveClose());
          socket.terminate();
        });
      },
    };

    socket.on('error', (err: Error) => {
      clearTimeout(settleTimer);
      rejectPromise(err);
    });

    socket.on('message', (data: unknown) => {
      const frame = String(data);
      if (frame.startsWith('0{')) {
        socket.send('40');
        return;
      }
      if (frame === '2') {
        socket.send('3');
        return;
      }
      if (frame.startsWith('40')) {
        clearTimeout(settleTimer);
        resolvePromise(client);
        return;
      }
      if (!frame.startsWith('42')) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(frame.slice(2));
      } catch {
        return;
      }
      if (!Array.isArray(decoded) || typeof decoded[0] !== 'string') return;
      const event: RawSocketIoEvent = { name: decoded[0], payload: decoded[1] };
      events.push(event);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].name === event.name) {
          waiters[i].resolve(event.payload);
          waiters.splice(i, 1);
        }
      }
    });
  });
}

/**
 * Give the server a beat to deliver anything it was going to deliver, so a
 * "this socket must NOT have received it" assertion is not just fast.
 */
export function settle(ms = 250): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
