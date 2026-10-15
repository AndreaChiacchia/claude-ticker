import type { Delta } from './format'

/** The terminal's default color, as a Raster cell holds it (bit 24 alone). */
export const DEFAULT = 0x01000000
export const HOT = 0xff0000
export const UP = 0xff0000
export const DOWN = 0x5fff00
export const FLAT = 0x585858
export const FIGURES = 0x8a8a8a
export const SEP = 0x585858
/** The running turn: lavender, a hue none of the teal ramp steps has. */
export const LIVE = 0xafafd7

export const LIVE_FILL = 0xafafd7
export const LIVE_BUMP = 0xd7d7ff
export const WHITE = 0xffffff
export const DARK = 0x1c1c1c
export const EMPTY_BAR = 0x303030
export const FLASH_UP = 0x5fff00
export const FLASH_DOWN = 0xff0000
export const HIGH_BG = 0xd70000
export const CHEAP = 0x5fff00
/** The token digits that changed, going up: claudespotter's warm white-gold glint. */
export const TOKEN_FLASH_UP = 0xfff5d7
/** The token digits that changed, going down: claudespotter's ice-cyan glint. */
export const TOKEN_FLASH_DOWN = 0x5fd7ff

/** The teal scale of finished turns, cheap to pricey. */
export const RAMP: readonly number[] = [0x005f5f, 0x008787, 0x00afaf, 0x5fd7d7]

/** The color of a ramp step; gray (FIGURES) while the session is too young for a step. */
export function rampColor(step: 0 | 1 | 2 | 3 | null): number {
  if (step === null) return FIGURES

  return RAMP[step] ?? FIGURES
}

/** `color` moved `amount` (0..1) toward white, per channel; the terminal default stays as it is. */
export function lighten(color: number, amount: number): number {
  if (color === DEFAULT) return DEFAULT
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  const up = (c: number): number => Math.round(c + (255 - c) * amount)

  return (up(r) << 16) | (up(g) << 8) | up(b)
}

/** `a` blended into `b` by `t` (0..1), per channel. A side that is the terminal default cannot blend: it switches at the half. */
export function mixColor(a: number, b: number, t: number): number {
  if (a === DEFAULT || b === DEFAULT) return t < 0.5 ? a : b
  const mix = (shift: number): number => {
    const ca = (a >> shift) & 0xff
    const cb = (b >> shift) & 0xff

    return Math.round(ca + (cb - ca) * t)
  }

  return (mix(16) << 16) | (mix(8) << 8) | mix(0)
}

/** True for a background light enough that dark glyphs read on it. */
export function isBright(bg: number): boolean {
  if (bg === DEFAULT) return false
  const r = (bg >> 16) & 0xff
  const g = (bg >> 8) & 0xff
  const b = bg & 0xff

  return 0.299 * r + 0.587 * g + 0.114 * b >= 110
}

/** Glyphs by code point. `bars` is indexed from 1; index 0 is unused. */
export const GLYPH = {
  sigma: 0x03a3,
  sep: 0x2502,
  live: 0x25cf,
  liveOff: 0x25cb,
  /** The empty cell of the meter bar (the Blocks look). */
  track: 0x2591,
  /** The filled cell of the meter bar. */
  full: 0x2588,
  /** A thin line at the left edge of a cell: the boundary between strip blocks that touch. */
  hairline: 0x258f,
  bars: [0x20, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588],
  toolL: 0x2039,
  toolR: 0x203a,
  bang: 0x203c,
  star1: 0x2726,
  star2: 0x2727,
  /** The marker of a finished turn a background helper is still adding to. */
  refresh: 0x21bb,
}

/** `#rrggbb` for Text; undefined for the terminal default. */
export function hex(color: number): string | undefined {
  if (color === DEFAULT) return undefined

  return '#' + (color & 0xffffff).toString(16).padStart(6, '0')
}

export type Display = {
  label: 'symbol' | 'prompt' | 'number' | 'numbered'
  change: 'dollars' | 'percent' | 'off'
  tokens: 'compact' | 'labeled'
  cachePercent: 'off' | 'on'
}

