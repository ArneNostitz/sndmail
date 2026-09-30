#!/usr/bin/env python3
"""Exercise the standalone worker against a local, deterministic IMAP server."""

import email.utils
import importlib.util
import json
import os
from pathlib import Path
import socket
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
WORKER = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "src-tauri/target/release/sndmail-worker"
spec = importlib.util.spec_from_file_location("gmail_fixture", ROOT / "scripts/test-worker-fixture.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def raw_message(uid, parent=None):
    refs = f"References: <{parent}>\r\nIn-Reply-To: <{parent}>\r\n" if parent else ""
    return (f"From: Fixture <fixture@example.test>\r\nTo: reader@example.test\r\n"
            f"Subject: {'Re: ' if parent else ''}Fixture IMAP\r\n"
            f"Date: {email.utils.formatdate(usegmt=True)}\r\n"
            f"Message-ID: <imap-{uid}@example.test>\r\n{refs}"
            "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
            f"Fixture body {uid}\r\n").encode()


class State:
    uidvalidity = 1
    messages = {1: (raw_message(1), "")}
    lock = threading.Lock()


class ImapHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b"* OK fixture IMAP ready\r\n")
        self.wfile.flush()
        idle_tag = None
        while True:
            line = self.rfile.readline()
            if not line:
                return
            line = line.decode(errors="replace").strip()
            if os.environ.get("SNDMAIL_FIXTURE_TRACE"):
                print(f"IMAP <= {line}", flush=True)
            if idle_tag and line.upper() == "DONE":
                self.reply(idle_tag, "OK IDLE finished")
                idle_tag = None
                continue
            parts = line.split(" ", 2)
            if len(parts) < 2:
                continue
            tag, command = parts[0], parts[1].upper()
            args = parts[2] if len(parts) > 2 else ""
            with State.lock:
                items = dict(State.messages)
                validity = State.uidvalidity
            if command == "CAPABILITY":
                self.wfile.write(b"* CAPABILITY IMAP4rev1 IDLE UIDPLUS\r\n")
            elif command == "LOGIN":
                pass
            elif command == "LIST":
                self.wfile.write(b'* LIST (\\HasNoChildren \\Inbox) "/" "INBOX"\r\n')
            elif command in ("SELECT", "EXAMINE"):
                self.wfile.write(b"* FLAGS (\\Seen \\Flagged)\r\n")
                self.wfile.write(f"* {len(items)} EXISTS\r\n".encode())
                self.wfile.write(f"* OK [UIDVALIDITY {validity}] valid\r\n".encode())
                self.wfile.write(f"* OK [UIDNEXT {max(items, default=0) + 1}] next\r\n".encode())
            elif command == "STATUS":
                unseen = sum("\\Seen" not in flags for _, flags in items.values())
                self.wfile.write(f'* STATUS "INBOX" (MESSAGES {len(items)} UIDNEXT {max(items, default=0) + 1} UIDVALIDITY {validity} UNSEEN {unseen})\r\n'.encode())
            elif command == "UID":
                subparts = args.split(" ", 2)
                operation = subparts[0].upper() if subparts else ""
                if operation == "SEARCH":
                    query = " ".join(subparts[1:])
                    selected = list(items)
                    if ":*" in query:
                        floor = int(query.split(":", 1)[0])
                        selected = [uid for uid in selected if uid >= floor]
                    self.wfile.write(("* SEARCH " + " ".join(map(str, selected)) + "\r\n").encode())
                elif operation == "FETCH":
                    uid_set = subparts[1]
                    requested = set()
                    for part in uid_set.split(","):
                        if ":" in part:
                            low, high = part.split(":")
                            requested.update(range(int(low), max(items, default=0) + 1 if high == "*" else int(high) + 1))
                        else:
                            requested.add(int(part))
                    flags_only = "BODY" not in args.upper()
                    for seq, uid in enumerate(sorted(items), 1):
                        if uid not in requested:
                            continue
                        raw, flags = items[uid]
                        if flags_only:
                            self.wfile.write(f"* {seq} FETCH (UID {uid} FLAGS ({flags}))\r\n".encode())
                        else:
                            date = email.utils.formatdate(usegmt=True)
                            self.wfile.write(f'* {seq} FETCH (UID {uid} FLAGS ({flags}) INTERNALDATE "30-Sep-2026 12:00:00 +0000" BODY[] {{{len(raw)}}}\r\n'.encode())
                            self.wfile.write(raw + b")\r\n")
            elif command == "IDLE":
                self.wfile.write(b"+ idling\r\n")
                self.wfile.flush()
                idle_tag = tag
                continue
            elif command == "NOOP":
                pass
            elif command == "LOGOUT":
                self.wfile.write(b"* BYE logout\r\n")
                self.reply(tag, "OK LOGOUT")
                return
            else:
                self.reply(tag, "BAD unsupported")
                continue
            self.reply(tag, "OK completed")

    def reply(self, tag, text):
        self.wfile.write(f"{tag} {text}\r\n".encode())
        self.wfile.flush()


