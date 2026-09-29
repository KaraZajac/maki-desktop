/**
 * CryptoNight, Monero's original slow hash (variant 0), as `cn_slow_hash` computes it
 * (src/crypto/slow-hash.c, the portable version): the Keccak state of the data, a 2 MiB scratchpad
 * filled with AES rounds, half a million rounds of AES and 64-bit multiplication reading and
 * writing it, then one of BLAKE-256, Grøstl-256, JH-256 and Skein-512-256 over the state, as its
 * first byte picks.
 *
 * Monero mines with it no longer, but wallet2 still makes the key it encrypts the files a
 * view-only wallet and its cold wallet pass each other with: the hash of the view key
 * (`generate_chacha_key`). So maki desktop needs it to read the Monero GUI's unsigned
 * transactions and to write what it signs back. Once per wallet, and cached.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { blake256 } from '@noble/hashes/blake1.js'
import { keccakP } from '@noble/hashes/sha3.js'

// ---------------------------------------------------------------------------------------------
// AES: the S-box and round tables, for AES's rounds as CryptoNight uses them (no key schedule's
// last round: every round has MixColumns).

const SBOX = new Uint8Array(256)
const T0 = new Uint32Array(256)
const T1 = new Uint32Array(256)
const T2 = new Uint32Array(256)
const T3 = new Uint32Array(256)
{
  // the S-box from GF(2^8)'s inverses, and the tables from it
  let p = 1
  let q = 1
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)
    q = (q ^ (q << 1)) & 0xff
    q = (q ^ (q << 2)) & 0xff
    q = (q ^ (q << 4)) & 0xff
    if (q & 0x80) q ^= 0x09
    const x =
      q ^
      ((q << 1) | (q >> 7)) ^
      ((q << 2) | (q >> 6)) ^
      ((q << 3) | (q >> 5)) ^
      ((q << 4) | (q >> 4))
    SBOX[p] = (x ^ 0x63) & 0xff
  } while (p !== 1)
  SBOX[0] = 0x63
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i]
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x1b : 0)) & 0xff
    const s3 = s2 ^ s
    // little-endian words: a column's bytes in the order they sit in memory
    T0[i] = (s2 | (s << 8) | (s << 16) | (s3 << 24)) >>> 0
    T1[i] = (s3 | (s2 << 8) | (s << 16) | (s << 24)) >>> 0
    T2[i] = (s | (s3 << 8) | (s2 << 16) | (s << 24)) >>> 0
    T3[i] = (s | (s << 8) | (s3 << 16) | (s2 << 24)) >>> 0
  }
}

/** One AES round (SubBytes, ShiftRows, MixColumns, AddRoundKey) of the block at `at`, in place. */
function aesRound(w: Uint32Array, at: number, key: Uint32Array, k: number): void {
  const a0 = w[at]
  const a1 = w[at + 1]
  const a2 = w[at + 2]
  const a3 = w[at + 3]
  w[at] = T0[a0 & 0xff] ^ T1[(a1 >>> 8) & 0xff] ^ T2[(a2 >>> 16) & 0xff] ^ T3[a3 >>> 24] ^ key[k]
  w[at + 1] =
    T0[a1 & 0xff] ^ T1[(a2 >>> 8) & 0xff] ^ T2[(a3 >>> 16) & 0xff] ^ T3[a0 >>> 24] ^ key[k + 1]
  w[at + 2] =
    T0[a2 & 0xff] ^ T1[(a3 >>> 8) & 0xff] ^ T2[(a0 >>> 16) & 0xff] ^ T3[a1 >>> 24] ^ key[k + 2]
  w[at + 3] =
    T0[a3 & 0xff] ^ T1[(a0 >>> 8) & 0xff] ^ T2[(a1 >>> 16) & 0xff] ^ T3[a2 >>> 24] ^ key[k + 3]
}

