export interface CacheOptions<K, V> {
  maxEntries: number
  maxWeight?: number
  ttl?: number
  weight?: (value: V, key: K) => number
  isPinned?: (key: K) => boolean
  now?: () => number
}

/** LRU storage for disposable references; pinned callers retain their original values. */
export class BoundedCache<K, V> extends Map<K, V> {
  private options: CacheOptions<K, V>
  private readonly touched = new Map<K, number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  generation = 0

  constructor(options: CacheOptions<K, V>) {
    super()
    this.options = options
  }

  private now() { return (this.options.now ?? Date.now)() }
  private pinned(key: K) { return this.options.isPinned?.(key) ?? false }

  private scheduleExpiry() {
    if (this.timer != null) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.options.ttl) return
    let expiry = Infinity
    for (const [key, touched] of this.touched) {
      if (!this.pinned(key)) expiry = Math.min(expiry, touched + this.options.ttl)
    }
    if (!Number.isFinite(expiry)) return
    this.timer = setTimeout(() => { this.timer = undefined; this.prune() }, Math.max(1, expiry - this.now()))
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  get weight() {
    let weight = 0
    for (const [key, value] of this) if (!this.pinned(key)) weight += this.options.weight?.(value, key) ?? 1
    return weight
  }

  override has(key: K): boolean {
    if (super.has(key) && !this.pinned(key) && this.options.ttl &&
      this.now() - (this.touched.get(key) ?? 0) >= this.options.ttl) this.delete(key)
    return super.has(key)
  }

  override get(key: K): V | undefined {
    if (!this.has(key)) return undefined
    const value = super.get(key)!
    super.delete(key)
    super.set(key, value)
    this.touched.set(key, this.now())
    this.scheduleExpiry()
    return value
  }

  override set(key: K, value: V): this {
    super.delete(key)
    super.set(key, value)
    this.touched.set(key, this.now())
    this.prune()
    return this
  }

  override delete(key: K): boolean {
    this.touched.delete(key)
    const removed = super.delete(key)
    this.scheduleExpiry()
    return removed
  }

  override clear(): void {
    this.generation++
    super.clear()
    this.touched.clear()
    if (this.timer != null) clearTimeout(this.timer)
    this.timer = undefined
  }

  configure(options: Partial<CacheOptions<K, V>>) {
    this.options = { ...this.options, ...options }
    this.prune()
  }

  prune() {
    let weight = 0
    let count = 0
    const candidates: K[] = []
    const now = this.now()
    for (const [key, value] of this) {
      if (this.pinned(key)) continue
      const itemWeight = this.options.weight?.(value, key) ?? 1
      const expired = this.options.ttl != null && this.options.ttl > 0 && now - (this.touched.get(key) ?? 0) >= this.options.ttl
      if (expired || itemWeight > (this.options.maxWeight ?? Infinity)) {
        super.delete(key)
        this.touched.delete(key)
        continue
      }
      candidates.push(key)
      weight += itemWeight
      count++
    }
    for (const key of candidates) {
      if (count <= this.options.maxEntries && weight <= (this.options.maxWeight ?? Infinity)) break
      weight -= this.options.weight?.(super.get(key)!, key) ?? 1
      count--
      super.delete(key)
      this.touched.delete(key)
    }
    this.scheduleExpiry()
  }
}
