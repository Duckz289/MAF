"""Independent Newcombe 1998 method 10 calculator.

Not imported by the scoring runner. Exists so the TypeScript reference in
analysis-v1.ts can be checked against a second implementation and against
Newcombe (1998) Statistics in Medicine 17:2635-2650 Table III.

    python evaluation/experiments/analysis/newcombe-method10-independent.py
"""

from __future__ import annotations

import math


def wilson_closed(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 1.0
    p = successes / n
    z2 = z * z
    den = 1 + z2 / n
    center = (p + z2 / (2 * n)) / den
    half = (z / den) * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))
    return max(0.0, center - half), min(1.0, center + half)


def wilson_quadratic(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson limits as roots of |m - p| = z * sqrt(m(1-m)/n)."""
    if n == 0:
        return 0.0, 1.0
    p = successes / n
    z2 = z * z
    a = 1 + z2 / n
    b = -(2 * p + z2 / n)
    c = p * p
    disc = b * b - 4 * a * c
    s = math.sqrt(max(disc, 0.0))
    m1 = (-b - s) / (2 * a)
    m2 = (-b + s) / (2 * a)
    lo, hi = (m1, m2) if m1 <= m2 else (m2, m1)
    return max(0.0, lo), min(1.0, hi)


def newcombe10(
    e: int,
    f: int,
    g: int,
    h: int,
    z: float = 1.96,
    method: int = 10,
    wilson=wilson_closed,
) -> dict[str, float | int]:
    n = e + f + g + h
    p1 = (e + f) / n
    p2 = (e + g) / n
    theta = (f - g) / n
    l1, u1 = wilson(e + f, n, z)
    l2, u2 = wilson(e + g, n, z)
    a = (e + f) * (g + h) * (e + g) * (f + h)
    num = e * h - f * g
    if method == 10 and num > 0:
        num = max(num - n / 2, 0)
    phi = 0.0 if a == 0 else num / math.sqrt(a)
    rad_l = (p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2
    rad_u = (p2 - l2) ** 2 - 2 * phi * (p2 - l2) * (u1 - p1) + (u1 - p1) ** 2
    lo = theta - math.sqrt(max(rad_l, 0.0))
    hi = theta + math.sqrt(max(rad_u, 0.0))
    return {
        "n": n,
        "theta": theta,
        "p1": p1,
        "p2": p2,
        "phi": phi,
        "l1": l1,
        "u1": u1,
        "l2": l2,
        "u2": u2,
        "lower": max(-1.0, lo),
        "upper": min(1.0, hi),
        "rad_l": rad_l,
        "rad_u": rad_u,
    }


TABLE_III = [
    (36, 12, 2, 0, 0.0569, 0.3404),
    (20, 12, 2, 16, 0.0562, 0.3292),
    (18, 12, 2, 18, 0.0562, 0.3290),
    (36, 14, 0, 0, 0.1528, 0.4167),
    (35, 14, 0, 1, 0.1461, 0.4175),
    (18, 14, 0, 18, 0.1441, 0.3963),
    (2, 97, 1, 0, 0.8721, 0.9854),
    (1, 97, 1, 1, 0.8736, 0.9850),
    (0, 29, 1, 0, 0.6666, 0.9882),
    (2, 98, 0, 0, 0.9178, 0.9945),
    (1, 98, 0, 1, 0.9171, 0.9916),
    (0, 30, 0, 0, 0.8395, 1.0),
    (54, 0, 0, 0, -0.0664, 0.0664),
    (53, 0, 0, 1, -0.0729, 0.0729),
    (30, 0, 0, 24, -0.0358, 0.0358),
    (29, 0, 0, 25, -0.0354, 0.0354),
    (28, 0, 0, 26, -0.0352, 0.0352),
    (27, 0, 0, 27, -0.0351, 0.0351),
]


def main() -> None:
    print("z=1.96 method 10 vs Newcombe 1998 Table III")
    print(
        f"{'e':>4} {'f':>4} {'g':>4} {'h':>4} {'theta':>8} {'lo':>10} {'hi':>10} "
        f"{'pub_lo':>8} {'pub_hi':>8} {'dlo':>8} {'dhi':>8}"
    )
    for e, f, g, h, plo, phi in TABLE_III:
        r = newcombe10(e, f, g, h, z=1.96, method=10)
        print(
            f"{e:4d} {f:4d} {g:4d} {h:4d} {r['theta']:8.4f} {r['lower']:10.6f} "
            f"{r['upper']:10.6f} {plo:8.4f} {phi:8.4f} {r['lower']-plo:8.4f} {r['upper']-phi:8.4f}"
        )

    print("\nquadratic vs closed-form Wilson 8/10 z=1.96")
    print(wilson_closed(8, 10), wilson_quadratic(8, 10))

    z_precise = 1.959963984540054
    print("\nexperiment-scale fixtures with precise z (e=n11, f=n01, g=n10, h=n00)")
    examples = [
        ("3 BOTH, 2 MAF, 1 NAT", 3, 1, 2, 0),
        ("zero discordance all pass", 29, 0, 0, 0),
        ("zero discordance mix", 15, 0, 0, 14),
        ("one sided 8 vs 0", 10, 0, 8, 11),
        ("small 3 vs 0", 20, 0, 3, 6),
        ("8 vs 1", 12, 1, 8, 8),
        ("boundary all fail", 0, 0, 0, 29),
        ("boundary all maf", 0, 0, 29, 0),
        ("1 vs 1 small", 4, 1, 1, 4),
        ("all discordant maf", 0, 0, 5, 0),
    ]
    for name, n11, n10, n01, n00 in examples:
        r = newcombe10(n11, n01, n10, n00, z=z_precise, method=10)
        rq = newcombe10(
            n11, n01, n10, n00, z=z_precise, method=10, wilson=wilson_quadratic
        )
        print(
            f"{name:28s} n={r['n']:2d} theta={r['theta']:+.8f} "
            f"[{r['lower']:+.10f}, {r['upper']:+.10f}] "
            f"q=[{rq['lower']:+.10f}, {rq['upper']:+.10f}] phi={r['phi']:.8f}"
        )


if __name__ == "__main__":
    main()
