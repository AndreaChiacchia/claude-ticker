import type { Entry, Live } from '../types'
import { GLYPH, mixColor } from './cells'
import { cacheHit, formatCost, shortTool, toneFor } from './format'
import type { Effects, Settings } from './row'

/** One animation frame lasts this long. */
export const FRAME_MS = 100

/** A size or color change takes this many frames (0.4 s at 10 frames per second). */
export const GROW_FRAMES = 4

/** The row stays at least this many frames (2 s at 10 frames per second) on a turn before it moves to another. */
export const FOCUS_HOLD = 20

export type Odo = { shown: number; target: number; flashFrom: number; flashUntil: number; flashDir: 'up' | 'down' }
/** Why the row shows a turn: it runs, a background helper is still adding to it, or it is simply the newest. */
export type FocusMode = 'live' | 'growing' | 'rest'
/** The turn the row describes; `since` is the tick this turn began to be shown in this mode. */
export type Focus = { n: number; mode: FocusMode; since: number }
export type BadgeKind = 'none' | 'tool' | 'cheap' | 'high'
export type Badge = { kind: BadgeKind; text: string; from: number; until: number }
/** A value (or a color, when `isColor`) on its way from `from` to `to`, begun at tick `start`. */
export type Tween = { from: number; to: number; start: number; isColor: boolean }

export type Anim = {
  tick: number
  sessionId: string | null
  isPrimed: boolean
  sigma: Odo
  turn: Odo
  badge: Badge
  bumpUntil: number
  lastSeenN: number
  liveTurnId: string | null
  /** Turn numbers that already raised the NEW HIGH badge. */
  highFired: Set<number>
  /** The cost each finished turn had at the last sync, to see which ones grew. */
  entryCosts: Map<number, number>
  cheapFiredFor: number
  /** Tokens are flowing (a streamed chunk arrived) until this tick. */
  flowUntil: number
  tweens: Map<string, Tween>
  /** The turn the row describes (see `pickFocus`); null until the first sync. */
  focus: Focus | null
}

/** What the row shows: the finished entries, the running turn, the session ledger and `growing`: finished turns with a helper at work, by last activity (most recent last). */
export type Scene = { entries: Entry[]; live: Live | null; ledger: number | null; growing: number[] }

const newOdo = (): Odo => ({ shown: 0, target: 0, flashFrom: 0, flashUntil: 0, flashDir: 'up' })

export function createAnim(tick = 0): Anim {
  return {
    tick,
    sessionId: null,
    isPrimed: false,
    sigma: newOdo(),
    turn: newOdo(),
    badge: { kind: 'none', text: '', from: 0, until: 0 },
    bumpUntil: 0,
    lastSeenN: 0,
    liveTurnId: null,
    highFired: new Set(),
    entryCosts: new Map(),
    cheapFiredFor: 0,
    flowUntil: 0,
    tweens: new Map(),
    focus: null,
  }
}

export function setOdo(o: Odo, target: number, jump: boolean): void {
  o.target = target
  if (jump) {
    o.shown = target
    o.flashUntil = 0
  }
}

/** One frame of the odometer: the shown figure moves toward the target; digits that changed flash for 3 frames. */
export function stepOdo(o: Odo, tick: number): void {
  const diff = o.target - o.shown
  const dist = Math.abs(diff)
  if (dist < 0.0005) {
    o.shown = o.target

    return
  }
  const old = o.shown
  const unit = old < 0.1 ? 0.001 : 0.01
  const step = Math.max(unit, dist / 4)
  o.shown = step >= dist - 1e-9 ? o.target : old + Math.sign(diff) * step
  const before = Array.from(formatCost(old))
  const after = Array.from(formatCost(o.shown))
  if (before.join('') === after.join('')) return
  const common = Math.min(before.length, after.length)
  let from = common
  for (let i = 0; i < common; i++) {
    if (before[i] !== after[i]) {
      from = i
      break
    }
  }
  o.flashFrom = from
  o.flashUntil = tick + 3
  o.flashDir = o.target > old ? 'up' : 'down'
}

const PRIORITY: Record<BadgeKind, number> = { none: 0, tool: 1, cheap: 2, high: 3 }

/** Shows a badge unless one with a higher priority is still showing. */
export function raiseBadge(anim: Anim, kind: Exclude<BadgeKind, 'none'>, text: string, frames: number): void {
  const b = anim.badge
  if (b.kind !== 'none' && anim.tick < b.until && PRIORITY[b.kind] > PRIORITY[kind]) return
  anim.badge = { kind, text, from: anim.tick, until: anim.tick + frames }
}

/** The bar's tip flashes for 2 frames. */
export function bump(anim: Anim): void {
  anim.bumpUntil = anim.tick + 2
}

/** A tool call: its name in the badge for 8 frames, and a bump. */
export function flashTool(anim: Anim, tool: string): void {
  raiseBadge(anim, 'tool', String.fromCodePoint(GLYPH.toolL) + shortTool(tool) + String.fromCodePoint(GLYPH.toolR), 8)
  bump(anim)
}

