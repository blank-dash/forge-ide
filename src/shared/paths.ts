const WINDOWS_ROOT = /^[A-Za-z]:\/?$/
const UNC_ROOT = /^\/\/[^/]+\/[^/]+\/?$/

export function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

export function basename(value: string): string {
  const normalised = toPosix(value).replace(/\/+$/, '')
  if (!normalised || WINDOWS_ROOT.test(normalised)) return normalised
  return normalised.slice(normalised.lastIndexOf('/') + 1)
}

export function dirname(value: string): string {
  const normalised = toPosix(value).replace(/\/+$/, '')
  if (!normalised || WINDOWS_ROOT.test(normalised) || UNC_ROOT.test(normalised)) return normalised
  const boundary = normalised.lastIndexOf('/')
  if (boundary < 0) return '.'
  if (boundary === 0) return '/'
  return normalised.slice(0, boundary)
}

export function ext(value: string): string {
  const name = basename(value)
  const boundary = name.lastIndexOf('.')
  return boundary <= 0 ? '' : name.slice(boundary)
}

export function isInside(parent: string, candidate: string): boolean {
  const root = comparable(parent)
  const target = comparable(candidate)
  return target === root || target.startsWith(`${root}/`)
}

function comparable(value: string): string {
  const normalised = toPosix(value).replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(normalised) || normalised.startsWith('//')
    ? normalised.toLowerCase()
    : normalised
}
