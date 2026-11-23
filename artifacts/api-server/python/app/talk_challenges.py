"""Explicit admin import definitions for Demo Day CTF awards, not credentials."""

TALK_CHALLENGES = tuple(
    (
        f"talk-demo-day-2026-10-{day}",
        f"Talk: Demo Day 10/{day}",
        f"Gave a security related talk on Weekly Demos 10/{day}/2026",
        flag,
    )
    for day, flag in (
        ("02", "weekly_demo_talk_oct02"),
        ("09", "oct09_dmo_dayz"),
        ("16", "10sixteen_demo_talk"),
    )
)