/** A streamed chunk arrived: the current turn shimmers for the next 5 frames (0.5 s). */
export function markFlow(anim: Anim): void {
  anim.flowUntil = anim.tick + 5
}

// ---- easing -------------------------------------------------------------------------------------

/** The value of a tween at the animation's tick: ease-out quadratic over `GROW_FRAMES`, exactly on `to` at the end. */
function valueAt(anim: Anim, t: Tween): number {
  if (t.from === t.to) return t.to
  const p = Math.min(1, (anim.tick - t.start) / GROW_FRAMES)
  if (p >= 1) return t.to
  const e = 1 - (1 - p) * (1 - p)

  return t.isColor ? mixColor(t.from, t.to, e) : t.from + (t.to - t.from) * e
}

const isDone = (anim: Anim, t: Tween): boolean => t.from === t.to || anim.tick - t.start >= GROW_FRAMES

function tweenKey(anim: Anim, key: string, target: number, animate: boolean, isColor: boolean): number {
  const tw = anim.tweens.get(key)
  if (tw === undefined) {
    anim.tweens.set(key, { from: target, to: target, start: anim.tick, isColor })

    return target
  }
  if (tw.to !== target) {
    tw.from = animate ? valueAt(anim, tw) : target
    tw.to = target
    tw.start = anim.tick
  }

  return valueAt(anim, tw)
}

/**
 * Moves the number kept under `key` toward `target` and returns its value at this tick. A new key starts
 * settled at the target; a changed target eases from the current value (at once when `animate` is false).
 */
export function tweenTo(anim: Anim, key: string, target: number, animate: boolean): number {
  return tweenKey(anim, key, target, animate, false)
}

/** `tweenTo` for a color: the blend goes through `mixColor`. */
export function tweenColorTo(anim: Anim, key: string, target: number, animate: boolean): number {
  return tweenKey(anim, key, target, animate, true)
}

/** The value of `key` at this tick, without retargeting; undefined when the key is unknown. */
export function tweenValue(anim: Anim, key: string): number | undefined {
  const tw = anim.tweens.get(key)

  return tw === undefined ? undefined : valueAt(anim, tw)
}

/** True while `key` is still on its way to its target. */
export function isTweening(anim: Anim, key: string): boolean {
  const tw = anim.tweens.get(key)

  return tw !== undefined && !isDone(anim, tw)
}

/** Forgets every tween whose key is not in `keys`. */
export function pruneTweens(anim: Anim, keys: ReadonlySet<string>): void {
  for (const key of Array.from(anim.tweens.keys())) {
    if (!keys.has(key)) anim.tweens.delete(key)
  }
}

// ---- the turn the row follows -------------------------------------------------------------------

/**
 * Which turn the row describes. A running main turn always wins. Otherwise a finished turn whose background helper is
 * still working (the one that was active last), otherwise the newest turn. The choice stays at least `hold` frames
 * on a turn before it moves; a turn that stopped (its main turn ended, or its helper finished) stays `hold` frames with its
 * final figures. Pure: `prev` is never changed, and is returned itself when nothing moved.
 */
export function pickFocus(scene: Scene, prev: Focus | null, tick: number, hold: number): Focus {
  const { entries, live, growing } = scene
  const lastN = entries.at(-1)?.n ?? 0
  const has = (n: number): boolean => entries.some(x => x.n === n)
  const modeOf = (n: number): FocusMode => (growing.includes(n) ? 'growing' : 'rest')
  const keep = (n: number, mode: FocusMode): Focus => (prev !== null && prev.n === n && prev.mode === mode ? prev : { n, mode, since: tick })

  if (live !== null) return keep(lastN + 1, 'live')

  let want: { n: number; mode: FocusMode } = { n: lastN, mode: 'rest' }
  for (let i = growing.length - 1; i >= 0; i--) {
    const g = growing[i]
    if (g !== undefined && has(g)) {
      want = { n: g, mode: 'growing' }
      break
    }
  }
  if (hold <= 0 || prev === null) return keep(want.n, want.mode)

  // The running turn has just ended: it stays with its final figures, as the newest turn (never as `prev.n`, which may be one too high).
  if (prev.mode === 'live') {
    return entries.length === 0 ? keep(want.n, want.mode) : { n: lastN, mode: modeOf(lastN), since: tick }
  }
  if (!has(prev.n)) return keep(want.n, want.mode)
  // Its helper started or finished: the hold starts over.
  if (modeOf(prev.n) !== prev.mode) return { n: prev.n, mode: modeOf(prev.n), since: tick }
  if (want.n === prev.n) return prev

  return tick - prev.since >= hold ? { n: want.n, mode: want.mode, since: tick } : prev
}

/** True when the focus is where `pickFocus` would put it without any hold: no switch is waiting for its time. */
export function isFocusSettled(anim: Anim, scene: Scene): boolean {
  if (anim.focus === null) return false
  const f = pickFocus(scene, anim.focus, anim.tick, 0)

  return f.n === anim.focus.n && f.mode === anim.focus.mode
}

