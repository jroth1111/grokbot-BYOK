/**
 * Connect-RPC streaming envelope codec.
 *
 * Connect streaming requests/responses are framed as a sequence of envelopes.
 * Each envelope begins with a 5-byte header: a single flags byte followed by a
 * big-endian uint32 length, then that many bytes of payload. This module
 * encodes and decodes those frames so the shim can read incoming Connect
 * streams and write outgoing ones.
 */

import type { ConnectEnvelope } from "../types.js";

/** Flag byte for ordinary data frames. */
export const DATA_FLAGS = 0x00;

/** Flag byte marking the end-stream trailer frame. */
export const END_STREAM_FLAGS = 0x02;

/** Content type used for Connect streaming JSON payloads. */
export const CONTENT_TYPE = "application/connect+json";

/** Size of the fixed envelope header (1 flags byte + 4 length bytes). */
const HEADER_SIZE = 5;

/**
 * Encode a single Connect streaming envelope.
 *
 * @param flags  The 1-byte flags value (e.g. {@link DATA_FLAGS} or
 *               {@link END_STREAM_FLAGS}).
 * @param data   The payload bytes that follow the header.
 * @returns      A new Buffer containing the 5-byte header followed by `data`.
 */
export function encodeEnvelope(flags: number, data: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(flags & 0xff, 0);
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

/**
 * Parse every complete envelope out of `buf`.
 *
 * @param buf  Bytes that may contain one or more envelopes (possibly partial).
 * @returns    The fully contained envelopes, in order.
 * @throws     {Error} if a header or its declared body is incomplete.
 */
export function parseEnvelopes(buf: Buffer): ConnectEnvelope[] {
  const envelopes: ConnectEnvelope[] = [];
  let offset = 0;

  while (offset < buf.length) {
    if (buf.length - offset < HEADER_SIZE) {
      throw new Error(
        `incomplete Connect envelope header: have ${buf.length - offset} bytes, need ${HEADER_SIZE}`,
      );
    }

    const flags = buf.readUInt8(offset);
    const length = buf.readUInt32BE(offset + 1);
    const bodyStart = offset + HEADER_SIZE;
    const bodyEnd = bodyStart + length;

    if (buf.length < bodyEnd) {
      throw new Error(
        `incomplete Connect envelope body: declared ${length} bytes, have ${buf.length - bodyStart}`,
      );
    }

    envelopes.push({ flags, data: buf.subarray(bodyStart, bodyEnd) });
    offset = bodyEnd;
  }

  return envelopes;
}