/** AES-256's key schedule, its first ten round keys: what CryptoNight's ten rounds take. */
function expandKey(key: Uint8Array): Uint32Array {
  const w = new Uint32Array(60)
  const view = new DataView(key.buffer, key.byteOffset, 32)
  for (let i = 0; i < 8; i++) w[i] = view.getUint32(4 * i, true)
  let rcon = 1
  for (let i = 8; i < 60; i++) {
    let t = w[i - 1]
    if (i % 8 === 0) {
      // RotWord, SubWord, Rcon (little-endian words)
      t = (t >>> 8) | (t << 24)
      t =
        SBOX[t & 0xff] |
        (SBOX[(t >>> 8) & 0xff] << 8) |
        (SBOX[(t >>> 16) & 0xff] << 16) |
        (SBOX[t >>> 24] << 24)
      t ^= rcon
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff
    } else if (i % 8 === 4) {
      t =
        SBOX[t & 0xff] |
        (SBOX[(t >>> 8) & 0xff] << 8) |
        (SBOX[(t >>> 16) & 0xff] << 16) |
        (SBOX[t >>> 24] << 24)
    }
    w[i] = (w[i - 8] ^ t) >>> 0
  }
  return w.subarray(0, 40)
}

// ---------------------------------------------------------------------------------------------
// 64-bit words as pairs of 32-bit halves, for the main loop's multiplication and additions.

/** The 128-bit product of two 64-bit numbers, each as (low, high) 32-bit halves: [lo lo, lo hi, hi lo, hi hi]. */
function mul64(aLo: number, aHi: number, bLo: number, bHi: number, out: Uint32Array): void {
  // 16-bit limbs, so every partial product is exact in a double
  const a = [aLo & 0xffff, aLo >>> 16, aHi & 0xffff, aHi >>> 16]
  const b = [bLo & 0xffff, bLo >>> 16, bHi & 0xffff, bHi >>> 16]
  const r = [0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < 4; i++) {
    let carry = 0
    for (let j = 0; j < 4; j++) {
      const t = a[i] * b[j] + r[i + j] + carry
      r[i + j] = t % 65536
      carry = Math.floor(t / 65536)
    }
    r[i + 4] += carry
  }
  out[0] = (r[0] | (r[1] << 16)) >>> 0
  out[1] = (r[2] | (r[3] << 16)) >>> 0
  out[2] = (r[4] | (r[5] << 16)) >>> 0
  out[3] = (r[6] | (r[7] << 16)) >>> 0
}

const MEMORY = 1 << 21
const ITERATIONS = 1 << 20

function keccakState(data: Uint8Array): Uint8Array {
  // Keccak-1600 with Monero's padding, rate 136, the whole 200-byte state kept
  const state = new Uint8Array(200)
  const words = new Uint32Array(state.buffer)
  const rate = 136
  let at = 0
  for (; at + rate <= data.length; at += rate) {
    for (let i = 0; i < rate; i++) state[i] ^= data[at + i]
    keccakP(words, 24)
  }
  const last = data.subarray(at)
  for (let i = 0; i < last.length; i++) state[i] ^= last[i]
  state[last.length] ^= 0x01
  state[rate - 1] ^= 0x80
  keccakP(words, 24)
  return state
}

