import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { extname, join, posix } from "node:path";

/**
 * A workspace's Files folder, with folders inside it. Every path a person or an agent gives is checked here first,
 * so nothing can name a place outside the folder, and a link inside it is never followed.
 */

export const MAX_DEPTH = 12;
const MAX_SEGMENT = 120;
const MAX_PATH = 400;
const BAD_SEGMENT = /[\\\u0000-\u001f\u007f<>:"|?*]/;

export class PathProblem extends Error {}

/** "a/b/c.txt" from whatever was sent, or a plain error. The empty string is the top folder. */
export function cleanPath(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string" || raw.length > MAX_PATH) throw new PathProblem("That path is too long.");
  const parts = raw.split("/").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length > MAX_DEPTH) throw new PathProblem(`Folders can go ${MAX_DEPTH} levels deep.`);
  for (const part of parts) {
    if (part === "." || part === ".." || part.length > MAX_SEGMENT || BAD_SEGMENT.test(part) || part.startsWith(".")) {
      throw new PathProblem(`"${part.slice(0, 40)}" cannot be used as a name. Avoid \\ : * ? " < > | and names starting with a dot.`);
    }
  }
  return parts.join("/");
}

/** One name, as typed in a rename or new-folder box. */
export function cleanName(raw: unknown): string {
  const name = cleanPath(typeof raw === "string" ? raw.replace(/\//g, " ") : raw);
  if (!name) throw new PathProblem("Enter a name.");
  return name;
}

/** The place on disk, after checking no part of the way there is a link. */
export function onDisk(root: string, path: string, { mustExist = true } = {}) {
  let current = root;
  for (const part of path ? path.split("/") : []) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (mustExist) throw new PathProblem("That file or folder no longer exists.");
      return join(root, path);
    }
    if (lstatSync(current).isSymbolicLink()) throw new PathProblem("That file or folder no longer exists.");
  }
  return current;
}

export const isFolder = (root: string, path: string) => statSync(onDisk(root, path)).isDirectory();
export const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const within = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** "report.xlsx" becomes "report (2).xlsx" when that name is taken, so nothing is ever overwritten. */
export function freeName(root: string, folder: string, name: string) {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let copy = 1; copy < 1000; copy += 1) {
    const candidate = copy === 1 ? name : `${stem} (${copy})${extension}`;
    if (!existsSync(join(onDisk(root, folder), candidate))) return candidate;
  }
  throw new PathProblem("Too many files with that name.");
}

export interface Entry { name: string; path: string; kind: "file" | "folder"; size: number; modified: Date; items?: number }

/** One folder's contents: folders first, then files. Links are left out. */
export function listFolder(root: string, folder: string): Entry[] {
  const place = onDisk(root, folder);
  const entries: Entry[] = [];
  for (const name of readdirSync(place)) {
    if (name.startsWith(".")) continue;
    const info = lstatSync(join(place, name));
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) entries.push({ name, path: within(folder, name), kind: "folder", size: 0, modified: info.mtime, items: readdirSync(join(place, name)).filter((item) => !item.startsWith(".")).length });
    else if (info.isFile()) entries.push({ name, path: within(folder, name), kind: "file", size: info.size, modified: info.mtime });
  }
  return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === "folder" ? -1 : 1));
}

/** Every file under a folder, with its size. Used for counts, storage and moving search entries along. */
export function allFiles(root: string, folder = ""): { path: string; size: number }[] {
  const found: { path: string; size: number }[] = [];
  const walk = (relative: string, depth: number) => {
    if (depth > MAX_DEPTH + 1) return;
    const place = relative ? join(root, relative) : root;
    if (!existsSync(place)) return;
    for (const name of readdirSync(place)) {
      const info = lstatSync(join(place, name));
      if (info.isSymbolicLink()) continue;
      const path = within(relative, name);
      if (info.isDirectory()) walk(path, depth + 1);
      else if (info.isFile()) found.push({ path, size: info.size });
    }
  };
  walk(folder, folder ? folder.split("/").length : 0);
  return found;
}

/** Every folder, for the "move to" picker. */
export function allFolders(root: string): string[] {
  const found: string[] = [];
  const walk = (relative: string, depth: number) => {
    if (depth >= MAX_DEPTH) return;
    for (const name of readdirSync(relative ? join(root, relative) : root)) {
      if (name.startsWith(".")) continue;
      const info = lstatSync(join(root, relative, name));
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const path = within(relative, name);
      found.push(path);
      walk(path, depth + 1);
    }
  };
  walk("", 0);
  return found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Makes each folder on the way that is missing. A link, or a file in the way, is refused. */
export function ensureFolder(root: string, folder: string) {
  if (folder.split("/").length > MAX_DEPTH) throw new PathProblem(`Folders can go ${MAX_DEPTH} levels deep.`);
  let made = "";
  for (const part of folder ? folder.split("/") : []) {
    made = within(made, part);
    const place = onDisk(root, made, { mustExist: false });
    if (!existsSync(place)) mkdirSync(place, { mode: 0o700 });
    else if (!lstatSync(place).isDirectory()) throw new PathProblem(`"${part}" is a file, so it cannot hold others.`);
  }
}

export function makeFolder(root: string, folder: string, name: string) {
  const path = within(folder, cleanName(name));
  if (path.split("/").length > MAX_DEPTH) throw new PathProblem(`Folders can go ${MAX_DEPTH} levels deep.`);
  const place = onDisk(root, path, { mustExist: false });
  if (existsSync(place)) throw new PathProblem("Something with that name is already here.");
  onDisk(root, folder);
  mkdirSync(place, { mode: 0o700 });
  return path;
}

/** A folder cannot go inside itself, and nothing is replaced: a clash gets a new name. */
function checkTarget(root: string, from: string, folder: string) {
  if (!isFolder(root, folder || "")) throw new PathProblem("Choose a folder to put it in.");
  if (folder === from || folder.startsWith(`${from}/`)) throw new PathProblem("A folder cannot go inside itself.");
}

export function moveItem(root: string, from: string, folder: string) {
  onDisk(root, from);
  checkTarget(root, from, folder);
  if (parentOf(from) === folder) return from;
  const to = within(folder, freeName(root, folder, baseOf(from)));
  if (to.split("/").length > MAX_DEPTH) throw new PathProblem(`Folders can go ${MAX_DEPTH} levels deep.`);
  renameSync(onDisk(root, from), join(root, to));
  return to;
}

export function copyItem(root: string, from: string, folder: string) {
  onDisk(root, from);
  checkTarget(root, from, folder);
  const to = within(folder, freeName(root, folder, baseOf(from)));
  cpSync(onDisk(root, from), join(root, to), { recursive: true, errorOnExist: true, force: false, dereference: false, filter: (source) => !lstatSync(source).isSymbolicLink() });
  return to;
}

export function renameItem(root: string, from: string, name: string) {
  const place = onDisk(root, from);
  const clean = cleanName(name);
  if (!statSync(place).isDirectory() && extname(clean).toLowerCase() !== extname(from).toLowerCase()) {
    throw new PathProblem(`Keep the ${extname(from) || "same"} ending, so the file still opens.`);
  }
  const to = within(parentOf(from), clean);
  if (to === from) return from;
  if (existsSync(join(root, to)) && to.toLowerCase() !== from.toLowerCase()) throw new PathProblem("Something with that name is already here.");
  renameSync(place, join(root, to));
  return to;
}

export function removeItem(root: string, path: string) {
  if (!path) throw new PathProblem("The top folder cannot be deleted.");
  rmSync(onDisk(root, path), { recursive: true, force: false });
}

export const posixJoin = posix.join;
