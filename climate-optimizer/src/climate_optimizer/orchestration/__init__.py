"""Cycle orchestration — the loops and the in-memory state they drive.

The per-greenhouse planning :mod:`.cycle` (read → gate → simulate → plan → validate → apply), the
cadence :mod:`.scheduler` that dispatches it, and the mutable service state those loops own:
operator overrides (:mod:`.runtime`) and the plan-record / escalation :mod:`.store`.
"""
