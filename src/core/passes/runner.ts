import { spawn } from 'node:child_process'

export interface RunResult {
  ok: boolean
  output: string
  error?: string
}

/** Injectable so the pipeline can be tested without the CLI installed. */
export type PromptRunner = (prompt: string) => Promise<RunResult>

/**
 * The CLI reports this as "Please run /login", but /login is a slash command
 * inside an interactive session; typed at a shell it fails. Name the command
 * that actually works.
 */
const NOT_LOGGED_IN =
  'The Claude Code CLI is installed but not signed in. Run "claude auth login" in a terminal, ' +
  'complete the browser sign-in, then try again.'

/**
 * The command comes from project settings and is run through a shell, which is
 * needed on Windows where the CLI is a .cmd shim. Restricting it to a plain
 * program name or path keeps that from becoming a way to run arbitrary shell.
 *
 * Backslashes are allowed because a Windows path is the normal way to name a
 * command here; the shell treats them as separators, not as syntax. What is
 * excluded is everything that could chain or redirect: & | ; < > ^ % ! ( ) " '.
 */
const SAFE_COMMAND = /^[A-Za-z0-9_.\\\/:~ -]+$/

const NOT_INSTALLED =
  'Claude Code CLI not found. Install it with "npm install -g @anthropic-ai/claude-code", ' +
  'or set a different command in project settings.'

/**
 * Send a prompt to the Claude Code CLI in print mode.
 *
 * The prompt goes over stdin rather than as an argument: a chapter of dialogue
 * runs to tens of kilobytes, past the command-line length limit on Windows.
 */
export function cliRunner(command: string, extraArgs: string[] = []): PromptRunner {
  return (prompt) =>
    new Promise<RunResult>((resolve) => {
      if (!SAFE_COMMAND.test(command)) {
        resolve({
          ok: false,
          output: '',
          error: `"${command}" is not a valid command. Use a program name or a path.`
        })
        return
      }

      let child
      try {
        // On Windows the CLI is a .cmd shim, which needs a shell. Node warns
        // when args are passed separately alongside shell:true, so the whole
        // invocation is built as one string; SAFE_COMMAND above is what makes
        // that sound.
        const args = ['-p', ...extraArgs]
        child =
          process.platform === 'win32'
            ? spawn(`"${command}" ${args.join(' ')}`, { stdio: ['pipe', 'pipe', 'pipe'], shell: true })
            : spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch {
        resolve({ ok: false, output: '', error: NOT_INSTALLED })
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false

      const finish = (result: RunResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }

      child.stdout.on('data', (d) => (stdout += String(d)))
      child.stderr.on('data', (d) => (stderr += String(d)))

      child.on('error', (e: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          output: '',
          error: e.code === 'ENOENT' ? NOT_INSTALLED : e.message
        })
      })

      child.on('close', (code) => {
        if (code === 0) finish({ ok: true, output: stdout })
        else {
          const detail = stderr.trim() || stdout.trim()
          let error: string
          if (/not logged in|please run \/login|authentication/i.test(detail)) {
            error = NOT_LOGGED_IN
          } else if (/not recognized|is not recognized|command not found|ENOENT/i.test(detail)) {
            // A shell reports a missing command through the exit code, not ENOENT.
            error = NOT_INSTALLED
          } else {
            error = `The pass exited with code ${code}. ${detail}`.trim()
          }
          finish({ ok: false, output: stdout, error })
        }
      })

      try {
        child.stdin.write(prompt)
        child.stdin.end()
      } catch (e) {
        finish({ ok: false, output: '', error: String(e) })
      }
    })
}
