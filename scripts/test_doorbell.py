import contextlib
import importlib.util
import io
import sqlite3
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("doorbell", Path(__file__).with_name("agent-link-doorbell.py"))
doorbell = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doorbell)

READY = "some output\n──────\n❯ \n──────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"
CODEX_READY = "output\n› \n\n  ? for shortcuts                                  100% context left"
BUSY = "● Working\n✻ Ideating… (6s · ↓ 263 tokens)\n❯ \n  esc to interrupt"
BUSY_MINUTES = "✻ Cooking… (2m 14s · ↓ 4k tokens)\n❯ \n──────"
DIALOG = "Quick safety check: is this a project you trust?\n❯ No, exit\n  Yes, I trust this folder\nEnter to confirm · Esc to cancel"
TYPING = "──────\n❯ half written by a human\n──────"


class Harness:
    def __init__(self, **options):
        self.ids = ()
        self.pane = READY
        self.now = 0.0
        self.sent, self.giveups, self.logs = [], [], []
        self.fail_send = False

        def send(text):
            if self.fail_send:
                raise RuntimeError("tmux down")
            self.sent.append(text)
        self.ringer = doorbell.Ringer(lambda: self.ids, lambda: self.pane, send,
                                      lambda count, reason: self.giveups.append((count, reason)),
                                      self.logs.append, clock=lambda: self.now, **options)


class ClassifyTests(unittest.TestCase):
    def test_screens(self):
        self.assertEqual(doorbell.classify_pane(READY), "ready")
        self.assertEqual(doorbell.classify_pane(CODEX_READY), "ready")
        self.assertEqual(doorbell.classify_pane(BUSY), "busy")
        self.assertEqual(doorbell.classify_pane(BUSY_MINUTES), "busy")
        self.assertEqual(doorbell.classify_pane(DIALOG), "dialog")
        self.assertEqual(doorbell.classify_pane(TYPING), "typing")
        self.assertEqual(doorbell.classify_pane(""), "typing")

    def test_blank_rows_below_the_ui_do_not_hide_the_prompt(self):
        padded = "──────\n❯\n──────\n" + "\n" * 15  # tmux pads a short pane with empty rows
        self.assertEqual(doorbell.classify_pane(padded), "ready")
        busy_padded = "✻ Working… (5s · ↓ 10 tokens)\n❯\n" + "\n" * 15
        self.assertEqual(doorbell.classify_pane(busy_padded), "busy")

    def test_only_the_last_prompt_line_counts(self):
        stale_empty_above = "❯\nI typed this earlier and it ran\n❯ half written by a human\n──────"
        self.assertEqual(doorbell.classify_pane(stale_empty_above), "typing")
        self.assertEqual(doorbell.classify_pane("❯ old command\noutput\n❯\n──────"), "ready")

    def test_multiline_draft_below_an_empty_looking_prompt_is_not_ready(self):
        self.assertEqual(doorbell.classify_pane("output\n›\n  second line of a multi-line draft"), "typing")
        self.assertEqual(doorbell.classify_pane("❯\nwrite the report about invoices\n──────"), "typing")

    def test_dialog_wins_over_empty_prompt(self):
        self.assertEqual(doorbell.classify_pane("Do you want to proceed?\n❯ \n(y/n)"), "dialog")
        self.assertEqual(doorbell.classify_pane("Select an option\n❯ \nPress Enter to select"), "dialog")


