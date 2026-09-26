/**
 * The preflight CLI probe must find a binary it can actually run (#22975).
 *
 * These cases spawn real processes against real fixture scripts, because the
 * bug is invisible to a mock: a dead version-manager shim is an ordinary
 * executable file, so every fs lookup and every stubbed resolver agrees that it
 * is the one `gh`, and only the spawn can tell it from the working copy behind
 * it.
 *
 * Every fixture name carries this file's issue number, so no directory Orca
 * knows about (`/usr/local/bin`, a real nix profile) can hold a matching binary
 * and make a case pass for the wrong reason.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { findRunnableLocalCommand } from './preflight-command-exec'

// A shim of the reported shape: a real script whose `exec` target is long gone.
// bash reports that as exit 126 and `execFile` surfaces it as a numeric
// `error.code` — the same shape a working CLI's own non-zero exit has, which is
// exactly why a boolean probe cannot tell the two stories apart.
const SHIM =
  '#!/usr/bin/env bash\n# asdf-plugin: github-cli 2.6.0\nexec "/nonexistent/asdf" exec "gh" "$@"\n'

const COMMAND = 'orca-22975-gh'
const ABSENT_COMMAND = 'orca-22975-absent-cli'

let root = ''
let originalPath = ''
let originalHome = ''

/** A directory holding one executable fixture `command`, recording its argv. */
async function makeBinDir(label: string, command = COMMAND, runnable = true): Promise<string> {
  const dir = await mkdtemp(path.join(root, `${label}-`))
  const body = runnable
    ? `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(path.join(dir, 'argv.txt'))}\nprintf 'gh version 2.98.0 (fixture)\\n'\n`
    : SHIM
  await writeFile(path.join(dir, command), body)
  await chmod(path.join(dir, command), 0o755)
  return dir
}

const RELATIVE_TOOLS = `.${path.sep}tools`

