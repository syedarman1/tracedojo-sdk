# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman


class TracedojoError(Exception):
    """An actionable error whose message is safe to print (contains no customer data)."""