/** CryptoNight, variant 0: `cn_slow_hash(data, length, hash, 0, 0, 0)`. */
export function cnSlowHash(data: Uint8Array): Uint8Array {
  const state = keccakState(data)
  const long = new Uint32Array(MEMORY / 4)
  const text = new Uint32Array(32)
  text.set(new Uint32Array(state.buffer, 64, 32))
  // the scratchpad: the state's 128 bytes after the first 64, AES'd again and again
  let key = expandKey(state.subarray(0, 32))
  for (let i = 0; i < MEMORY / 128; i++) {
    for (let j = 0; j < 8; j++) for (let r = 0; r < 10; r++) aesRound(text, 4 * j, key, 4 * r)
    long.set(text, i * 32)
  }

  const k = new Uint32Array(state.buffer, 0, 16)
  const a = new Uint32Array(4)
  const b = new Uint32Array(4)
  for (let i = 0; i < 4; i++) {
    a[i] = k[i] ^ k[8 + i]
    b[i] = k[4 + i] ^ k[12 + i]
  }
  const c = new Uint32Array(4)
  const d = new Uint32Array(4)
  const mask = MEMORY / 16 - 1
  for (let i = 0; i < ITERATIONS / 2; i++) {
    // AES round of the block a points at, with a as the key; b into it
    let j = ((a[0] >>> 4) | (a[1] << 28)) & mask
    let at = 4 * j
    c[0] = long[at]
    c[1] = long[at + 1]
    c[2] = long[at + 2]
    c[3] = long[at + 3]
    aesRound(c, 0, a, 0)
    long[at] = c[0] ^ b[0]
    long[at + 1] = c[1] ^ b[1]
    long[at + 2] = c[2] ^ b[2]
    long[at + 3] = c[3] ^ b[3]
    // multiply by the block c points at, add to a, write it there, and xor what was there into a
    j = ((c[0] >>> 4) | (c[1] << 28)) & mask
    at = 4 * j
    const x0 = long[at]
    const x1 = long[at + 1]
    const x2 = long[at + 2]
    const x3 = long[at + 3]
    mul64(c[0], c[1], x0, x1, d)
    // d is (hi, lo): a's first half gets the high 64 bits, its second the low
    let lo = a[0] + d[2]
    let carry = lo > 0xffffffff ? 1 : 0
    const s0 = lo >>> 0
    const s1 = (a[1] + d[3] + carry) >>> 0
    lo = a[2] + d[0]
    carry = lo > 0xffffffff ? 1 : 0
    const s2 = lo >>> 0
    const s3 = (a[3] + d[1] + carry) >>> 0
    long[at] = s0
    long[at + 1] = s1
    long[at + 2] = s2
    long[at + 3] = s3
    a[0] = s0 ^ x0
    a[1] = s1 ^ x1
    a[2] = s2 ^ x2
    a[3] = s3 ^ x3
    b.set(c)
  }

  // the scratchpad folded back into the state's 128 bytes, with the other half of its key
  text.set(new Uint32Array(state.buffer, 64, 32))
  key = expandKey(state.subarray(32, 64))
  for (let i = 0; i < MEMORY / 128; i++) {
    for (let j = 0; j < 32; j++) text[j] ^= long[i * 32 + j]
    for (let j = 0; j < 8; j++) for (let r = 0; r < 10; r++) aesRound(text, 4 * j, key, 4 * r)
  }
  new Uint32Array(state.buffer, 64, 32).set(text)
  keccakP(new Uint32Array(state.buffer), 24)
  return FINAL[state[0] & 3](state)
}

// ---------------------------------------------------------------------------------------------
// The four hashes that finish it.

const FINAL: ((data: Uint8Array) => Uint8Array)[] = [
  (d) => blake256(d),
  groestl256,
  jh256,
  skein512_256
]

// Grøstl-256 (the final, tweaked version): 64-byte blocks, P and Q of ten rounds each on an 8x8
// byte state held column by column.

function gmul(a: number, b: number): number {
  let r = 0
  while (b) {
    if (b & 1) r ^= a
    a = ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff
    b >>= 1
  }
  return r
}

const MIX = [2, 2, 3, 4, 5, 3, 5, 7]
const MIX_TABLE = MIX.map((m) => Uint8Array.from({ length: 256 }, (_, x) => gmul(x, m)))

