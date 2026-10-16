// The looks of the three visuals: the meter bar, the chart bars and the strip blocks.
import { SEP, TRACK_HEAVY } from './cells'

// ---- the meter bar ------------------------------------------------------------------------------

export type MeterStyleId =
  | 'blocks'
  | 'parallelogram'
  | 'shade'
  | 'solid'
  | 'smooth'
  | 'smooth-bare'
  | 'line'
  | 'heavy'
  | 'dots'
  | 'squares'
  | 'diamonds'
  | 'braille'
  | 'ascii'
  | 'arrow'

export const METER_STYLE_IDS: readonly MeterStyleId[] = [
  'blocks',
  'parallelogram',
  'shade',
  'solid',
  'smooth',
  'smooth-bare',
  'line',
  'heavy',
  'dots',
  'squares',
  'diamonds',
  'braille',
  'ascii',
  'arrow',
]

export const DEFAULT_METER_STYLE: MeterStyleId = 'blocks'

export function isMeterStyle(v: unknown): v is MeterStyleId {
  return typeof v === 'string' && (METER_STYLE_IDS as readonly string[]).includes(v)
}

/**
 * One look of the meter bar, as code points. `eighths`: 'moving' draws an eighth-block tip only while the bar eases,
 * 'always' draws it at rest too, 'never' uses whole cells only. `open` / `close` frame the bar; `head` is the arrow tip.
 */
export type MeterStyle = {
  fill: number
  track: number
  trackColor: number
  open?: number
  close?: number
  head?: number
  eighths: 'never' | 'moving' | 'always'
}

export const METER_STYLES: Record<MeterStyleId, MeterStyle> = {
  blocks: { fill: 0x2588, track: 0x2591, trackColor: SEP, eighths: 'moving' },
  parallelogram: { fill: 0x25b0, track: 0x25b1, trackColor: SEP, eighths: 'never' },
  shade: { fill: 0x2593, track: 0x2591, trackColor: SEP, eighths: 'never' },
  solid: { fill: 0x2588, track: 0x2588, trackColor: SEP, eighths: 'never' },
  smooth: { fill: 0x2588, track: 0x2591, trackColor: SEP, eighths: 'always' },
  'smooth-bare': { fill: 0x2588, track: 0x20, trackColor: SEP, eighths: 'always' },
  line: { fill: 0x2501, track: 0x2500, trackColor: SEP, eighths: 'never' },
  heavy: { fill: 0x2501, track: 0x2501, trackColor: TRACK_HEAVY, eighths: 'never' },
  dots: { fill: 0x25cf, track: 0x25cb, trackColor: SEP, eighths: 'never' },
  squares: { fill: 0x25a0, track: 0x25a1, trackColor: SEP, eighths: 'never' },
  diamonds: { fill: 0x25c6, track: 0x25c7, trackColor: SEP, eighths: 'never' },
  braille: { fill: 0x28ff, track: 0x28c0, trackColor: SEP, eighths: 'never' },
  ascii: { fill: 0x23, track: 0x2d, trackColor: SEP, open: 0x5b, close: 0x5d, eighths: 'never' },
  arrow: { fill: 0x3d, track: 0x20, trackColor: SEP, open: 0x5b, close: 0x5d, head: 0x3e, eighths: 'never' },
}

// ---- the chart bars -----------------------------------------------------------------------------

export type ChartStyleId = 'spark' | 'braille' | 'shade'

export const CHART_STYLE_IDS: readonly ChartStyleId[] = ['spark', 'braille', 'shade']

export const DEFAULT_CHART_STYLE: ChartStyleId = 'spark'

export function isChartStyle(v: unknown): v is ChartStyleId {
  return typeof v === 'string' && (CHART_STYLE_IDS as readonly string[]).includes(v)
}

/** `levels[k - 1]` is the glyph of level k (1..8); `empty` is the glyph of an empty slot and of a zero-cost turn. */
export type ChartStyle = { levels: readonly number[]; empty: number }

export const CHART_STYLES: Record<ChartStyleId, ChartStyle> = {
  spark: { levels: [0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588], empty: 0x2581 },
  braille: { levels: [0x2840, 0x28c0, 0x28c4, 0x28e4, 0x28e6, 0x28f6, 0x28f7, 0x28ff], empty: 0x28c0 },
  shade: { levels: [0x2591, 0x2591, 0x2592, 0x2592, 0x2593, 0x2593, 0x2588, 0x2588], empty: 0x2591 },
}

// ---- the strip blocks ---------------------------------------------------------------------------

export type StripStyleId = 'blocks' | 'shade' | 'parallelogram' | 'squares' | 'dots' | 'braille' | 'ascii'

export const STRIP_STYLE_IDS: readonly StripStyleId[] = ['blocks', 'shade', 'parallelogram', 'squares', 'dots', 'braille', 'ascii']

export const DEFAULT_STRIP_STYLE: StripStyleId = 'blocks'

export function isStripStyle(v: unknown): v is StripStyleId {
  return typeof v === 'string' && (STRIP_STYLE_IDS as readonly string[]).includes(v)
}

/**
 * `fill: null` is the background-colored block; otherwise every cell of a block is `fill` in the block's color.
 * `lead` is the glyph of the first cell of every block after the first (it belongs to the block's own width).
 */
export type StripStyle = { fill: number | null; lead: number }

export const STRIP_STYLES: Record<StripStyleId, StripStyle> = {
  blocks: { fill: null, lead: 0x258f },
  shade: { fill: 0x2593, lead: 0x2591 },
  parallelogram: { fill: 0x25b0, lead: 0x25b1 },
  squares: { fill: 0x25a0, lead: 0x25a1 },
  dots: { fill: 0x25cf, lead: 0x25cb },
  braille: { fill: 0x28ff, lead: 0x28c0 },
  ascii: { fill: 0x23, lead: 0x7c },
}
