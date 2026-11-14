import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  parseReplayDisclosure,
  parseReplayExpectations,
  REPLAY_MAX_DISCLOSURE_BYTES,
  REPLAY_MAX_EXPECTATIONS_BYTES,
} from "../../lib/private-inference-replay/schema";

export async function readLocalReplayFile(
  path: string,
  kind: "keys" | "expectations",
) {
  if (!isAbsolute(path))
    throw new Error("Select an absolute local replay file path");
  const expected = await lstat(path),
    maximum =
      kind === "keys"
        ? REPLAY_MAX_DISCLOSURE_BYTES
        : REPLAY_MAX_EXPECTATIONS_BYTES;
  if (
    !expected.isFile() ||
    expected.isSymbolicLink() ||
    expected.nlink !== 1 ||
    expected.mode & 0o077 ||
    (typeof process.getuid === "function" &&
      expected.uid !== process.getuid()) ||
    expected.size < 1 ||
    expected.size > maximum
  )
    throw new Error(
      "Replay files must be bounded private owner-only regular files without links",
    );
  const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
    buffer = Buffer.alloc(maximum + 1);
  try {
    const info = await file.stat();
    if (
      info.ino !== expected.ino ||
      info.dev !== expected.dev ||
      !info.isFile() ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      info.size !== expected.size
    )
      throw new Error("The local replay file changed before opening");
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (!length || length > maximum)
      throw new Error("The local replay file exceeds its limit");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, length),
    );
    try {
      return kind === "keys"
        ? parseReplayDisclosure(text)
        : parseReplayExpectations(text);
    } catch {
      throw new Error(
        "The local replay file has an unsupported or invalid disclosure format",
      );
    }
  } finally {
    buffer.fill(0);
    await file.close();
  }
}