function groestlPermutation(x: Uint8Array, q: boolean): void {
  const shifts = q ? [1, 3, 5, 7, 0, 2, 4, 6] : [0, 1, 2, 3, 4, 5, 6, 7]
  const t = new Uint8Array(64)
  for (let round = 0; round < 10; round++) {
    // AddRoundConstant
    for (let col = 0; col < 8; col++) {
      if (q) {
        for (let row = 0; row < 7; row++) x[8 * col + row] ^= 0xff
        x[8 * col + 7] ^= 0xff ^ (col << 4) ^ round
      } else {
        x[8 * col] ^= (col << 4) ^ round
      }
    }
    // SubBytes and ShiftBytes: row r moves left by its shift
    for (let col = 0; col < 8; col++)
      for (let row = 0; row < 8; row++)
        t[8 * col + row] = SBOX[x[8 * ((col + shifts[row]) % 8) + row]]
    // MixBytes: each column by the circulant matrix (2, 2, 3, 4, 5, 3, 5, 7)
    for (let col = 0; col < 8; col++)
      for (let row = 0; row < 8; row++) {
        let v = 0
        for (let k = 0; k < 8; k++) v ^= MIX_TABLE[(k - row + 8) % 8][t[8 * col + k]]
        x[8 * col + row] = v
      }
  }
}

export function groestl256(data: Uint8Array): Uint8Array {
  const h = new Uint8Array(64)
  h[62] = 0x01 // 256, the output's length, big-endian in the last bytes
  const blocks = Math.floor((data.length + 1 + 8) / 64) + ((data.length + 1 + 8) % 64 ? 1 : 0)
  const padded = new Uint8Array(blocks * 64)
  padded.set(data)
  padded[data.length] = 0x80
  new DataView(padded.buffer).setBigUint64(padded.length - 8, BigInt(blocks))
  const p = new Uint8Array(64)
  const q = new Uint8Array(64)
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 64; i++) {
      p[i] = h[i] ^ padded[at + i]
      q[i] = padded[at + i]
    }
    groestlPermutation(p, false)
    groestlPermutation(q, true)
    for (let i = 0; i < 64; i++) h[i] ^= p[i] ^ q[i]
  }
  p.set(h)
  groestlPermutation(p, false)
  for (let i = 0; i < 64; i++) p[i] ^= h[i]
  return p.slice(32)
}

// JH-256: the 64-bit bitslice implementation's E8 (42 rounds), in BigInts.

const M64 = (1n << 64n) - 1n

