import { execFile } from 'node:child_process'
import path from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import { getSystemCliInstallDirectories } from '../../shared/system-cli-install-dirs'
import { isCommandOnLocalPath, listLocalCommandPaths } from './command-path-resolver'
import { buildLocalPreflightEnv } from './preflight-local-env'
import { runPreflightCommandInWsl } from './preflight-wsl-command'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

const execFileAsync = promisify(execFile)
export const PREFLIGHT_COMMAND_TIMEOUT_MS = 5000
const WSL_COMMAND_PATH_SENTINEL = '__ORCA_PREFLIGHT_COMMAND_PATH__'

export type PreflightCommandResult = { stdout: string; stderr: string }

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function withPreflightTimeout<T>(command: string, commandPromise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      commandPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = Object.assign(new Error(`Timed out running ${command}`), {
            code: 'ETIMEDOUT'
          })
          reject(error)
        }, PREFLIGHT_COMMAND_TIMEOUT_MS)
        if (typeof timeout.unref === 'function') {
          timeout.unref()
        }
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

/** Rejects on non-zero exit, spawn failure, or timeout — it never reports
 *  "absent" as a value. A caller that collapses that rejection into `false`
 *  makes "not installed" and "could not run it" the same answer; see
 *  docs/reference/wsl-probe-failure-semantics.md before doing so. */
export async function execLocalPreflightCommandOrThrow(
  command: string,
  args: string[]
): Promise<PreflightCommandResult> {
  const env = buildLocalPreflightEnv()
  const commandPromise = execFileAsync(command, args, {
    encoding: 'utf-8',
    timeout: PREFLIGHT_COMMAND_TIMEOUT_MS,
    // Preflight probes console-subsystem binaries (git, gh, node); without this
    // each one flashes a console and steals foreground on Windows (#10488).
    windowsHide: true,
    ...(env ? { env } : {})
  }) as Promise<PreflightCommandResult>

  return withPreflightTimeout(command, commandPromise)
}

// Throws on any failure — a distro that is booting/unreachable throws the
// same way a command that genuinely doesn't exist does. Callers must not
// collapse both into "absent"; see docs/reference/wsl-probe-failure-semantics.md.
export async function execCommandInWslOrThrow(
  target: WslPreflightTarget,
  command: string
): Promise<PreflightCommandResult> {
  const commandPromise = runPreflightCommandInWsl(target, command, PREFLIGHT_COMMAND_TIMEOUT_MS)
  // Label only (runPreflightCommandInWsl owns the actual wsl.exe invocation) —
  // not the literal 'wsl.exe' so the wsl-invocation-boundary guard doesn't
  // mistake this string for a spawn site.
  return withPreflightTimeout('wsl command', commandPromise)
}

/** How many extra binaries one local CLI probe may spawn after PATH's winner
 *  fails. Each probe can cost the full 5s timeout, so the fallback stays bounded
 *  no matter how many copies of the CLI a PATH holds. */
const PREFLIGHT_LOCAL_FALLBACK_PROBE_LIMIT = 3

type LocalProbeAttempt = 'ran' | 'failed' | 'timed-out'

/**
 * Whether `error` is a kill on timeout rather than a completed run.
 *
 * Narrowed with `in` rather than a cast: `execFile` rejects with an `Error`
 * carrying `killed`/`code`, and Node's own typings do not declare them.
 */
function probeTimedOut(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  if ('killed' in error && error.killed === true) {
    return true
  }
  return 'code' in error && error.code === 'ETIMEDOUT'
}

/** Runs one probe without letting a failure become an answer. */
async function attemptLocalProbe(command: string, args: string[]): Promise<LocalProbeAttempt> {
  try {
    await execLocalPreflightCommandOrThrow(command, args)
    return 'ran'
  } catch (error) {
    // Why separate: `execFile` reports a completed non-zero exit as a numeric
    // `code`, and a kill on timeout as `killed` with a null `code`. A timed-out
    // probe says nothing about the copies behind it, and paying 5s per copy on a
    // loaded machine would make the Integrations pane slower than the bug.
    return probeTimedOut(error) ? 'timed-out' : 'failed'
  }
}

/**
 * Every location worth spawning for `command`: PATH's own matches in PATH order
 * (relative entries absolutized so the scan can report them), then the system
 * CLI install directories Orca already seeds.
 *
 * Why win32 gets none: `execFile` refuses a `.cmd`/`.bat` spawn without a shell
 * (EINVAL), and Windows PATH hits for these CLIs are routinely npm shims, so an
 * absolute-path fallback would replace "not installed" with a probe error.
 * `getSystemCliInstallDirectories` is POSIX-only for the same kind of reason.
 */
