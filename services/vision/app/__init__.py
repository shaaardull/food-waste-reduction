"""Plate-Clean Rewards vision inference service.

Phase 2 standalone microservice. The same Phase 1 tool-output shape goes
in and out, so the only thing that changes when we swap the backend is the
implementation behind the Backend.infer() call.
"""

__version__ = "0.1.0"