const JH256_H0 = hexBytes(
  'eb98a3412c20d3eb92cdbe7b9cb245c11c93519160d4c7fa260082d67e508a03a4239e267726b945e0fb1a48d41a9477cdb5ab26026b177a56f024420fff2fa871a396897f2e4d751d144908f77de262277695f776248f9487d5b6574780296c5c5e272dac8e0d6c518450c657057a0f7be4d367702412ea89e3ab13d31cd769'
)
/** E8's 42 round constants, 32 bytes each (jh.c's E8_bitslice_roundconstant). */
const JH_CONSTANTS = hexBytes(
  '72d5dea2df15f8677b84150ab723155781abd6904d5a87f64e9f4fc5c3d12b40ea983ae05c45fa9c03c5d29966b2999a660296b4f2bb538ab556141a88dba231' +
    '03a35a5c9a190edb403fb20a87c144101c051980849e951d6f33ebad5ee7cddc10ba139202bf6b41dc786515f7bb27d00a2c813937aa78503f1abfd2410091d3' +
    '422d5a0df6cc7e90dd629f9c92c097ce185ca70bc72b44acd1df65d663c6fc23976e6c039ee0b81a2105457e446ceca8eef103bb5d8e61fafd9697b294838197' +
    '4a8e8537db03302f2a678d2dfb9f6a958afe7381f8b8696c8ac77246c07f4214c5f4158fbdc75ec475446fa78f11bb8052de75b7aee488bc82b8001e98a6a3f4' +
    '8ef48f33a9a36315aa5f5624d5b7f989b6f1ed207c5ae0fd36cae95a06422c36ce2935434efe983d533af974739a4ba7d0f51f596f4e81860e9dad81afd85a9f' +
    'a7050667ee34626a8b0b28be6eb9172747740726c680103fe0a07e6fc67e487b0d550aa54af8a4c091e3e79f978ef19e8676728150608dd47e9e5a41f3e5b062' +
    'fc9f1fec4054207ae3e41a00cef4c9844fd794f59dfa95d8552e7e1124c354a55bdf7228bdfe6e2878f57fe20fa5c4b205897cefee49d32e447e9385eb28597f' +
    '705f6937b324314a5e8628f11dd6e465c71b770451b920e774fe43e823d4878a7d29e8a3927694f2ddcb7a099b30d9c11d1b30fb5bdc1be0da24494ff29c82bf' +
    'a4e7ba31b470bfff0d324405def8bc483baefc3253bbd339459fc3c1e0298ba0e5c905fdf7ae090f947034124290f134a271b701e344ed95e93b8e364f2f984a' +
    '88401d63a06cf61547c1444b8752afff7ebb4af1e20ac6304670b6c5cc6e8ce6a4d5a456bd4fca00da9d844bc83e18ae7357ce453064d1ade8a6ce68145c2567' +
    'a3da8cf2cb0ee11633e906589a94999a1f60b220c26f847bd1ceac7fa0d1851832595ba18ddd19d3509a1cc0aaa5b4469f3d6367e4046bbaf6ca19ab0b56ee7e' +
    '1fb179eaa9282174e9bdf7353b3651ee1d57ac5a7550d3763a46c2fea37d7001f735c1af98a4d84278edec209e6b677941836315ea3adba8fac33b4d32832c83' +
    'a7403b1f1c2747f35940f034b72d769ae73e4e6cd2214ffdb8fd8d39dc5759ef8d9b0c492b49ebda5ba2d74968f3700d7d3baed07a8d5584f5a5e9f0e4f88e65' +
    'a0b8a2f436103b530ca8079e753eec5a9168949256e8884f5bb05c55f8babc4ce3bb3b99f387947b75daf4d6726b1c5d64aeac28dc34b36d6c34a550b828db71' +
    'f861e2f2108d512ae3db643359dd75fc1cacbcf143ce3fa267bbd13c02e843b0330a5bca8829a1757f34194db416535c923b94c30e794d1e797475d7b6eeaf3f' +
    'eaa8d4f7be1a39215cf47e094c23275126a32453ba323cd244a3174a6da6d5adb51d3ea6aff2c90883593d98916b3c564cf87ca17286604d46e23ecc086ec7f6' +
    '2f9833b3b1bc765e2bd666a5efc4e62a06f4b6e8bec1d43674ee8215bcef2163fdc14e0df453c969a77d5ac4065858267ec1141606e0fa167e90af3d28639d3f' +
    'd2c9f2e3009bd20c5faace30b7d40c30742a5116f2e032980deb30d8e3cef89a4bc59e7bb5f17992ff51e66e048668d39b234d57e6966731cce6a6f3170a7505' +
    'b17681d913326cce3c175284f805a262f42bcbb378471547ff46548223936a4838df58074e5e6565f2fc7c89fc86508e31702e44d00bca86f04009a23078474e' +
    '65a0ee39d1f73883f75ee937e42c3abd2197b2260113f86fa344edd1ef9fdee78ba0df15762592d93c85f7f612dc42bed8a7ec7cab27b07e538d7ddaaa3ea8de' +
    'aa25ce93bd0269d85af643fd1a7308f9c05fefda174a19a5974d66334cfd216a35b49831db411570ea1e0fbbedcd549b9ad063a151974072f6759dbf91476fe2'
)

function hexBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '')
  return Uint8Array.from({ length: clean.length / 2 }, (_, i) =>
    parseInt(clean.slice(2 * i, 2 * i + 2), 16)
  )
}

function le64(bytes: Uint8Array, at: number): bigint {
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i])
  return v
}

