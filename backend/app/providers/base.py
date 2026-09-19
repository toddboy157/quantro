"""
The interface every data source implements. This is the seam described in
the build scope doc: the calc engine, API and frontend only ever talk to
this interface, never to a specific vendor's SDK/response shape. Swapping
mock -> Polygon -> a future OPRA/Cboe DataShop connector means writing a
new class here, not touching anything downstream.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import List


@dataclass
class ContractSnapshot:
    strike: float
    expiry_days: float  # calendar days to expiry, can be fractional for 0DTE intraday
    is_call: bool
    open_interest: int
    implied_vol: float  # annualized, e.g. 0.18 for 18%


@dataclass
class ChainSnapshot:
    underlying: str
    spot: float
    timestamp: float  # unix seconds
    contracts: List[ContractSnapshot] = field(default_factory=list)


class OptionsDataProvider(abc.ABC):
    """Abstract base for anything that can hand back a live options chain."""

    @abc.abstractmethod
    async def get_chain(self, underlying: str) -> ChainSnapshot:
        """Return the current full chain snapshot for one underlying."""
        raise NotImplementedError

    async def close(self) -> None:
        """Override to release HTTP clients / sockets on shutdown."""
        return None