class RingerTests(unittest.TestCase):
    def test_no_unseen_never_rings(self):
        h = Harness()
        self.assertEqual(h.ringer.step(), "idle")
        self.assertEqual(h.sent, [])

    def test_rings_with_fixed_text_only_and_backs_off(self):
        h = Harness(base_delay=30, max_delay=600)
        h.ids = ("secret-message-id",)
        self.assertEqual(h.ringer.step(), "rang")
        self.assertEqual(h.sent, [doorbell.NUDGE_TEXT])
        self.assertNotIn("secret-message-id", h.sent[0])
        h.now = 29
        self.assertEqual(h.ringer.step(), "waiting")
        h.now = 30
        self.assertEqual(h.ringer.step(), "rang")
        h.now = 30 + 59
        self.assertEqual(h.ringer.step(), "waiting")  # delay doubled to 60
        h.now = 30 + 60
        self.assertEqual(h.ringer.step(), "rang")
        self.assertEqual(len(h.sent), 3)

    def test_busy_dialog_and_typing_never_receive_keystrokes_and_do_not_use_attempts(self):
        for pane, outcome in ((BUSY, "skip_busy"), (DIALOG, "skip_dialog"), (TYPING, "skip_typing")):
            h = Harness(max_attempts=1)
            h.ids = ("m1",)
            h.pane = pane
            self.assertEqual(h.ringer.step(), outcome)
            self.assertEqual(h.sent, [])
            self.assertEqual(h.ringer.attempts, 0)
            h.pane = READY  # becomes idle later: rings at once, attempt budget intact
            self.assertEqual(h.ringer.step(), "rang")
            self.assertEqual(len(h.sent), 1)

    def test_alert_waits_one_last_interval_after_the_final_reminder(self):
        h = Harness(max_attempts=2, base_delay=10, max_delay=600)
        h.ids = ("m1",)
        self.assertEqual(h.ringer.step(), "rang")      # t=0
        h.now = 10
        self.assertEqual(h.ringer.step(), "rang")      # t=10, final reminder, next deadline t=30
        self.assertEqual(h.giveups, [])                # not alerted right after sending
        h.now = 29
        self.assertEqual(h.ringer.step(), "waiting")
        h.now = 30
        self.assertEqual(h.ringer.step(), "gave_up_now")
        self.assertEqual(h.giveups, [(1, "no response after 2 reminders")])
        for tick in range(2, 6):
            h.now = tick * 100
            self.assertEqual(h.ringer.step(), "gave_up")
        self.assertEqual(len(h.giveups), 1)             # alert fires once
        self.assertEqual(len(h.sent), 2)

    def test_agent_answering_during_the_last_interval_cancels_the_alert(self):
        h = Harness(max_attempts=1, base_delay=10)
        h.ids = ("m1",)
        h.ringer.step()
        h.ids = ()
        h.now = 50
        self.assertEqual(h.ringer.step(), "idle")
        self.assertEqual(h.giveups, [])

    def test_new_message_rearms_budget_but_keeps_the_backoff_floor(self):
        h = Harness(max_attempts=2, base_delay=30, max_delay=600)
        h.ids = ("m1",)
        h.ringer.step()                                 # t=0 rang, next_ring=30
        h.now = 1
        h.ids = ("m1", "m2")
        self.assertEqual(h.ringer.step(), "waiting")    # not a second ring one second later
        h.now = 30
        self.assertEqual(h.ringer.step(), "rang")
        self.assertEqual(h.ringer.attempts, 1)          # budget was re-armed by the new message

    def test_marking_one_message_seen_does_not_reset_anything(self):
        h = Harness(max_attempts=3, base_delay=30)
        h.ids = ("m1", "m2")
        h.ringer.step()
        h.now = 1
        h.ids = ("m2",)
        self.assertEqual(h.ringer.step(), "waiting")
        self.assertEqual(h.ringer.attempts, 1)

    def test_dialog_or_unknown_screen_for_too_long_alerts_a_human(self):
        h = Harness(max_blocked=3)
        h.ids = ("m1",)
        h.pane = DIALOG
        self.assertEqual([h.ringer.step() for _ in range(3)], ["skip_dialog", "skip_dialog", "gave_up_now"])
        self.assertEqual(h.giveups, [(1, "session blocked by a dialog")])
        self.assertEqual(h.sent, [])

    def test_a_long_busy_turn_is_not_an_alert(self):
        h = Harness(max_blocked=2)
        h.ids = ("m1",)
        h.pane = BUSY
        for _ in range(10):
            self.assertEqual(h.ringer.step(), "skip_busy")
        self.assertEqual(h.giveups, [])

    def test_typing_failures_are_bounded_and_alert(self):
        h = Harness(base_delay=5)
        h.ids = ("m1",)
        h.fail_send = True
        outcomes = []
        for tick in range(3):
            h.now = tick * 5
            outcomes.append(h.ringer.step())
        self.assertEqual(outcomes, ["send_failed", "send_failed", "gave_up_now"])
        self.assertEqual(h.giveups, [(1, "cannot type into the session")])
        self.assertEqual(h.ringer.attempts, 0)  # nothing was actually delivered

    def test_inbox_read_failure_keeps_state_and_does_not_ring_or_reset(self):
        h = Harness(max_attempts=3, base_delay=1)
        h.ids = ("m1",)
        self.assertEqual(h.ringer.step(), "rang")

        def broken():
            raise OSError("network down")
        h.ringer.unseen_ids = broken
        h.now = 5
        self.assertEqual(h.ringer.step(), "error")
        self.assertEqual((h.ringer.attempts, h.ringer.signature), (1, ("m1",)))
        self.assertEqual(len(h.sent), 1)
        h.ringer.unseen_ids = lambda: ("m1",)  # recovery resumes the same episode
        self.assertEqual(h.ringer.step(), "rang")
        self.assertEqual(h.ringer.attempts, 2)

    def test_reading_everything_resets_state(self):
        h = Harness(max_attempts=2, base_delay=1)
        h.ids = ("m1",)
        h.ringer.step()
        h.ids = ()
        self.assertEqual(h.ringer.step(), "idle")
        self.assertEqual((h.ringer.attempts, h.ringer.gave_up, h.ringer.signature), (0, False, None))
        h.ids = ("m1",)  # same id unseen again is a fresh episode
        h.now = 100
        self.assertEqual(h.ringer.step(), "rang")


