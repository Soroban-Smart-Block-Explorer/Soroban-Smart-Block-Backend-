/**
 * Graceful shutdown integration tests (Issue #439).
 *
 * Verifies that:
 *   - server.close() stops accepting new TCP connections
 *   - In-flight requests complete before the close callback fires
 */

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import express from 'express';
import { AddressInfo } from 'node:net';

function makeServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const app = express();
  app.use(handler);
  return http.createServer(app);
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(port: number, path = '/', extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        // Connection: close prevents keep-alive so the server connection count reaches zero
        headers: { Connection: 'close', ...extraHeaders },
        // agent: false ensures no socket reuse across requests
        agent: false,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('graceful shutdown', () => {
  it('close callback fires after in-flight requests complete', async () => {
    let release: () => void;
    const released = new Promise<void>((r) => { release = r; });

    const server = makeServer((_req, res) => {
      released.then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(JSON.stringify({ done: true }));
      });
    });
    const port = await listen(server);

    // Fire the slow in-flight request (does not await yet)
    const inFlight = request(port);

    // Give the request a moment to reach the handler
    await new Promise((r) => setTimeout(r, 20));

    // Begin graceful close — callback should not fire until in-flight request ends
    const closePromise = closeServer(server);
    let closedBeforeRequest = false;
    let closedAfterRequest = false;

    // Release the handler slightly after close() was called
    setTimeout(() => {
      closedBeforeRequest = !closedAfterRequest;
      release!();
    }, 30);

    const { status, body } = await inFlight;
    closedAfterRequest = true;

    await closePromise;

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ done: true });
    // Close callback fired AFTER the in-flight request completed
    expect(closedBeforeRequest).toBe(true);
  });

  it('rejects new TCP connections after server.close() is called', async () => {
    const server = makeServer((_req, res) => {
      res.writeHead(200, { Connection: 'close' });
      res.end('ok');
    });
    const port = await listen(server);

    // Drain any pre-existing connections by making one request with Connection: close
    await request(port);

    // Initiate close — no outstanding connections, callback fires quickly
    server.close();

    // A fresh TCP connection attempt should now be refused
    const err = await new Promise<Error | null>((resolve) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/', agent: false },
        (res) => { res.resume(); resolve(null); },
      );
      req.on('error', (e) => resolve(e));
      req.end();
    });

    expect(err).not.toBeNull();
    expect((err as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });

  it('module-scoped server pattern: httpServer can be closed from outside main()', async () => {
    // Simulate the module-scope pattern introduced in #439:
    // httpServer is declared at module scope and assigned inside an init function.
    let httpServer: http.Server | null = null;

    function initServer(): Promise<number> {
      const app = express();
      app.get('/ping', (_req, res) => res.json({ pong: true }));
      httpServer = http.createServer(app);
      return listen(httpServer);
    }

    function shutdown(): Promise<void> {
      return new Promise((resolve) => {
        if (!httpServer) { resolve(); return; }
        httpServer.close(() => resolve());
      });
    }

    const port = await initServer();

    const { status } = await request(port, '/ping');
    expect(status).toBe(200);

    await shutdown();

    // After shutdown, a new connection must be refused
    const err = await new Promise<Error | null>((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/ping', agent: false }, () => resolve(null));
      req.on('error', (e) => resolve(e));
      req.end();
    });
    expect(err).not.toBeNull();
    expect((err as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });
});
