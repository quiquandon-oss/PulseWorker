"""
Pure-stdlib statistics primitives for the AI-capital-rotation research
study (research/ai_capital_rotation.py). No numpy/pandas/scipy: this
project's existing sister research module (PulseWorkerV2's research/
stats_utils.py) already establishes the convention of hand-rolled,
dependency-free statistics for exactly this kind of research script, and
the task instructions explicitly ask to avoid unnecessary dependencies.

Every function here is deterministic and takes plain Python lists/floats
-- no I/O, no randomness -- so it can be unit-tested with fixed synthetic
inputs, independent of any live data fetch.

A documented simplification: significance tests below use the standard
NORMAL approximation (via statistics.NormalDist) rather than an exact
Student-t distribution. For the sample sizes this study actually reaches
(order of dozens to ~150 trading days), the t- and normal distributions
are close enough that this does not materially change conclusions, and
avoiding a hand-rolled incomplete-beta/t-CDF implementation keeps this
module small and easy to audit. This is a deliberate, disclosed choice,
not an oversight -- see the module docstring in ai_capital_rotation.py's
own report-writing section for how this is stated in the final report.
"""

import math
from statistics import NormalDist

_NORMAL = NormalDist()


def mean(xs):
    xs = list(xs)
    if not xs:
        return None
    return sum(xs) / len(xs)


def stdev(xs, ddof=1):
    xs = list(xs)
    n = len(xs)
    if n - ddof <= 0:
        return None
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (n - ddof))


def pearson_r(xs, ys):
    """Pearson correlation coefficient. Returns None if inputs are
    mismatched, too short (n < 3), or either series has zero variance
    (undefined correlation, never silently returned as 0)."""
    if len(xs) != len(ys) or len(xs) < 3:
        return None
    n = len(xs)
    mx, my = mean(xs), mean(ys)
    sx = sum((x - mx) ** 2 for x in xs)
    sy = sum((y - my) ** 2 for y in ys)
    if sx <= 0 or sy <= 0:
        return None
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return sxy / math.sqrt(sx * sy)


def fisher_r_pvalue(r, n):
    """Two-tailed p-value for a Pearson r via the Fisher z-transform and
    a normal approximation to the sampling distribution of z (standard
    error 1/sqrt(n-3)). Returns None if r is None/±1 (transform
    undefined) or n < 4."""
    if r is None or n is None or n < 4:
        return None
    if abs(r) >= 1:
        return 0.0
    z = 0.5 * math.log((1 + r) / (1 - r))
    se = 1 / math.sqrt(n - 3)
    z_stat = z / se
    return 2 * (1 - _NORMAL.cdf(abs(z_stat)))


def ols_simple(xs, ys):
    """Single-predictor OLS: ys = intercept + slope*xs + error.
    Returns a dict with slope, intercept, r_squared, n, se_slope,
    t_stat (slope / se_slope), and a two-tailed p-value for the slope
    (normal approximation -- see module docstring). Returns None if
    fewer than 4 points or x has zero variance."""
    if len(xs) != len(ys) or len(xs) < 4:
        return None
    n = len(xs)
    mx, my = mean(xs), mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 0:
        return None
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    intercept = my - slope * mx
    residuals = [y - (intercept + slope * x) for x, y in zip(xs, ys)]
    sse = sum(e ** 2 for e in residuals)
    sst = sum((y - my) ** 2 for y in ys)
    r_squared = 1 - sse / sst if sst > 0 else None
    dof = n - 2
    if dof <= 0:
        return None
    mse = sse / dof
    se_slope = math.sqrt(mse / sxx) if sxx > 0 else None
    t_stat = slope / se_slope if se_slope else None
    p_value = 2 * (1 - _NORMAL.cdf(abs(t_stat))) if t_stat is not None else None
    return {
        "n": n, "slope": slope, "intercept": intercept, "r_squared": r_squared,
        "se_slope": se_slope, "t_stat": t_stat, "p_value": p_value,
    }


