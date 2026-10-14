import { Frame } from '@playwright/test'

/**
 * Read the xterm.js terminal of a module iframe. xterm does not keep its text
 * in the DOM in a readable order, so the module exposes its terminal as
 * `window.term` (module-pyxtermjs, module-serial) and these read its buffer:
 *
 *   await terminalText(frame)   // one line per row
 *   await terminalSize(frame)   // { cols, rows }
 */

/** Text of the frame's terminal, one line per row, trailing whitespace trimmed. */
export function terminalText(frame: Frame): Promise<string> {
  return frame.evaluate(() => {
    const term = (window as any).term
    if (!term) return ''
    const buffer = term.buffer.active
    const out: string[] = []
    for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i).translateToString(true))
    return out.join('\n')
  })
}

/** Columns and rows of the frame's terminal. */
export function terminalSize(frame: Frame): Promise<{ cols: number; rows: number }> {
  return frame.evaluate(() => {
    const term = (window as any).term
    return { cols: term?.cols ?? 0, rows: term?.rows ?? 0 }
  })
}
