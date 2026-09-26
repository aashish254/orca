import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'

const { runPreflightCommandInWslMock, execFileAsyncMock, listLocalCommandPathsMock } = vi.hoisted(
  () => ({
    runPreflightCommandInWslMock: vi.fn(),
    execFileAsyncMock: vi.fn(),
    listLocalCommandPathsMock: vi.fn()
  })
)

vi.mock('./preflight-wsl-command', () => ({
  runPreflightCommandInWsl: runPreflightCommandInWslMock
}))

vi.mock('./command-path-resolver', () => ({
  isCommandOnLocalPath: vi.fn(async () => false),
  listLocalCommandPaths: listLocalCommandPathsMock
}))

// Why: `findRunnableLocalCommand` decides what to spawn next from the error
// `execFile` puts on a failed probe, so the shapes below have to be its own.
vi.mock('child_process', () => {
  const execFileWithPromisify = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
  return { execFile: execFileWithPromisify, spawn: vi.fn() }
})

import { findRunnableLocalCommand, isCommandOnPath } from './preflight-command-exec'

describe('isCommandOnPath', () => {
  const sentinel = '__ORCA_PREFLIGHT_COMMAND_PATH__'

  beforeEach(() => {
    runPreflightCommandInWslMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the shared literal lookup and accepts a sentinel-prefixed POSIX path', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    runPreflightCommandInWslMock.mockResolvedValue({
      stdout: `shell startup chatter\n${sentinel}/home/user/.local/bin/codex\n`,
      stderr: ''
    })

    const found = await isCommandOnPath('codex', { distro: 'Ubuntu' })

    expect(found).toBe(true)
    expect(runPreflightCommandInWslMock).toHaveBeenCalledOnce()
    const [, command] = runPreflightCommandInWslMock.mock.calls[0] as [{ distro: string }, string]
    expect(command).toContain(
      buildPosixCommandPathLookupScript(
        { kind: 'literal', value: 'codex' },
        // The WSL branch skips Windows mounts, so detection and this check
        // cannot disagree about the same distro.
        { skipWindowsMountDirs: true }
      )
    )
    expect(command).toContain(
      ['if [ -n "$resolved" ]; then', `printf '${sentinel}%s\\n' "$resolved"`, 'fi'].join('\n')
    )
  })

  it.each([
    ['/absolute/startup/chatter', false],
    [`${sentinel}relative/path`, false],
    ['codex', false],
    ["alias codex='codex --wrapped'", false]
  ])('parses WSL lookup output %s as available: %s', async (stdout, expected) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    runPreflightCommandInWslMock.mockResolvedValue({ stdout: `${stdout}\n`, stderr: '' })

    await expect(isCommandOnPath('codex', { distro: 'Ubuntu' })).resolves.toBe(expected)
  })
})

