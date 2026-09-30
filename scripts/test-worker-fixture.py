#!/usr/bin/env python3
"""Run the real sndmail-worker process against a local Gmail fixture.

Usage: python3 scripts/test-worker-fixture.py [path/to/sndmail-worker]
Build the binary first with `cargo build --bin sndmail-worker` in src-tauri.
The fixture never touches the user's mail database or HOME.
"""

import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
WORKER = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "src-tauri/target/debug/sndmail-worker"
HOLD_SECONDS = int(sys.argv[sys.argv.index("--hold-seconds") + 1]) if "--hold-seconds" in sys.argv else 0
NOW_MS = int(time.time() * 1000)
MESSAGE = {
    "id": "m-fixture-1", "threadId": "t-fixture-1", "labelIds": ["INBOX", "UNREAD"],
    "snippet": "Your verification code is 581942", "internalDate": str(NOW_MS),
    "sizeEstimate": 92,
    "payload": {"mimeType": "text/plain", "headers": [
        {"name": "From", "value": "Fixture <fixture@example.test>"},
        {"name": "To", "value": "reader@example.test"},
        {"name": "Subject", "value": "Your verification code is 581942"},
        {"name": "Message-ID", "value": "<fixture-1@example.test>"},
    ], "body": {"data": base64.urlsafe_b64encode(b"Your verification code is 581942").decode().rstrip("=")}},
}
NEW_MESSAGE = json.loads(json.dumps(MESSAGE))
NEW_MESSAGE["id"] = "m-fixture-2"
NEW_MESSAGE["snippet"] = "Your verification code is 764321"
NEW_MESSAGE["payload"]["headers"][2]["value"] = "Your verification code is 764321"
NEW_MESSAGE["payload"]["body"]["data"] = base64.urlsafe_b64encode(b"Your verification code is 764321").decode().rstrip("=")
TRASH_MESSAGE = json.loads(json.dumps(MESSAGE))
TRASH_MESSAGE.update(id="m-trash", threadId="t-trash", labelIds=["TRASH"], snippet="Old trash", internalDate=str(NOW_MS - 60_000))
TRASH_MESSAGE["payload"]["headers"][2]["value"] = "Old trash"
TRASH_MESSAGE["payload"]["body"]["data"] = base64.urlsafe_b64encode(b"Old trash").decode().rstrip("=")