def until(predicate, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.1)
    raise AssertionError("IMAP fixture worker did not reach expected state")


def main():
    with socketserver.ThreadingTCPServer(("127.0.0.1", 0), ImapHandler) as server:
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory(prefix="sndmail-imap-worker-") as tmp:
            data = Path(tmp)
            fixture.database(data / "sndmail.db")
            with sqlite3.connect(data / "sndmail.db") as db:
                db.execute("DELETE FROM messages WHERE id='m-trash'")
                db.execute("DELETE FROM thread_labels WHERE thread_id='t-trash'")
                db.execute("DELETE FROM threads WHERE id='t-trash'")
                db.execute("ALTER TABLE messages ADD COLUMN imap_uid INTEGER")
                db.execute("ALTER TABLE messages ADD COLUMN imap_folder TEXT")
                db.execute("ALTER TABLE messages ADD COLUMN auth_results TEXT")
                db.execute("UPDATE accounts SET provider='imap', imap_host='127.0.0.1', imap_port=?, imap_security='none', imap_password='fixture-pass', auth_method='password', access_token=NULL, refresh_token=NULL WHERE id='a-fixture'", (server.server_address[1],))
            env = dict(os.environ, SNDMAIL_WORKER_FIXTURE="1", SNDMAIL_WORKER_DATA_DIR=str(data))
            process = subprocess.Popen([str(WORKER)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                def count():
                    with sqlite3.connect(data / "sndmail.db") as db:
                        return db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
                try:
                    until(lambda: count() == 1)
                except AssertionError:
                    with sqlite3.connect(data / "sndmail.db") as db:
                        status = db.execute("SELECT phase, error FROM worker_mail_status").fetchall()
                    raise AssertionError(f"IMAP initial sync failed: status={status}, exit={process.poll()}")
                with sqlite3.connect(data / "sndmail.db") as db:
                    mid, thread = db.execute("SELECT id, thread_id FROM messages").fetchone()
                    assert mid == "imap-a-fixture-INBOX-1" and thread.startswith("imap-thread-"), (mid, thread)
                with State.lock:
                    State.messages[2] = (raw_message(2, "imap-1@example.test"), "")
                fixture.wake(data)
                until(lambda: count() == 2)
                with sqlite3.connect(data / "sndmail.db") as db:
                    rows = db.execute("SELECT id, thread_id FROM messages ORDER BY id").fetchall()
                    assert rows[0][1] == rows[1][1], rows
                with State.lock:
                    raw, _ = State.messages[2]
                    State.messages[2] = (raw, "\\Seen \\Flagged")
                fixture.wake(data)
                def flags_updated():
                    with sqlite3.connect(data / "sndmail.db") as db:
                        return db.execute("SELECT is_read, is_starred FROM messages WHERE imap_uid=2").fetchone() == (1, 1)
                until(flags_updated)
                with State.lock:
                    del State.messages[2]
                fixture.wake(data)
                until(lambda: count() == 1)
                with sqlite3.connect(data / "sndmail.db") as db:
                    old_thread = db.execute("SELECT thread_id FROM messages WHERE imap_uid=1").fetchone()[0]
                    db.execute("INSERT INTO pending_operations VALUES ('a-fixture', ?, 'pending')", (old_thread,))
                with State.lock:
                    State.uidvalidity = 2
                    State.messages = {1: (raw_message(99), "")}
                fixture.wake(data)
                time.sleep(0.5)
                with sqlite3.connect(data / "sndmail.db") as db:
                    assert db.execute("SELECT body_text FROM messages WHERE imap_uid=1").fetchone()[0].strip() == "Fixture body 1"
                    assert db.execute("SELECT uidvalidity FROM folder_sync_state").fetchone()[0] == 1
                    db.execute("DELETE FROM pending_operations")
                fixture.wake(data)
                def validity_replaced():
                    with sqlite3.connect(data / "sndmail.db") as db:
                        body = db.execute("SELECT body_text FROM messages WHERE imap_uid=1").fetchone()
                        validity = db.execute("SELECT uidvalidity FROM folder_sync_state").fetchone()
                        return body and body[0].strip() == "Fixture body 99" and validity and validity[0] == 2
                until(validity_replaced)
                print("PASS: separate IMAP worker initial/UID delta, References, flags, expunge and pending-safe UIDVALIDITY reset")
            finally:
                process.kill()
                out, err = process.communicate(timeout=5)
                if process.returncode not in (-9, 0):
                    print(out.decode(errors="replace"), err.decode(errors="replace"), file=sys.stderr)
                server.shutdown()


if __name__ == "__main__":
    main()
