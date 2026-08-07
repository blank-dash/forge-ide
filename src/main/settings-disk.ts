import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

export interface SettingsDiskRead {
  value: unknown
  source: 'primary' | 'backup'
}

export function readSettingsDisk(file: string): SettingsDiskRead | null {
  const primary = readJson(file)
  if (primary !== null) return { value: primary, source: 'primary' }

  const backup = readJson(`${file}.bak`)
  if (backup === null) return null
  writeSettingsDisk(file, JSON.stringify(backup, null, 2), false)
  return { value: backup, source: 'backup' }
}

export function writeSettingsDisk(file: string, payload: string, keepBackup = true): void {
  const temporary = `${file}.tmp`
  mkdirSync(path.dirname(file), { recursive: true })
  if (keepBackup && existsSync(file)) copyFileSync(file, `${file}.bak`)
  writeFileSync(temporary, payload, 'utf8')
  renameSync(temporary, file)
}

function readJson(file: string): unknown | null {
  if (!existsSync(file)) return null
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch (error) {
    console.warn(`[settings] could not read ${file}`, error)
    return null
  }
}
