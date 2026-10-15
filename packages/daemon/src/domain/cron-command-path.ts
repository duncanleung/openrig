import fs from "node:fs";
import path from "node:path";

/**
 * Path guard for the shell cron kind (RIG-84). A cron command must be an absolute path to an
 * existing, executable regular file whose REAL path (symlinks resolved) sits under one of the
 * allowed roots. Run at registration and again before every run, so a file swapped for a
 * symlink after registration is still refused. The scheduler spawns the returned real path.
 */

export class CronCommandError extends Error {}

export function validateCronCommand(command: unknown, allowedRoots: string[]): string {
  if (typeof command !== "string" || command.length === 0) throw new CronCommandError("command must be a non-empty string");
  if (command.includes("\0")) throw new CronCommandError("command must not contain NUL");
  if (!path.isAbsolute(command)) throw new CronCommandError("command must be an absolute path");
  if (command.split(path.sep).includes("..")) throw new CronCommandError('command must not contain ".." segments');
  let real: string;
  try {
    real = fs.realpathSync(command);
  } catch {
    throw new CronCommandError(`command does not exist: ${command}`);
  }
  if (!fs.statSync(real).isFile()) throw new CronCommandError(`command is not a regular file: ${command}`);
  try {
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    throw new CronCommandError(`command is not executable: ${command}`);
  }
  const roots = allowedRoots.flatMap((root) => {
    try { return [fs.realpathSync(root)]; } catch { return []; }
  });
  const inside = roots.some((root) => {
    const rel = path.relative(root, real);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!inside) throw new CronCommandError(`command resolves outside the allowed directories: ${real}`);
  return real;
}

/** Args are passed as an argv array and never through a shell. */
export function validateCronArgs(args: unknown): string[] {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.length > 32) throw new CronCommandError("args must be an array of at most 32 strings");
  for (const arg of args) {
    if (typeof arg !== "string" || arg.length > 1024 || arg.includes("\0")) {
      throw new CronCommandError("each arg must be a string of at most 1024 characters without NUL");
    }
  }
  return args as string[];
}
