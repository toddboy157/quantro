from .base import ChainSnapshot, ContractSnapshot, OptionsDataProvider
from .mock_provider import MockOptionsProvider

__all__ = [
    "ChainSnapshot",
    "ContractSnapshot",
    "OptionsDataProvider",
    "MockOptionsProvider",
]


def get_provider(name: str, **kwargs) -> OptionsDataProvider:
    """Factory so swapping data sources is a one-line config change,
    never a rewrite of the calc engine, API, or frontend."""
    name = name.strip().lower()
    if name == "mock":
        return MockOptionsProvider(**kwargs)
    if name == "polygon":
        from .polygon_provider import PolygonOptionsProvider
        return PolygonOptionsProvider(**kwargs)
    raise ValueError(f"Unknown DATA_PROVIDER: {name!r} (expected 'mock' or 'polygon')")