def ols_multivariate(rows, ys):
    """Multi-predictor OLS via the normal equations (X'X)^-1 X'y, solved
    by Gauss-Jordan elimination on the augmented matrix -- no numpy.
    `rows` is a list of predictor tuples (one row per observation, NOT
    including the intercept column); an intercept column of 1s is added
    internally. Returns a dict with `coefficients` (intercept first,
    then one per predictor in `rows` column order), `se` (same order),
    `t_stats`, `p_values`, `r_squared`, and `n`. Returns None if the
    design matrix is singular (perfectly collinear predictors, or fewer
    observations than parameters) rather than raising or fabricating a
    result -- this is a fail-closed research tool, not a production
    fitting routine that must always return something."""
    n = len(rows)
    if n != len(ys) or n == 0:
        return None
    k = len(rows[0]) + 1  # +1 for intercept
    if n <= k:
        return None
    X = [[1.0] + [float(v) for v in row] for row in rows]

    # X'X (k x k) and X'y (k x 1)
    XtX = [[sum(X[i][a] * X[i][b] for i in range(n)) for b in range(k)] for a in range(k)]
    Xty = [sum(X[i][a] * ys[i] for i in range(n)) for a in range(k)]

    # Gauss-Jordan on [XtX | Xty | I] to get both the solution and
    # (X'X)^-1 (needed for standard errors) in one pass.
    aug = [XtX[i][:] + [1.0 if i == j else 0.0 for j in range(k)] + [Xty[i]] for i in range(k)]
    for col in range(k):
        pivot_row = max(range(col, k), key=lambda r: abs(aug[r][col]))
        if abs(aug[pivot_row][col]) < 1e-12:
            return None  # singular / collinear
        aug[col], aug[pivot_row] = aug[pivot_row], aug[col]
        pivot = aug[col][col]
        aug[col] = [v / pivot for v in aug[col]]
        for r in range(k):
            if r == col:
                continue
            factor = aug[r][col]
            if factor != 0:
                aug[r] = [v - factor * aug[col][j] for j, v in enumerate(aug[r])]

    coefficients = [aug[i][-1] for i in range(k)]
    inv_XtX = [[aug[i][k + j] for j in range(k)] for i in range(k)]

    fitted = [sum(coefficients[a] * X[i][a] for a in range(k)) for i in range(n)]
    residuals = [ys[i] - fitted[i] for i in range(n)]
    sse = sum(e ** 2 for e in residuals)
    my = mean(ys)
    sst = sum((y - my) ** 2 for y in ys)
    r_squared = 1 - sse / sst if sst > 0 else None
    dof = n - k
    if dof <= 0:
        return None
    mse = sse / dof
    se = [math.sqrt(mse * inv_XtX[a][a]) if inv_XtX[a][a] > 0 else None for a in range(k)]
    t_stats = [coefficients[a] / se[a] if se[a] else None for a in range(k)]
    p_values = [2 * (1 - _NORMAL.cdf(abs(t))) if t is not None else None for t in t_stats]
    return {
        "n": n, "coefficients": coefficients, "se": se, "t_stats": t_stats,
        "p_values": p_values, "r_squared": r_squared,
    }


def wilson_ci(successes, n, confidence=0.95):
    """Wilson score interval for a binomial proportion -- better-behaved
    than the naive normal approximation at small n or p near 0/1, and
    needs no scipy. Returns (point_estimate, lo, hi), or None if n==0."""
    if n == 0:
        return None
    z = _NORMAL.inv_cdf(1 - (1 - confidence) / 2)
    p = successes / n
    denom = 1 + z ** 2 / n
    center = (p + z ** 2 / (2 * n)) / denom
    half_width = (z * math.sqrt(p * (1 - p) / n + z ** 2 / (4 * n ** 2))) / denom
    return (p, max(0.0, center - half_width), min(1.0, center + half_width))


def two_sample_test(xs, ys):
    """Welch-style two-sample test for a difference in means, using the
    normal approximation (see module docstring) instead of an exact
    Welch-Satterthwaite t-distribution. Used to compare, e.g., crypto
    forward returns after the weakest 20% of basket days versus the
    unconditional sample. Returns a dict with n1, n2, mean1, mean2,
    mean_diff, se, z_stat, p_value (two-tailed), or None if either
    sample has fewer than 2 observations."""
    xs, ys = list(xs), list(ys)
    n1, n2 = len(xs), len(ys)
    if n1 < 2 or n2 < 2:
        return None
    m1, m2 = mean(xs), mean(ys)
    s1, s2 = stdev(xs), stdev(ys)
    se = math.sqrt((s1 ** 2) / n1 + (s2 ** 2) / n2)
    if se == 0:
        return None
    diff = m1 - m2
    z_stat = diff / se
    p_value = 2 * (1 - _NORMAL.cdf(abs(z_stat)))
    return {
        "n1": n1, "n2": n2, "mean1": m1, "mean2": m2,
        "mean_diff": diff, "se": se, "z_stat": z_stat, "p_value": p_value,
    }


def benjamini_hochberg(pvalues, alpha=0.05):
    """Benjamini-Hochberg FDR correction. `pvalues` is a list that may
    contain None (untestable comparisons, e.g. too few observations) --
    None entries are passed through as (None, False) and excluded from
    the correction itself, never treated as p=0 or p=1. Returns a list
    the same length and order as the input, of (adjusted_p, reject)
    tuples. Matches the same BH convention research/source_analysis.py
    already uses elsewhere in this project's research tooling."""
    indexed = [(i, p) for i, p in enumerate(pvalues) if p is not None]
    m = len(indexed)
    result = [None] * len(pvalues)
    if m == 0:
        return [(None, False) for _ in pvalues]
    indexed.sort(key=lambda t: t[1])
    adjusted = [None] * m
    prev = 1.0
    for rank in range(m, 0, -1):
        i, p = indexed[rank - 1]
        adj = min(prev, p * m / rank)
        adjusted[rank - 1] = adj
        prev = adj
    for (i, p), adj in zip(indexed, adjusted):
        result[i] = (adj, adj < alpha)
    for i in range(len(pvalues)):
        if result[i] is None:
            result[i] = (None, False)
    return result
