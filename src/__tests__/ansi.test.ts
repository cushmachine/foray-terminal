// ANSI colour renderer for history rows tests.
//
// Run with: npx tsx --test src/__tests__/ansi.test.ts
// (executed directly via `tsx`, using node's built-in test runner)
//
// Covers:
//  1. paletteFromTheme: 256 entries; the theme's 16, the cube corners, the
//     grey ramp, and the default foreground/background
//  2. ansiLineToHtml: HTML escaping, colour runs, several codes in one
//     sequence, 256-colour and truecolor, bold + basic colour → bright,
//     inverse with palette defaults, dim/italic/underline/strike
//  3. Non-SGR escapes (other CSI finals, OSC, lone ESC + char) are dropped
//     without leaving traces, and no empty spans are emitted

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ansiLineToHtml, paletteFromTheme, plainStyle, type ThemeColors } from '../ansi.ts'

const ESC = '\x1b'

// Distinct, easy-to-spot values so a wrong palette slot shows in the output.
const theme: ThemeColors = {
  foreground: '#fg0000',
  background: '#bg0000',
  black: '#000001',
  red: '#000002',
  green: '#000003',
  yellow: '#000004',
  blue: '#000005',
  magenta: '#000006',
  cyan: '#000007',
  white: '#000008',
  brightBlack: '#000009',
  brightRed: '#000010',
  brightGreen: '#000011',
  brightYellow: '#000012',
  brightBlue: '#000013',
  brightMagenta: '#000014',
  brightCyan: '#000015',
  brightWhite: '#000016',
}

const palette = paletteFromTheme(theme)

const html = (line: string) => ansiLineToHtml(line, palette)

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

test('paletteFromTheme has 256 entries with the theme first, then the cube, then greys', () => {
  assert.equal(palette.colors.length, 256)
  assert.equal(palette.colors[0], theme.black)
  assert.equal(palette.colors[7], theme.white)
  assert.equal(palette.colors[9], theme.brightRed)
  assert.equal(palette.colors[15], theme.brightWhite)
  assert.equal(palette.colors[16], '#000000')
  assert.equal(palette.colors[196], '#ff0000')
  assert.equal(palette.colors[231], '#ffffff')
  assert.equal(palette.colors[232], '#080808')
  assert.equal(palette.colors[244], '#808080')
  assert.equal(palette.colors[255], '#eeeeee')
  assert.equal(palette.foreground, theme.foreground)
  assert.equal(palette.background, theme.background)
})

test('paletteFromTheme accepts the THEME object shape with its extra keys', () => {
  // Terminal.tsx's THEME also carries cursor and selection colours; the
  // structural type must not reject them.
  const withExtras = { ...theme, cursor: '#123456', cursorAccent: '#654321', selectionBackground: '#00000033' }
  assert.equal(paletteFromTheme(withExtras).colors[1], theme.red)
})

// ---------------------------------------------------------------------------
// Plain text and escaping
// ---------------------------------------------------------------------------

test('plain text comes out with no wrapper and HTML characters escaped', () => {
  assert.equal(html('a <b> & "c"'), 'a &lt;b&gt; &amp; &quot;c&quot;')
  assert.equal(html('just text'), 'just text')
})

test('an empty line renders as the empty string', () => {
  assert.equal(html(''), '')
})

test('a line of nothing but escapes renders as the empty string', () => {
  assert.equal(html(`${ESC}[31m${ESC}[0m`), '')
})

// ---------------------------------------------------------------------------
// SGR colours and attributes
// ---------------------------------------------------------------------------

test('a single colour run followed by a reset', () => {
  assert.equal(
    html(`${ESC}[31mred${ESC}[0m plain`),
    `<span style="color:${theme.red}">red</span> plain`,
  )
})

test('text inside a styled run is still escaped', () => {
  assert.equal(
    html(`${ESC}[32m<ok>${ESC}[0m`),
    `<span style="color:${theme.green}">&lt;ok&gt;</span>`,
  )
})

test('two codes in one sequence (1;31) apply together', () => {
  assert.equal(
    html(`${ESC}[1;31mx${ESC}[m`),
    `<span style="color:${theme.brightRed};font-weight:700">x</span>`,
  )
})

test('256-colour foreground and background', () => {
  assert.equal(html(`${ESC}[38;5;196mx`), '<span style="color:#ff0000">x</span>')
  assert.equal(html(`${ESC}[48;5;244mx`), '<span style="background-color:#808080">x</span>')
  // The first 16 indexes are the theme's colours.
  assert.equal(html(`${ESC}[38;5;9mx`), `<span style="color:${theme.brightRed}">x</span>`)
})

test('truecolor foreground and background', () => {
  assert.equal(html(`${ESC}[38;2;1;2;3mx`), '<span style="color:#010203">x</span>')
  assert.equal(html(`${ESC}[48;2;255;0;16mx`), '<span style="background-color:#ff0010">x</span>')
  assert.equal(
    html(`${ESC}[38;2;10;20;30;48;2;40;50;60mx`),
    '<span style="color:#0a141e;background-color:#28323c">x</span>',
  )
})

test('bold with a basic colour uses the bright colour, whichever order the codes arrive in', () => {
  assert.equal(
    html(`${ESC}[1m${ESC}[34mx`),
    `<span style="color:${theme.brightBlue};font-weight:700">x</span>`,
  )
  assert.equal(
    html(`${ESC}[34m${ESC}[1mx`),
    `<span style="color:${theme.brightBlue};font-weight:700">x</span>`,
  )
})

