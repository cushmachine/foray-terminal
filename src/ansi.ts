// Renders history rows captured from tmux (`capture-pane -e`, so the SGR
// colour escapes survive) as HTML. The live screen is an xterm.js canvas;
// history is ordinary page text so it scrolls and selects natively, and
// this is what gives that text its colours back. Only SGR is interpreted;
// every other escape sequence is dropped. No dependencies, so it can be
// unit tested without a DOM.
//
// tmux writes a colour code where the colour changes, not at the start of
// every row, so a row that continues the style of the row above it
// carries no code of its own. The caller threads one Style through the
// rows in order and the style at the end of one row opens the next.

export interface Palette {
  /** 256 CSS colours: 16 from the theme, the 6x6x6 cube, then 24 greys. */
  colors: string[]
  foreground: string
  background: string
}

/** The 16 ANSI colours plus the defaults; theme.ts extends it with the cursor and selection. */
export interface ThemeColors {
  foreground: string
  background: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

// The xterm 256-colour cube levels and grey ramp, which every terminal
// renders the same way. The first 16 come from the theme instead so that
// history matches the live screen above it.
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

function hex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

export function paletteFromTheme(theme: ThemeColors): Palette {
  const colors = [
    theme.black, theme.red, theme.green, theme.yellow,
    theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
    theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
  ]
  for (let i = 0; i < 216; i++) {
    colors.push(hex(CUBE_LEVELS[Math.floor(i / 36)], CUBE_LEVELS[Math.floor(i / 6) % 6], CUBE_LEVELS[i % 6]))
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    colors.push(hex(v, v, v))
  }
  return { colors, foreground: theme.foreground, background: theme.background }
}

/**
 * A palette index, or a CSS colour for truecolor. Indexes stay unresolved
 * until render time because bold changes which entry a basic colour maps to.
 */
type Colour = number | string

export interface Style {
  fg: Colour | null
  bg: Colour | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  inverse: boolean
}

export function plainStyle(): Style {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false }
}

function isByte(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 255
}

/**
 * The colour after a 38 or 48: `5;n` or `2;r;g;b`. Returns null for a
 * malformed one, plus how many parameters were consumed so the caller
 * can skip past them either way.
 */
function extendedColour(args: string[]): { colour: Colour | null; used: number } {
  const mode = Number(args[0])
  if (mode === 5) {
    const n = Number(args[1])
    return { colour: isByte(n) ? n : null, used: 2 }
  }
  if (mode === 2) {
    const [r, g, b] = args.slice(1, 4).map(Number)
    return { colour: isByte(r) && isByte(g) && isByte(b) ? hex(r, g, b) : null, used: 4 }
  }
  return { colour: null, used: args.length > 0 ? 1 : 0 }
}

function applySgr(params: string, s: Style): void {
  const parts = params.split(';')
  for (let i = 0; i < parts.length; i++) {
    // tmux writes sub-parameters with colons (`4:3` for a curly underline,
    // `38:5:n` for colours); the leading number is the code that matters.
    const sub = parts[i].split(':')
    const code = sub[0] === '' ? 0 : Number(sub[0])
    if (!Number.isInteger(code)) continue
    switch (code) {
      case 0: Object.assign(s, plainStyle()); break
      case 1: s.bold = true; break
      case 2: s.dim = true; break
      case 3: s.italic = true; break
      case 4: s.underline = true; break
      case 7: s.inverse = true; break
      case 9: s.strike = true; break
      case 22: s.bold = false; s.dim = false; break
      case 23: s.italic = false; break
      case 24: s.underline = false; break
      case 27: s.inverse = false; break
      case 29: s.strike = false; break
      case 39: s.fg = null; break
      case 49: s.bg = null; break
      case 38:
      case 48: {
        const inline = sub.length > 1
        const { colour, used } = extendedColour(inline ? sub.slice(1) : parts.slice(i + 1))
        if (colour !== null) {
          if (code === 38) s.fg = colour
          else s.bg = colour
        }
        if (!inline) i += used
        break
      }
      default:
        if (code >= 30 && code <= 37) s.fg = code - 30
        else if (code >= 40 && code <= 47) s.bg = code - 40
        else if (code >= 90 && code <= 97) s.fg = code - 90 + 8
        else if (code >= 100 && code <= 107) s.bg = code - 100 + 8
    }
  }
}

