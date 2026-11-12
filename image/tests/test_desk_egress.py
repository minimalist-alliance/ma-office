#!/usr/bin/python3 -I
"""desk-egress on a fake clock, and on a fake tc. No root, no network. python3 -I image/tests/test_desk_egress.py"""
import calendar
import configparser
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest

sys.dont_write_bytecode = True  # Nothing lands in the release's directory.
RECIPE = pathlib.Path(__file__).resolve().parent.parent / "recipe"
loader = importlib.machinery.SourceFileLoader("desk_egress", str(RECIPE / "desk-egress" / "desk-egress"))
spec = importlib.util.spec_from_loader("desk_egress", loader)
E = importlib.util.module_from_spec(spec)
loader.exec_module(E)
E.log = lambda *a, **k: None

GB = 10**9
GBH = {"normal": 3.75, "capped": 1.89, "deep": 1.20}  # A viewer at each profile's hard cap, ADR 0036 section 1
OCT1 = calendar.timegm((2026, 10, 1, 0, 0, 0))  # A 31-day month, as the ADR's table


def cfg(**over):
    return {**E.DEFAULTS, **over}


def mbps_gbh(m):
    return m * 0.45


GBH_MAX = {"normal": 5.55, "capped": 1.89, "deep": 1.20}  # level Max (ADR 0039), held to the capped picture past 100 GB (S-29)


def simulate(viewers, other_saturated=False, rtc_broken=False, days=31, baseline_gbh=0.03, uploads=(), gbh=None):
    """By the minute, as section 5 did. Each class sends what its kernel ceiling lets it, so a clamp or a profile feeds back.
    uploads: (start hour, GB), each sent on 1:20 as fast as its class lets it. gbh: a viewer's GB an hour at each profile."""
    gbh = gbh or GBH
    b = E.Budget(cfg(), OCT1)
    counters = {"10": 0, "15": 0, "20": 0}
    minutes, per_minute = days * 1440, []
    flags = {"clamped": 0, "slowed": 0, "profiles": []}
    pending, left = sorted(uploads), 0.0
    for m in range(minutes):
        rates = b.rates()
        stream_gbh = mbps_gbh(rates["10"]) if rtc_broken else min(viewers(m) * gbh[b.profile], mbps_gbh(rates["10"]))
        other_gbh = mbps_gbh(rates["20"] + rates["15"]) if other_saturated else baseline_gbh
        while pending and pending[0][0] * 60 <= m:
            left += pending.pop(0)[1]
        if left > 0 and not other_saturated:
            up = min(left, max(0.0, mbps_gbh(rates["20"]) - other_gbh) / 60)
            left -= up
            other_gbh += up * 60
        s, o = stream_gbh * GB / 60, other_gbh * GB / 60
        counters["10"] += int(s)
        counters["20"] += int(o)
        per_minute.append((s + o) / GB)
        b.tick(OCT1 + m * 60 + 59, dict(counters))
        flags["clamped"] += b.clamped
        flags["slowed"] += b.slowed
        if not flags["profiles"] or flags["profiles"][-1] != b.profile:
            flags["profiles"].append(b.profile)
    def peak(window):
        run, best = 0.0, 0.0
        for i, v in enumerate(per_minute):
            run += v
            if i >= window:
                run -= per_minute[i - window]
            best = max(best, run)
        return best
    return types.SimpleNamespace(p15=peak(15), p24=peak(1440), month=sum(per_minute), **flags)


class AdrTable(unittest.TestCase):
    """Section 5's table: peak 15 min, peak 24 h, month. Within 3%: the ADR's sim isn't in the repo, and its small baseline is unknown."""

    def near(self, got, want, what):
        self.assertLessEqual(abs(got - want), max(0.03 * want, 0.06), f"{what}: got {got:.2f}, ADR says {want}")

    def check(self, r, p15, p24, month):
        self.near(r.p15, p15, "peak 15 min")
        self.near(r.p24, p24, "peak 24 h")
        self.near(r.month, month, "month")

    def test_video_8h_a_day(self):
        r = simulate(lambda m: 1 if m % 1440 < 480 else 0)
        self.check(r, 0.9, 31, 527)
        self.assertEqual(r.clamped, 0)
        self.assertLess(r.p24, 150)

    def test_one_viewer_nonstop(self):
        r = simulate(lambda m: 1)
        self.check(r, 0.9, 91, 1127)
        self.assertEqual(r.profiles, ["normal", "capped", "deep"])
        self.assertEqual(r.clamped, 0)

    def test_other_saturated_nobody_viewing(self):
        r = simulate(lambda m: 0, other_saturated=True)
        self.check(r, 11.3, 40, 364)
        self.assertGreater(r.slowed, 0)

    def test_one_viewer_and_other_saturated(self):
        r = simulate(lambda m: 1, other_saturated=True)
        self.check(r, 12.2, 107.7, 1411)  # S-29: 117 GB in 24 h before; the deep line looks ahead now

    def test_two_viewers_nonstop(self):
        r = simulate(lambda m: 2)
        self.check(r, 1.9, 105.4, 1996)  # S-29: 133 GB in 24 h before, 2 GB under the clamp; now the deep line holds them
        self.assertEqual(r.clamped, 0, "two honest viewers must never reach the clamp")

    def test_broken_rtc_section_3(self):
        r = simulate(lambda m: 0, rtc_broken=True, days=2)
        self.assertGreater(r.clamped, 0)
        self.near(r.p24, 144, "broken desk-rtc, any 24 h")

    def test_broken_rtc_and_other_saturated_section_3(self):
        """Both at their ceilings: the clamp counts desk-rtc's class alone now (S-29), so it comes at 135 GB of the stream, not
        135 of everything, and the guard's day stop ends it sooner, at 4.4 h rather than 20.4. It reached the stop before too (153)."""
        r = simulate(lambda m: 0, rtc_broken=True, other_saturated=True, days=2)
        self.near(r.p24, 184.6, "broken desk-rtc and bucket saturated, any 24 h")
        self.assertGreater(r.clamped, 0)


GUARD_DAY_GB = 150  # ADR 0082's `day` stop: everything the desk sent in 24 h


class HonestViewers(unittest.TestCase):
    """S-29 (16 D, item 2): two or three honest viewers and an upload never clamp desk-rtc or reach the guard's day stop.
    From the 1st of a month, so the 100 GB month line can't step the stream down first. The weekend review's cases, by the
    real class. Before S-29 each of these clamped, and the uploads also reached the stop (image/lab/s29/)."""

    def honest(self, r, what):
        self.assertEqual(r.clamped, 0, f"{what}: clamped {r.clamped} minutes")
        self.assertLess(r.p24, GUARD_DAY_GB - 10, f"{what}: {r.p24:.1f} GB in 24 h")

    def test_two_viewers_and_a_whole_bucket_upload_at_any_hour(self):
        for hour in (12, 20, 23, 30):
            with self.subTest(hour=hour):
                self.honest(simulate(lambda m: 2, days=2, uploads=((hour, 30),)), f"2 viewers, 30 GB at hour {hour}")

    def test_two_viewers_and_6_gb_a_day_of_other_traffic(self):
        self.honest(simulate(lambda m: 2, days=2, baseline_gbh=0.25), "2 viewers, 6 GB a day")

    def test_two_viewers_at_max(self):
        r = simulate(lambda m: 2, days=3, gbh=GBH_MAX, uploads=((23, 30),))
        self.honest(r, "2 viewers at Max, 30 GB at hour 23")
        self.assertLessEqual(len(r.profiles), 6, f"flapping: {r.profiles}")

    def test_three_viewers_and_an_upload(self):
        for hour in (5, 17):
            with self.subTest(hour=hour):
                self.honest(simulate(lambda m: 3, days=2, uploads=((hour, 30),)), f"3 viewers, 30 GB at hour {hour}")

    def test_four_viewers_never_clamp(self):
        r = simulate(lambda m: 4, days=2)
        self.assertEqual(r.clamped, 0)
        self.assertLess(r.p24, GUARD_DAY_GB)

    def test_one_viewer_is_as_before(self):
        """One viewer nonstop at High: nothing in a day steps it, and only the month's 100 GB caps it, at hour 26.5."""
        r = simulate(lambda m: 1, days=2)
        self.assertEqual(r.profiles, ["normal", "capped"])
        self.assertAlmostEqual(r.p24, 90.7, delta=0.5)

    def test_one_viewer_at_max_steps_once(self):
        r = simulate(lambda m: 1, days=3, gbh=GBH_MAX)
        self.assertEqual(r.profiles, ["normal", "capped"])
        self.assertEqual(r.clamped, 0)

    def test_a_broken_desk_rtc_is_still_clamped_and_held_under_the_stop(self):
        r = simulate(lambda m: 0, rtc_broken=True, days=2)
        self.assertGreater(r.clamped, 0)
        self.assertLess(r.p24, GUARD_DAY_GB)