export const DEFAULT_DISPLAY: Display = { label: 'symbol', change: 'dollars', tokens: 'compact', cachePercent: 'off' }

const CHOICES: { [K in keyof Display]: readonly Display[K][] } = {
  label: ['symbol', 'prompt', 'number', 'numbered'],
  change: ['dollars', 'percent', 'off'],
  tokens: ['compact', 'labeled'],
  cachePercent: ['off', 'on'],
}

function pick<K extends keyof Display>(options: Record<string, unknown>, key: K): Display[K] {
  const value = options[key]
  const found = CHOICES[key].find(c => c === value)

  return found ?? DEFAULT_DISPLAY[key]
}

/** The display settings, each falling back to its default when unknown. */
export function normalizeDisplay(options: Record<string, unknown>): Display {
  return {
    label: pick(options, 'label'),
    change: pick(options, 'change'),
    tokens: pick(options, 'tokens'),
    cachePercent: pick(options, 'cachePercent'),
  }
}

export const DELTA_COLOR: Record<Delta['dir'], number> = { up: UP, down: DOWN, flat: FLAT }

const PROMPT_CHARS = 18

export function labelText(display: Display, n: number, symbol: string, prompt: string): string {
  if (display.label === 'symbol') return symbol
  if (display.label === 'number') return `#${n}`
  if (display.label === 'numbered') return `#${n} ${symbol}`
  const chars = Array.from(prompt)
  const head = chars.slice(0, PROMPT_CHARS).join('')

  return `#${n} "${head}${chars.length > PROMPT_CHARS ? '…' : ''}"`
}

export type Cell = { cp: number; fg: number; bg: number }

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6)

const isZeroWidth = (cp: number): boolean => (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f)

const isUnsafe = (cp: number): boolean =>
  cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp > 0xffff || isZeroWidth(cp) || isWide(cp)

/** A code point a Raster takes; anything it would refuse (control, wide, zero-width, beyond the BMP) becomes `?`. */
export function safeCp(cp: number): number {
  return isUnsafe(cp) ? 0x3f : cp
}

/** One cell per code point of `text`, each through `safeCp`. */
export function textCells(text: string, fg: number, bg: number = DEFAULT): Cell[] {
  const cells: Cell[] = []
  for (const ch of text) {
    cells.push({ cp: safeCp(ch.codePointAt(0) ?? 0x3f), fg, bg })
  }

  return cells
}

/** `n` spaces on `bg`. */
export function blank(n: number, bg: number = DEFAULT): Cell[] {
  const cells: Cell[] = []
  for (let i = 0; i < n; i++) cells.push({ cp: 0x20, fg: DEFAULT, bg })

  return cells
}

/** The Raster's `cells` prop: little-endian u32 triplets [code point, foreground, background], in base64. */
export function encodeCells(cells: Cell[]): string {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach((cell, i) => {
    words[i * 3] = cell.cp
    words[i * 3 + 1] = cell.fg
    words[i * 3 + 2] = cell.bg
  })
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

/** The inverse of `encodeCells`. */
export function decodeCells(b64: string): Cell[] {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const words = new Uint32Array(bytes.buffer)
  const cells: Cell[] = []
  for (let i = 0; i + 2 < words.length; i += 3) {
    cells.push({ cp: words[i] ?? 0, fg: words[i + 1] ?? 0, bg: words[i + 2] ?? 0 })
  }

  return cells
}

export type Run = { text: string; fg: number; bg: number }

/** Trailing default-background spaces dropped, then equal neighbours merged: the cells as colored Text runs. */
export function runs(cells: Cell[]): Run[] {
  let end = cells.length
  while (end > 0) {
    const last = cells[end - 1]
    if (last !== undefined && last.cp === 0x20 && last.bg === DEFAULT) end--
    else break
  }
  const out: Run[] = []
  for (let i = 0; i < end; i++) {
    const cell = cells[i]
    if (cell === undefined) continue
    const prev = out[out.length - 1]
    const ch = String.fromCodePoint(cell.cp)
    if (prev !== undefined && prev.fg === cell.fg && prev.bg === cell.bg) prev.text += ch
    else out.push({ text: ch, fg: cell.fg, bg: cell.bg })
  }

  return out
}
