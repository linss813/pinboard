import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { IMAGE_MIME_WHITELIST, MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION } from '../shared/constants'
import { t } from './i18n'
import { blobToDataUrl } from './util'

const DB_NAME = 'pinboard-assets'
const STORE = 'assets'

interface AssetEntry {
  id: string
  mime: string
  blob: Blob | null
  bitmap: ImageBitmap | null
  objectUrl: string | null
  uploaded: boolean
  loading: Promise<ImageBitmap | null> | null
  retryAt: number
  uploadTimer: ReturnType<typeof setTimeout> | null
}

interface StoredAsset {
  blob: Blob
  mime: string
  uploaded: boolean
}

interface DbLike {
  get(key: string): Promise<StoredAsset | null>
  put(key: string, value: StoredAsset): Promise<void>
}

function openDb(): Promise<DbLike | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
      }
      request.onsuccess = () => {
        const db = request.result
        resolve({
          get: (key) =>
            new Promise((res) => {
              const tx = db.transaction(STORE, 'readonly')
              const req = tx.objectStore(STORE).get(key)
              req.onsuccess = () => res((req.result as StoredAsset | undefined) ?? null)
              req.onerror = () => res(null)
            }),
          put: (key, value) =>
            new Promise((res) => {
              const tx = db.transaction(STORE, 'readwrite')
              tx.objectStore(STORE).put(value, key)
              tx.oncomplete = () => res()
              tx.onerror = () => res()
            }),
        })
      }
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function isImageMime(mime: string): boolean {
  return (IMAGE_MIME_WHITELIST as readonly string[]).includes(mime)
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), mime, quality))
}

export type AssetErrorCode = 'missing' | 'load' | 'unsupported' | 'tooLarge' | 'decode' | 'process'

export class AssetError extends Error {
  readonly code: AssetErrorCode

  constructor(code: AssetErrorCode, message: string) {
    super(message)
    this.name = 'AssetError'
    this.code = code
  }
}

export class AssetStore {
  private entries = new Map<string, AssetEntry>()
  private dbPromise: Promise<DbLike | null>
  private onChange: () => void = () => undefined

  constructor(private readonly roomId: string) {
    this.dbPromise = openDb()
  }

  setOnChange(callback: () => void): void {
    this.onChange = callback
  }

  private key(id: string): string {
    return `${this.roomId}:${id}`
  }

  private apiUrl(id: string): string {
    return `/api/rooms/${encodeURIComponent(this.roomId)}/assets/${id}`
  }

  peekBitmap(id: string): ImageBitmap | null {
    const entry = this.entries.get(id)
    if (!entry) {
      void this.ensure(id)
      return null
    }
    if (entry.bitmap) return entry.bitmap
    if (!entry.loading && Date.now() >= entry.retryAt) void this.ensure(id)
    return null
  }

  displayUrl(id: string): string {
    return this.entries.get(id)?.objectUrl ?? this.apiUrl(id)
  }

  async ensure(id: string): Promise<ImageBitmap | null> {
    if (!id) return null
    let entry = this.entries.get(id)
    if (entry?.bitmap) return entry.bitmap
    if (entry?.loading) return entry.loading
    if (entry && entry.retryAt > Date.now()) return null
    if (!entry) {
      entry = {
        id,
        mime: '',
        blob: null,
        bitmap: null,
        objectUrl: null,
        uploaded: true,
        loading: null,
        retryAt: 0,
        uploadTimer: null,
      }
      this.entries.set(id, entry)
    }
    const current = entry
    current.loading = (async () => {
      try {
        const db = await this.dbPromise
        let stored = await db?.get(this.key(id)) ?? null
        let blob: Blob | null = stored?.blob ?? null
        if (!blob) {
          const res = await fetch(this.apiUrl(id), { cache: 'force-cache' })
          if (!res.ok) {
            throw res.status === 404
              ? new AssetError('missing', t('error.assetMissing'))
              : new AssetError('load', t('error.assetLoad'))
          }
          blob = await res.blob()
          stored = { blob, mime: blob.type, uploaded: true }
          await db?.put(this.key(id), stored)
        }
        if (blob.size > MAX_IMAGE_BYTES) throw new AssetError('tooLarge', t('error.imageTooLarge'))
        current.blob = blob
        current.mime = stored?.mime || blob.type
        current.uploaded = stored?.uploaded ?? true
        current.bitmap = await createImageBitmap(blob)
        current.objectUrl = URL.createObjectURL(blob)
        current.retryAt = 0
        if (!current.uploaded) this.scheduleUpload(id)
        this.onChange()
        return current.bitmap
      } catch (error) {
        current.retryAt = Date.now() + 5000
        if (!(error instanceof AssetError) || error.code !== 'missing') {
          console.warn('[assets] load failed', id, error)
        }
        return null
      } finally {
        current.loading = null
      }
    })()
    return current.loading
  }