class Lookahead(unittest.TestCase):
    def test_ahead_of(self):
        now = OCT1 + 86400
        self.assertEqual(E.ahead_of([], now, 0), 0)
        self.assertEqual(E.ahead_of([], now, 1000), 1000 * 86400)
        # 50 GB 23 h ago and 10 GB just now: at 1 MB a second the window grows until the 50 GB slot leaves in an hour.
        w = [[now - 23 * 3600, 50 * GB], [now - now % 300, 10 * GB]]
        self.assertEqual(E.ahead_of(w, now, 0), 60 * GB)
        # Slowly: highest just before the 50 GB slot leaves, an hour on.
        self.assertAlmostEqual(E.ahead_of(w, now, 10**5) / GB, 60 + 0.36, delta=0.001)
        # Faster: highest just before the 10 GB slot leaves, a day on, with a day of the rate in it.
        self.assertAlmostEqual(E.ahead_of(w, now, 10**6) / GB, 10 + 86.4, delta=0.001)
        self.assertEqual(E.ahead_of(list(reversed(w)), now, 10**6), E.ahead_of(w, now, 10**6), "order doesn't matter")

    def test_the_clamp_counts_desk_rtc_alone(self):
        """16 D: 100 GB of stream and a 40 GB upload in 24 h clamped desk-rtc before; the upload is the bucket's business."""
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 3600, {"10": 100 * GB, "15": 0, "20": 0})
        b.tick(OCT1 + 7200, {"10": 100 * GB, "15": 0, "20": 40 * GB})
        self.assertFalse(b.clamped)
        self.assertEqual(b.rates()["10"], 60.0)
        b.tick(OCT1 + 10800, {"10": 136 * GB, "15": 0, "20": 40 * GB})
        self.assertTrue(b.clamped)

    def test_a_step_comes_while_it_can_hold_the_line(self):
        """Two viewers at High's cap from the 1st: capped well before 100 GB, deep before the window passes 105 GB."""
        r = simulate(lambda m: 2, days=2)
        self.assertEqual(r.profiles[:3], ["normal", "capped", "deep"])
        self.assertLess(r.p24, 107)

    def test_back_to_normal_only_if_max_fits(self):
        """Capped and seeing the capped picture's rate, the desk can't tell Max from High, so it goes back to normal only if
        the window could take normal at Max."""
        b = E.Budget(cfg(), OCT1)
        b.profile, b.profile_since = "capped", OCT1 - 2 * E.PROFILE_HOLD_S
        b.windows = [[OCT1 - 3600, 50 * GB]]
        b.deep_rate = 0.5 * 10**6  # deep-equivalent: 20 GB a day
        b.updated = OCT1
        b.last = {"10": 0, "15": 0, "20": 0}
        stream = int(0.5 * 10**6 / E.DEEP_SHARE["capped"] * 60)
        b.tick(OCT1 + 60, {"10": stream, "15": 0, "20": 0})
        self.assertLess(b.ahead, 100 * GB)  # at the rate it sees, normal would fit
        self.assertEqual(b.profile, "capped")  # but not at Max's
        b2 = E.Budget(cfg(), OCT1)
        b2.profile, b2.profile_since = "capped", OCT1 - 2 * E.PROFILE_HOLD_S
        b2.windows, b2.updated, b2.last = [[OCT1 - 3600, 40 * GB]], OCT1, {"10": 0, "15": 0, "20": 0}
        b2.tick(OCT1 + 60, {"10": 0, "15": 0, "20": 0})
        self.assertEqual(b2.profile, "normal")

    def test_a_state_from_before_keeps_its_month(self):
        old = E.Budget(cfg(), OCT1).saved("x")
        old["month"], old["month_bytes"] = "2026-10", 250 * GB
        del old["stream_windows"], old["deep_rate"]
        b = E.Budget(cfg(), OCT1 + 60, json.loads(json.dumps(old)), "x")
        self.assertEqual(b.month_bytes, 250 * GB)
        self.assertEqual((b.stream_windows, b.deep_rate), ([], 0.0))
        for bad in ({**old, "stream_windows": 3}, {**old, "stream_windows": [[1]]}, {**old, "deep_rate": "fast"}):
            b = E.Budget(cfg(), OCT1 + 60, bad, "x")
            self.assertEqual(b.month_bytes, 250 * GB, bad)
            self.assertEqual((b.stream_windows, b.deep_rate), ([], 0.0), bad)

    def test_state_keeps_the_stream_window_and_rate(self):
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 60, {"10": 5 * GB, "15": 0, "20": 0})
        b2 = E.Budget(cfg(), OCT1 + 61, json.loads(json.dumps(b.saved("x"))), "x")
        self.assertEqual(b2.stream_windows, b.stream_windows)
        self.assertAlmostEqual(b2.deep_rate, b.deep_rate)


class Bucket(unittest.TestCase):
    def test_empties_at_30_gb_and_reopens_about_2_h_idle(self):
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 60, {"10": 0, "15": 0, "20": 29 * GB})
        self.assertFalse(b.slowed)
        self.assertEqual(b.rates(), {"10": 60.0, "15": 2.0, "20": 100.0})
        b.tick(OCT1 + 120, {"10": 0, "15": 2 * GB, "20": 29 * GB})
        self.assertTrue(b.slowed)
        self.assertEqual(b.rates(), {"10": 60.0, "15": 0.25, "20": 0.75})
        t, emptied = OCT1 + 120, OCT1 + 120
        while b.slowed:
            t += 60
            b.tick(t, {"10": 0, "15": 2 * GB, "20": 29 * GB})
        self.assertAlmostEqual(t - emptied, 8000, delta=60)  # 1 GB at 1 Mbps
        self.assertEqual(b.rates()["20"], 100.0)

    def test_the_stream_never_counts(self):
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 60, {"10": 90 * GB, "15": 0, "20": 0})
        self.assertFalse(b.slowed)

    def test_a_full_volume_a_day_never_empties_it(self):
        b, sent, t = E.Budget(cfg(), OCT1), 0, OCT1
        for _ in range(60):
            sent += int(8 * 2**30)
            t += 86400
            b.tick(t, {"10": 0, "15": 0, "20": sent})
            self.assertFalse(b.slowed)

    def test_held_at_one_mbps_it_stays_slowed(self):
        b, sent, t = E.Budget(cfg(), OCT1), 31 * GB, OCT1 + 60
        b.tick(t, {"10": 0, "15": 0, "20": sent})
        for _ in range(1440):
            t += 60
            sent += 125000 * 60
            b.tick(t, {"10": 0, "15": 0, "20": sent})
            self.assertTrue(b.slowed)

    def test_time_stopped_refills(self):
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 60, {"10": 0, "15": 0, "20": 31 * GB})
        self.assertTrue(b.slowed)
        s = json.loads(json.dumps(b.saved("boot1")))
        b2 = E.Budget(cfg(), OCT1 + 86400, s, "boot2")
        b2.tick(OCT1 + 86400, {"10": 0, "15": 0, "20": 0})
        self.assertFalse(b2.slowed)
        self.assertAlmostEqual(b2.level / GB, 10.8, delta=0.05)