async function localProbeCandidates(command: string): Promise<string[]> {
  if (process.platform === 'win32') {
    return []
  }
  const installDirPaths = await listLocalCommandPaths(command, {
    env: {
      PATH: getSystemCliInstallDirectories(process.platform, homedir()).join(path.delimiter)
    }
  })
  return [
    ...new Set([
      ...(await listLocalCommandPaths(command, { env: { PATH: absolutePathValue() } })),
      ...installDirPaths
    ])
  ]
}

/**
 * PATH with every relative entry resolved against the directory `execFile`
 * would resolve it against.
 *
 * Why: the fs scan counts only absolute resolutions, so a PATH entry spelled
 * relative to cwd is invisible to it and the copy behind it never enters the
 * probe. Absolutizing the entry leaves that contract (and every other user of
 * the scan) alone while putting the hidden copy back in PATH order — which is
 * what makes it a candidate rather than a last resort: PATH order is also the
 * order in which a doomed shim ahead of it wins every resolution (#22975).
 */
function absolutePathValue(): string {
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  return pathValue
    .split(path.delimiter)
    .map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(entry)))
    .join(path.delimiter)
}

/**
 * The `command` this host can actually run, or null when nothing can.
 *
 * Why this exists (#22975): a version-manager shim (`~/.asdf/shims/gh`) is a
 * real, executable script, so every fs lookup — this file's
 * `isCommandOnPath`, `resolveCliCommand`'s install-dir scan — selects it over
 * the working binary behind it and then reports the shim's failure to execute
 * as "not installed". Only spawning distinguishes the two, and only trying the
 * copies behind it recovers the answer.
 *
 * Candidates are probed by absolute path, in PATH order and then install-dir
 * order, and the first one that runs is returned — so the caller probes the
 * *same* binary for `--version` and for whatever it checks next. A healthy host
 * pays one fs scan and the one spawn it already paid.
 */
export async function findRunnableLocalCommand(
  command: string,
  args: string[] = ['--version']
): Promise<string | null> {
  const candidates = await localProbeCandidates(command)
  for (const candidate of candidates.slice(0, 1 + PREFLIGHT_LOCAL_FALLBACK_PROBE_LIMIT)) {
    const attempt = await attemptLocalProbe(candidate, args)
    if (attempt === 'ran') {
      return candidate
    }
    if (attempt === 'timed-out') {
      return null
    }
  }
  // The bare name is the historical probe, and it is still the only route for a
  // host the scan above cannot answer: win32, which produces no candidates at all,
  // and a command spelled with a separator (`./bin/gh`), which short-circuits the
  // PATH walk to a relative resolution the absolute-only scan drops. Where the
  // scan did report copies, every one of them has been spawned by now, so a host
  // with an all-absolute PATH does not pay this spawn a second time.
  if (candidates.length === 0) {
    return (await attemptLocalProbe(command, args)) === 'ran' ? command : null
  }
  return null
}

/**
 * Whether a WSL distro can run `command --version`.
 *
 * Why no local branch: a boolean is exactly the shape that turned a dead shim
 * into "Not installed" (#22975). Local callers take
 * {@link findRunnableLocalCommand}, which answers with the binary it proved.
 */
export async function isCommandAvailable(
  command: string,
  wslTarget: WslPreflightTarget
): Promise<boolean> {
  try {
    await execCommandInWslOrThrow(wslTarget, `${shellQuote(command)} --version`)
    return true
  } catch {
    return false
  }
}

export async function isCommandOnPath(
  command: string,
  wslTarget?: WslPreflightTarget
): Promise<boolean> {
  if (!wslTarget) {
    // Why (#9297): resolve against PATH with fs instead of spawning one
    // where/which subprocess per probe — privilege-management software gates
    // each spawn and stalls startup. buildLocalPreflightEnv() supplies the same
    // registry-merged PATH the child process previously saw (undefined = posix
    // process.env), so the found/not-found result is identical.
    return isCommandOnLocalPath(command, { env: buildLocalPreflightEnv() })
  }
  try {
    // Why: preflight must validate the executable on PATH, not a shell alias or function.
    const { stdout } = await execCommandInWslOrThrow(
      wslTarget,
      [
        // Same skip as agent detection: without it this branch answers "yes"
        // for a Windows binary reached through interop, so preflight and the
        // detector disagree about the same distro.
        buildPosixCommandPathLookupScript(
          { kind: 'literal', value: command },
          { skipWindowsMountDirs: true }
        ),
        'if [ -n "$resolved" ]; then',
        `printf '${WSL_COMMAND_PATH_SENTINEL}%s\\n' "$resolved"`,
        'fi'
      ].join('\n')
    )
    // Why: WSL startup chatter can contain unrelated absolute paths.
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(WSL_COMMAND_PATH_SENTINEL))
      .map((line) => line.slice(WSL_COMMAND_PATH_SENTINEL.length))
      .some((line) => path.posix.isAbsolute(line))
  } catch {
    return false
  }
}
