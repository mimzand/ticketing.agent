import { describe, expect, it } from 'vitest';
import {
  AgentStateFileSchema,
  encodeFrame,
  FrameDecoder,
  parseHello,
  parseRequest,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type Envelope,
} from './index.js';

const TOKEN = 'a'.repeat(43);
// ASCII helpers: this package compiles without DOM or Node typings.
const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const bytesOf = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const ping: Envelope = { id: 'r1', kind: 'req', method: 'system.ping', payload: {} };

describe('framing', () => {
  it('writes a 4-byte big-endian length and UTF-8 JSON', () => {
    const frame = encodeFrame(ping);
    const length = new DataView(frame.buffer).getUint32(0, false);
    expect(length).toBe(frame.byteLength - 4);
    expect(JSON.parse(ascii(frame.subarray(4)))).toEqual(ping);
  });

  it('decodes frames split across and joined within chunks', () => {
    const a = encodeFrame(ping);
    const b = encodeFrame({ ...ping, id: 'r2' });
    const stream = new Uint8Array([...a, ...b]);
    const decoder = new FrameDecoder();
    const results = [
      ...decoder.push(stream.subarray(0, 3)),
      ...decoder.push(stream.subarray(3, a.byteLength + 5)),
      ...decoder.push(stream.subarray(a.byteLength + 5)),
    ];
    expect(results.map((r) => (r.ok ? r.value.id : r.error.code))).toEqual(['r1', 'r2']);
  });

  it('fails on an oversized header and then ignores input', () => {
    const decoder = new FrameDecoder(16);
    const [result] = decoder.push(encodeFrame(ping));
    expect(result?.ok).toBe(false);
    expect(decoder.failed).toBe(true);
    expect(decoder.push(encodeFrame(ping))).toEqual([]);
  });

  it('fails on a body that is not JSON', () => {
    const body = bytesOf('not json');
    const frame = new Uint8Array(4 + body.byteLength);
    new DataView(frame.buffer).setUint32(0, body.byteLength, false);
    frame.set(body, 4);
    const [result] = new FrameDecoder().push(frame);
    expect(result).toMatchObject({ ok: false, error: { code: 'bad_frame' } });
  });
});

describe('handshake', () => {
  const hello = (payload: unknown): Envelope => ({
    id: 'h1',
    kind: 'req',
    method: 'system.hello',
    payload,
  });
  const valid = {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    token: TOKEN,
    client: { kind: 'test', version: '1' },
  };

  it('uses the ticket-agent protocol, version 1', () => {
    expect(PROTOCOL_NAME).toBe('ticket-agent');
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('accepts a well-formed hello', () => {
    expect(parseHello(hello(valid)).ok).toBe(true);
  });

  it('rejects any other first message', () => {
    expect(parseHello(ping)).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });

  it('rejects a wrong protocol version', () => {
    expect(parseHello(hello({ ...valid, version: 2 }))).toMatchObject({
      ok: false,
      error: { code: 'unsupported_version' },
    });
  });

  it('rejects a short token before it is compared', () => {
    expect(parseHello(hello({ ...valid, token: 'short' }))).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
  });
});

describe('state file', () => {
  const state = {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    host: '127.0.0.1',
    port: 50_000,
    token: TOKEN,
    pid: 1234,
    startedAt: new Date().toISOString(),
  };

  it('accepts 127.0.0.1', () => {
    expect(AgentStateFileSchema.safeParse(state).success).toBe(true);
  });

  it.each(['localhost', '0.0.0.0', '::1', '[::1]', '127.0.0.2', '192.168.1.10', ''])(
    'rejects host %j',
    (host) => {
      expect(AgentStateFileSchema.safeParse({ ...state, host }).success).toBe(false);
    },
  );
});

describe('method registry', () => {
  it('validates params and rejects unknown methods', () => {
    expect(parseRequest({ ...ping, kind: 'req' }).ok).toBe(true);
    expect(parseRequest({ id: 'x', kind: 'req', method: 'system.ping', payload: { a: 1 } })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect(parseRequest({ id: 'x', kind: 'req', method: 'tickets.list', payload: {} }).ok).toBe(true);
    expect(parseRequest({ id: 'x', kind: 'req', method: 'research.start', payload: {} })).toMatchObject({
      ok: false,
      error: { code: 'unknown_method' },
    });
  });
});
