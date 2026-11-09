import { api } from "./api.ts";

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
  reader.onerror = () => reject(new Error("This file could not be read."));
  reader.readAsDataURL(file);
});

/** Uploads a file to this workspace and returns the path it was saved under. A name may hold folders, as from a folder upload. */
export async function uploadFile(path: string, file: File, folder = "", name = file.name): Promise<string> {
  const { name: saved } = await api(`${path}/files`, { body: { name, folder, dataBase64: await toBase64(file) } });
  return saved;
}
