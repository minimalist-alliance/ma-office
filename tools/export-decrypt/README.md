# Opening a protected data download

When you download your data from the Desk app, you can protect the file with a passphrase you choose. The file then ends in `.zip.enc`, and nothing can open it without that passphrase: not us, not anyone who finds the file. We never see your passphrase and can't recover it, so keep it somewhere safe.

## To open it

You need [Node](https://nodejs.org) 18 or newer, and nothing else:

```sh
node decrypt.mjs minimalist-alliance-export-2026-11-08.zip.enc
```

It asks for the passphrase (what you type isn't shown) and writes `minimalist-alliance-export-2026-11-08.zip` beside the file, which any ZIP tool opens. It won't overwrite a file that's there, reads the file a piece at a time so a download of any size opens in a little memory, and leaves nothing half-opened if the passphrase is wrong or the file is damaged or cut short. The passphrase is never taken on the command line, so it stays out of your shell's history. For a script, `--passphrase-file <file>` reads it from a file only you can read.

## The format (version 1)

So that you aren't tied to this tool: anyone can write another from this page. `web/src/export/passphrase.ts` is the Desk app's own code for it.

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | magic, the ASCII bytes `MAEXPORT` |
| 8 | 1 | format version, `1` |
| 9 | 1 | key derivation, `1` = PBKDF2-HMAC-SHA-256 |
| 10 | 1 | cipher, `1` = AES-256-GCM |
| 11 | 1 | reserved, `0` |
| 12 | 4 | PBKDF2 iterations, big-endian (600000 today) |
| 16 | 16 | salt, random |
| 32 | 4 | record size, big-endian (1048576): plaintext bytes in every record but the last |
| 36 | 4 | nonce prefix, random |
| 40 | to the end | records, back to back |

- **The key:** PBKDF2-HMAC-SHA-256 of the passphrase (Unicode NFC, as UTF-8) with the salt and the iteration count from the header, 32 bytes.
- **A record** is the ciphertext of up to one record size of the ZIP archive, then its 16-byte GCM tag. Every record but the last holds exactly one record size of the archive; the last holds 0 to one record size (0 only for an empty archive).
- **Its IV** is the 4-byte nonce prefix, then the record's number (the first is 0) as 8 big-endian bytes.
- **Its additional data** is the 40 header bytes, then the record's number as 8 big-endian bytes, then one byte: `1` on the last record, `0` on any other. So a record can't be moved, dropped or repeated, and a file cut short fails at its end.
- Putting every record's plaintext together gives the ZIP exactly.

The PBKDF2 count is in the header so a later version can raise it. The archive's `README.txt` says the same once the file is open.
