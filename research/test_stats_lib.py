import math
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from stats_lib import (
    mean, stdev, pearson_r, fisher_r_pvalue, ols_simple, ols_multivariate,
    wilson_ci, benjamini_hochberg, two_sample_test,
)


def test_mean_and_stdev_basic():
    assert mean([1, 2, 3, 4]) == 2.5
    assert mean([]) is None
    assert abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.13809) < 1e-4


def test_pearson_r_perfect_positive():
    xs = [1, 2, 3, 4, 5]
    ys = [2, 4, 6, 8, 10]
    assert abs(pearson_r(xs, ys) - 1.0) < 1e-9


def test_pearson_r_perfect_negative():
    xs = [1, 2, 3, 4, 5]
    ys = [10, 8, 6, 4, 2]
    assert abs(pearson_r(xs, ys) - (-1.0)) < 1e-9


def test_pearson_r_zero_variance_returns_none():
    assert pearson_r([1, 1, 1], [1, 2, 3]) is None


def test_pearson_r_too_short_returns_none():
    assert pearson_r([1, 2], [1, 2]) is None


def test_pearson_r_mismatched_length_returns_none():
    assert pearson_r([1, 2, 3], [1, 2]) is None


def test_fisher_r_pvalue_none_cases():
    assert fisher_r_pvalue(None, 10) is None
    assert fisher_r_pvalue(0.5, 3) is None
    assert fisher_r_pvalue(1.0, 10) == 0.0
    assert fisher_r_pvalue(-1.0, 10) == 0.0


def test_fisher_r_pvalue_no_correlation_large_n():
    # r=0 should give p=1.0 regardless of n (z=0)
    p = fisher_r_pvalue(0.0, 100)
    assert abs(p - 1.0) < 1e-9


def test_fisher_r_pvalue_strong_r_small_p():
    p = fisher_r_pvalue(0.8, 50)
    assert p < 0.001


def test_ols_simple_exact_line():
    xs = [1, 2, 3, 4, 5, 6]
    ys = [3, 5, 7, 9, 11, 13]  # y = 2x + 1, no noise
    result = ols_simple(xs, ys)
    assert abs(result["slope"] - 2.0) < 1e-9
    assert abs(result["intercept"] - 1.0) < 1e-9
    assert abs(result["r_squared"] - 1.0) < 1e-9
    assert result["n"] == 6


def test_ols_simple_too_few_points():
    assert ols_simple([1, 2], [1, 2]) is None


def test_ols_simple_zero_variance_x():
    assert ols_simple([1, 1, 1, 1], [1, 2, 3, 4]) is None


def test_ols_multivariate_exact_plane():
    # y = 1 + 2*x1 - 1*x2, no noise, 6 observations, 2 predictors
    rows = [(1, 0), (2, 1), (3, 0), (4, 2), (5, 1), (6, 3)]
    ys = [1 + 2 * x1 - x2 for x1, x2 in rows]
    result = ols_multivariate(rows, ys)
    assert result is not None
    coeffs = result["coefficients"]
    assert abs(coeffs[0] - 1.0) < 1e-6
    assert abs(coeffs[1] - 2.0) < 1e-6
    assert abs(coeffs[2] - (-1.0)) < 1e-6
    assert abs(result["r_squared"] - 1.0) < 1e-6


def test_ols_multivariate_singular_returns_none():
    # x2 = 2*x1 exactly -> perfectly collinear -> singular X'X
    rows = [(1, 2), (2, 4), (3, 6), (4, 8), (5, 10)]
    ys = [1, 2, 3, 4, 5]
    assert ols_multivariate(rows, ys) is None


def test_ols_multivariate_too_few_observations():
    rows = [(1, 2), (2, 3)]
    ys = [1, 2]
    assert ols_multivariate(rows, ys) is None


def test_wilson_ci_midpoint_and_bounds():
    p, lo, hi = wilson_ci(5, 10)
    assert abs(p - 0.5) < 1e-9
    assert 0.0 <= lo < 0.5 < hi <= 1.0


def test_wilson_ci_zero_n_returns_none():
    assert wilson_ci(0, 0) is None


def test_wilson_ci_extreme_proportions_stay_in_bounds():
    p, lo, hi = wilson_ci(10, 10)
    assert p == 1.0
    assert 0.0 <= lo <= 1.0
    assert hi == 1.0
    p, lo, hi = wilson_ci(0, 10)
    assert p == 0.0
    assert abs(lo) < 1e-9
    assert 0.0 <= hi <= 1.0


def test_two_sample_test_identical_samples_no_difference():
    xs = [0.01, 0.02, 0.03, 0.01, 0.02]
    ys = [0.01, 0.02, 0.03, 0.01, 0.02]
    result = two_sample_test(xs, ys)
    assert abs(result["mean_diff"]) < 1e-9
    assert abs(result["p_value"] - 1.0) < 1e-9


def test_two_sample_test_clear_difference_significant():
    xs = [1.0, 1.1, 0.9, 1.05, 0.95, 1.02, 0.98, 1.03, 0.97, 1.01]
    ys = [0.0, 0.1, -0.1, 0.05, -0.05, 0.02, -0.02, 0.03, -0.03, 0.01]
    result = two_sample_test(xs, ys)
    assert result["mean_diff"] > 0.9
    assert result["p_value"] < 0.001


def test_two_sample_test_too_few_observations_returns_none():
    assert two_sample_test([1.0], [1.0, 2.0]) is None
    assert two_sample_test([1.0, 2.0], [1.0]) is None


def test_benjamini_hochberg_passthrough_none():
    result = benjamini_hochberg([0.01, None, 0.5])
    assert result[1] == (None, False)
    assert result[0][0] is not None
    assert result[2][0] is not None


def test_benjamini_hochberg_all_none():
    result = benjamini_hochberg([None, None])
    assert result == [(None, False), (None, False)]


def test_benjamini_hochberg_monotonicity_and_rejection():
    # Classic example: small p-values should survive correction, large ones should not.
    pvalues = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216]
    result = benjamini_hochberg(pvalues, alpha=0.05)
    adjusted = [r[0] for r in result]
    # adjusted p-values must be non-decreasing when sorted by original p-value rank
    order = sorted(range(len(pvalues)), key=lambda i: pvalues[i])
    sorted_adjusted = [adjusted[i] for i in order]
    for a, b in zip(sorted_adjusted, sorted_adjusted[1:]):
        assert a <= b + 1e-9
    # the smallest p-value should be rejected at alpha=0.05
    assert result[0][1] is True
