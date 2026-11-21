// The plugin's own version, for the panel's bug report link. Orca installs the manifest beside src/,
// and plugins have no host method that reports their version.
import { readFile } from 'node:fs/promises'

const MANIFEST = new URL('../orca-plugin.json', import.meta.url)

/** The manifest's `version`, or null when it cannot be read. */
export async function readPluginVersion(log: (message: string) => void, file: URL | string = MANIFEST): Promise<string | null> {
  try {
    const { version } = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown }
    if (typeof version === 'string' && version) {
      return version
    }
    log('plugin.version: the manifest has no version')
  } catch (error) {
    log(`plugin.version: could not read the manifest: ${(error as Error).message}`)
  }
  return null
}