/** A directory holding a working copy, spelled relative to cwd for PATH tests. */
async function makeRelativeToolsDir(): Promise<string> {
  const tools = path.join(root, 'tools')
  await mkdir(tools)
  await writeFile(
    path.join(tools, COMMAND),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(path.join(tools, 'argv.txt'))}\nprintf 'gh version 2.98.0 (fixture)\\n'\n`
  )
  await chmod(path.join(tools, COMMAND), 0o755)
  return tools
}

/**
 * What `./tools/<command>` means to a process whose cwd is the fixture root — the
 * string the probe derives, which on macOS comes back through the `/var` symlink
 * and so is not simply `path.join(root, …)`. The callers assert alongside a
 * `probedArgs` check, so this is never the only thing pinning a pass.
 */
function runnableToolsPath(): string {
  return path.resolve(RELATIVE_TOOLS, COMMAND)
}

async function probedArgs(dir: string): Promise<string[]> {
  try {
    return (await readFile(path.join(dir, 'argv.txt'), 'utf8')).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

describe.skipIf(process.platform === 'win32')(
  'findRunnableLocalCommand probes copies until one runs',
  () => {
    beforeAll(async () => {
      originalPath = process.env.PATH ?? ''
      originalHome = process.env.HOME ?? ''
    })

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'orca-22975-case-'))
    })

    afterEach(async () => {
      process.env.PATH = originalPath
      process.env.HOME = originalHome
      await rm(root, { recursive: true, force: true })
    })

    it('skips the shim PATH chose and returns the working copy behind it', async () => {
      const shim = await makeBinDir('shim', COMMAND, false)
      const good = await makeBinDir('good')
      process.env.PATH = [shim, good].join(path.delimiter)

      await expect(findRunnableLocalCommand(COMMAND)).resolves.toBe(path.join(good, COMMAND))
      expect(await probedArgs(good)).toEqual(['--version'])
    })

    it('returns PATH’s own winner when it runs, without probing anything else', async () => {
      const first = await makeBinDir('first')
      const second = await makeBinDir('second')
      process.env.PATH = [first, second].join(path.delimiter)

      await expect(findRunnableLocalCommand(COMMAND)).resolves.toBe(path.join(first, COMMAND))
      expect(await probedArgs(second)).toEqual([])
    })

    it('probes the args the caller named, not a hardcoded --version', async () => {
      const good = await makeBinDir('good')
      process.env.PATH = good

      await findRunnableLocalCommand(COMMAND, ['auth', 'status'])

      expect(await probedArgs(good)).toEqual(['auth', 'status'])
    })

    it('reaches a working copy that is on no PATH, through the install dirs Orca seeds', async () => {
      // The reported machine: `gh` lives in the nix profile and the dead shim is
      // the only `gh` PATH can see. `getSystemCliInstallDirectories` already
      // lists `~/.nix-profile/bin`, so this copy is in scope for the fallback.
      const shim = await makeBinDir('shim', COMMAND, false)
      const home = await mkdtemp(path.join(root, 'home-'))
      const profileBin = path.join(home, '.nix-profile', 'bin')
      await mkdir(profileBin, { recursive: true })
      await writeFile(
        path.join(profileBin, COMMAND),
        "#!/bin/sh\nprintf 'gh version 2.98.0 (fixture)\\n'\n"
      )
      await chmod(path.join(profileBin, COMMAND), 0o755)
      process.env.HOME = home
      process.env.PATH = shim

      await expect(findRunnableLocalCommand(COMMAND)).resolves.toBe(path.join(profileBin, COMMAND))
    })

    it('gives up rather than probing every copy a PATH happens to hold', async () => {
      // Why this is a test and not a comment: a probe can burn the full
      // PREFLIGHT_COMMAND_TIMEOUT_MS, so an unbounded fallback would turn a
      // six-deep PATH into a half-minute Integrations pane. The working copy sits
      // past the cap on purpose: honoring the cap must be observable.
      const doomed: string[] = []
      for (const index of [0, 1, 2, 3]) {
        doomed.push(await makeBinDir(`doomed-${index}`, COMMAND, false))
      }
      const pastCap = await makeBinDir('past-cap')
      process.env.PATH = [...doomed, pastCap].join(path.delimiter)

      await expect(findRunnableLocalCommand(COMMAND)).resolves.toBeNull()
      expect(await probedArgs(pastCap)).toEqual([])
    })

    it('reaches a working copy in a relative PATH entry ahead of a dead absolute shim', async () => {
      // Why a real spawn and not a stub: the whole point is that two resolvers
      // disagree. `listLocalCommandPaths` counts absolute resolutions only, so a
      // PATH entry spelled `./tools` reaches it only after the probe absolutizes
      // the entry — and the fs check that decides "is this even a file" is the
      // thing a mock cannot supply.
      const tools = await makeRelativeToolsDir()
      const shim = await makeBinDir('shim', COMMAND, false)
      const cwdBefore = process.cwd()
      process.chdir(root)
      // `.` is a *relative* PATH entry: `path.isAbsolute` rejects it, which is why
      // the scan needs it absolutized before it can report the copy inside.
      process.env.PATH = [RELATIVE_TOOLS, shim].join(path.delimiter)

      try {
        await expect(findRunnableLocalCommand(COMMAND)).resolves.toBe(runnableToolsPath())
        expect(await probedArgs(tools)).toEqual(['--version'])
      } finally {
        process.chdir(cwdBefore)
      }
    })

    it('reaches a working relative PATH entry when a dead absolute shim outranks it', async () => {
      // Why the reverse order is its own case: the escape hatch this replaces was
      // a final bare-name spawn, and `execFile` walks PATH from the top — so with
      // the doomed shim ahead, the bare spawn re-resolves onto that same shim,
      // fails, and answers null with the working copy still untried. Absolutizing
      // puts it inside the bounded probe instead, which is what #22975 is about.
      const tools = await makeRelativeToolsDir()
      const shim = await makeBinDir('shim', COMMAND, false)
      const cwdBefore = process.cwd()
      process.chdir(root)
      process.env.PATH = [shim, RELATIVE_TOOLS].join(path.delimiter)

      try {
        await expect(findRunnableLocalCommand(COMMAND)).resolves.toBe(runnableToolsPath())
        expect(await probedArgs(tools)).toEqual(['--version'])
      } finally {
        process.chdir(cwdBefore)
      }
    })

    it('keeps a relative PATH entry in PATH order, where the probe cap can reach it', async () => {
      // Why order rather than mere reachability: the fallback is capped, so
      // "absolutize the relative entries" is only equivalent to PATH order if the
      // absolutized entries stay where PATH put them. Here the working copy is
      // PATH's first entry and four doomed absolute copies follow it; a probe that
      // scanned the absolute entries and appended the relative ones would spend all
      // four spawns on the doomed copies and report null with the answer untried.
      const tools = await makeRelativeToolsDir()
      const doomed: string[] = []
      for (const index of [0, 1, 2, 3]) {
        doomed.push(await makeBinDir(`doomed-${index}`, COMMAND, false))
      }
      const cwdBefore = process.cwd()
      process.chdir(root)
      process.env.PATH = [RELATIVE_TOOLS, ...doomed].join(path.delimiter)

      try {
        await expect(findRunnableLocalCommand(COMMAND)).resolves.toBe(runnableToolsPath())
        expect(await probedArgs(tools)).toEqual(['--version'])
        for (const dir of doomed) {
          expect(await probedArgs(dir)).toEqual([])
        }
      } finally {
        process.chdir(cwdBefore)
      }
    })

    it('reports nothing runnable when no copy of the command exists', async () => {
      const good = await makeBinDir('good')
      process.env.PATH = good

      await expect(findRunnableLocalCommand(ABSENT_COMMAND)).resolves.toBeNull()
      expect(await probedArgs(good)).toEqual([])
    })
  }
)
