import unittest

from backend.kgi_bridge.capabilities import (
    AVAILABLE,
    FORBIDDEN,
    TEMPORARY_ERROR,
    UNKNOWN,
    CapabilityRegistry,
)


class CapabilityRegistryTests(unittest.TestCase):
    def test_unqueried_key_starts_unknown(self):
        registry = CapabilityRegistry()
        self.assertEqual(registry.state("data:任意表"), UNKNOWN)
        self.assertFalse(registry.is_forbidden("data:任意表"))

    def test_mark_forbidden_is_sticky_and_carries_detail(self):
        registry = CapabilityRegistry()
        registry.mark_forbidden("data:某排行表", {"upstream_code": "D403"})
        self.assertEqual(registry.state("data:某排行表"), FORBIDDEN)
        self.assertTrue(registry.is_forbidden("data:某排行表"))
        self.assertEqual(registry.detail("data:某排行表"), {"upstream_code": "D403"})

    def test_mark_available_clears_stale_detail(self):
        registry = CapabilityRegistry()
        registry.mark_forbidden("data:table", {"upstream_code": "D403"})
        registry.mark_available("data:table")
        self.assertEqual(registry.state("data:table"), AVAILABLE)
        self.assertIsNone(registry.detail("data:table"))
        self.assertFalse(registry.is_forbidden("data:table"))

    def test_temporary_error_does_not_downgrade_confirmed_forbidden(self):
        # A transient network blip on a table we've already confirmed D403
        # for must not erase the sticky forbidden state — otherwise the
        # capability cache would start retrying an entitlement-denied table
        # again after every unrelated timeout.
        registry = CapabilityRegistry()
        registry.mark_forbidden("data:table")
        registry.mark_temporary_error("data:table")
        self.assertEqual(registry.state("data:table"), FORBIDDEN)

    def test_temporary_error_on_unknown_key_is_recorded(self):
        registry = CapabilityRegistry()
        registry.mark_temporary_error("data:table", {"message": "timeout"})
        self.assertEqual(registry.state("data:table"), TEMPORARY_ERROR)
        self.assertEqual(registry.detail("data:table"), {"message": "timeout"})

    def test_snapshot_is_a_copy(self):
        registry = CapabilityRegistry()
        registry.mark_available("data:a")
        snap = registry.snapshot()
        snap["data:a"] = FORBIDDEN
        self.assertEqual(registry.state("data:a"), AVAILABLE)


if __name__ == "__main__":
    unittest.main()