describe('findRunnableLocalCommand', () => {
  const shim = '/Users/tester/.asdf/shims/gh'
  const second = '/Users/tester/.volta/bin/gh'
  const third = '/usr/local/bin/gh'

  const spawnedCommands = () => execFileAsyncMock.mock.calls.map(([command]) => command)

  let pathBefore = ''

  beforeEach(() => {
    pathBefore = process.env.PATH ?? ''
    execFileAsyncMock.mockReset()
    listLocalCommandPathsMock.mockReset()
    listLocalCommandPathsMock.mockResolvedValue([shim, second, third])
  })

  afterEach(() => {
    // The Windows case below spies on the shared `process` object, and this
    // repo's vitest config installs no `restoreMocks`, so each file owns its own
    // cleanup.
    vi.restoreAllMocks()
    process.env.PATH = pathBefore
  })

  it('returns the first copy that runs and leaves the rest alone', async () => {
    execFileAsyncMock.mockImplementation(async (command: string) => {
      if (command === shim) {
        throw Object.assign(new Error('cannot execute'), { code: 126 })
      }
      return { stdout: 'gh version 2.98.0\n', stderr: '' }
    })

    await expect(findRunnableLocalCommand('gh')).resolves.toBe(second)
    expect(spawnedCommands()).toEqual([shim, second])
  })

  it('keeps looking when a copy exits non-zero', async () => {
    execFileAsyncMock.mockImplementation(async (command: string) => {
      if (command === third) {
        return { stdout: 'gh version 2.98.0\n', stderr: '' }
      }
      throw Object.assign(new Error('Command failed'), { code: 1 })
    })

    await expect(findRunnableLocalCommand('gh')).resolves.toBe(third)
  })

  it('stops at a timed-out copy instead of paying the timeout once per copy', async () => {
    // Why a separate verdict: `execFile` reports a kill on timeout as
    // `killed: true` with a null `code`, and that says nothing about the copies
    // behind it. Falling through would make a loaded machine wait 5s per `gh`.
    execFileAsyncMock.mockImplementation(async (command: string) => {
      if (command === second) {
        throw Object.assign(new Error('Timed out'), { killed: true, code: null })
      }
      throw Object.assign(new Error('cannot execute'), { code: 126 })
    })

    await expect(findRunnableLocalCommand('gh')).resolves.toBeNull()
    expect(spawnedCommands()).toEqual([shim, second])
  })

  it('stops on the ETIMEDOUT shape as well as the killed shape', async () => {
    // Why both: a wedged probe surfaces either as `execFile`'s own kill
    // (`killed: true`, null `code`) or as the wrapper's `ETIMEDOUT`. Recognising
    // only one would keep spawning copies behind a CLI that is already hung.
    execFileAsyncMock.mockImplementation((command: string) =>
      command === second
        ? Promise.reject(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }))
        : Promise.reject(Object.assign(new Error('cannot execute'), { code: 126 }))
    )

    await expect(findRunnableLocalCommand('gh')).resolves.toBeNull()
    expect(spawnedCommands()).toEqual([shim, second])
  })

  it('reads a rejection that is not an object as an ordinary failure', async () => {
    // Why: the timeout verdict is read off properties, so a rejection carrying a
    // bare string must count as "this copy did not run" — neither a reason to
    // stop the whole probe nor a crash while reading it.
    execFileAsyncMock.mockImplementation((command: string) =>
      command === third
        ? Promise.resolve({ stdout: 'gh version 2.98.0\n', stderr: '' })
        : Promise.reject('not an error object')
    )

    await expect(findRunnableLocalCommand('gh')).resolves.toBe(third)
    expect(spawnedCommands()).toEqual([shim, second, third])
  })

  it('probes the bare command name when fs finds no candidate', async () => {
    // Why still reachable: win32 produces no candidates at all, and a command
    // spelled with a separator (`./bin/gh`) short-circuits the PATH walk to a
    // resolution the absolute-only scan drops. Those hosts keep the answer they
    // get today rather than a new "not installed".
    listLocalCommandPathsMock.mockResolvedValue([])
    execFileAsyncMock.mockResolvedValue({ stdout: 'gh version 2.98.0\n', stderr: '' })

    await expect(findRunnableLocalCommand('gh')).resolves.toBe('gh')
    expect(spawnedCommands()).toEqual(['gh'])
  })

  it('probes a relative PATH entry as the absolute directory cwd gives it', async () => {
    // Why this is a separate case: `listLocalCommandPaths` counts absolute
    // resolutions only, so on a PATH that spells its second entry `./tools` the
    // scan saw the doomed shim and nothing else, and the bare-name spawn that used
    // to be the escape hatch re-resolves through PATH from the top — onto that same
    // shim — and answers null with the working copy still untried. Absolutizing the
    // entry puts the hidden copy inside the bounded probe, in PATH order.
    const relativeDir = path.join('.', 'tools')
    process.env.PATH = [shim.replace('/gh', ''), relativeDir].join(path.delimiter)
    const absoluteDir = path.resolve(relativeDir)
    const hidden = `${absoluteDir}/gh`
    const absolutePath = [shim.replace('/gh', ''), absoluteDir].join(path.delimiter)
    listLocalCommandPathsMock.mockImplementation(
      async (_command: string, options?: { env?: NodeJS.ProcessEnv }) =>
        options?.env?.PATH === absolutePath ? [shim, hidden] : []
    )
    execFileAsyncMock.mockImplementation(async (command: string) => {
      if (command === hidden) {
        return { stdout: 'gh version 2.98.0\n', stderr: '' }
      }
      throw Object.assign(new Error('cannot execute'), { code: 126 })
    })

    await expect(findRunnableLocalCommand('gh')).resolves.toBe(hidden)
    // PATH order is preserved, so the shim is still tried first, and the bare name
    // is never paid for: every copy this PATH holds has now been spawned by path.
    expect(spawnedCommands()).toEqual([shim, hidden])
  })

  it('does not pay for the bare name when every PATH entry is absolute', async () => {
    // Why: with an all-absolute PATH the loop above already spawned every copy the
    // bare-name resolution could possibly reach, so a final `gh` is a second doomed
    // spawn of `shim` and doubles the worst-case probe cost for no answer.
    process.env.PATH = ['/Users/tester/.asdf/shims', '/usr/local/bin'].join(path.delimiter)
    execFileAsyncMock.mockRejectedValue(Object.assign(new Error('cannot execute'), { code: 126 }))

    await expect(findRunnableLocalCommand('gh')).resolves.toBeNull()
    expect(spawnedCommands()).not.toContain('gh')
  })

  it('never falls back on Windows, where an absolute .cmd spawn is EINVAL', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    execFileAsyncMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await expect(findRunnableLocalCommand('gh')).resolves.toBeNull()
    expect(listLocalCommandPathsMock).not.toHaveBeenCalled()
    expect(spawnedCommands()).toEqual(['gh'])
  })
})
