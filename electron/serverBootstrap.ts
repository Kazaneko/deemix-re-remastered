import { readFile } from 'fs/promises'
import type { DeemixServer } from './server'
import { playlistSync } from './services/playlistSync'
import { artistSync } from './services/artistSync'
import { spotifyAPI } from './services/spotifyAPI'
import { qobuzAuth } from './services/qobuzAuth'

/**
 * Service start-up shared by the desktop app (electron/main.ts) and the
 * headless server (electron/headless/main.ts): restore saved Spotify/Qobuz
 * credentials, apply persisted download settings, and start the playlist and
 * artist sync engines with the server's settings.
 *
 * Moved verbatim out of main.ts initServer(); only the Electron-specific bits
 * are injected: how stored credentials are decoded (safeStorage on desktop),
 * where the files live, and how events reach the UI (IPC vs server-sent events).
 */

export interface StoredCredential {
  data?: string
  encrypted?: boolean
  obfuscated?: boolean
}

export interface BootstrapOptions {
  credentialsPath: string
  settingsPath: string
  /** Decode one stored credential field; '' when absent or unreadable (never the ciphertext). */
  decodeCredential: (stored: StoredCredential | undefined) => string
  /** Deliver an event to the UI, on the same channel names the preload API listens to. */
  forward: (channel: string, data: unknown) => void
}

