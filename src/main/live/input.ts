import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Synthetic mouse and keyboard input.
 *
 * Electron can only deliver input events to its own windows, so driving the
 * desktop needs the operating system's own API. Rather than add a native module
 * — which would have to be compiled per platform and per Electron version, and
 * is exactly the kind of dependency that breaks a packaged build — this drives
 * `user32` through one long-lived PowerShell process.
 *
 * One process, not one per action: spawning PowerShell costs a few hundred
 * milliseconds, which would make a click slower than the model deciding to make
 * it. The process is started when live control is first used and killed when the
 * session ends.
 */

export type MouseButton = 'left' | 'right' | 'middle'

export interface InputBackend {
  readonly available: boolean
  /** Why it is unavailable, for the UI to show instead of failing silently. */
  readonly reason?: string
  move(x: number, y: number): Promise<void>
  click(x: number, y: number, button: MouseButton, double: boolean): Promise<void>
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>
  scroll(x: number, y: number, amount: number): Promise<void>
  typeText(text: string): Promise<void>
  pressKey(key: string, modifiers: string[]): Promise<void>
  dispose(): void
}

export function createInputBackend(): InputBackend {
  if (process.platform === 'win32') return new WindowsInput()
  return new UnsupportedInput(
    `Controlling the screen is only implemented on Windows so far. On ${process.platform} the ` +
      'agent can still see the screen, but not click or type.'
  )
}

class UnsupportedInput implements InputBackend {
  readonly available = false
  constructor(readonly reason: string) {}

  private refuse(): Promise<never> {
    return Promise.reject(new Error(this.reason))
  }

  move = (): Promise<void> => this.refuse()
  click = (): Promise<void> => this.refuse()
  drag = (): Promise<void> => this.refuse()
  scroll = (): Promise<void> => this.refuse()
  typeText = (): Promise<void> => this.refuse()
  pressKey = (): Promise<void> => this.refuse()
  dispose = (): void => undefined
}

class WindowsInput implements InputBackend {
  readonly available = true
  private child: ChildProcessWithoutNullStreams | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private startupError: string | null = null
  private scriptPath: string | null = null
  /** Whatever the helper complained about, kept for a useful error message. */
  private stderr = ''

  /**
   * The helper runs from a file rather than being piped in.
   *
   * `powershell -Command -` reads the script from stdin, which means the host
   * owns that stream — the command loop's own ReadLine then never sees a thing
   * and every action is silently swallowed. A file leaves stdin free.
   */
  private script(): string {
    if (this.scriptPath) return this.scriptPath
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-live-'))
    const file = path.join(dir, 'input.ps1')
    writeFileSync(file, SCRIPT, 'utf8')
    this.scriptPath = file
    return file
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child
    if (this.startupError) throw new Error(this.startupError)

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script()],
      { windowsHide: true }
    )

    child.on('error', (error) => {
      this.startupError = `Could not start the input helper: ${error.message}`
      this.child = null
    })
    child.on('exit', () => {
      this.child = null
    })

    // Kept rather than discarded: when a click does nothing, the reason is
    // nearly always here — and an unread pipe eventually blocks the writer too.
    child.stdout.resume()
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-2000)
    })

    this.child = child
    return child
  }

  /** What the helper last complained about, if anything. */
  lastError(): string {
    return this.stderr.trim()
  }

  /**
   * Commands are serialised.
   *
   * The helper reads one line at a time; two writes racing would interleave
   * into a line it cannot parse, and a dropped click is worse than a slow one.
   */
  private send(command: Record<string, unknown>): Promise<void> {
    const run = async (): Promise<void> => {
      const child = this.ensure()
      const line = `${JSON.stringify(command)}\n`
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(line, (error) => (error ? reject(error) : resolve()))
      })
    }

    this.queue = this.queue.then(run, run)
    return this.queue as Promise<void>
  }

  move(x: number, y: number): Promise<void> {
    return this.send({ op: 'move', x, y })
  }

  click(x: number, y: number, button: MouseButton, double: boolean): Promise<void> {
    return this.send({ op: 'click', x, y, button, double })
  }

  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    return this.send({ op: 'drag', x: fromX, y: fromY, x2: toX, y2: toY })
  }

  scroll(x: number, y: number, amount: number): Promise<void> {
    return this.send({ op: 'scroll', x, y, amount })
  }

  typeText(text: string): Promise<void> {
    return this.send({ op: 'type', text })
  }

  pressKey(key: string, modifiers: string[]): Promise<void> {
    return this.send({ op: 'key', key, modifiers })
  }

  dispose(): void {
    const child = this.child
    this.child = null
    if (!child || child.killed) return
    // Ask first, so the helper can release any held modifier keys.
    child.stdin.write('{"op":"quit"}\n', () => child.kill())
  }
}