function jhE8(x: bigint[]): void {
  // x[2 * row + half], as the C's x[row][half]
  const swaps: [bigint, bigint][] = [
    [0x5555555555555555n, 1n],
    [0x3333333333333333n, 2n],
    [0x0f0f0f0f0f0f0f0fn, 4n],
    [0x00ff00ff00ff00ffn, 8n],
    [0x0000ffff0000ffffn, 16n]
  ]
  for (let round = 0; round < 42; round++) {
    const c = JH_CONSTANTS.subarray(32 * round, 32 * round + 32)
    for (let i = 0; i < 2; i++) {
      let [m0, m1, m2, m3, m4, m5, m6, m7] = [0, 2, 4, 6, 1, 3, 5, 7].map((r) => x[2 * r + i])
      const cc0 = le64(c, 8 * i)
      const cc1 = le64(c, 8 * (i + 2))
      // SS: two S-boxes at once, each S0 or S1 as its constant bit says
      m3 ^= M64
      m7 ^= M64
      m0 ^= (m2 ^ M64) & cc0
      m4 ^= (m6 ^ M64) & cc1
      const t0 = cc0 ^ (m0 & m1)
      const t1 = cc1 ^ (m4 & m5)
      m0 ^= m2 & m3
      m4 ^= m6 & m7
      m3 ^= (m1 ^ M64) & m2
      m7 ^= (m5 ^ M64) & m6
      m1 ^= m0 & m2
      m5 ^= m4 & m6
      m2 ^= m0 & (m3 ^ M64)
      m6 ^= m4 & (m7 ^ M64)
      m0 ^= m1 | m3
      m4 ^= m5 | m7
      m3 ^= m1 & m2
      m7 ^= m5 & m6
      m1 ^= t0 & m0
      m5 ^= t1 & m4
      m2 ^= t0
      m6 ^= t1
      // L: the MDS transform
      m4 ^= m1
      m5 ^= m2
      m6 ^= m0 ^ m3
      m7 ^= m0
      m0 ^= m5
      m1 ^= m6
      m2 ^= m4 ^ m7
      m3 ^= m4
      ;[0, 2, 4, 6, 1, 3, 5, 7].forEach(
        (r, k) => (x[2 * r + i] = [m0, m1, m2, m3, m4, m5, m6, m7][k])
      )
      // the swapping layer of rounds 0 to 5 of every seven, on the odd rows
      const which = round % 7
      if (which < 5) {
        const [mask, shift] = swaps[which]
        for (const r of [1, 3, 5, 7]) {
          const v = x[2 * r + i]
          x[2 * r + i] = ((v & mask) << shift) | ((v & ((mask << shift) & M64)) >> shift)
        }
      } else if (which === 5) {
        for (const r of [1, 3, 5, 7]) {
          const v = x[2 * r + i]
          x[2 * r + i] = ((v << 32n) | (v >> 32n)) & M64
        }
      }
    }
    if (round % 7 === 6) {
      for (const r of [1, 3, 5, 7]) [x[2 * r], x[2 * r + 1]] = [x[2 * r + 1], x[2 * r]]
    }
  }
}

export function jh256(data: Uint8Array): Uint8Array {
  const x = Array.from({ length: 16 }, (_, i) => le64(JH256_H0, 8 * i))
  const bits = BigInt(data.length) * 8n
  // the message, a 1 bit, zeros, and its length in bits (128 bits, big-endian) in its own block
  const partial = data.length % 64
  const blocks = Math.floor(data.length / 64) + (partial ? 2 : 1)
  const padded = new Uint8Array(blocks * 64)
  padded.set(data)
  padded[data.length] = 0x80
  new DataView(padded.buffer).setBigUint64(padded.length - 8, bits)
  for (let at = 0; at < padded.length; at += 64) {
    const m = Array.from({ length: 8 }, (_, i) => le64(padded, at + 8 * i))
    for (let i = 0; i < 8; i++) x[i] ^= m[i]
    jhE8(x)
    for (let i = 0; i < 8; i++) x[8 + i] ^= m[i]
  }
  const out = new Uint8Array(32)
  const view = new DataView(out.buffer)
  for (let i = 0; i < 4; i++) view.setBigUint64(8 * i, x[12 + i], true)
  return out
}

// Skein-512-256 (Skein 1.3): Threefish-512's 72 rounds in UBI chaining, in BigInts.

