"""The deterministic core — pure domain logic with no I/O.

The input data-quality gate (:mod:`.gating`, spec 07), the constraint engine + application gate
(:mod:`.constraints`, spec 06), and the digital twin (:mod:`.twin`, spec 03). These depend only on
the domain models and typed config — never on the platform client, the scheduler, or the service.
"""
