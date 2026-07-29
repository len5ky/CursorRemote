import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { startVoiceRelay, type VoiceRelayHarness } from './helpers/voice-relay-harness.js';
import {
  connectRawSocketIo,
  settle,
  type RawSocketIoClient,
} from './helpers/socketio-raw-client.js';

/**
 * A hangup is private to the account whose call ended.
 *
 * `io.emit` broadcasts to every connected socket, so a second logged-in
 * operator saw the first operator's session id, epoch, termination reason and
 * provider-cleanup state — and a client that keys its UI off `voice:hangup`
 * would tear down a call it does not own. Delivery is therefore scoped to the
 * owning account's sockets.
 */

const harnesses: VoiceRelayHarness[] = [];
const clients: RawSocketIoClient[] = [];

// Registered up front so a failing assertion still releases every socket; a
// leaked ws connection keeps the test runner alive past the suite.
after(async () => {
  for (const client of clients) await client.close();
  for (const harness of harnesses) await harness.close();
});

async function track(pending: Promise<VoiceRelayHarness>): Promise<VoiceRelayHarness> {
  const resolved = await pending;
  harnesses.push(resolved);
  return resolved;
}

async function connect(port: number, cookie: string): Promise<RawSocketIoClient> {
  const client = await connectRawSocketIo(port, cookie);
  clients.push(client);
  return client;
}

interface MintedSession {
  sessionId: string;
  epoch: number;
  attachToken: string;
}

async function mintAndAttach(
  harness: VoiceRelayHarness,
  cookie: string,
  callId: string,
): Promise<MintedSession> {
  const minted = await harness.raw({
    method: 'POST',
    path: '/api/voice/token',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(minted.status, 200, `token mint failed: ${minted.body}`);
  const session = JSON.parse(minted.body) as MintedSession;

  const attached = await harness.raw({
    method: 'POST',
    path: '/api/voice/call',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callId,
      sessionId: session.sessionId,
      epoch: session.epoch,
      attachToken: session.attachToken,
    }),
  });
  assert.equal(attached.status, 200, `call attach failed: ${attached.body}`);
  return session;
}

describe('voice hangup delivery scope', () => {
  it('delivers a hangup to the owning account only, never to another logged-in operator', async () => {
    const harness = await track(startVoiceRelay({ password: 'scope-password' }));
    // Two logins are two distinct persisted sessions: two separate accounts as
    // far as voice ownership is concerned.
    const cookieOwner = await harness.login();
    const cookieBystander = await harness.login();
    assert.notEqual(cookieOwner, cookieBystander, 'each login must mint a distinct session');

    const owner = await connect(harness.port, cookieOwner);
    const bystander = await connect(harness.port, cookieBystander);

    const session = await mintAndAttach(harness, cookieOwner, 'call-scope-1');

    const terminated = await harness.raw({
      method: 'POST',
      path: '/api/voice/terminate',
      headers: { Cookie: cookieOwner, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        epoch: session.epoch,
        reason: 'client_request',
      }),
    });
    assert.equal(terminated.status, 200, `terminate failed: ${terminated.body}`);

    const delivered = await owner.waitFor('voice:hangup');
    assert.equal((delivered as { sessionId: string }).sessionId, session.sessionId);

    await settle();
    assert.equal(
      bystander.received('voice:hangup'),
      false,
      "a second logged-in operator must never receive another account's hangup",
    );
  });

  it('still reaches every socket the owning account has open', async () => {
    const harness = await track(startVoiceRelay({ password: 'scope-password' }));
    const cookieOwner = await harness.login();

    // Same credential, two tabs.
    const tabOne = await connect(harness.port, cookieOwner);
    const tabTwo = await connect(harness.port, cookieOwner);

    const session = await mintAndAttach(harness, cookieOwner, 'call-scope-2');
    await harness.raw({
      method: 'POST',
      path: '/api/voice/terminate',
      headers: { Cookie: cookieOwner, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        epoch: session.epoch,
        reason: 'client_request',
      }),
    });

    await tabOne.waitFor('voice:hangup');
    await tabTwo.waitFor('voice:hangup');
  });
});