class Steps(unittest.TestCase):
    def run_day(self, b, t, total):
        """Sends `total` more bytes on 1:10 in one tick."""
        b.tick(t, {"10": b.last.get("10", 0) + int(total), "15": b.last.get("15", 0), "20": b.last.get("20", 0)})

    def test_month_lines(self):
        b, t = E.Budget(cfg(), OCT1), OCT1
        for _ in range(3):  # 99 GB over three days, 33 a day: nowhere near a day line
            for _ in range(24):
                t += 3600
                self.run_day(b, t, 33 * GB / 24)
        self.assertEqual(b.profile, "normal")
        t += 3600
        self.run_day(b, t, 2 * GB)
        self.assertEqual(b.profile, "capped")
        for _ in range(20):
            t += 86400 + 3600
            self.run_day(b, t, 20 * GB)
        self.assertEqual(b.month, "2026-10")
        self.assertEqual(b.profile, "deep")  # 500 GB this month
        self.assertFalse(b.clamped)

    def test_other_traffic_counts_toward_the_lines(self):
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 86400 * 2, {"10": 40 * GB, "15": 0, "20": 0})
        self.assertEqual(b.profile, "normal")
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 86400 * 2, {"10": 40 * GB, "15": 1 * GB, "20": 54 * GB})
        self.assertEqual(b.profile, "capped")

    def test_day_deep_has_a_hysteresis(self):
        b = E.Budget(cfg(), OCT1)
        self.run_day(b, OCT1 + 60, 121 * GB)
        self.assertEqual(b.profile, "deep")
        self.assertTrue(b.day_deep)
        # Still 121 GB in the window at 23 h 50, and past the window it's 0, so it lets go.
        self.run_day(b, OCT1 + 86000, 0)
        self.assertTrue(b.day_deep)
        self.run_day(b, OCT1 + 86400 + 400, 0)
        self.assertFalse(b.day_deep)

    def test_day_deep_releases_only_under_95(self):
        b, t = E.Budget(cfg(), OCT1), OCT1
        self.run_day(b, t + 60, 9 * GB)
        self.run_day(b, t + 43200, 97 * GB)
        self.assertTrue(b.day_deep)  # 106 GB in 24 h
        self.run_day(b, t + 86400 + 400, 0)  # The 9 GB left the window, leaving 97: under 105, not under 95.
        self.assertTrue(b.day_deep)
        self.run_day(b, t + 43200 + 86400 + 400, 0)
        self.assertFalse(b.day_deep)

    def test_clamp_at_135_until_under_120(self):
        b, t = E.Budget(cfg(), OCT1), OCT1
        self.run_day(b, t + 60, 100 * GB)
        self.run_day(b, t + 3600, 40 * GB)
        self.assertTrue(b.clamped)
        self.assertEqual(b.rates()["10"], 1.0)
        self.run_day(b, t + 86400 + 400, 0)  # 40 GB left, under 120.
        self.assertFalse(b.clamped)
        self.assertEqual(b.rates()["10"], 60.0)

    def test_sharper_waits_an_hour_softer_is_at_once(self):
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 60, {"10": 0, "15": 0, "20": 101 * GB})  # not the stream, so no rate ahead: capped, not deep
        self.assertEqual(b.profile, "capped")
        t = calendar.timegm((2026, 11, 1, 0, 0, 0))  # The month rolled and the 24 h window emptied.
        self.run_day(b, t, 0)
        self.assertEqual(b.month, "2026-11")
        self.assertEqual(b.month_bytes, 0)
        self.assertEqual(b.profile, "normal")  # capped since long ago, so the hold has passed

    def test_no_flapping_around_a_line(self):
        """A total swinging across the line every minute for 10 h: softer at once, sharper at most once an hour."""
        b, t, profile, sharper = E.Budget(cfg(), OCT1), OCT1, "normal", []
        for i in range(600):
            t += 60
            b.month_bytes = (100 if i % 2 == 0 else 95) * GB
            self.run_day(b, t, 0)
            if b.profile != profile:
                if b.profile == "normal":
                    sharper.append(t)
                profile = b.profile
        self.assertGreaterEqual(len(sharper), 5, "the line was crossed")
        self.assertTrue(all(y - x >= E.PROFILE_HOLD_S for x, y in zip(sharper, sharper[1:])))

    def test_month_rollover_keeps_the_24_h_window(self):
        b, end = E.Budget(cfg(), OCT1), calendar.timegm((2026, 10, 31, 23, 0, 0))
        b.tick(end, {"10": 0, "15": 0, "20": 85 * GB})
        b.tick(end + 7200, {"10": 0, "15": 0, "20": 102 * GB})
        self.assertEqual(b.month, "2026-11")
        self.assertEqual(b.month_bytes, 17 * GB)
        self.assertEqual(b.profile, "capped")  # 102 GB in 24 h


class Survival(unittest.TestCase):
    def test_counter_that_goes_back_is_a_new_shaper(self):
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 60, {"10": 5 * GB, "15": 0, "20": 0})
        b.tick(OCT1 + 120, {"10": 1 * GB, "15": 0, "20": 0})
        self.assertEqual(b.month_bytes, 6 * GB)

    def test_restart_same_boot_counts_what_it_missed(self):
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 60, {"10": 5 * GB, "15": 0, "20": 0})
        b2 = E.Budget(cfg(), OCT1 + 90, json.loads(json.dumps(b.saved("boot1"))), "boot1")
        b2.tick(OCT1 + 120, {"10": 7 * GB, "15": 0, "20": 0})
        self.assertEqual(b2.month_bytes, 7 * GB)

    def test_new_boot_starts_the_counters_over(self):
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 60, {"10": 5 * GB, "15": 0, "20": 0})
        b2 = E.Budget(cfg(), OCT1 + 90, json.loads(json.dumps(b.saved("boot1"))), "boot2")
        b2.tick(OCT1 + 120, {"10": 1 * GB, "15": 0, "20": 0})
        self.assertEqual(b2.month_bytes, 6 * GB)

    def test_state_survives_slowed_clamped_and_profile(self):
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 60, {"10": 136 * GB, "15": 0, "20": 31 * GB})
        s = json.loads(json.dumps(b.saved("x")))
        b2 = E.Budget(cfg(), OCT1 + 61, s, "x")
        self.assertEqual((b2.slowed, b2.clamped, b2.profile, b2.day_deep), (True, True, "deep", True))
        self.assertEqual(b2.rates(), {"10": 1.0, "15": 0.25, "20": 0.75})

    def test_bad_states_start_over(self):
        good = E.Budget(cfg(), OCT1).saved("x")
        for bad in ({}, {"v": 1}, [], "nope", 7, {**good, "level": "x"}, {**good, "windows": [[1]]}, {**good, "windows": 3},
                    {**good, "last": 3}, {**good, "month_bytes": None}):
            b = E.Budget(cfg(), OCT1, bad, "x")
            b.tick(OCT1 + 60, {"10": 1, "15": 0, "20": 0})
            self.assertFalse(b.slowed or b.clamped, bad)
            self.assertEqual(b.profile, "normal", bad)
        self.assertEqual(E.Budget(cfg(), OCT1, {**good, "profile": "sparkly"}, "x").profile, "normal")

    def test_clock_going_back_breaks_nothing(self):
        b = E.Budget(cfg(), OCT1 + 1000)
        b.tick(OCT1 + 1000, {"10": 1 * GB, "15": 0, "20": 1 * GB})
        level = b.level
        b.tick(OCT1, {"10": 1 * GB, "15": 0, "20": 1 * GB})
        self.assertEqual(b.level, level)