class UnseenReaderTests(unittest.TestCase):
    def bridge(self, allowed=("c",), poll_fails=False, authorize_fails=False):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.execute("CREATE TABLE inbox(id TEXT, channel_id TEXT, seen_at REAL, accepted_at REAL)")
        db.executemany("INSERT INTO inbox VALUES(?,?,?,?)", [
            ("unseen1", "c", None, None), ("seen", "c", 1.0, None), ("accepted", "c", None, 2.0),
            ("other-channel", "d", None, None), ("unseen2", "c", None, None)])

        class Bridge:
            def poll_inbox(self, limit):
                if poll_fails:
                    raise OSError("offline")

            def _authorize(self):
                if authorize_fails:
                    raise OSError("offline")
                return allowed
        bridge = Bridge()
        bridge.db = db
        return bridge

    def test_only_unseen_unaccepted_messages_in_allowed_channels_count(self):
        self.assertEqual(doorbell.make_unseen_reader(self.bridge())(), ("unseen1", "unseen2"))
        self.assertEqual(doorbell.make_unseen_reader(self.bridge(allowed=("c", "d")))(),
                         ("unseen1", "other-channel", "unseen2"))
        self.assertEqual(doorbell.make_unseen_reader(self.bridge(allowed=()))(), ())

    def test_failed_poll_is_reported_but_cached_state_is_still_read(self):
        with contextlib.redirect_stderr(io.StringIO()) as captured:
            ids = doorbell.make_unseen_reader(self.bridge(poll_fails=True))()
        self.assertEqual(ids, ("unseen1", "unseen2"))
        self.assertIn("poll failed (OSError)", captured.getvalue())

    def test_authorize_outage_raises_so_the_ringer_cannot_mistake_it_for_empty(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(OSError):
            doorbell.make_unseen_reader(self.bridge(authorize_fails=True))()


class SendTests(unittest.TestCase):
    """tmux_send against a scripted screen: how many Enters, and when it must refuse."""

    def run_send(self, screens, enters_needed):
        keys = []
        state = {"enters": 0, "shown": 0}

        def run(command, **kwargs):
            keys.append(command[-1] if command[-1] == "Enter" else "TEXT")
            if command[-1] == "Enter":
                state["enters"] += 1

        def capture():
            if state["enters"] >= enters_needed:
                return screens["sent"]
            return screens["typed"] if state["shown"] else screens["ready"]

        def run_and_mark(command, **kwargs):
            run(command, **kwargs)
            if command[-1] != "Enter":
                state["shown"] = 1
        return keys, doorbell.tmux_send, run_and_mark, capture

    SCREENS = {"ready": READY,
               "typed": "──────\n❯ " + doorbell.NUDGE_TEXT + "\n──────\n  ⏵⏵ auto mode on",
               "sent": "● Reading inbox\n──────\n❯ \n──────\n  ⏵⏵ auto mode on"}

    def test_first_enter_is_enough(self):
        keys, send, run, capture = self.run_send(self.SCREENS, 1)
        send("%0", doorbell.NUDGE_TEXT, sleep=lambda s: None, capture=capture, run=run)
        self.assertEqual(keys, ["TEXT", "Enter"])

    def test_a_swallowed_first_enter_is_retried_once_the_text_is_still_visible(self):
        keys, send, run, capture = self.run_send(self.SCREENS, 2)  # Claude Code's observed behaviour
        send("%0", doorbell.NUDGE_TEXT, sleep=lambda s: None, capture=capture, run=run)
        self.assertEqual(keys, ["TEXT", "Enter", "Enter"])

    def test_enter_is_withheld_when_the_text_never_appears(self):
        keys, send, run, capture = self.run_send({**self.SCREENS, "typed": READY}, 99)
        with self.assertRaises(RuntimeError):
            send("%0", doorbell.NUDGE_TEXT, sleep=lambda s: None, capture=capture, run=run)
        self.assertEqual(keys, ["TEXT"])

    def test_enter_is_withheld_when_a_dialog_appears_after_typing(self):
        keys, send, run, capture = self.run_send({**self.SCREENS, "typed": DIALOG + "\n" + self.SCREENS["typed"]}, 99)
        with self.assertRaises(RuntimeError):
            send("%0", doorbell.NUDGE_TEXT, sleep=lambda s: None, capture=capture, run=run)
        self.assertEqual(keys, ["TEXT"])

    def test_gives_up_after_bounded_enters_if_it_never_submits(self):
        keys, send, run, capture = self.run_send(self.SCREENS, 99)
        with self.assertRaises(RuntimeError):
            send("%0", doorbell.NUDGE_TEXT, sleep=lambda s: None, capture=capture, run=run)
        self.assertEqual(keys.count("Enter"), 3)

    def test_refuses_to_start_when_the_session_is_not_ready(self):
        keys, send, run, capture = self.run_send({**self.SCREENS, "ready": BUSY}, 1)
        with self.assertRaises(RuntimeError):
            send("%0", doorbell.NUDGE_TEXT, sleep=lambda s: None, capture=capture, run=run)
        self.assertEqual(keys, [])


class ArgumentTests(unittest.TestCase):
    def test_non_finite_and_non_positive_delays_are_rejected(self):
        for flag, value in (("--max-delay", "0"), ("--max-delay", "-5"), ("--base-delay", "nan"),
                            ("--interval", "inf")):
            with self.subTest(flag=flag, value=value), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                doorbell.main(["--config", "/x.json", "--tmux-target", "t", flag, value])

    def test_max_delay_below_base_delay_is_rejected(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            doorbell.main(["--config", "/x.json", "--tmux-target", "t", "--base-delay", "60", "--max-delay", "30"])


if __name__ == "__main__":
    unittest.main()
