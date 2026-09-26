import { describe, expect, it } from 'vitest'
import { cobsDecode, cobsEncode, crc32, decodeFrame, Deframer, encodeFrame, FrameError, Reader, Writer } from './protocol'

describe('framing', () => {
  it('uses the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('round-trips whatever the payload', () => {
    const bodies = [new Uint8Array(), new Uint8Array(1), new Uint8Array(1024), Uint8Array.from({ length: 700 }, (_, i) => i % 256)]
    for (const body of bodies) {
      const wire = encodeFrame(0x42, 0xbeef, body)
      expect(wire.filter((b) => b === 0).length).toBe(1)
      expect(decodeFrame(wire.subarray(0, -1))).toEqual({ kind: 0x42, id: 0xbeef, body })
    }
  })

  it('COBS survives runs longer than 254', () => {
    const data = Uint8Array.from({ length: 600 }, (_, i) => (i % 7 === 0 ? 0 : 0x55))
    expect(cobsDecode(cobsEncode(data))).toEqual(data)
  })

  it('copes with dribbles and garbage', () => {
    const d = new Deframer()
    const stream = [...new TextEncoder().encode('\x07junk'), 0, ...encodeFrame(1, 1, new TextEncoder().encode('first')), ...encodeFrame(2, 2, new Uint8Array(300))]
    const got = stream.flatMap((b) => d.push(Uint8Array.of(b)))
    expect(got).toHaveLength(3)
    expect(got[0]).toBeInstanceOf(FrameError)
    expect((got[2] as { body: Uint8Array }).body).toEqual(new Uint8Array(300))
  })

  it('rejects a corrupted frame', () => {
    const wire = encodeFrame(1, 1, new TextEncoder().encode('hello'))
    wire[3] ^= 0x10
    expect(() => decodeFrame(wire.subarray(0, -1))).toThrow('CRC')
  })
})

describe('bodies', () => {
  it('round-trips every field type', () => {
    const body = new Writer().u8(7).u16(513).i32(-18000).u64(1_790_399_658_000).str8('maki').bytes16(Uint8Array.of(1, 2, 3)).finish()
    const r = new Reader(body)
    expect([r.u8(), r.u16(), r.i32(), r.u64(), r.str8(), r.bytes16()]).toEqual([7, 513, -18000, 1_790_399_658_000, 'maki', Uint8Array.of(1, 2, 3)])
    r.end()
  })

  it('refuses short and over-long bodies', () => {
    expect(() => new Reader(Uint8Array.of(1)).u16()).toThrow()
    const r = new Reader(Uint8Array.of(1, 2))
    r.u8()
    expect(() => r.end()).toThrow()
  })
})