class FakeTc:
    """A stand-in for subprocess.run. Holds a shaper the way tc reports it, and takes batches."""

    def __init__(self, classes=None, root="fq_codel", leaves=None):
        self.classes, self.root, self.batches, self.fail = classes or {}, root, [], False
        self.leaves = leaves or {}  # minor -> kind; a class not named has a member's: pfifo under 1:10, fq_codel otherwise

    def __call__(self, argv, **kw):
        out, rc, err = "", 0, ""
        if self.fail:
            rc, err = 1, "tc is broken"
        elif argv[1:3] == ["-batch", "-"]:
            self.batches.append(kw["input"].splitlines())
        elif "class" in argv:
            # The shape of iproute2 6.15's tc -j -s class show, as on image 0.2.2. fq_codel's own flows are listed as classes too.
            out = json.dumps([{"class": "htb", "handle": f"1:{m}", "root": True, "leaf": f"0x{m}", "prio": 0, "rate": r, "ceil": r, "burst": 1600, "cburst": 1600,
                               "stats": {"bytes": b, "packets": 1, "drops": 0, "overlimits": 0, "requeues": 0, "backlog": 0, "qlen": 0}} for m, (r, b) in self.classes.items()]
                             + [{"class": "fq_codel", "handle": "15:352", "parent": "15:", "stats": {"bytes": 999, "packets": 1}}])
        elif "qdisc" in argv:
            out = [{"kind": "htb" if self.root == "htb" else "mq", "handle": "1:" if self.root == "htb" else "0:"}]
            if "root" not in argv:
                out += [{"kind": self.leaves.get(m, "pfifo" if m == "10" else "fq_codel"), "handle": f"{m}:", "parent": f"1:{m}"} for m in self.classes]
            out = json.dumps(out)
        return types.SimpleNamespace(returncode=rc, stdout=out, stderr=err)


class ShaperTests(unittest.TestCase):
    NORMAL = {"10": 60.0, "15": 2.0, "20": 100.0}
    ALL = {"10": (7500000, 0), "15": (250000, 0), "20": (12500000, 0)}

    def test_from_nothing_in_order(self):
        tc = FakeTc()
        E.Shaper(cfg(interface="lo"), run=tc).apply(self.NORMAL)
        self.assertEqual(tc.batches, [[
            "qdisc replace dev lo root handle 1: htb default 20",
            "class replace dev lo parent 1: classid 1:10 htb rate 60000000bit ceil 60000000bit burst 1mb cburst 1mb prio 0 quantum 60000",
            "qdisc replace dev lo parent 1:10 handle 10: pfifo limit 1000",
            "class replace dev lo parent 1: classid 1:15 htb rate 2000000bit ceil 2000000bit prio 0 quantum 60000",
            "qdisc replace dev lo parent 1:15 handle 15: fq_codel",
            "class replace dev lo parent 1: classid 1:20 htb rate 100000000bit ceil 100000000bit burst 256kb cburst 256kb prio 1 quantum 60000",
            "qdisc replace dev lo parent 1:20 handle 20: fq_codel",
        ]])

    def test_nothing_to_do_changes_nothing(self):
        tc = FakeTc(dict(self.ALL), "htb")
        E.Shaper(cfg(interface="lo"), run=tc).apply(self.NORMAL)
        self.assertEqual(tc.batches, [])

    def test_a_clamp_changes_only_the_rates(self):
        tc = FakeTc(dict(self.ALL), "htb")
        E.Shaper(cfg(interface="lo"), run=tc).apply({"10": 60.0, "15": 0.25, "20": 0.75})
        self.assertEqual(tc.batches, [[
            "class replace dev lo parent 1: classid 1:15 htb rate 250000bit ceil 250000bit prio 0 quantum 60000",
            "class replace dev lo parent 1: classid 1:20 htb rate 750000bit ceil 750000bit burst 256kb cburst 256kb prio 1 quantum 60000",
        ]])

    def test_a_lost_class_comes_back_without_touching_the_root(self):
        classes = dict(self.ALL)
        del classes["20"]
        tc = FakeTc(classes, "htb")
        E.Shaper(cfg(interface="lo"), run=tc).apply(self.NORMAL)
        self.assertFalse(any("root" in line for line in tc.batches[0]))
        self.assertEqual(len(tc.batches[0]), 2)

    def test_a_fresh_start_on_a_counted_shaper_charges_none_of_it(self):
        """No state, and a shaper that already counted 37 GB: only what's sent from now on counts."""
        tc = FakeTc({"10": (7500000, 5 * GB), "15": (250000, 1 * GB), "20": (12500000, 31 * GB)}, "htb")
        b, s = E.Budget(cfg(), OCT1), E.Shaper(cfg(interface="lo"), run=tc)
        E.baseline(b, s)
        tc.classes["20"] = (12500000, 31 * GB + 10**6)
        E.step(b, s, OCT1 + 60)
        self.assertFalse(b.slowed)
        self.assertEqual(b.month_bytes, 10**6)

    def test_this_boots_saved_counters_are_kept(self):
        tc = FakeTc({"10": (7500000, 5 * GB), "15": (250000, 0), "20": (12500000, 2 * GB)}, "htb")
        old = E.Budget(cfg(), OCT1)
        old.tick(OCT1 + 60, {"10": 5 * GB, "15": 0, "20": 1 * GB})
        b = E.Budget(cfg(), OCT1 + 90, json.loads(json.dumps(old.saved("boot1"))), "boot1")
        E.baseline(b, E.Shaper(cfg(interface="lo"), run=tc))
        E.step(b, E.Shaper(cfg(interface="lo"), run=tc), OCT1 + 120)
        self.assertEqual(b.month_bytes, 7 * GB, "the 1 GB sent while no process ran still counts")

    def test_step_counts_and_acts(self):
        tc = FakeTc({"10": (7500000, 5 * GB), "15": (250000, 1), "20": (12500000, 31 * GB)}, "htb")
        b, s = E.Budget(cfg(), OCT1), E.Shaper(cfg(interface="lo"), run=tc)
        E.step(b, s, OCT1 + 60)
        self.assertEqual(b.month_bytes, 36 * GB + 1)
        self.assertTrue(any("rate 750000bit" in line for line in tc.batches[0]))


class FailOpen(unittest.TestCase):
    def test_ten_failed_ticks_lift_a_clamp_with_no_read(self):
        """A new iproute2 changes tc's JSON, say: reading breaks, writing works. The daemon goes on, and the next good tick decides again."""
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "profile")
            tc = FakeTc({"10": (125000, 136 * GB), "15": (31250, 0), "20": (93750, 31 * GB)}, "htb")
            b, s, f = E.Budget(cfg(), OCT1), E.Shaper(cfg(interface="lo"), run=tc), 0
            b.level, b.slowed, b.clamped = 0.0, True, True

            def broken():
                raise ValueError("no such field")
            s.classes = broken
            for i in range(1, 12):
                f = E.guarded_tick(b, s, OCT1 + i * 60, f, path)
                self.assertEqual(f, i)
                self.assertEqual(len(tc.batches), 0 if i < 10 else 1)
            self.assertEqual(tc.batches[0], [E.Shaper.class_line("lo", m, r) for m, r in self.normal().items()])
            del s.classes
            self.assertEqual(E.guarded_tick(b, s, OCT1 + 720, f, path), 0)

    @staticmethod
    def normal():
        return E.normal_rates(cfg())

    def test_a_tc_that_fails_is_only_a_failed_tick(self):
        with tempfile.TemporaryDirectory() as d:
            tc = FakeTc()
            tc.fail = True
            b, s = E.Budget(cfg(), OCT1), E.Shaper(cfg(interface="lo"), run=tc)
            for i in range(1, 12):
                self.assertEqual(E.guarded_tick(b, s, OCT1 + i * 60, i - 1, os.path.join(d, "profile")), i)


