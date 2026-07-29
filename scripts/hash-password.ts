#!/usr/bin/env tsx
// Generate a bcrypt hash for AUTH_PASSWORD_HASH.
//
//   npm run auth:hash              # prompts, input hidden
//   npm run auth:hash -- 'secret'  # non-interactive (note: lands in shell history)
//
// Put the printed line in your .env. Storing the hash instead of the plaintext
// means a leaked .env does not hand over a directly reusable password.

import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;
const MIN_LENGTH = 12;

// Read a line from stdin without echoing it. Uses raw mode when stdin is a TTY
// so the password never appears on screen or in the terminal scrollback.
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(new Error("No TTY available — pass the password as an argument instead."));
      return;
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        switch (char) {
          case "\n":
          case "\r":
          case "\u0004": // Ctrl-D
            cleanup();
            stdout.write("\n");
            resolve(value);
            return;
          case "\u0003": // Ctrl-C
            cleanup();
            stdout.write("\n");
            reject(new Error("Cancelled."));
            return;
          case "\u007f": // Backspace
          case "\b":
            value = value.slice(0, -1);
            break;
          default:
            // Ignore other control characters.
            if (char >= " ") value += char;
        }
      }
    };

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const fromArgv = process.argv[2];
  const password = fromArgv ?? (await promptHidden("Dashboard password: "));

  if (!password || password.length < MIN_LENGTH) {
    console.error(`Password must be at least ${MIN_LENGTH} characters.`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  console.log("\nAdd this to your .env (and remove any plaintext AUTH_PASSWORD):\n");
  console.log(`AUTH_PASSWORD_HASH=${hash}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
