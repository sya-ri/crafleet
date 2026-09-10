"""Exercise real Readline/ZLE/Fish tab completion without executing the edited line."""

import argparse
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import termios
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shell", choices=["bash", "zsh", "fish"], required=True)
    parser.add_argument("--setup", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--startup", action="store_true")
    parser.add_argument("--login", action="store_true")
    parser.add_argument("--expect-compinit-prompt", action="store_true")
    args = parser.parse_args()
    with open(args.cases, encoding="utf-8") as source:
        cases = json.load(source)
    pid, terminal = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 160, 0, 0))
        os.chdir(args.cwd)
        os.environ["TERM"] = "xterm"
        os.environ["HISTFILE"] = "/dev/null"
        if args.shell == "zsh":
            os.environ["PROMPT"] = "__CRAFLEET_STARTUP__ "
        if args.startup:
            options = {"bash": (["--login"] if args.login else []) + ["-i"], "zsh": ["-i"], "fish": ["--private", "--interactive"]}
        else:
            os.environ["XDG_CONFIG_HOME"] = os.path.join(args.cwd, ".shell-config")
            options = {"bash": ["--noprofile", "--norc", "-i"], "zsh": ["-f", "-i"], "fish": ["--no-config", "--private", "--interactive"]}
        os.execvp(args.shell, [args.shell, *options[args.shell]])

    compinit_prompt_seen = False

    def read_until(pattern, allow_compinit_prompt=False):
        nonlocal compinit_prompt_seen
        output = b""
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            ready, _, _ = select.select([terminal], [], [], 0.2)
            if not ready:
                continue
            try:
                chunk = os.read(terminal, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            # Some interactive shells ask the terminal for the cursor position.
            if b"\x1b[6n" in chunk:
                os.write(terminal, b"\x1b[1;1R")
            output += chunk
            if len(output) > 1024 * 1024:
                raise RuntimeError("Unexpectedly large shell output")
            if allow_compinit_prompt and not compinit_prompt_seen and re.search(
                rb"Ignore insecure [^\r\n]+ and continue \[y\] or abort compinit \[n\]\? ",
                output,
            ):
                # Normal compinit may audit runner-provided completion paths.
                # Answer its prompt before sending any commands. 'y' excludes
                # the insecure paths; it does not load their completions.
                os.write(terminal, b"y")
                compinit_prompt_seen = True
            match = re.search(pattern, output)
            if match:
                return match
        raise RuntimeError("Shell completion did not finish: " + repr(output[-4000:]))

    try:
        if args.shell == "zsh":
            read_until(rb"__CRAFLEET_STARTUP__ ", allow_compinit_prompt=True)
        if args.expect_compinit_prompt and not compinit_prompt_seen:
            raise RuntimeError("Expected the Zsh compinit security prompt")
        setup = "'" + args.setup.replace("'", "'\\''") + "'"
        os.write(terminal, ("source " + setup + " && printf '\\n__READY__\\n'\n").encode())
        read_until(rb"\r?\n__READY__\r?\n")
        results = []
        for case in cases:
            os.write(terminal, case.encode() + b"\t")
            # Ctrl-O is a probe widget installed by the fixture. It prints the
            # edited buffer; it never invokes the user's command line.
            os.write(terminal, b"\x0f")
            match = read_until(rb"\r?\n__RESULT__(.*?)__END__\r?\n")
            results.append(match.group(1).decode())
            # Clear through the editor, then acknowledge the empty buffer. A
            # SIGINT would let the terminal driver flush the next probe's input.
            os.write(terminal, b"\x01\x0b\x0f")
            read_until(rb"\r?\n__RESULT____END__\r?\n")
        print(json.dumps(results))
    finally:
        os.close(terminal)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 3
        reaped = False
        while time.monotonic() < deadline:
            ended, _ = os.waitpid(pid, os.WNOHANG)
            if ended:
                reaped = True
                break
            time.sleep(0.05)
        if not reaped:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)


if __name__ == "__main__":
    main()