class Profile(unittest.TestCase):
    def test_restarts_only_on_a_change(self):
        calls = []
        run = lambda argv, **kw: calls.append(argv)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "profile")
            E.set_profile("normal", p, run)  # First write at boot: nothing's running on it yet.
            self.assertEqual(calls, [])
            E.set_profile("normal", p, run)
            self.assertEqual(calls, [])
            E.set_profile("capped", p, run)
            self.assertEqual(len(calls), 1)
            self.assertIn("try-restart", calls[0])
            self.assertEqual(pathlib.Path(p).read_text(encoding="ascii"), "capped\n")


class Files(unittest.TestCase):
    def test_shipped_conf_is_the_defaults(self):
        p = configparser.ConfigParser()
        p.read(RECIPE / "files/etc/ma/egress.conf")
        got = {k: (v if k == "interface" else float(v)) for k, v in p.items("egress")}
        self.assertEqual(got, E.DEFAULTS)

    def test_a_bad_conf_is_the_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            for text in ("[egress]\nbucket_gb = lots\n", "not an ini\n", "[other]\nx=1\n"):
                path = os.path.join(d, "c")
                with open(path, "w", encoding="ascii") as f:
                    f.write(text)
                self.assertEqual(E.load_conf(path)["bucket_gb"], 30.0)
            self.assertEqual(E.load_conf(os.path.join(d, "missing"))["bucket_gb"], 30.0)

    def test_confs_differ_only_where_they_should(self):
        def read(name):
            p = configparser.ConfigParser(interpolation=None)
            p.read(RECIPE / "desk-stream" / name)
            return {s: dict(p.items(s)) for s in p.sections()}
        base, capped, deep = read("stream.conf"), read("stream-capped.conf"), read("stream-deep.conf")
        self.assertEqual(base["audio"], capped["audio"])
        self.assertEqual(base["audio"], deep["audio"])
        self.assertEqual(capped["video"]["x264"], base["video"]["x264"].replace("quantizer=23", "quantizer=28").replace("bitrate=8000", "bitrate=4000")
                         .replace("vbv-maxrate=8000:vbv-bufsize=1200", "vbv-maxrate=4000:vbv-bufsize=600"))
        self.assertEqual(deep["video"]["x264"], base["video"]["x264"].replace("quantizer=23", "quantizer=30").replace("bitrate=8000", "bitrate=2500")
                         .replace("vbv-maxrate=8000:vbv-bufsize=1200", "vbv-maxrate=2500:vbv-bufsize=375"))
        # From desk-stream 0.3.0 deskcap converts as it captures (ADR 0073): stream.conf and the capped profile have no convert
        # line, and the deep one's is only its scaler. 0.2.4's capture and convert are the fallback lines, scaled the same way.
        scale = "videoscale ! video/x-raw,width=960,height=540"
        self.assertEqual(capped["video"].get("convert", ""), base["video"].get("convert", ""))
        self.assertEqual(deep["video"]["convert"], " ! ".join(x for x in (base["video"].get("convert", ""), scale) if x))
        self.assertEqual(capped["video"]["fallback-convert"], base["video"]["fallback-convert"])
        self.assertEqual(deep["video"]["fallback-convert"], base["video"]["fallback-convert"] + " ! " + scale)
        for key in ("capture", "fallback-capture", "caps", "rtp", "x264-aarch64"):
            self.assertEqual(base["video"][key], capped["video"][key])
            self.assertEqual(base["video"][key], deep["video"][key])
        self.assertEqual(base["adapt"]["enabled"], capped["adapt"]["enabled"])
        self.assertEqual(base["adapt"]["enabled"], deep["adapt"]["enabled"])

    def test_each_profile_holds_the_members_level_to_its_picture(self):
        """S-29: the capped conf has stream.conf's four levels, each held to the capped picture (fewer lines, a higher quantizer,
        a lower ceiling: never more than the profile itself asks of the encoder), so Low stays Low; the deep conf has none."""
        def levels(name):
            p = configparser.ConfigParser(interpolation=None)
            p.read(RECIPE / "desk-stream" / name)
            return {s[len("level."):]: {k: int(v) for k, v in p.items(s)} for s in p.sections() if s.startswith("level.")}
        base, capped, deep = levels("stream.conf"), levels("stream-capped.conf"), levels("stream-deep.conf")
        top = {"max-height": 0, "quantizer": 28, "bitrate": 4000, "vbv-buf-capacity": 150}  # [video]'s x264 line in stream-capped.conf
        self.assertEqual(sorted(capped), ["high", "low", "max", "medium"])
        for name, v in base.items():
            lines = min(x for x in (v["max-height"], top["max-height"]) if x) if v["max-height"] or top["max-height"] else 0
            want = {"max-height": lines, "quantizer": max(v["quantizer"], top["quantizer"]), "bitrate": min(v["bitrate"], top["bitrate"]),
                    "vbv-buf-capacity": v["vbv-buf-capacity"]}
            self.assertEqual(capped[name], want, name)
        self.assertEqual(capped["low"], base["low"])
        self.assertEqual(capped["high"], top)
        self.assertEqual(deep, {})

    def run_conf(self, profile, have=("stream.conf", "stream-capped.conf", "stream-deep.conf")):
        with tempfile.TemporaryDirectory() as d:
            rel = pathlib.Path(d)
            prof = rel / "profile"
            if profile is not None:
                prof.write_text(profile)
            script = (RECIPE / "desk-stream/run").read_text().replace("/run/desk-egress/profile", str(prof))
            (rel / "run").write_text(script)
            (rel / "run").chmod(0o755)
            (rel / "desk-stream").write_text("import sys\nprint(sys.argv[2])\n")
            for name in have:
                (rel / name).write_text("")
            out = subprocess.run([str(rel / "run")], env={"RELEASE_DIR": d, "PATH": "/usr/bin:/bin"}, capture_output=True, text=True, check=True).stdout
            return pathlib.Path(out.strip()).name

    def test_run_picks_the_conf(self):
        self.assertEqual(self.run_conf(None), "stream.conf")
        self.assertEqual(self.run_conf("normal\n"), "stream.conf")
        self.assertEqual(self.run_conf("capped\n"), "stream-capped.conf")
        self.assertEqual(self.run_conf("deep\n"), "stream-deep.conf")
        self.assertEqual(self.run_conf("../../etc/passwd\n"), "stream.conf")
        self.assertEqual(self.run_conf(""), "stream.conf")
        self.assertEqual(self.run_conf("deep\n", have=("stream.conf",)), "stream.conf", "a release without the conf is the normal picture")

    def test_classify_can_only_label(self):
        text = (RECIPE / "files/etc/nftables.conf").read_text()
        chain = text[text.index("chain classify"):text.index("chain output")]
        code = "\n".join(line for line in chain.splitlines() if not line.strip().startswith("#"))
        self.assertIn("policy accept", code)
        for word in ("drop", "reject", "queue"):
            self.assertNotIn(word, code)

    def test_never_touches_the_browser(self):
        unit = (RECIPE / "files/etc/systemd/system/desk-egress.service").read_text()
        self.assertIn("InaccessiblePaths=-/data/browser", unit)
        self.assertIn("ReadWritePaths=-/data/desk-egress\n", unit)
        self.assertTrue(E.STATE.startswith("/data/desk-egress/"))

    def test_wants_not_requires(self):
        for name in ("desk-rtc", "deskd"):
            unit = (RECIPE / f"files/etc/systemd/system/{name}.service").read_text()
            self.assertIn("Wants=desk-egress.service\n", unit)
            self.assertIn("After=desk-egress.service\n", unit)
            self.assertNotIn("Requires=desk-egress", unit)
            self.assertNotIn("BindsTo=desk-egress", unit)


GUILD_CONF = RECIPE / "files/etc/ma/guild.conf"


def gcfg(itype="c7g.xlarge", **over):
    return E.load_guild(cfg(**over), GUILD_CONF, itype)


