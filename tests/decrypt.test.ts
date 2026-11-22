import { afterAll, describe, expect, test } from 'bun:test'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Blowfish } from 'egoroof-blowfish'
import { decryptTrackBuffer, decryptTrackFile, trackBlowfishKey } from '../electron/services/deezerDecrypt'
import { DecryptPool } from '../electron/services/decryptPool'

const SNG_ID = '3135556'
const IV = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
const WORKER_TS = path.join(import.meta.dir, '../electron/workers/decryptWorker.ts')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deemix-decrypt-'))

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** Apply Deezer's stripe scheme in the encrypt direction to build fixtures. */
function encryptLikeDeezer(plain: Buffer, sngId: string): Buffer {
  const bf = new Blowfish(trackBlowfishKey(sngId), Blowfish.MODE.CBC, Blowfish.PADDING.NULL)
  const out = Buffer.from(plain)
  for (let pos = 0, idx = 0; pos < plain.length; pos += 2048, idx++) {
    if (idx % 3 !== 0 || plain.length - pos < 2048) continue
    bf.setIv(IV)
    const enc = Buffer.from(bf.encode(plain.subarray(pos, pos + 2048), Blowfish.TYPE.UINT8_ARRAY))
    enc.copy(out, pos, 0, 2048)
  }
  return out
}

/** Random audio-ish payload with zero runs, including stripes that END in zeros. */
function samplePlain(size: number): Buffer {
  const b = crypto.randomBytes(size)
  for (let pos = 0; pos + 2048 <= size; pos += 2048 * 7) b.fill(0, pos + 2040, pos + 2048)
  return b
}

function writeFixture(name: string, size: number) {
  const plain = samplePlain(size)
  const encPath = path.join(tmp, `${name}.enc`)
  fs.writeFileSync(encPath, encryptLikeDeezer(plain, SNG_ID))
  return { plain, encPath, outPath: path.join(tmp, `${name}.out`) }
}

describe('deezerDecrypt', () => {
  test('round-trips stripes, including a short trailing stripe', () => {
    const plain = samplePlain(2048 * 10 + 777)
    const enc = encryptLikeDeezer(plain, SNG_ID)
    expect(enc.equals(plain)).toBe(false)
    expect(decryptTrackBuffer(enc, SNG_ID).equals(plain)).toBe(true)
  })

  test('stripes ending in null bytes survive PADDING.NULL stripping', () => {
    const plain = Buffer.alloc(2048 * 3)
    crypto.randomFillSync(plain, 0, 1000) // first stripe: 1000 random bytes then zeros
    const enc = encryptLikeDeezer(plain, SNG_ID)
    expect(decryptTrackBuffer(enc, SNG_ID).equals(plain)).toBe(true)
  })

  test('decryptTrackFile writes the plaintext', () => {
    const { plain, encPath, outPath } = writeFixture('file', 2048 * 9 + 5)
    decryptTrackFile(encPath, SNG_ID, outPath)
    expect(fs.readFileSync(outPath).equals(plain)).toBe(true)
  })
})

describe('DecryptPool', () => {
  test('decrypts concurrently on worker threads', async () => {
    const pool = new DecryptPool(WORKER_TS, 2)
    try {
      const fixtures = Array.from({ length: 5 }, (_, i) => writeFixture(`pool-${i}`, 2048 * 50 + i * 13))
      await Promise.all(fixtures.map(f => pool.decrypt(f.encPath, SNG_ID, f.outPath)))
      for (const f of fixtures) expect(fs.readFileSync(f.outPath).equals(f.plain)).toBe(true)
      expect(pool.isInline).toBe(false)
    } finally {
      await pool.destroy()
    }
  })

  test('propagates decryption errors without killing the pool', async () => {
    const pool = new DecryptPool(WORKER_TS, 1)
    try {
      await expect(pool.decrypt(path.join(tmp, 'missing.enc'), SNG_ID, path.join(tmp, 'x.out'))).rejects.toThrow()
      const f = writeFixture('after-error', 2048 * 6)
      await pool.decrypt(f.encPath, SNG_ID, f.outPath)
      expect(fs.readFileSync(f.outPath).equals(f.plain)).toBe(true)
    } finally {
      await pool.destroy()
    }
  })

  test('falls back to inline decryption when workers cannot start', async () => {
    const pool = new DecryptPool(path.join(tmp, 'does-not-exist.js'), 2)
    try {
      const f = writeFixture('fallback', 2048 * 6 + 1)
      await pool.decrypt(f.encPath, SNG_ID, f.outPath)
      expect(fs.readFileSync(f.outPath).equals(f.plain)).toBe(true)
      expect(pool.isInline).toBe(true)
    } finally {
      await pool.destroy()
    }
  })
})