function resolve(c: Colour | null, palette: Palette): string | null {
  if (c === null) return null
  return typeof c === 'number' ? palette.colors[c] : c
}

/** The inline CSS for a style, or '' when the text needs no span at all. */
function cssFor(s: Style, palette: Palette): string {
  // xterm's default drawBoldTextInBrightColors: bold text in one of the
  // eight basic colours takes the bright variant instead of a heavier face.
  const fgIndex = typeof s.fg === 'number' && s.bold && s.fg < 8 ? s.fg + 8 : s.fg
  let fg = resolve(fgIndex, palette)
  let bg = resolve(s.bg, palette)
  if (s.inverse) [fg, bg] = [bg ?? palette.background, fg ?? palette.foreground]
  const props: string[] = []
  if (fg) props.push(`color:${fg}`)
  if (bg) props.push(`background-color:${bg}`)
  if (s.bold) props.push('font-weight:700')
  if (s.italic) props.push('font-style:italic')
  const decoration = [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean)
  if (decoration.length > 0) props.push(`text-decoration:${decoration.join(' ')}`)
  if (s.dim) props.push('opacity:0.6')
  return props.join(';')
}

function between(code: number, lo: number, hi: number): boolean {
  return code >= lo && code <= hi
}

/**
 * Consumes the escape sequence starting at `at` (an ESC byte), applying it
 * to `s` when it is SGR, and returns the index just past it. Sequences cut
 * off by the end of the row are dropped whole.
 */
function skipEscape(line: string, at: number, s: Style): number {
  const kind = line[at + 1]
  if (kind === '[') {
    let j = at + 2
    while (j < line.length && between(line.charCodeAt(j), 0x30, 0x3f)) j++
    const params = line.slice(at + 2, j)
    while (j < line.length && between(line.charCodeAt(j), 0x20, 0x2f)) j++
    if (j >= line.length) return j
    // A private-mode marker (`ESC[?25h`, `ESC[>4;2m`) is never SGR.
    if (line[j] === 'm' && !/^[<=>?]/.test(params)) applySgr(params, s)
    return j + 1
  }
  if (kind === ']') {
    for (let j = at + 2; j < line.length; j++) {
      if (line[j] === '\x07') return j + 1
      if (line[j] === '\x1b') return line[j + 1] === '\\' ? j + 2 : j
    }
    return line.length
  }
  // Anything else: ESC, optional intermediates, one final byte.
  let j = at + 1
  while (j < line.length && between(line.charCodeAt(j), 0x20, 0x2f)) j++
  return Math.min(j + 1, line.length)
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

/**
 * One captured row → HTML. Escapes text; wraps styled runs in
 * `<span style="...">`. Plain text comes out bare and an empty row as ''.
 * `style` is the style in force at the row's start and is left holding
 * the one at its end, so consecutive rows can share it.
 */
export function ansiLineToHtml(line: string, palette: Palette, style: Style = plainStyle()): string {
  let out = ''
  // The style of the span currently open, '' when none. Spans open only
  // when text arrives, so a run of escapes with nothing between them (a
  // trailing reset, say) leaves no empty span behind.
  let open = ''
  const emit = (text: string) => {
    if (text === '') return
    const css = cssFor(style, palette)
    if (css !== open) {
      if (open) out += '</span>'
      if (css) out += `<span style="${css}">`
      open = css
    }
    out += escapeHtml(text)
  }
  let i = 0
  while (i < line.length) {
    const esc = line.indexOf('\x1b', i)
    if (esc === -1) {
      emit(line.slice(i))
      break
    }
    emit(line.slice(i, esc))
    i = skipEscape(line, esc, style)
  }
  if (open) out += '</span>'
  return out
}