class GuildConf(unittest.TestCase):
    """/etc/ma/guild.conf: the tier from the instance type, and the numbers a member."""

    def test_tiers(self):
        # The day line is the members' (4 GB a member) under the temporary 120 GB cap (Security's NET031-1), released at
        # 3.5 GB a member under 105.
        for itype, n, voice, rtc, day, rel, line, gvoice, grtc in (("t4g.small", 25, 20, 60, 100, 87.5, 100, 5, 2.5), ("t4g.medium", 50, 40, 60, 120, 105, 200, 10, 5),
                                                                   ("c7g.xlarge", 200, 160, 150, 120, 105, 800, 40, 20), ("c7g.2xlarge", 200, 160, 150, 120, 105, 800, 40, 20),
                                                                   ("", 200, 160, 150, 120, 105, 800, 40, 20)):
            with self.subTest(itype=itype):
                c = gcfg(itype)
                self.assertEqual((c["members"], c["voice_mbps"], c["rtc_mbps"], c["guild_day_gb"], c["guild_day_release_gb"], c["guild_members_day_gb"],
                                  c["guarded_voice_mbps"]), (n, voice, rtc, day, rel, line, gvoice))
                self.assertAlmostEqual(c["guarded_rtc_mbps"], grtc)
                self.assertTrue(c["guild"])
                self.assertEqual(c["instance_type"], itype or "unknown")

    def test_shipped_conf_is_the_defaults(self):
        p = configparser.ConfigParser()
        p.read(GUILD_CONF)
        self.assertEqual({k: float(v) for k, v in p.items("egress")}, E.GUILD_DEFAULTS)
        self.assertEqual({k: int(v) for k, v in p.items("tiers")}, E.GUILD_TIERS)

    def test_a_bad_or_missing_conf_is_the_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "g.conf")
            for text in ("[egress]\nvoice_mbps_per_member = loud\n[tiers]\nt4g.small = many\ndefault = -1\n", "not an ini\n", ""):
                with self.subTest(text=text):
                    pathlib.Path(path).write_text(text)
                    self.assertEqual(E.load_guild(cfg(), path, "t4g.small"), gcfg("t4g.small"))
                    self.assertEqual(E.load_guild(cfg(), path, "m7g.large"), gcfg("m7g.large"))
            self.assertEqual(E.load_guild(cfg(), os.path.join(d, "missing"), "t4g.small"), gcfg("t4g.small"))
            pathlib.Path(path).write_text("[tiers]\nc7g.large = 100\n[egress]\nvoice_mbps_per_member = 1\n")
            c = E.load_guild(cfg(), path, "c7g.large")
            self.assertEqual((c["members"], c["voice_mbps"], c["guild_day_gb"], c["guild_members_day_gb"]), (100, 100.0, 120.0, 400.0))

    def test_the_day_cap(self):
        """Temporary, until Platform's guard knows a Guild Desk: at most 120 GB, released at most at 105. 0 is no cap; a
        missing, negative or unreadable cap is 120 and 105; a release cap above the line releases at the line."""
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "g.conf")
            for text, itype, want in (("[egress]\nday_cap_gb = 0\nday_release_cap_gb = 0\n", "c7g.xlarge", (800, 700)),
                                      ("[egress]\nday_cap_gb = 0\nday_release_cap_gb = 0\n", "t4g.medium", (200, 175)),
                                      ("[egress]\nday_cap_gb = 150\nday_release_cap_gb = 130\n", "t4g.medium", (150, 130)),
                                      ("[egress]\nday_cap_gb = 90\n", "t4g.small", (90, 87.5)),
                                      ("[egress]\nday_cap_gb = 90\nday_release_cap_gb = 0\n", "c7g.xlarge", (90, 90)),
                                      ("[egress]\nday_cap_gb = -1\nday_release_cap_gb = nan\n", "c7g.xlarge", (120, 105)),
                                      ("[egress]\nday_cap_gb = inf\nday_release_cap_gb = lots\n", "c7g.xlarge", (120, 105)),
                                      ("[egress]\nday_gb_per_member = 4\n", "c7g.xlarge", (120, 105)),
                                      ("", "t4g.small", (100, 87.5))):
                with self.subTest(text=text, itype=itype):
                    pathlib.Path(path).write_text(text)
                    c = E.load_guild(cfg(), path, itype)
                    self.assertEqual((c["guild_day_gb"], c["guild_day_release_gb"]), want)
            self.assertEqual(E.load_guild(cfg(), os.path.join(d, "missing"), "c7g.xlarge")["guild_day_gb"], 120)

    def test_the_instance_type_is_what_the_hypervisor_reports(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "product_name")
            pathlib.Path(p).write_text("t4g.small\n")
            self.assertEqual(E.instance_type(p), "t4g.small")
            self.assertEqual(E.instance_type(os.path.join(d, "none")), "")
        self.assertEqual(E.PRODUCT, "/sys/devices/virtual/dmi/id/product_name")
        self.assertEqual(E.GUILD_FLAG, "/run/ma/guild")


class MemberDeskUnchanged(unittest.TestCase):
    """Nothing of a Guild Desk on a member's desk: the same classes, rates, budgets and state file."""

    def test_classes_rates_and_state(self):
        self.assertIs(E.classes_for(cfg()), E.CLASSES)
        self.assertEqual(sorted(E.CLASSES), ["10", "15", "20"])
        b = E.Budget(cfg(), OCT1)
        b.tick(OCT1 + 60, {"10": GB, "15": 0, "20": GB})
        self.assertEqual(b.rates(), {"10": 60.0, "15": 2.0, "20": 100.0})
        self.assertEqual(E.normal_rates(cfg()), {"10": 60.0, "15": 2.0, "20": 100.0})
        self.assertEqual(sorted(b.saved("x")), sorted(["v", "boot", "updated", "last", "level", "slowed", "month", "month_bytes", "windows",
                                                      "day_deep", "clamped", "profile", "profile_since", "stream_windows", "deep_rate"]))

    def test_a_guild_state_on_a_members_desk_is_a_members(self):
        g = E.Budget(gcfg(), OCT1)
        g.guarded = True
        b = E.Budget(cfg(), OCT1 + 60, json.loads(json.dumps(g.saved("b"))), "b")
        self.assertNotIn("guarded", b.saved("b"))
        self.assertEqual(b.rates(), {"10": 60.0, "15": 2.0, "20": 100.0})

    def test_the_guild_class_lines_are_the_members_for_10_15_20(self):
        """The class options are every desk's; only a Guild Desk's leaf under 1:10 differs (fq_codel for many members' data)."""
        for m in ("10", "15", "20"):
            self.assertEqual(E.GUILD_CLASSES[m][0], E.CLASSES[m][0])
        for m in ("15", "20"):
            self.assertEqual(E.GUILD_CLASSES[m], E.CLASSES[m])
        self.assertEqual(E.CLASSES["10"], ("burst 1mb cburst 1mb prio 0", "pfifo limit 1000"))
        self.assertEqual(E.GUILD_CLASSES["10"], ("burst 1mb cburst 1mb prio 0", "fq_codel"))

    def test_a_members_shaper_never_reads_its_leaves(self):
        """As before: a member's tick reads the classes, and the root only when a class is missing; never the leaves."""
        tc = FakeTc(dict(ShaperTests.ALL), "htb")
        calls = []
        def run(argv, **kw):
            calls.append(argv)
            return tc(argv, **kw)
        E.Shaper(cfg(interface="lo"), run=run).apply(ShaperTests.NORMAL)
        self.assertEqual([a for a in calls if "qdisc" in a], [])
        self.assertEqual(tc.batches, [])