export async function bootstrapServer(server: DeemixServer, opts: BootstrapOptions): Promise<void> {
  // Restore Spotify credentials from saved storage before sync init
  try {
    const credentialsPath = opts.credentialsPath
    const credData = JSON.parse(await readFile(credentialsPath, 'utf-8'))
    const decodeField = opts.decodeCredential
    const spotifyClientId = decodeField(credData.spotifyClientId)
    const spotifyClientSecret = decodeField(credData.spotifyClientSecret)
    if (spotifyClientId && spotifyClientSecret) {
      spotifyAPI.setCredentials(spotifyClientId, spotifyClientSecret)
      console.log('[Main] Spotify credentials restored from storage')
    }
    // Restore Qobuz session (browser-minted token) if present.
    const qobuzUserId = decodeField(credData.qobuzUserId)
    const qobuzToken = decodeField(credData.qobuzToken)
    // Advanced connect: re-apply user-supplied app_id + app_secret BEFORE
    // restoring the session, so API calls use the app the token belongs to.
    const qobuzAppId = decodeField(credData.qobuzAppId)
    const qobuzAppSecret = decodeField(credData.qobuzAppSecret)
    if (qobuzAppId && qobuzAppSecret) {
      qobuzAuth.setManualCredentials(qobuzAppId, qobuzAppSecret)
      console.log('[Main] Qobuz manual app credentials restored from storage')
    }
    if (qobuzUserId && qobuzToken) {
      qobuzAuth.restoreSession(qobuzToken, Number(qobuzUserId))
      console.log('[Main] Qobuz session restored from storage')
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      console.warn('[Main] Failed to restore Spotify credentials:', e.message)
    }
  }

  // Apply persisted download concurrency + pacing to the server (and through
  // it, the downloader) BEFORE sync engines initialize (issue #97). The server
  // otherwise relies entirely on the renderer's first /api/settings push, so a
  // launch-triggered sync could race startup and run at the constructor default
  // (5 / off) instead of a user-lowered value. The renderer's later push still
  // confirms the full settings; this just closes the boot window.
  try {
    const settingsPath = opts.settingsPath
    const persisted = JSON.parse(await readFile(settingsPath, 'utf-8'))
    const applied: { maxConcurrentDownloads?: number; downloadPacing?: 'off' | 'balanced' | 'cautious' } = {}
    const mc = parseInt(persisted?.maxConcurrentDownloads, 10)
    if (!isNaN(mc) && mc >= 1 && mc <= 50) applied.maxConcurrentDownloads = mc
    if (['off', 'balanced', 'cautious'].includes(persisted?.downloadPacing)) applied.downloadPacing = persisted.downloadPacing
    if (Object.keys(applied).length > 0) {
      server.updateSettings(applied)
      console.log('[Main] Applied persisted download settings at boot:', applied)
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') console.warn('[Main] Failed to apply persisted download settings at boot:', e.message)
  }

  // Provide current download settings to the sync engine so synced playlists
  // use the same quality, folder structure, templates, and metadata settings
  playlistSync.setSettingsProvider(() => {
    const s = server.getSettings()
    return {
      downloadPath: s.downloadPath,
      quality: s.quality,
      bitrateFallback: s.bitrateFallback,
      isrcFallback: s.isrcFallback,
      createArtistFolder: s.createArtistFolder,
      createAlbumFolder: s.createAlbumFolder,
      saveArtwork: s.saveArtwork,
      embedArtwork: s.embedArtwork,
      saveLyrics: s.saveLyrics,
      syncedLyrics: s.syncedLyrics,
      preferSyncedLyrics: s.preferSyncedLyrics,
      deleteSupersededLyrics: s.deleteSupersededLyrics,
      createErrorLog: s.createErrorLog,
      savePlaylistAsCompilation: s.savePlaylistAsCompilation,
      createPlaylistFile: s.createPlaylistFile,
      createAlbumPlaylistFile: s.createAlbumPlaylistFile,
      overwriteFiles: s.overwriteFiles,
      skipDuplicateTracks: s.skipDuplicateTracks,
      maxConcurrentDownloads: s.maxConcurrentDownloads,
      folderSettings: {
        createPlaylistFolder: s.createPlaylistFolder,
        createArtistFolder: s.createArtistFolder,
        createAlbumFolder: s.createAlbumFolder,
        createCDFolder: s.createCDFolder,
        createPlaylistStructure: s.createPlaylistStructure,
        createSinglesStructure: s.createSinglesStructure,
        createShortReleaseFolder: s.createShortReleaseFolder,
        playlistFolderTemplate: s.playlistFolderTemplate,
        albumFolderTemplate: s.albumFolderTemplate,
        artistFolderTemplate: s.artistFolderTemplate
      },
      trackTemplates: {
        trackNameTemplate: s.trackNameTemplate,
        albumTrackTemplate: s.albumTrackTemplate,
        playlistTrackTemplate: s.playlistTrackTemplate
      },
      metadataSettings: {
        tags: s.tags,
        albumCovers: s.albumCovers,
        useNullSeparator: s.useNullSeparator,
        saveID3v1: s.saveID3v1,
        saveOnlyMainArtist: s.saveOnlyMainArtist,
        artistSeparator: s.artistSeparator,
        dateFormatFlac: s.dateFormatFlac,
        titleCasing: s.titleCasing,
        artistCasing: s.artistCasing,
        removeAlbumVersion: s.removeAlbumVersion,
        featuredArtistsHandling: s.featuredArtistsHandling,
        keepVariousArtists: s.keepVariousArtists,
        removeArtistCombinations: s.removeArtistCombinations
      }
    }
  })

  // Initialize playlist sync engine
  await playlistSync.init()
  console.log('[Main] Playlist sync engine initialized')

  // Forward sync events to renderer
  playlistSync.on('sync:start', (playlistId: string) => {
    opts.forward('sync:start', { playlistId })
  })
  playlistSync.on('sync:progress', (playlistId: string, data: any) => {
    opts.forward('sync:progress', { playlistId, ...data })
  })
  playlistSync.on('sync:complete', (playlistId: string, result: any) => {
    opts.forward('sync:complete', { playlistId, ...result })
  })
  playlistSync.on('sync:error', (playlistId: string, error: string) => {
    opts.forward('sync:error', { playlistId, error })
  })

  // Artist sync engine — shares the download-settings provider with playlistSync
  // so quality, folder structure, templates, and metadata stay consistent.
  artistSync.setSettingsProvider(() => {
    const s = server.getSettings()
    return {
      downloadPath: s.downloadPath,
      quality: s.quality,
      bitrateFallback: s.bitrateFallback,
      isrcFallback: s.isrcFallback,
      createArtistFolder: s.createArtistFolder,
      createAlbumFolder: s.createAlbumFolder,
      saveArtwork: s.saveArtwork,
      embedArtwork: s.embedArtwork,
      saveLyrics: s.saveLyrics,
      syncedLyrics: s.syncedLyrics,
      preferSyncedLyrics: s.preferSyncedLyrics,
      deleteSupersededLyrics: s.deleteSupersededLyrics,
      createErrorLog: s.createErrorLog,
      overwriteFiles: s.overwriteFiles,
      skipDuplicateTracks: s.skipDuplicateTracks,
      maxConcurrentDownloads: s.maxConcurrentDownloads,
      folderSettings: {
        createPlaylistFolder: s.createPlaylistFolder,
        createArtistFolder: s.createArtistFolder,
        createAlbumFolder: s.createAlbumFolder,
        createCDFolder: s.createCDFolder,
        createPlaylistStructure: s.createPlaylistStructure,
        createSinglesStructure: s.createSinglesStructure,
        createShortReleaseFolder: s.createShortReleaseFolder,
        playlistFolderTemplate: s.playlistFolderTemplate,
        albumFolderTemplate: s.albumFolderTemplate,
        artistFolderTemplate: s.artistFolderTemplate
      },
      trackTemplates: {
        trackNameTemplate: s.trackNameTemplate,
        albumTrackTemplate: s.albumTrackTemplate,
        playlistTrackTemplate: s.playlistTrackTemplate
      },
      metadataSettings: {
        tags: s.tags,
        albumCovers: s.albumCovers,
        useNullSeparator: s.useNullSeparator,
        saveID3v1: s.saveID3v1,
        saveOnlyMainArtist: s.saveOnlyMainArtist,
        artistSeparator: s.artistSeparator,
        dateFormatFlac: s.dateFormatFlac,
        titleCasing: s.titleCasing,
        artistCasing: s.artistCasing,
        removeAlbumVersion: s.removeAlbumVersion,
        featuredArtistsHandling: s.featuredArtistsHandling,
        keepVariousArtists: s.keepVariousArtists,
        removeArtistCombinations: s.removeArtistCombinations
      }
    }
  })

  await artistSync.init()
  console.log('[Main] Artist sync engine initialized')

  artistSync.on('sync:start', (artistId: string) => {
    opts.forward('artistSync:start', { artistId })
  })
  artistSync.on('sync:progress', (artistId: string, data: any) => {
    opts.forward('artistSync:progress', { artistId, ...data })
  })
  artistSync.on('sync:complete', (artistId: string, result: any) => {
    opts.forward('artistSync:complete', { artistId, ...result })
  })
  artistSync.on('sync:error', (artistId: string, error: string) => {
    opts.forward('artistSync:error', { artistId, error })
  })
}
