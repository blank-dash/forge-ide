import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const limitMb = Number(process.env.FORGE_BUILD_LIMIT_MB ?? 350)
const root = path.resolve('release')
let largest = null

for (const entry of await readdir(root).catch(() => [])) {
  if (!/\.(exe|dmg|AppImage|deb|rpm|zip)$/i.test(entry)) continue
  const bytes = (await stat(path.join(root, entry))).size
  if (!largest || bytes > largest.bytes) largest = { entry, bytes }
}

if (!largest) {
  console.log('No packaged installer found; size check skipped.')
  process.exit(0)
}

const sizeMb = largest.bytes / 1024 / 1024
console.log(`${largest.entry}: ${sizeMb.toFixed(1)} MB (limit ${limitMb} MB)`)
if (sizeMb > limitMb) process.exit(1)
