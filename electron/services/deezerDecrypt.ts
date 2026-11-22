import * as fs from 'fs'
import * as crypto from 'crypto'
import { Blowfish } from 'egoroof-blowfish'

/**
 * Deezer track decryption ("BF_CBC_STRIPE").
 *
 * Pure, dependency-light module so it can run both inside a worker thread
 * (electron/workers/decryptWorker.ts, the normal path) and inline on the main
 * thread (DecryptPool's last-resort fallback). Keep it free of Electron imports.
 *
 * The algorithm is unchanged from the previous Downloader.decryptFile(): every
 * third 2048-byte stripe is Blowfish-CBC encrypted with a per-track key and a
 * fixed IV; everything else (including a short final stripe) is plaintext.
 */

const BLOWFISH_SECRET = 'g4el58wc0zvf9na1'
const STRIPE_SIZE = 2048
const IV = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])

/** Per-track Blowfish key: md5(SNG_ID) halves XORed with the static secret. */
export function trackBlowfishKey(sngId: string): Buffer {
  const hash = crypto.createHash('md5').update(sngId, 'ascii').digest('hex')
  const key = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) {
    key[i] = hash.charCodeAt(i) ^ hash.charCodeAt(i + 16) ^ BLOWFISH_SECRET.charCodeAt(i)
  }
  return key
}

export function decryptTrackBuffer(input: Buffer, sngId: string): Buffer {
  const bf = new Blowfish(trackBlowfishKey(sngId), Blowfish.MODE.CBC, Blowfish.PADDING.NULL)

  // LOAD-BEARING: must be Buffer.alloc (zero-filled), never allocUnsafe.
  // egoroof-blowfish's PADDING.NULL decode() strips trailing 0x00 bytes, so a
  // 2048-byte stripe can legitimately come back at 2041–2047 bytes (~0.4% of
  // stripes, MP3 frames are full of nulls). That is lossless only because the
  // gap here is already zero. allocUnsafe would scatter garbage through the
  // audio while still reporting success. The check below enforces it.
  const output = Buffer.alloc(input.length)

  let chunkIndex = 0
  let position = 0

  while (position < input.length) {
    const chunkSize = Math.min(STRIPE_SIZE, input.length - position)
    const chunk = input.subarray(position, position + chunkSize)

    if (chunkIndex % 3 === 0 && chunkSize === STRIPE_SIZE) {
      let decrypted: Buffer
      try {
        bf.setIv(IV) // IV resets for every stripe
        decrypted = Buffer.from(bf.decode(chunk, Blowfish.TYPE.UINT8_ARRAY))
      } catch (e: any) {
        // Unreachable under the guard above; kept as a tripwire. Never fall
        // back to copying the still-encrypted bytes: that would produce a
        // "successful" file full of noise.
        throw new Error(`Chunk decryption failed at byte ${position}: ${e?.message ?? e}`)
      }
      decrypted.copy(output, position)

      if (decrypted.length < chunkSize) {
        for (let i = position + decrypted.length; i < position + chunkSize; i++) {
          if (output[i] !== 0) {
            throw new Error(
              `Decrypt output buffer is not zero-filled at byte ${i}: PADDING.NULL ` +
              `strips trailing nulls, so this buffer must come from Buffer.alloc, ` +
              `never Buffer.allocUnsafe`
            )
          }
        }
      }
    } else {
      chunk.copy(output, position)
    }

    position += chunkSize
    chunkIndex++
  }

  return output
}

/**
 * Decrypt `inputPath` into `outputPath`. Synchronous on purpose: it is meant to
 * run on a worker thread, where blocking is harmless. The output file is only
 * written after the whole buffer decrypted, so a failure leaves no partial file.
 */
export function decryptTrackFile(inputPath: string, sngId: string, outputPath: string): void {
  const input = fs.readFileSync(inputPath)
  const output = decryptTrackBuffer(input, sngId)
  fs.writeFileSync(outputPath, output)
}