test('bold leaves already-bright, 256-colour and truecolor foregrounds alone', () => {
  assert.equal(
    html(`${ESC}[1;94mx`),
    `<span style="color:${theme.brightBlue};font-weight:700">x</span>`,
  )
  assert.equal(html(`${ESC}[1;38;5;196mx`), '<span style="color:#ff0000;font-weight:700">x</span>')
  assert.equal(html(`${ESC}[1;38;2;1;2;3mx`), '<span style="color:#010203;font-weight:700">x</span>')
})

test('inverse with no colours set swaps the palette defaults', () => {
  assert.equal(
    html(`${ESC}[7mx${ESC}[27my`),
    `<span style="color:${theme.background};background-color:${theme.foreground}">x</span>y`,
  )
})

test('inverse swaps explicit foreground and background', () => {
  assert.equal(
    html(`${ESC}[31;7mx`),
    `<span style="color:${theme.background};background-color:${theme.red}">x</span>`,
  )
})

test('bright (90-97, 100-107) colours', () => {
  assert.equal(html(`${ESC}[92mx`), `<span style="color:${theme.brightGreen}">x</span>`)
  assert.equal(html(`${ESC}[105mx`), `<span style="background-color:${theme.brightMagenta}">x</span>`)
})

test('dim, italic, underline and strike-through', () => {
  assert.equal(html(`${ESC}[2mx`), '<span style="opacity:0.6">x</span>')
  assert.equal(html(`${ESC}[3mx`), '<span style="font-style:italic">x</span>')
  assert.equal(html(`${ESC}[4mx`), '<span style="text-decoration:underline">x</span>')
  assert.equal(html(`${ESC}[9mx`), '<span style="text-decoration:line-through">x</span>')
  assert.equal(html(`${ESC}[4;9mx`), '<span style="text-decoration:underline line-through">x</span>')
})

test('attributes switch off individually (22, 23, 24, 27, 29, 39, 49)', () => {
  assert.equal(html(`${ESC}[1;2mx${ESC}[22my`), '<span style="font-weight:700;opacity:0.6">x</span>y')
  assert.equal(html(`${ESC}[3mx${ESC}[23my`), '<span style="font-style:italic">x</span>y')
  assert.equal(html(`${ESC}[4mx${ESC}[24my`), '<span style="text-decoration:underline">x</span>y')
  assert.equal(html(`${ESC}[9mx${ESC}[29my`), '<span style="text-decoration:line-through">x</span>y')
  assert.equal(
    html(`${ESC}[31;42mx${ESC}[39my${ESC}[49mz`),
    `<span style="color:${theme.red};background-color:${theme.green}">x</span>` +
      `<span style="background-color:${theme.green}">y</span>z`,
  )
})

test('style changes mid-line open a new span; unchanged style keeps the same one', () => {
  assert.equal(
    html(`${ESC}[31ma${ESC}[32mb${ESC}[32mc`),
    `<span style="color:${theme.red}">a</span><span style="color:${theme.green}">bc</span>`,
  )
})

// ---------------------------------------------------------------------------
// Stripping and no empty spans
// ---------------------------------------------------------------------------

test('unknown CSI sequences and OSC strings are dropped without a trace', () => {
  assert.equal(html(`${ESC}[2Jclear ${ESC}]0;title\x07done`), 'clear done')
  assert.equal(html(`${ESC}]0;title${ESC}\\after`), 'after')
  assert.equal(html(`${ESC}[?25h${ESC}[Kvisible${ESC}[1;5H`), 'visible')
})

test('a lone ESC + char and a truncated sequence are dropped', () => {
  assert.equal(html(`${ESC}(Btext`), 'text')
  assert.equal(html(`text${ESC}`), 'text')
  assert.equal(html(`text${ESC}[31`), 'text')
  assert.equal(html(`text${ESC}]0;title`), 'text')
})

test('dropped sequences do not disturb the SGR state around them', () => {
  assert.equal(
    html(`${ESC}[31m${ESC}[2Jx${ESC}]0;t\x07y`),
    `<span style="color:${theme.red}">xy</span>`,
  )
})

test('a trailing reset produces no empty span', () => {
  const out = html(`${ESC}[32mok${ESC}[0m`)
  assert.equal(out, `<span style="color:${theme.green}">ok</span>`)
  assert.ok(!out.includes('<span></span>'))
  assert.ok(!/<span style="[^"]*"><\/span>/.test(out))
})

test('a leading reset and back-to-back style changes with no text produce nothing', () => {
  assert.equal(html(`${ESC}[0m${ESC}[31m${ESC}[32mx`), `<span style="color:${theme.green}">x</span>`)
})

test('a style carried in from the row above applies until the row changes it', () => {
  // tmux writes a code only where the colour changes: the second row of a
  // red block carries none of its own.
  const style = plainStyle()
  assert.equal(ansiLineToHtml('\x1b[31mred', palette, style), `<span style="color:${palette.colors[1]}">red</span>`)
  assert.equal(ansiLineToHtml('still red', palette, style), `<span style="color:${palette.colors[1]}">still red</span>`)
  assert.equal(ansiLineToHtml('\x1b[39mplain', palette, style), 'plain')
  assert.equal(ansiLineToHtml('and plain', palette, style), 'and plain')
})
