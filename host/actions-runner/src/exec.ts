import { execFile } from "node:child_process";
import type { BinName, Policy } from "./policy.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with an argument vector: never a shell. Replaceable in tests. */
export type Exec = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBuffer: number },
) => Promise<ExecResult>;

const CLEAN_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };

export const execFileExec: Exec = (file, args, { timeoutMs, maxBuffer }) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer, encoding: "utf8", env: CLEAN_ENV, shell: false },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const code = typeof error.code === "number" ? error.code : 1;
        if (typeof error.code === "string" || error.killed) {
          return resolve({
            code,
            stdout: "",
            stderr: `Command failed: ${error.code ?? "ABORTED"}`,
          });
        }
        resolve({ code, stdout, stderr });
      },
    );
  });

export interface Step {
  bin: BinName;
  args: string[];
  /** Run through `sudo -n` (the sudoers file lists exactly these commands). */
  sudo: boolean;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const CERTBOT_TIMEOUT_MS = 240_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/** The full argv for a step, including the sudo prefix. Used by the runner and the sudoers renderer. */
export function argvOf(policy: Policy, step: Step): { file: string; args: string[] } {
  const program = policy.bins[step.bin];
  return step.sudo
    ? { file: policy.bins.sudo, args: ["-n", "-H", "--", program, ...step.args] }
    : { file: program, args: step.args };
}

export function runStep(policy: Policy, exec: Exec, step: Step): Promise<ExecResult> {
  const { file, args } = argvOf(policy, step);
  return exec(file, args, {
    timeoutMs: step.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
}