class GuildShaper(unittest.TestCase):
    def test_from_nothing_adds_voice(self):
        tc = FakeTc()
        E.Shaper(dict(gcfg("t4g.small"), interface="lo"), run=tc).apply(E.normal_rates(gcfg("t4g.small")))
        self.assertEqual(tc.batches[0][1:3], [
            "class replace dev lo parent 1: classid 1:10 htb rate 60000000bit ceil 60000000bit burst 1mb cburst 1mb prio 0 quantum 60000",
            "qdisc replace dev lo parent 1:10 handle 10: fq_codel"])
        self.assertEqual(tc.batches[0][-2:], [
            "class replace dev lo parent 1: classid 1:30 htb rate 20000000bit ceil 20000000bit burst 1mb cburst 1mb prio 0 quantum 60000",
            "qdisc replace dev lo parent 1:30 handle 30: fq_codel"])
        self.assertEqual(len(tc.batches[0]), 9)

    def test_a_shaper_without_voice_gets_it_without_touching_the_root(self):
        """A member's shaper under a desk-egress that now sees the flag (an update, or a rollback and forward again): 1:10 gets
        the tier's rate and fq_codel in place of pfifo, 1:30 is added, and the root and the other classes stay."""
        tc = FakeTc(dict(ShaperTests.ALL), "htb")
        E.Shaper(dict(gcfg(), interface="lo"), run=tc).apply(E.normal_rates(gcfg()))
        self.assertEqual(tc.batches, [[
            "class replace dev lo parent 1: classid 1:10 htb rate 150000000bit ceil 150000000bit burst 1mb cburst 1mb prio 0 quantum 60000",
            "qdisc del dev lo parent 1:10 handle 10:",
            "qdisc replace dev lo parent 1:10 handle 10: fq_codel",
            "class replace dev lo parent 1: classid 1:30 htb rate 160000000bit ceil 160000000bit burst 1mb cburst 1mb prio 0 quantum 60000",
            "qdisc replace dev lo parent 1:30 handle 30: fq_codel"]])

    def test_a_guild_shaper_as_it_should_be_changes_nothing(self):
        tc = FakeTc({"10": (18750000, 0), "15": (250000, 0), "20": (12500000, 0), "30": (20000000, 0)}, "htb", leaves={"10": "fq_codel", "30": "fq_codel"})
        E.Shaper(dict(gcfg(), interface="lo"), run=tc).apply(E.normal_rates(gcfg()))
        self.assertEqual(tc.batches, [])

    def test_a_guild_leaf_of_the_wrong_kind_is_replaced_alone(self):
        tc = FakeTc({"10": (18750000, 0), "15": (250000, 0), "20": (12500000, 0), "30": (20000000, 0)}, "htb", leaves={"30": "fq_codel"})
        E.Shaper(dict(gcfg(), interface="lo"), run=tc).apply(E.normal_rates(gcfg()))
        self.assertEqual(tc.batches, [["qdisc del dev lo parent 1:10 handle 10:", "qdisc replace dev lo parent 1:10 handle 10: fq_codel"]])

    def test_check_needs_voice_on_a_guild_desk_only(self):
        self.assertEqual(sorted(E.classes_for(gcfg())), ["10", "15", "20", "30"])

    def test_step_counts_voice(self):
        tc = FakeTc({"10": (7500000, 0), "15": (250000, 0), "20": (12500000, 0), "30": (20000000, 7 * GB)}, "htb")
        b, s = E.Budget(gcfg(), OCT1), E.Shaper(dict(gcfg(), interface="lo"), run=tc)
        E.step(b, s, OCT1 + 60)
        self.assertEqual(b.month_bytes, 7 * GB)
        self.assertEqual(b.level, 30 * GB, "voice never touches the bucket")

    def test_unclamp_puts_voice_back_too(self):
        tc = FakeTc()
        E.Shaper(dict(gcfg("t4g.medium"), interface="lo"), run=tc).unclamp()
        self.assertIn("class replace dev lo parent 1: classid 1:30 htb rate 40000000bit ceil 40000000bit burst 1mb cburst 1mb prio 0 quantum 60000", tc.batches[0])


def simulate_guild(members, voice_gbh, days=2, itype="c7g.xlarge", rtc_gbh=0.0, other_gbh=0.03, c=None):
    """By the minute, as AdrTable does: voice_gbh(minute) is what Commons wants to send, capped by 1:30's rate. first is the
    24 h total when the line first slowed anything."""
    c = c or gcfg(itype)
    b = E.Budget(c, OCT1)
    counters = {"10": 0, "15": 0, "20": 0, "30": 0}
    per_minute, guarded, first = [], 0, None
    for m in range(days * 1440):
        r = b.rates()
        v = min(voice_gbh(m), mbps_gbh(r["30"]))
        d = min(rtc_gbh, mbps_gbh(r["10"]))
        counters["30"] += int(v * GB / 60)
        counters["10"] += int(d * GB / 60)
        counters["20"] += int(other_gbh * GB / 60)
        per_minute.append((v + d + other_gbh) / 60)
        b.tick(OCT1 + m * 60 + 59, dict(counters))
        guarded += b.guarded
        if b.guarded and first is None:
            first = sum(per_minute[-1440:])
        self_check = (b.profile, b.clamped)
        assert self_check == ("normal", False), self_check
    run, best = 0.0, 0.0
    for i, x in enumerate(per_minute):
        run += x
        if i >= 1440:
            run -= per_minute[i - 1440]
        best = max(best, run)
    return types.SimpleNamespace(p24=best, guarded=guarded, budget=b, first=first)


LOUD = 0.312  # GB a member an hour: ADR 0080's worst hour, everyone in the room, 10 voices heard, nobody pausing


GUARD_DAY_GB = 150  # Platform's cost guard stops any instance past this in 24 h, and doesn't know a Guild Desk yet


def uncapped(itype="c7g.xlarge"):
    """The members' line alone, as once the guard knows a Guild Desk and the cap is 0."""
    c = gcfg(itype)
    return dict(c, guild_day_gb=c["guild_members_day_gb"], guild_day_release_gb=c["guild_members_day_gb"] * 7 / 8)


