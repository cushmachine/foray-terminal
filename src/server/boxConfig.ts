// Per-box label and palette: an optional, non-secret ~/.foray/config.json
// (path overridable with FORAY_CONFIG) so two Foray servers can be told
// apart at a glance: tab title, home-screen name, theme colour, accent.
//
//   { "label": "Studio", "palette": { "accent": "#d4a72c" } }
//
// Palette keys are the colour tokens of src/styles.css :root without the
// leading `--`. Everything here is validated strictly because the values
// end up in an inline <style> and in HTML: a bad entry is dropped with a
// one-line warning, never a crash and never emitted. Read once at server
// start; `pm2 restart foray` applies a change.

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Logger } from './log.ts'

export const MAX_LABEL_LENGTH = 24

/** Colour tokens of styles.css :root a box may override. */
export const PALETTE_KEYS: readonly string[] = [
  'bg', 'surface', 'surface-raised', 'surface-hover', 'border', 'border-subtle',
  'text', 'text-dim', 'text-faint',
  'accent', 'accent-dim', 'accent-text', 'danger', 'danger-dim', 'warning', 'warning-dim',
  'key-bg', 'key-border', 'key-text', 'key-active',
  'term-cursor', 'term-selection',
  'ansi-black', 'ansi-red', 'ansi-green', 'ansi-yellow', 'ansi-blue', 'ansi-magenta',
  'ansi-cyan', 'ansi-white', 'ansi-bright-black', 'ansi-bright-red', 'ansi-bright-green',
  'ansi-bright-yellow', 'ansi-bright-blue', 'ansi-bright-magenta', 'ansi-bright-cyan',
  'ansi-bright-white',
]

export interface BoxConfig {
  label?: string
  /** Validated colours (plus derived ones), keyed without `--`. */
  palette: Record<string, string>
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const CHANNEL = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)'
const ALPHA = '(?:0|1|0?\\.\\d+|1\\.0+|\\d{1,3}%)'
const RGB = new RegExp(`^rgba?\\(\\s*${CHANNEL}\\s*,\\s*${CHANNEL}\\s*,\\s*${CHANNEL}\\s*(?:,\\s*${ALPHA}\\s*)?\\)$`, 'i')

/** Whether `value` is a literal colour safe to put in a stylesheet. */
export function isSafeColor(value: unknown): value is string {
  return typeof value === 'string' && (HEX.test(value) || RGB.test(value))
}

type Rgb = [number, number, number]

function toRgb(color: string): Rgb | null {
  if (color.startsWith('#')) {
    let h = color.slice(1)
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
  }
  const m = color.match(/\d+/g)
  return m ? ([Number(m[0]), Number(m[1]), Number(m[2])] as Rgb) : null
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
const toHex = ([r, g, b]: Rgb) => `#${hex2(r)}${hex2(g)}${hex2(b)}`
const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => v + (b[i]! - v) * t) as Rgb

const DEFAULT_BG: Rgb = [0x0a, 0x0a, 0x0c]

/**
 * Fill accent-dim, accent-text and term-selection from `accent` when the
 * file does not set them, with the relationships of the teal defaults:
 * dim is a dark wash of the accent over the background, text is a lighter
 * accent, selection is the accent at 20% alpha.
 */
function deriveAccent(palette: Record<string, string>): void {
  const accent = palette['accent'] && toRgb(palette['accent'])
  if (!accent) return
  const bg = (palette['bg'] && toRgb(palette['bg'])) || DEFAULT_BG
  palette['accent-dim'] ??= toHex(mix(bg, accent, 0.2))
  palette['accent-text'] ??= toHex(mix(accent, [255, 255, 255], 0.2))
  palette['term-selection'] ??= `${toHex(accent)}33`
}

function cleanLabel(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH).trim()
}

/** Validate parsed JSON into a BoxConfig, warning (never throwing) about what it drops. */
export function parseBoxConfig(data: unknown, warn: (msg: string) => void = () => {}): BoxConfig {
  const config: BoxConfig = { palette: {} }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    warn('config must be a JSON object; ignoring it')
    return config
  }
  const obj = data as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (key !== 'label' && key !== 'palette') warn(`unknown config key "${key.slice(0, 40)}" ignored`)
  }
  if ('label' in obj) {
    if (typeof obj['label'] !== 'string') warn('config label must be a string; ignored')
    else {
      const label = cleanLabel(obj['label'])
      if (label) config.label = label
    }
  }
  const palette = obj['palette']
  if (palette !== undefined) {
    if (typeof palette !== 'object' || palette === null || Array.isArray(palette)) {
      warn('config palette must be an object; ignored')
    } else {
      for (const [key, value] of Object.entries(palette)) {
        if (!PALETTE_KEYS.includes(key)) warn(`unknown palette key "${key.slice(0, 40)}" ignored`)
        else if (!isSafeColor(value)) warn(`palette "${key}" is not a hex or rgb()/rgba() colour; ignored`)
        else config.palette[key] = value
      }
    }
  }
  deriveAccent(config.palette)
  return config
}

/** Where the config lives: FORAY_CONFIG, else ~/.foray/config.json. */
export function boxConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['FORAY_CONFIG'] || path.join(os.homedir(), '.foray', 'config.json')
}

/**
 * Read the config file. A missing file is `null` (today's behaviour,
 * silently); an unreadable or malformed one warns and is also `null`.
 */
export function loadBoxConfig(file: string, logger?: Pick<Logger, 'log'>): BoxConfig | null {
  const warn = (msg: string) => logger?.log(`box config ${file}: ${msg}`)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') warn(`cannot read: ${(err as Error).message}`)
    return null
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    warn('not valid JSON; ignoring it')
    return null
  }
  const config = parseBoxConfig(data, warn)
  if (!config.label && Object.keys(config.palette).length === 0) return null
  return config
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** The page title for a labelled box. */
export function titleFor(config: BoxConfig): string {
  return config.label ? `Foray · ${config.label}` : 'Foray'
}

/** index.html with the box's title, theme colour, palette overrides and label meta applied. */
export function applyBoxConfigToHtml(html: string, config: BoxConfig): string {
  const title = escapeHtml(titleFor(config))
  const accent = config.palette['accent']
  let out = html.replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`)
  out = out.replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, (_m, a, b) => `${a}${escapeHtml(config.label ? `Foray ${config.label}` : 'Foray')}${b}`)
  if (accent) out = out.replace(/(<meta name="theme-color" content=")[^"]*(")/, (_m, a, b) => `${a}${accent}${b}`)
  const decls = Object.entries(config.palette).map(([k, v]) => `--${k}:${v};`).join('')
  const extra = [
    config.label ? `<meta name="foray-label" content="${escapeHtml(config.label)}" />` : '',
    decls ? `<style id="foray-box-palette">:root{${decls}}</style>` : '',
  ].filter(Boolean).join('\n    ')
  // Inserted into <head>; a function replacer so `$` in values is literal.
  return extra ? out.replace('</head>', () => `${extra}\n  </head>`) : out
}

/** Short name for the home screen: "Foray <label>" if it fits in 12, else the label. */
export function shortNameFor(label: string): string {
  const joined = `Foray ${label}`
  return joined.length <= 12 ? joined : label
}

/** manifest.json with the box's name, short name and theme colour applied. */
export function applyBoxConfigToManifest(manifest: Record<string, unknown>, config: BoxConfig): Record<string, unknown> {
  const out = { ...manifest }
  if (config.label) {
    out['name'] = titleFor(config)
    out['short_name'] = shortNameFor(config.label)
  }
  if (config.palette['accent']) out['theme_color'] = config.palette['accent']
  return out
}