  async ensureAll(ids: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(ids)].map((id) => this.ensure(id)))
  }

  async getBlob(id: string): Promise<Blob | null> {
    await this.ensure(id)
    return this.entries.get(id)?.blob ?? null
  }

  async dataUrl(id: string): Promise<string | null> {
    const blob = await this.getBlob(id)
    return blob ? blobToDataUrl(blob) : null
  }

  async importFile(file: File): Promise<{
    assetId: string
    naturalW: number
    naturalH: number
  }> {
    if (!isImageMime(file.type)) throw new AssetError('unsupported', t('error.imageUnsupported'))
    if (file.size > MAX_IMAGE_BYTES) throw new AssetError('tooLarge', t('error.imageTooLarge'))
    const processed = await this.processBlob(file)
    return this.ingestBlob(processed.blob, processed.mime, processed.width, processed.height)
  }

  async ingestBlob(blob: Blob, mime: string, width?: number, height?: number): Promise<{
    assetId: string
    naturalW: number
    naturalH: number
  }> {
    if (!isImageMime(mime)) throw new AssetError('unsupported', t('error.imageUnsupported'))
    let finalBlob = blob
    let finalMime = mime
    let w = width
    let h = height
    if (!w || !h) {
      const processed = await this.processBlob(blob)
      finalBlob = processed.blob
      finalMime = processed.mime
      w = processed.width
      h = processed.height
    }
    if (finalBlob.size > MAX_IMAGE_BYTES) throw new AssetError('tooLarge', t('error.imageTooLarge'))
    const bytes = new Uint8Array(await finalBlob.arrayBuffer())
    const id = bytesToHex(sha256(bytes))
    let entry = this.entries.get(id)
    if (!entry) {
      entry = {
        id,
        mime: finalMime,
        blob: finalBlob,
        bitmap: null,
        objectUrl: null,
        uploaded: false,
        loading: null,
        retryAt: 0,
        uploadTimer: null,
      }
      this.entries.set(id, entry)
    }
    entry.blob = finalBlob
    entry.mime = finalMime
    if (!entry.bitmap) {
      try {
        entry.bitmap = await createImageBitmap(finalBlob)
        entry.objectUrl = URL.createObjectURL(finalBlob)
      } catch {
        // the browser rejected decoding; the upload will fail as well
      }
    }
    const db = await this.dbPromise
    await db?.put(this.key(id), { blob: finalBlob, mime: finalMime, uploaded: false })
    await this.upload(id)
    this.onChange()
    return { assetId: id, naturalW: w, naturalH: h }
  }

  private async processBlob(blob: Blob): Promise<{ blob: Blob; mime: string; width: number; height: number }> {
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(blob)
    } catch {
      throw new AssetError('decode', t('error.imageDecode'))
    }
    const width = bitmap.width
    const height = bitmap.height
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height))
    const shouldResize = scale < 1
    const shouldReencode = shouldResize || blob.size > 2.5 * 1024 * 1024
    if (!shouldResize && (!shouldReencode || blob.type === 'image/gif')) {
      bitmap.close()
      return { blob, mime: blob.type, width, height }
    }
    const targetW = Math.max(1, Math.round(width * scale))
    const targetH = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      throw new AssetError('process', t('error.imageProcess'))
    }
    ctx.drawImage(bitmap, 0, 0, targetW, targetH)
    bitmap.close()
    const mime = 'image/webp'
    const out = await canvasToBlob(canvas, mime, 0.9)
    if (!out) throw new AssetError('process', t('error.imageProcess'))
    return { blob: out, mime, width: targetW, height: targetH }
  }

  private scheduleUpload(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.uploadTimer || entry.uploaded) return
    entry.uploadTimer = setTimeout(() => {
      entry.uploadTimer = null
      void this.upload(id)
    }, 2500)
  }

  private async upload(id: string): Promise<boolean> {
    const entry = this.entries.get(id)
    if (!entry?.blob) return false
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(this.roomId)}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': entry.mime || entry.blob.type },
        body: entry.blob,
      })
      if (!res.ok) throw new Error(`upload failed: ${res.status}`)
      const data = (await res.json()) as { id?: string }
      entry.uploaded = true
      entry.retryAt = 0
      const db = await this.dbPromise
      await db?.put(this.key(id), { blob: entry.blob, mime: entry.mime, uploaded: true })
      if (data.id && data.id !== id) {
        // The server also hashes the bytes; keep the local id if they differ.
      }
      return true
    } catch (error) {
      console.warn('[assets] upload failed, will retry', id, error)
      entry.uploaded = false
      this.scheduleUpload(id)
      return false
    }
  }

  async retryPending(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (!entry.uploaded && entry.blob) void this.upload(entry.id)
    }
  }
}
