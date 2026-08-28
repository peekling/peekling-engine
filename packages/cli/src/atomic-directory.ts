import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

async function assertAbsent(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing path: ${target}`);
}

export async function atomicDirectory(
  target: string,
  writer: (temp: string) => Promise<void>,
): Promise<void> {
  const absolute = path.resolve(target);
  await assertAbsent(absolute);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temp = await mkdtemp(path.join(path.dirname(absolute), ".peekling-"));
  try {
    await writer(temp);
    await assertAbsent(absolute);
    await rename(temp, absolute);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}
