import { err, type Result } from '@ticket/shared';
import {
  decodeEnvelope,
  encodeEnvelope,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  type Envelope,
} from './envelope.js';
import { protocolError, type ProtocolError } from './errors.js';

// Web-standard globals (Node, Electron, browsers). Declared here because this
// package compiles without DOM or Node typings.
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new (
  label: string,
  options: { fatal: boolean },
) => { decode(input: Uint8Array): string };

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** One envelope as a frame: 4-byte big-endian length + UTF-8 JSON. */
export function encodeFrame(envelope: Envelope, maxFrameBytes = MAX_FRAME_BYTES): Uint8Array {
  const body = utf8Encoder.encode(encodeEnvelope(envelope));
  if (body.byteLength > maxFrameBytes) {
    throw new RangeError(`Envelope of ${body.byteLength} bytes exceeds the frame limit.`);
  }
  const frame = new Uint8Array(FRAME_HEADER_BYTES + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Incremental decoder for a byte stream of frames. `push` returns one result per
 * complete frame, in order. The first error is the last result: the decoder then
 * ignores further input and the receiver must close the connection.
 */
export class FrameDecoder {
  /** Largest accepted body. A server keeps it small until the handshake is done. */
  maxFrameBytes: number;
  #buffer: Uint8Array = new Uint8Array(0);
  #failed = false;

  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  get failed(): boolean {
    return this.#failed;
  }

  push(chunk: Uint8Array): Result<Envelope, ProtocolError>[] {
    if (this.#failed) return [];
    this.#append(chunk);
    const results: Result<Envelope, ProtocolError>[] = [];
    while (this.#buffer.byteLength >= FRAME_HEADER_BYTES) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, FRAME_HEADER_BYTES);
      const length = view.getUint32(0, false);
      if (length > this.maxFrameBytes) {
        results.push(this.#fail('Frame exceeds the size limit.'));
        break;
      }
      if (this.#buffer.byteLength < FRAME_HEADER_BYTES + length) break;
      const body = this.#buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length);
      this.#buffer = this.#buffer.subarray(FRAME_HEADER_BYTES + length);
      let text: string;
      try {
        text = utf8Decoder.decode(body);
      } catch {
        results.push(this.#fail('Frame is not valid UTF-8.'));
        break;
      }
      const result = decodeEnvelope(text);
      results.push(result);
      if (!result.ok) {
        this.#failed = true;
        this.#buffer = new Uint8Array(0);
        break;
      }
    }
    return results;
  }

  #append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    if (this.#buffer.byteLength === 0) {
      this.#buffer = chunk.slice();
      return;
    }
    const next = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    next.set(this.#buffer, 0);
    next.set(chunk, this.#buffer.byteLength);
    this.#buffer = next;
  }

  #fail(message: string): Result<never, ProtocolError> {
    this.#failed = true;
    this.#buffer = new Uint8Array(0);
    return err(protocolError('bad_frame', message));
  }
}
