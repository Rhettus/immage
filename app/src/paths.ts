// file paths as the system gives them: "/" on macOS and Linux, "\" (and
// sometimes "/") on Windows
const SEP = /[\\/]/;

// the last part of a path: a file's or a folder's name
export const baseName = (p: string) => p.split(SEP).filter(Boolean).pop() ?? p;

// the folder a path is in
export const parentDir = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

// whether `path` is `base` or inside it
export function within(path: string, base: string): boolean {
  if (path === base) return true;
  const b = base.replace(/[\\/]+$/, "");
  return path.startsWith(b) && SEP.test(path.charAt(b.length));
}
