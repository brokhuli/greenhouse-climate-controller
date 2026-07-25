"""Infrastructure adapters and cross-cutting technical concerns.

The Phase-2 REST client (:mod:`.dataaccess`), service-to-service / operator auth (:mod:`.auth`),
offline JSON-Schema validation against the shared ``contracts/`` (:mod:`.schema_validation`), and the
observability seams — structured JSON :mod:`.logging` and Prometheus :mod:`.metrics`. None of these
carry greenhouse domain logic; they are the seams between the core and the outside world.
"""
