"""Phase 3 greenhouse climate optimizer — deterministic core.

This first slice provides the fully-testable, LLM-free foundation: typed configuration,
domain models mirroring the wire contracts, the input-quality gate, the digital twin, the
constraint/application gate, and the Phase-2 data-access client. The LLM planner, the
FastAPI service, and the scheduler land in later slices.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