/**
 * Chooses the focus for this tick and points the turn odometer at its cost. A switch to another turn snaps the figure
 * (rolling from one turn's cost into another's would read as a change of this one); the same turn growing rolls with `stock`.
 */
export function syncFocus(anim: Anim, scene: Scene, stock: boolean, hold: number): void {
  const before = anim.focus
  const f = pickFocus(scene, before, anim.tick, hold)
  anim.focus = f
  const { live, entries } = scene
  const target = f.mode === 'live' ? (live?.costUsd ?? 0) : (entries.find(x => x.n === f.n)?.costUsd ?? 0)
  const jump =
    before === null ||
    !anim.isPrimed ||
    !stock ||
    (live !== null && live.turnId !== anim.liveTurnId) ||
    (before.n !== f.n && before.mode !== 'live')
  setOdo(anim.turn, target, jump)
  anim.liveTurnId = live?.turnId ?? null
}

/** One frame, in this order: the clock, the odometers, the badge expiry. */
export function advance(anim: Anim, effects: Effects): void {
  anim.tick += 1
  if (effects.stock) {
    stepOdo(anim.sigma, anim.tick)
    stepOdo(anim.turn, anim.tick)
  } else {
    anim.sigma.shown = anim.sigma.target
    anim.turn.shown = anim.turn.target
  }
  if (anim.badge.kind !== 'none' && anim.tick >= anim.badge.until) anim.badge = { kind: 'none', text: '', from: 0, until: 0 }
}

/** True when nothing is moving any more: the timer can stop. */
export function isSettled(anim: Anim): boolean {
  const odoDone = (o: Odo) => o.shown === o.target && anim.tick >= o.flashUntil
  for (const tw of anim.tweens.values()) {
    if (!isDone(anim, tw)) return false
  }

  return odoDone(anim.sigma) && odoDone(anim.turn) && anim.badge.kind === 'none' && anim.tick >= anim.bumpUntil
}

const HIGH_TEXT = String.fromCodePoint(GLYPH.bang) + ' NEW HIGH ' + String.fromCodePoint(GLYPH.bang)

/**
 * Points the animation targets at the session: the figures to roll to, and the one-off events
 * (a new finished turn, a new high) that raise badges. The first call primes silently.
 */
export function syncTargets(
  anim: Anim,
  scene: Scene,
  settings: Settings,
  sessionId: string | null,
  hold: number = FOCUS_HOLD,
): void {
  const { effects } = settings
  const { entries, live, ledger } = scene
  if (anim.sessionId !== sessionId) {
    Object.assign(anim, createAnim(anim.tick))
    anim.sessionId = sessionId
  }
  const costs = entries.map(x => x.costUsd)
  const newest = entries.at(-1)
  const lastN = newest?.n ?? 0

  setOdo(anim.sigma, ledger ?? costs.reduce((s, x) => s + x, 0), !anim.isPrimed || !effects.stock)

  syncFocus(anim, scene, effects.stock, hold)

  // The numbers start over after /ticker clear: forget the turns that fired.
  if (lastN < anim.lastSeenN) {
    anim.highFired.clear()
    anim.cheapFiredFor = 0
  }

  if (anim.isPrimed && lastN > anim.lastSeenN && newest) {
    const earlier = costs.slice(0, -1)
    if (effects.celebrate) {
      if (earlier.length >= 3 && newest.costUsd > Math.max(...earlier) && !anim.highFired.has(lastN)) {
        raiseBadge(anim, 'high', HIGH_TEXT, 10)
        anim.highFired.add(lastN)
      }
      if (toneFor(newest.costUsd, costs) === 'ok' && cacheHit(newest) >= 80 && anim.cheapFiredFor !== lastN) {
        raiseBadge(anim, 'cheap', '', 20)
        anim.cheapFiredFor = lastN
      }
    }
  }
  anim.lastSeenN = lastN

  // A finished turn that grew (a background helper at work) and became the session maximum raises the badge once.
  if (anim.isPrimed && effects.celebrate) {
    for (const e of entries) {
      const before = anim.entryCosts.get(e.n)
      if (before === undefined || e.costUsd <= before + 1e-9 || anim.highFired.has(e.n)) continue
      const others = entries.filter(x => x.n !== e.n).map(x => x.costUsd)
      if (others.length >= 3 && e.costUsd > Math.max(...others)) {
        raiseBadge(anim, 'high', HIGH_TEXT, 10)
        anim.highFired.add(e.n)
      }
    }
  }
  anim.entryCosts = new Map(entries.map(x => [x.n, x.costUsd]))

  if (
    effects.celebrate &&
    live &&
    entries.length >= 3 &&
    live.costUsd > Math.max(...costs) &&
    !anim.highFired.has(lastN + 1)
  ) {
    raiseBadge(anim, 'high', HIGH_TEXT, 10)
    anim.highFired.add(lastN + 1)
  }

  anim.isPrimed = true
}