class GuildBudget(unittest.TestCase):
    def test_twelve_loud_hours_a_day(self):
        """ADR 0080's worst hour, twelve hours a day, with light data all day besides (302 KB a second at 200 members,
        desk-rtc/README.md's guildscale: 0.0054 GB an hour a member). 25 members never reach their 100 GB line. 50 reach the
        120 GB cap and are slowed, and their 24 h stays under the guard's 150 GB stop. 200 are slowed from 120 GB; past
        that even 3 voices heard is 18 GB an hour, so only the guard's own Guild Desk limits keep them running."""
        for itype, n, guards, under_stop in (("t4g.small", 25, False, True), ("t4g.medium", 50, True, True), ("c7g.xlarge", 200, True, False)):
            with self.subTest(itype=itype):
                r = simulate_guild(n, lambda m, n=n: n * LOUD if m % 1440 < 720 else 0, days=3, itype=itype, rtc_gbh=n * 0.0054)
                self.assertEqual(r.guarded > 0, guards)
                self.assertEqual(r.p24 < GUARD_DAY_GB, under_stop, r.p24)
                if not guards:
                    self.assertGreater(r.p24, n * LOUD * 12 * 0.99)
        r = simulate_guild(200, lambda m: 200 * LOUD if m % 1440 < 720 else 0, days=3, rtc_gbh=200 * 0.0054, c=uncapped())
        self.assertEqual(r.guarded, 0, "without the cap the members' 800 GB line never slowed them before the guard's stop")

    def test_the_line_comes_before_the_guards_stop_on_every_tier(self):
        """Security's NET031-1: however loud, the desk slows voice and desk-rtc's class before its 24 h reaches the guard's
        150 GB, at its 100 or 120 GB line (within a tick). Without the cap, 50 and 200 members reached 150 first."""
        for itype, n in (("t4g.small", 25), ("t4g.medium", 50), ("c7g.xlarge", 200), ("c7g.2xlarge", 200)):
            for load in ("voice", "data", "both"):
                with self.subTest(itype=itype, load=load):
                    v = (lambda m: 10**6) if load != "data" else (lambda m: 0)
                    r = simulate_guild(n, v, days=1, itype=itype, rtc_gbh=10**6 if load != "voice" else 0)
                    self.assertIsNotNone(r.first)
                    self.assertLess(r.first, gcfg(itype)["guild_day_gb"] + 3.5)
                    self.assertLess(r.first, GUARD_DAY_GB - 25)
        for itype, n in (("t4g.medium", 50), ("c7g.xlarge", 200)):
            r = simulate_guild(n, lambda m: 10**6, days=1, itype=itype, c=uncapped(itype))
            self.assertGreater(r.first, GUARD_DAY_GB)

    def test_the_members_lines_dont_apply(self):
        """A member's desk would clamp desk-rtc at 135 GB in 24 h and step its stream at 100: a Guild Desk does neither (on
        the members' line, without the temporary cap, so the guild's own line doesn't slow it first)."""
        r = simulate_guild(200, lambda m: 200 * LOUD if m % 1440 < 600 else 0, days=2, rtc_gbh=2.0, c=uncapped())
        self.assertGreater(r.p24, 135 * 4)
        self.assertEqual(r.guarded, 0)
        self.assertEqual(r.budget.rates()["10"], 150.0)
        self.assertEqual(r.budget.profile, "normal")

    def test_a_broken_commons_at_the_ceiling_is_held_to_the_day_line(self):
        """Voice at its ceiling all day: past the line voice drops to its guarded rate, and desk-rtc's class too, until the 24 h total
        is under the release line. The worst 24 h is the line, reached at the ceiling, plus the guarded rate for the rest of the day:
        at 200 members 120 + 18 x (24 - 1.7) = 522 GB (1,032 on the members' 800 GB line); at 25, 100 + 2.25 x (24 - 11.1) = 129 GB."""
        for itype, n in (("t4g.small", 25), ("c7g.xlarge", 200)):
            with self.subTest(itype=itype):
                c = gcfg(itype)
                line, ceil, guarded = c["guild_day_gb"], mbps_gbh(c["voice_mbps"]), mbps_gbh(c["guarded_voice_mbps"])
                bound = line + guarded * (24 - line / ceil) + 0.5 * 24 + 0.03 * 24
                r = simulate_guild(n, lambda m: 10**6, days=4, itype=itype, rtc_gbh=0.5)
                self.assertGreater(r.guarded, 0)
                self.assertLess(r.p24, bound * 1.01)
                self.assertGreater(r.p24, line)

    def test_a_broken_desk_rtc_at_its_guild_ceiling_is_held_too(self):
        """1:10 is bigger on a Guild Desk (150 Mbit at 200 members), so the day line has to hold a broken desk-rtc as well:
        past 120 GB it drops to 20 Mbit until under 105 (800 and 700 on the members' line)."""
        r = simulate_guild(200, lambda m: 0, days=4, rtc_gbh=10**6)
        line, ceil, guarded = 120, mbps_gbh(150), mbps_gbh(20)
        self.assertGreater(r.guarded, 0)
        self.assertLess(r.p24, (line + guarded * (24 - line / ceil) + 0.03 * 24) * 1.01)

    def test_guarded_rates_and_release(self):
        c = gcfg("t4g.small")
        b = E.Budget(c, OCT1)
        b.tick(OCT1 + 60, {"10": 0, "15": 0, "20": 0, "30": 99 * GB})
        self.assertFalse(b.guarded)
        self.assertEqual(b.rates(), {"10": 60.0, "15": 2.0, "20": 100.0, "30": 20.0})
        b.tick(OCT1 + 120, {"10": 1 * GB, "15": 0, "20": 0, "30": 100 * GB})
        self.assertTrue(b.guarded)
        self.assertEqual(b.rates(), {"10": 2.5, "15": 2.0, "20": 100.0, "30": 5.0})
        b.tick(OCT1 + 86400 + 300, {"10": 1 * GB, "15": 0, "20": 0, "30": 100 * GB + 88 * GB})  # the old window gone, 88 GB in
        self.assertTrue(b.guarded, "88 GB is still over the 87.5 GB release line")
        b.tick(OCT1 + 2 * 86400 + 600, {"10": 1 * GB, "15": 0, "20": 0, "30": 188 * GB})
        self.assertFalse(b.guarded)
        self.assertEqual(b.rates()["30"], 20.0)

    def test_voice_never_slows_the_bucket_and_the_bucket_stays(self):
        b = E.Budget(gcfg(), OCT1)
        b.tick(OCT1 + 60, {"10": 0, "15": 0, "20": 0, "30": 80 * GB})
        self.assertFalse(b.slowed)
        b.tick(OCT1 + 120, {"10": 0, "15": 1 * GB, "20": 30 * GB, "30": 80 * GB})
        self.assertTrue(b.slowed, "the desk's own senders keep every desk's bucket")
        self.assertEqual(b.rates()["20"], 0.75)
        self.assertEqual(b.rates()["30"], 160.0)

    def test_state_keeps_guarded_and_lets_go_of_a_members_stream_steps(self):
        b = E.Budget(gcfg(), OCT1)
        b.tick(OCT1 + 60, {"10": 0, "15": 0, "20": 0, "30": 801 * GB})
        saved = json.loads(json.dumps(b.saved("b")))
        self.assertTrue(saved["guarded"])
        self.assertTrue(E.Budget(gcfg(), OCT1 + 90, saved, "b").guarded)
        m = E.Budget(cfg(), OCT1)
        m.tick(OCT1 + 60, {"10": 136 * GB, "15": 0, "20": 0})
        self.assertTrue(m.clamped)
        g = E.Budget(gcfg(), OCT1 + 90, json.loads(json.dumps(m.saved("b"))), "b")
        self.assertEqual((g.clamped, g.profile, g.day_deep, g.guarded), (False, "normal", False, False))
        self.assertEqual(g.rates()["10"], 150.0)

    def test_a_bad_guarded_value_is_not_guarded(self):
        b = E.Budget(gcfg(), OCT1)
        saved = json.loads(json.dumps(b.saved("b")))
        for v in ("yes", 1, None):
            saved["guarded"] = v
            self.assertFalse(E.Budget(gcfg(), OCT1 + 90, saved, "b").guarded)

    def test_unit_orders_after_desk_kind(self):
        unit = (RECIPE / "files/etc/systemd/system/desk-egress.service").read_text()
        self.assertIn("\nAfter=desk-kind.service\n", unit)
        self.assertNotIn("Requires=desk-kind", unit)


class BrowserAfterTheShaper(unittest.TestCase):
    """Security's NET031-5: the Browser never starts before desk-egress is up (READY or failed), so it never runs unshaped at boot,
    whoever starts it. Only ordering, never a Requires (a desk with no shaper still gets a Browser), and no cycle with deskd."""

    def units(self, name):
        return (RECIPE / "files/etc/systemd/system" / name).read_text().splitlines()

    def keys(self, name, key):
        return [w for l in self.units(name) if l.startswith(key + "=") for w in l.split("=", 1)[1].split()]

    def test_the_browser_is_ordered_after_the_shaper(self):
        self.assertIn("desk-egress.service", self.keys("desk-browser.service", "After"))
        self.assertNotIn("desk-egress.service", self.keys("desk-browser.service", "Requires"))
        self.assertNotIn("desk-egress.service", self.keys("desk-browser.service", "Wants"))

    def test_no_cycle_with_deskd(self):
        # desk-egress is Before deskd, and so is the Browser: neither may be After deskd, nor desk-egress After the Browser.
        self.assertIn("deskd.service", self.keys("desk-egress.service", "Before"))
        self.assertIn("deskd.service", self.keys("desk-browser.service", "Before"))
        self.assertNotIn("deskd.service", self.keys("desk-browser.service", "After"))
        self.assertNotIn("desk-browser.service", self.keys("desk-egress.service", "After"))


if __name__ == "__main__":
    unittest.main()
