"""Centrifugal pump head/flow curve fit for P-4102A."""


def head_m(flow_m3h: float) -> float:
    # Vendor curve, second-order fit (R^2 = 0.998)
    return 61.4 - 0.00092 * flow_m3h**2


def npsh_required_m(flow_m3h: float) -> float:
    return 2.1 + 0.00031 * flow_m3h**2