const SKEIN_ROTATIONS = [
  [46, 36, 19, 37],
  [33, 27, 14, 42],
  [17, 49, 36, 39],
  [44, 9, 54, 56],
  [39, 30, 34, 24],
  [13, 50, 10, 17],
  [25, 29, 39, 43],
  [8, 35, 56, 22]
].map((r) => r.map(BigInt))
const SKEIN_PERMUTATIONS = [
  [0, 1, 2, 3, 4, 5, 6, 7],
  [2, 1, 4, 7, 6, 5, 0, 3],
  [4, 1, 6, 3, 0, 5, 2, 7],
  [6, 1, 0, 7, 2, 5, 4, 3]
]
const PARITY = 0x1bd11bdaa9fc1a22n
const TYPE_CFG = 4n
const TYPE_MSG = 48n
const TYPE_OUT = 63n

function rotl(v: bigint, n: bigint): bigint {
  return ((v << n) | (v >> (64n - n))) & M64
}

/** One UBI block: `chain` becomes Threefish-512 of the block, keyed by it and the tweak, fed forward. */
function skeinBlock(chain: bigint[], block: Uint8Array, t0: bigint, t1: bigint): void {
  const w = Array.from({ length: 8 }, (_, i) => le64(block, 8 * i))
  const ks = [...chain, chain.reduce((a, b) => a ^ b, PARITY)]
  const ts = [t0 & M64, t1 & M64, (t0 ^ t1) & M64]
  const x = w.map((v, i) => (v + ks[i] + (i === 5 ? ts[0] : i === 6 ? ts[1] : 0n)) & M64)
  for (let s = 1; s <= 18; s++) {
    // four rounds, then a key injection
    for (let r = 0; r < 4; r++) {
      const p = SKEIN_PERMUTATIONS[r]
      const rot = SKEIN_ROTATIONS[((s - 1) % 2) * 4 + r]
      for (let j = 0; j < 4; j++) {
        const a = p[2 * j]
        const b = p[2 * j + 1]
        x[a] = (x[a] + x[b]) & M64
        x[b] = rotl(x[b], rot[j]) ^ x[a]
      }
    }
    for (let i = 0; i < 8; i++) {
      let v = ks[(s + i) % 9]
      if (i === 5) v += ts[s % 3]
      if (i === 6) v += ts[(s + 1) % 3]
      if (i === 7) v += BigInt(s)
      x[i] = (x[i] + v) & M64
    }
  }
  for (let i = 0; i < 8; i++) chain[i] = x[i] ^ w[i]
}

function tweak(type: bigint, first: boolean, final: boolean): bigint {
  return (type << 56n) | (first ? 1n << 62n : 0n) | (final ? 1n << 63n : 0n)
}

export function skein512_256(data: Uint8Array): Uint8Array {
  const chain = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]
  // the configuration block: "SHA3", version 1, 256 bits out, sequential
  const cfg = new Uint8Array(64)
  const cv = new DataView(cfg.buffer)
  cv.setBigUint64(0, 0x0000000133414853n, true)
  cv.setBigUint64(8, 256n, true)
  skeinBlock(chain, cfg, 32n, tweak(TYPE_CFG, true, true))
  // the message: every block but the last, then the last (padded with zeros) as final
  const blocks = Math.max(1, Math.ceil(data.length / 64))
  for (let i = 0; i < blocks; i++) {
    const last = i === blocks - 1
    const block = new Uint8Array(64)
    const piece = data.subarray(64 * i, 64 * i + 64)
    block.set(piece)
    const done = BigInt(64 * i + piece.length)
    skeinBlock(chain, block, done, tweak(TYPE_MSG, i === 0, last))
  }
  // the output: counter 0, as its own final block
  skeinBlock(chain, new Uint8Array(64), 8n, tweak(TYPE_OUT, true, true))
  const out = new Uint8Array(32)
  const view = new DataView(out.buffer)
  for (let i = 0; i < 4; i++) view.setBigUint64(8 * i, chain[i], true)
  return out
}
