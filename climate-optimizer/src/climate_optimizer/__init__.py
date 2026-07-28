"""Phase 3 greenhouse climate optimizer.

A deterministic core — typed configuration, domain models mirroring the wire contracts, the
input-quality gate, the digital twin, the constraint/application gate, and the Phase-2 data-access
client — under an LLM planner, a cadence scheduler, and the FastAPI operator service that together
run the per-greenhouse planning cycle: read → gate → simulate → plan → validate → apply.

The platform's ``planning-context`` read handler, the Go API's ``/api/optimizer/*`` proxy, the
operator console, and the Compose services are separate, later slices.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