class Handler(http.server.BaseHTTPRequestHandler):
    delta = False
    refreshes = 0
    gets = 0
    full_lists = 0
    full_includes_trash = 0
    rate_limit_next_history = 0
    rate_limit_responses = 0
    long_retry_next_history = 0
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.__class__.gets += 1
        if self.headers.get("Authorization") != "Bearer fixture-access-new":
            self.send_error(401)
            return
        path = urlparse(self.path).path
        if path.endswith("/history") and (self.rate_limit_next_history or self.long_retry_next_history):
            long_retry = bool(self.long_retry_next_history)
            if long_retry:
                self.__class__.long_retry_next_history -= 1
                self.send_response(429)
                self.send_header("Retry-After", "120")
            else:
                self.__class__.rate_limit_next_history -= 1
                self.send_response(403)
            self.__class__.rate_limit_responses += 1
            body = json.dumps({"error": {"errors": [{"reason": "rateLimitExceeded"}]}}).encode()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.endswith("/profile"):
            data = {"historyId": "100"}
        elif path.endswith("/labels"):
            data = {"labels": [{"id": "INBOX", "name": "Inbox", "type": "system"}]}
        elif path.endswith("/threads"):
            self.__class__.full_lists += 1
            include_trash = "includeSpamTrash=true" in self.path
            self.__class__.full_includes_trash += int(include_trash)
            data = {"threads": [{"id": "t-fixture-1"}] + ([{"id": "t-trash"}] if include_trash else [])}
        elif path.endswith("/threads/t-fixture-1"):
            data = {"id": "t-fixture-1", "messages": [MESSAGE, NEW_MESSAGE] if self.delta else [MESSAGE]}
        elif path.endswith("/threads/t-trash"):
            data = {"id": "t-trash", "messages": [TRASH_MESSAGE]}
        elif path.endswith("/history"):
            if self.delta and "startHistoryId=100" in self.path:
                data = {"historyId": "101", "history": [{"messagesAdded": [{"message": {
                    "id": "m-fixture-2", "threadId": "t-fixture-1", "labelIds": ["INBOX", "UNREAD"]}}]}]}
            else:
                data = {"historyId": "101" if self.delta else "100", "history": []}
        else:
            self.send_error(404)
            return
        payload = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if urlparse(self.path).path != "/token":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        form = parse_qs(self.rfile.read(length).decode())
        expected = "fixture-refresh" if self.__class__.refreshes == 0 else "fixture-refresh-new"
        if form.get("refresh_token") != [expected]:
            self.send_error(401)
            return
        self.__class__.refreshes += 1
        payload = json.dumps({"access_token": "fixture-access-new", "refresh_token": "fixture-refresh-new", "expires_in": 3600}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class RelayHandler(http.server.BaseHTTPRequestHandler):
    registrations = []
    connections = 0
    channels = []
    lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != "/register" or self.headers.get("Authorization") != "Bearer fixture-relay-secret":
            self.send_error(403)
            return
        length = int(self.headers.get("Content-Length", "0"))
        registration = json.loads(self.rfile.read(length))
        with self.lock:
            RelayHandler.registrations.append(registration)
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def do_GET(self):
        if self.path != "/events" or self.headers.get("Authorization") != "Bearer fixture-relay-secret":
            self.send_error(403)
            return
        channel = queue.Queue()
        with self.lock:
            RelayHandler.connections += 1
            RelayHandler.channels.append(channel)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                payload = channel.get(timeout=60)
                self.wfile.write(b"data: " + json.dumps(payload).encode() + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, queue.Empty):
            return

    @classmethod
    def push(cls, payload):
        with cls.lock:
            for channel in cls.channels:
                channel.put(payload)


def database(path):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE _migrations(version INTEGER PRIMARY KEY);
        INSERT INTO _migrations VALUES (32);
        CREATE TABLE accounts (
            id TEXT PRIMARY KEY, email TEXT, display_name TEXT, created_at INTEGER DEFAULT 0,
            provider TEXT, access_token TEXT, refresh_token TEXT,
            token_expires_at INTEGER, history_id TEXT, imap_host TEXT, imap_port INTEGER,
            imap_security TEXT, imap_username TEXT, imap_password TEXT, auth_method TEXT,
            oauth_provider TEXT, oauth_client_id TEXT, oauth_client_secret TEXT,
            accept_invalid_certs INTEGER, is_active INTEGER, last_sync_at INTEGER, updated_at INTEGER
        );
        CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE labels(id TEXT, account_id TEXT, name TEXT, type TEXT, color_bg TEXT,
            color_fg TEXT, imap_folder_path TEXT, imap_special_use TEXT,
            PRIMARY KEY(account_id,id));
        CREATE TABLE threads(id TEXT, account_id TEXT, subject TEXT, snippet TEXT,
            last_message_at INTEGER, message_count INTEGER, is_read INTEGER, is_starred INTEGER,
            is_important INTEGER, has_attachments INTEGER, is_muted INTEGER DEFAULT 0,
            PRIMARY KEY(account_id,id));
        CREATE TABLE thread_labels(account_id TEXT, thread_id TEXT, label_id TEXT,
            PRIMARY KEY(account_id,thread_id,label_id));
        CREATE TABLE messages(id TEXT, account_id TEXT, thread_id TEXT, from_address TEXT,
            from_name TEXT, to_addresses TEXT, cc_addresses TEXT, bcc_addresses TEXT, reply_to TEXT,
            subject TEXT, snippet TEXT, date INTEGER, is_read INTEGER, is_starred INTEGER,
            body_html TEXT, body_text TEXT, body_cached INTEGER, raw_size INTEGER, internal_date INTEGER,
            list_unsubscribe TEXT, list_unsubscribe_post TEXT, message_id_header TEXT,
            references_header TEXT, in_reply_to_header TEXT, disposition_notification_to TEXT,
            is_read_receipt INTEGER DEFAULT 0,
            PRIMARY KEY(account_id,id));
        CREATE VIRTUAL TABLE messages_fts USING fts5(subject,from_name,from_address,body_text,snippet,
            content='messages',content_rowid='rowid',tokenize='trigram');
        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid,subject,from_name,from_address,body_text,snippet)
            VALUES(new.rowid,new.subject,new.from_name,new.from_address,new.body_text,new.snippet);
        END;
        CREATE TABLE attachments(id TEXT PRIMARY KEY, message_id TEXT, account_id TEXT,
            filename TEXT, mime_type TEXT, size INTEGER, gmail_attachment_id TEXT,
            imap_part_id TEXT, content_id TEXT, is_inline INTEGER);
        CREATE TABLE pending_operations(account_id TEXT, resource_id TEXT, status TEXT);
        CREATE TABLE folder_sync_state(account_id TEXT, folder_path TEXT, uidvalidity INTEGER,
            last_uid INTEGER, modseq INTEGER, last_sync_at INTEGER, PRIMARY KEY(account_id,folder_path));
    """)
    db.execute("INSERT INTO accounts(id,email,provider,access_token,refresh_token,token_expires_at,is_active) VALUES(?,?,?,?,?,?,1)",
               ("a-fixture", "reader@example.test", "gmail_api", "expired-token", "fixture-refresh", int(time.time()) - 1))
    db.execute("INSERT INTO settings VALUES ('google_client_id','fixture-client')")
    db.execute("INSERT INTO threads(id,account_id,subject,last_message_at,message_count,is_read,is_starred) VALUES('t-trash','a-fixture','Old trash',?,1,1,0)", (NOW_MS - 60_000,))
    db.execute("INSERT INTO messages(id,account_id,thread_id,subject,body_text,date,is_read,is_starred) VALUES('m-trash','a-fixture','t-trash','Old trash','Old trash',?,1,0)", (NOW_MS - 60_000,))
    db.execute("INSERT INTO thread_labels VALUES ('a-fixture','t-trash','TRASH')")
    db.commit()
    db.close()


def await_mail(path, deadline=20):
    stop = time.monotonic() + deadline
    while time.monotonic() < stop:
        with sqlite3.connect(path) as db:
            result = db.execute("SELECT id, thread_id, body_text FROM messages WHERE id='m-fixture-1'").fetchone()
            if result:
                return result
        time.sleep(0.1)
    raise AssertionError("worker did not persist fixture message")


def wake(data):
    return request(data, {"op": "wake"})


def request(data, payload):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(str(data / "worker.sock"))
        client.sendall(json.dumps(payload).encode() + b"\n")
        response = b""
        while b"\n" not in response:
            chunk = client.recv(4096)
            if not chunk:
                raise ConnectionError("worker closed control socket before response")
            response += chunk
        return json.loads(response.split(b"\n", 1)[0])


def main():
    if not WORKER.is_file():
        raise SystemExit(f"Build worker first: {WORKER}")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    relay_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RelayHandler)
    threading.Thread(target=relay_server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="sndmail-worker-fixture-") as tmp:
        data = Path(tmp)
        data.joinpath("sndmail.key").write_text(base64.b64encode(os.urandom(32)).decode())
        database(data / "sndmail.db")
        with sqlite3.connect(data / "sndmail.db") as db:
            db.executemany("INSERT INTO settings(key,value) VALUES (?,?)", [
                ("gmail_push_relay_url", f"http://127.0.0.1:{relay_server.server_port}"),
                ("gmail_push_relay_secret", "fixture-relay-secret"),
                ("gmail_push_topic_name", "fixture-topic-1"),
            ])
        profile_token = "fixture-profile-token"
        profiles = [{"profile_id": "fixture", "token_sha256": hashlib.sha256(profile_token.encode()).hexdigest(),
                     "account_ids": ["a-fixture"], "scopes": ["metadata"]}]
        profile_path = data / "worker-profiles.json"
        profile_path.write_text(json.dumps(profiles))
        profile_path.chmod(0o600)
        env = dict(os.environ, SNDMAIL_WORKER_FIXTURE="1", SNDMAIL_WORKER_DATA_DIR=str(data),
                   SNDMAIL_WORKER_GMAIL_URL=f"http://127.0.0.1:{server.server_port}/gmail/v1/users/me",
                   SNDMAIL_WORKER_TOKEN_URL=f"http://127.0.0.1:{server.server_port}/token")
        process = subprocess.Popen([str(WORKER)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 10
            while not (data / "worker.sock").exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            assert request(data, {"op": "health"})["data"]["protocol"] == 1
            result = await_mail(data / "sndmail.db")
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                with RelayHandler.lock:
                    connected = RelayHandler.connections >= 1
                    registered = any(r.get("topicName") == "fixture-topic-1" for r in RelayHandler.registrations)
                if connected and registered:
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("worker did not register and connect to local SSE relay")
            with sqlite3.connect(data / "sndmail.db") as db:
                assert result == ("m-fixture-1", "t-fixture-1", "Your verification code is 581942")
                assert db.execute("SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'verification'").fetchone()[0] == 1
                assert db.execute("SELECT history_id FROM accounts WHERE id='a-fixture'").fetchone()[0] == "100"
                refreshed = db.execute("SELECT access_token FROM accounts WHERE id='a-fixture'").fetchone()[0]
                assert refreshed != "fixture-access-new" and ":" in refreshed
                refresh_credential = db.execute("SELECT refresh_token FROM accounts WHERE id='a-fixture'").fetchone()[0]
                assert refresh_credential != "fixture-refresh-new" and ":" in refresh_credential
                initial_refreshes = Handler.refreshes
                assert initial_refreshes == 1, "concurrent startup paths refreshed one credential twice"
                assert db.execute("SELECT COUNT(*) FROM worker_change_events").fetchone()[0] == 1
                assert db.execute("SELECT COUNT(*) FROM worker_otp_notifications").fetchone()[0] == 0
                assert db.execute("SELECT COUNT(*) FROM messages WHERE id='m-trash'").fetchone()[0] == 1
                assert Handler.full_includes_trash == Handler.full_lists
                assert db.execute("SELECT phase FROM worker_mail_status WHERE id=1").fetchone()[0] == "ready"
            auth = {"profile_id": "fixture", "token": profile_token}
            accounts = request(data, {"op": "list_accounts", **auth})
            assert accounts["ok"] and accounts["data"]["accounts"][0]["id"] == "a-fixture"
            recent = request(data, {"op": "recent_messages", "account_id": "a-fixture", **auth})
            assert recent["ok"] and recent["data"]["messages"][0]["id"] == "m-fixture-1"
            changes = request(data, {"op": "changes", **auth})
            assert changes["ok"] and len(changes["data"]["events"]) == 1
            cursor = changes["data"]["next_cursor"]
            Handler.delta = True
            Handler.rate_limit_next_history = 1
            RelayHandler.push({"type": "gmail-history", "email": "reader@example.test"})
            deadline = time.monotonic() + (45 if HOLD_SECONDS else 20)
            while time.monotonic() < deadline:
                with sqlite3.connect(data / "sndmail.db") as db:
                    persisted = db.execute("SELECT COUNT(*) FROM messages WHERE id='m-fixture-2'").fetchone()[0] == 1
                    otp = db.execute("SELECT COUNT(*) FROM worker_otp_notifications").fetchone()[0] == 1
                    history = db.execute("SELECT history_id FROM accounts WHERE id='a-fixture'").fetchone()[0] == "101"
                    if persisted and otp and history:
                        break
                time.sleep(0.1)
            else:
                raise AssertionError("SSE push did not trigger Gmail History delta")
            assert Handler.rate_limit_responses == 1, "transient Gmail 403 was not retried"
            with RelayHandler.lock:
                first_connections = RelayHandler.connections
            wake(data)
            time.sleep(0.4)
            with RelayHandler.lock:
                assert RelayHandler.connections == first_connections, "ordinary wake reconnected SSE"
            with sqlite3.connect(data / "sndmail.db") as db:
                db.execute("UPDATE settings SET value='fixture-topic-2' WHERE key='gmail_push_topic_name'")
            assert request(data, {"op": "relay_reconfigure"})["data"]["reconfigured"]
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                with RelayHandler.lock:
                    reconnected = RelayHandler.connections > first_connections
                    reregistered = any(r.get("topicName") == "fixture-topic-2" for r in RelayHandler.registrations)
                if reconnected and reregistered:
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("relay reconfigure did not reload topic and reopen SSE")
            if HOLD_SECONDS:
                with sqlite3.connect(data / "sndmail.db") as db:
                    delivered = db.execute("SELECT delivered FROM worker_otp_notifications WHERE message_id='m-fixture-2'").fetchone()[0]
                print(f"Packaged notification fixture: worker PID={process.pid}, data={data}, OTP OS request accepted={delivered}", flush=True)
                time.sleep(HOLD_SECONDS)
            wake(data)
            time.sleep(0.5)
            with sqlite3.connect(data / "sndmail.db") as db:
                assert db.execute("SELECT COUNT(*) FROM worker_otp_notifications").fetchone()[0] == 1
                assert db.execute("SELECT COUNT(*) FROM messages WHERE id='m-trash'").fetchone()[0] == 1
            replay = request(data, {"op": "changes", "cursor": {"seq": cursor}, **auth})
            assert replay["ok"] and len(replay["data"]["events"]) == 1
            with sqlite3.connect(data / "sndmail.db") as db:
                db.execute("INSERT INTO worker_resync_requests(account_id) VALUES ('a-fixture')")
            lists_before = Handler.full_lists
            wake(data)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                with sqlite3.connect(data / "sndmail.db") as db:
                    pending_resync = db.execute("SELECT COUNT(*) FROM worker_resync_requests").fetchone()[0]
                if Handler.full_lists > lists_before and pending_resync == 0:
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("queued full resync did not complete")
            with sqlite3.connect(data / "sndmail.db") as db:
                assert db.execute("SELECT COUNT(*) FROM worker_otp_notifications").fetchone()[0] == 1
            duplicate = subprocess.Popen([str(WORKER)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            duplicate_out, duplicate_err = duplicate.communicate(timeout=15)
            assert duplicate.returncode != 0 and b"already owns" in duplicate_err, (duplicate_out, duplicate_err)
            try:
                sample = subprocess.run(["ps", "-o", "rss=,%cpu=", "-p", str(process.pid)], capture_output=True, text=True)
                print(f"Fixture worker snapshot RSS KiB and CPU%: {sample.stdout.strip()}")
            except PermissionError:
                print("Fixture worker snapshot RSS/CPU sampling unavailable in this sandbox")
            previous_gets = Handler.gets
            process.kill()
            process.communicate(timeout=5)
            process = subprocess.Popen([str(WORKER)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    if request(data, {"op": "health"})["data"]["state"] == "ready":
                        break
                except (OSError, KeyError):
                    pass
                time.sleep(0.1)
            else:
                raise AssertionError("worker did not recover after SIGKILL")
            wake(data)
            deadline = time.monotonic() + 10
            while Handler.gets <= previous_gets and time.monotonic() < deadline:
                time.sleep(0.1)
            assert Handler.gets > previous_gets, "restarted worker did not contact fixture provider"
            with sqlite3.connect(data / "sndmail.db") as db:
                assert db.execute("SELECT COUNT(*) FROM worker_otp_notifications").fetchone()[0] == 1
                assert Handler.refreshes == initial_refreshes, "restarted worker did not decrypt persisted access token"
            Handler.long_retry_next_history = 1
            before_retry = Handler.rate_limit_responses
            wake(data)
            deadline = time.monotonic() + 10
            while Handler.rate_limit_responses == before_retry and time.monotonic() < deadline:
                time.sleep(0.05)
            assert Handler.rate_limit_responses > before_retry, "Retry-After fixture was not reached"
            started = time.monotonic()
            process.send_signal(signal.SIGTERM)
            process.communicate(timeout=3)
            assert time.monotonic() - started < 3, "worker did not cancel a bounded retry wait"
            print("PASS: separate worker encrypted OAuth refresh, SSE push/reconfigure, transient Gmail 403 recovery, bounded retry cancellation, baseline, history delta, force resync, API profile/replay, lock, SIGKILL recovery, OTP dedup")
        finally:
            process.send_signal(signal.SIGTERM)
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
    server.shutdown()
    relay_server.shutdown()


if __name__ == "__main__":
    main()
