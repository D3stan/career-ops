// THE one place every user-layer write goes through. The core's #1 historical
// pain was data-loss (#649/#704/#920/#958); these guards make a web write
// crash-safe + non-clobbering by construction:
//   - atomic: write a UNIQUE temp file (pid + uuid → no concurrent-write race on
//     a single long-lived Next pid) in the SAME dir, then rename (atomic on POSIX),
//     so a kill mid-write can never truncate the real file.
//   - backup: optionally snapshot the prior contents to {file}.bak-{ts} before
//     overwriting, so a bad write is recoverable even though user files are gitignored.

export { atomicWrite, backup, atomicWriteWithBackup } from "./safe-write.mjs";
