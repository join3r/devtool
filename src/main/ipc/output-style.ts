import type { IpcRegistrar } from './registrar'
import { v } from './validate'
import { OUTPUT_STYLE_SET_CHANNEL, OUTPUT_STYLES, type OutputStyle } from '../../shared/output-style'

/**
 * A desktop sets its response style on a server it uses (`desktop-routing.ts`),
 * so the server's agents write the same way. A desktop's own windows change it
 * with `save-config`.
 */
export function registerOutputStyleHandlers(ipc: IpcRegistrar, deps: { set: (style: OutputStyle) => void }): void {
  ipc.handle(OUTPUT_STYLE_SET_CHANNEL, [v.literal(...OUTPUT_STYLES)], (_event, style) => deps.set(style))
}