/**
 * The helper.
 *
 * Reads newline-delimited JSON on stdin and drives `user32` through SendInput.
 * SendInput rather than the older `mouse_event`/`keybd_event`: it is the only
 * one that can deliver arbitrary Unicode, which typing anything but ASCII needs.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

Add-Type -Namespace ForgeLive -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)]
public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUTUNION u; }

[DllImport("user32.dll", SetLastError = true)]
public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
[DllImport("user32.dll")]
public static extern bool SetCursorPos(int X, int Y);
'@

$SIZE = [System.Runtime.InteropServices.Marshal]::SizeOf([type][ForgeLive.Native+INPUT])

function Send-Inputs([object[]] $items) {
  $arr = [ForgeLive.Native+INPUT[]] $items
  [void][ForgeLive.Native]::SendInput($arr.Length, $arr, $SIZE)
}

function New-MouseInput([uint32] $flags, [uint32] $data) {
  $i = New-Object ForgeLive.Native+INPUT
  $i.type = 0
  $m = New-Object ForgeLive.Native+MOUSEINPUT
  $m.dwFlags = $flags
  $m.mouseData = $data
  $i.u.mi = $m
  return $i
}

function New-KeyInput([uint16] $vk, [uint16] $scan, [uint32] $flags) {
  $i = New-Object ForgeLive.Native+INPUT
  $i.type = 1
  $k = New-Object ForgeLive.Native+KEYBDINPUT
  $k.wVk = $vk
  $k.wScan = $scan
  $k.dwFlags = $flags
  $i.u.ki = $k
  return $i
}

$MOUSE = @{ leftDown = 0x0002; leftUp = 0x0004; rightDown = 0x0008; rightUp = 0x0010; middleDown = 0x0020; middleUp = 0x0040; wheel = 0x0800 }
$KEYUP = 0x0002
$UNICODE = 0x0004

# Names are deliberately unlike any loop variable below. PowerShell variable
# names are case-insensitive, so a "$vk" loop variable and a "$VK" table are the
# same variable — which silently emptied this table before any key was looked up.
$VKEYS = @{
  'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'escape' = 0x1B; 'esc' = 0x1B
  'backspace' = 0x08; 'delete' = 0x2E; 'space' = 0x20; 'home' = 0x24; 'end' = 0x23
  'pageup' = 0x21; 'pagedown' = 0x22; 'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
  'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
  'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
}
$MODKEYS = @{ 'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B; 'meta' = 0x5B; 'cmd' = 0x5B }

function Invoke-Click($cmd) {
  [void][ForgeLive.Native]::SetCursorPos([int]$cmd.x, [int]$cmd.y)
  Start-Sleep -Milliseconds 16
  $button = if ($cmd.button) { [string]$cmd.button } else { 'left' }
  $down = switch ($button) { 'right' { $MOUSE.rightDown } 'middle' { $MOUSE.middleDown } default { $MOUSE.leftDown } }
  $up = switch ($button) { 'right' { $MOUSE.rightUp } 'middle' { $MOUSE.middleUp } default { $MOUSE.leftUp } }
  $times = if ($cmd.double) { 2 } else { 1 }
  for ($n = 0; $n -lt $times; $n++) {
    Send-Inputs @((New-MouseInput $down 0), (New-MouseInput $up 0))
    if ($times -gt 1) { Start-Sleep -Milliseconds 40 }
  }
}

function Invoke-Type($text) {
  $chars = [char[]]([string]$text)
  foreach ($ch in $chars) {
    $code = [uint16][int][char]$ch
    Send-Inputs @((New-KeyInput 0 $code $UNICODE), (New-KeyInput 0 $code ($UNICODE -bor $KEYUP)))
    Start-Sleep -Milliseconds 4
  }
}

function Invoke-Key($cmd) {
  $held = @()
  foreach ($mod in @($cmd.modifiers)) {
    if ($mod -and $MODKEYS.ContainsKey([string]$mod)) { $held += [uint16]$MODKEYS[[string]$mod] }
  }
  foreach ($heldCode in $held) { Send-Inputs @((New-KeyInput $heldCode 0 0)) }

  $name = ([string]$cmd.key).ToLower()
  if ($VKEYS.ContainsKey($name)) {
    $keyCode = [uint16]$VKEYS[$name]
    Send-Inputs @((New-KeyInput $keyCode 0 0), (New-KeyInput $keyCode 0 $KEYUP))
  } elseif ($name.Length -eq 1) {
    $charCode = [uint16][int][char]$name[0]
    Send-Inputs @((New-KeyInput 0 $charCode $UNICODE), (New-KeyInput 0 $charCode ($UNICODE -bor $KEYUP)))
  }

  # Released in reverse, so a modifier is never left stuck down.
  [array]::Reverse($held)
  foreach ($heldCode in $held) { Send-Inputs @((New-KeyInput $heldCode 0 $KEYUP)) }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }

  try {
    $cmd = $line | ConvertFrom-Json
    switch ($cmd.op) {
      'move'   { [void][ForgeLive.Native]::SetCursorPos([int]$cmd.x, [int]$cmd.y) }
      'click'  { Invoke-Click $cmd }
      'drag'   {
        [void][ForgeLive.Native]::SetCursorPos([int]$cmd.x, [int]$cmd.y)
        Start-Sleep -Milliseconds 16
        Send-Inputs @((New-MouseInput $MOUSE.leftDown 0))
        Start-Sleep -Milliseconds 40
        [void][ForgeLive.Native]::SetCursorPos([int]$cmd.x2, [int]$cmd.y2)
        Start-Sleep -Milliseconds 40
        Send-Inputs @((New-MouseInput $MOUSE.leftUp 0))
      }
      'scroll' {
        [void][ForgeLive.Native]::SetCursorPos([int]$cmd.x, [int]$cmd.y)
        Send-Inputs @((New-MouseInput $MOUSE.wheel ([uint32]([int]$cmd.amount))))
      }
      'type'   { Invoke-Type $cmd.text }
      'key'    { Invoke-Key $cmd }
      'quit'   { break }
    }
  } catch {
    [Console]::Error.WriteLine("line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)")
  }
}
`
