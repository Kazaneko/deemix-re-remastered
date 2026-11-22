import { describe, expect, test } from 'bun:test'
import { rewriteLoopbackUrl } from '../src/web/webBridge'

describe('rewriteLoopbackUrl', () => {
  const origin = 'http://192.168.1.20:6595'

  test('points hand-built backend URLs at the page origin', () => {
    expect(rewriteLoopbackUrl('http://127.0.0.1:6595/api/search?q=a', origin)).toBe(`${origin}/api/search?q=a`)
    expect(rewriteLoopbackUrl('http://localhost:6595/res/x.png', origin)).toBe(`${origin}/res/x.png`)
    expect(rewriteLoopbackUrl('http://127.0.0.1:80/api/health', 'https://deemix.lan')).toBe('https://deemix.lan/api/health')
    expect(rewriteLoopbackUrl('http://127.0.0.1:6595', origin)).toBe(origin)
  })

  test('relays Deezer public API calls through the server', () => {
    expect(rewriteLoopbackUrl('https://api.deezer.com/search?q=daft%20punk', origin)).toBe(`${origin}/headless/deezer-api/search?q=daft%20punk`)
    expect(rewriteLoopbackUrl('https://api.deezer.com/album/302127', origin)).toBe(`${origin}/headless/deezer-api/album/302127`)
  })

  test('leaves every other URL alone', () => {
    for (const url of [
      '/api/health',
      'http://127.0.0.10:6595/api',
      'http://localhost.evil.example/api',
      'http://example.com/?u=http://127.0.0.1:6595/',
      'https://api.deezer.com.evil.example/x',
      'https://e-cdns-images.dzcdn.net/images/cover/x.jpg'
    ]) {
      expect(rewriteLoopbackUrl(url, origin)).toBe(url)
    }
  })
})
