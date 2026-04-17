"""
Lightweight Preferential Bayesian Optimization (LPBO) for IDNA.

Implements a GP preference model (Chu & Ghahramani 2005) using:
  - RBF kernel
  - Laplace approximation for posterior inference
  - UCB acquisition (mu + beta*sigma) for candidate scoring
  - Diverse top-N selection for final candidates

Dependencies: numpy, scipy (both added to pyproject.toml)
Falls back gracefully to None if unavailable or insufficient data.
"""

from __future__ import annotations

import math
import numpy as np
from scipy.optimize import minimize
from scipy.special import ndtr as _Phi  # standard normal CDF


# ── Kernel ────────────────────────────────────────────────────────────────────

def _rbf_kernel(
    X1: np.ndarray,
    X2: np.ndarray,
    length_scale: float,
    sigma_f: float,
) -> np.ndarray:
    """Squared-exponential (RBF) kernel: k(x1,x2) = σ_f² exp(-||x1-x2||²/2l²)."""
    diff = X1[:, None, :] - X2[None, :, :]          # (n1, n2, d)
    sq_dist = np.einsum("ijk,ijk->ij", diff, diff)   # (n1, n2)
    return (sigma_f ** 2) * np.exp(-0.5 * sq_dist / (length_scale ** 2))


# ── GP Preference Model ───────────────────────────────────────────────────────

class PreferenceGP:
    """
    GP preference model via Laplace approximation.

    Likelihood: P(a ≻ b | f) = Φ((f_a - f_b) / σ_n)   [probit]
    Prior:      f ~ GP(0, K)
    Posterior:  Laplace approximation around f_MAP
    """

    def __init__(
        self,
        length_scale: float = 0.4,
        sigma_f: float = 1.0,
        sigma_noise: float = 0.1,
    ) -> None:
        self.length_scale = length_scale
        self.sigma_f = sigma_f
        self.sigma_noise = sigma_noise
        self._X: np.ndarray | None = None
        self._f_map: np.ndarray | None = None
        self._K_inv: np.ndarray | None = None

    def fit(self, X: np.ndarray, comparisons: list[tuple[int, int]]) -> None:
        """
        Fit GP to preference data.

        X:           (N, d) — all observed parameter vectors
        comparisons: list of (winner_idx, loser_idx) — indices into X
        """
        N = len(X)
        self._X = X.copy()

        K = _rbf_kernel(X, X, self.length_scale, self.sigma_f)
        K += 1e-6 * np.eye(N)  # jitter

        try:
            L = np.linalg.cholesky(K)
            self._K_inv = np.linalg.solve(L.T, np.linalg.solve(L, np.eye(N)))
        except np.linalg.LinAlgError:
            self._K_inv = np.linalg.pinv(K)

        sn = self.sigma_noise

        def neg_log_post(f: np.ndarray) -> float:
            ll = 0.0
            for w, l in comparisons:
                z = (f[w] - f[l]) / sn
                ll += math.log(max(_Phi(z), 1e-10))
            prior = 0.5 * float(f @ self._K_inv @ f)
            return -ll + prior

        def grad(f: np.ndarray) -> np.ndarray:
            g = self._K_inv @ f
            inv_sn = 1.0 / sn
            sqrt2pi = math.sqrt(2 * math.pi)
            for w, l in comparisons:
                z = (f[w] - f[l]) / sn
                phi_z = math.exp(-0.5 * z * z) / sqrt2pi
                p = max(_Phi(z), 1e-10)
                dz = phi_z / p * inv_sn
                g[w] -= dz
                g[l] += dz
            return g

        result = minimize(
            neg_log_post, np.zeros(N), jac=grad, method="L-BFGS-B",
            options={"maxiter": 300, "ftol": 1e-8},
        )
        self._f_map = result.x

    def predict(self, X_new: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Posterior mean and variance at new points (N_new, d)."""
        if self._X is None or self._f_map is None:
            return np.zeros(len(X_new)), np.ones(len(X_new))

        K_s = _rbf_kernel(X_new, self._X, self.length_scale, self.sigma_f)   # (N_new, N)
        K_ss_diag = self.sigma_f ** 2 * np.ones(len(X_new))                   # prior var

        mu = K_s @ (self._K_inv @ self._f_map)
        var_diag = K_ss_diag - np.einsum("ij,jk,ik->i", K_s, self._K_inv, K_s)
        return mu, np.maximum(var_diag, 0.0)


# ── Candidate pool & selection ────────────────────────────────────────────────

def _build_pool(
    best: np.ndarray,
    d: int,
    rng: np.random.Generator,
    n_comparisons: int,
    size: int = 300,
) -> np.ndarray:
    """Generate a candidate pool: local perturbations + axis extremes + random.

    Pool composition shifts from exploration-heavy → exploitation-heavy as
    more comparison data accumulates.
    """
    pool = np.empty((size, d))
    # Distribution: local 30% / axis-extremes 35% / random 35%
    # (stays exploration-heavy until many comparisons)
    n_local  = size * 3 // 10
    n_axis   = size * 35 // 100
    n_random = size - n_local - n_axis

    # Sigma widens in early rounds — shrinks slowly as data grows
    sigma = max(0.35, 0.55 - 0.015 * n_comparisons)
    noise = rng.normal(0, sigma, (n_local, d))
    pool[:n_local] = np.clip(best + noise, 0.0, 1.0)

    # Axis extremes: push each axis to 0.05 or 0.95
    for i in range(n_axis):
        v = best.copy()
        ax = i % d
        v[ax] = 0.05 if v[ax] > 0.5 else 0.95
        pool[n_local + i] = v

    # Pure random exploration
    pool[n_local + n_axis:] = rng.uniform(0.0, 1.0, (n_random, d))
    return pool


def _diverse_top_n(
    pool: np.ndarray,
    scores: np.ndarray,
    n: int,
    min_dist: float = 0.15,
) -> list[np.ndarray]:
    """Greedy diverse selection: pick top-scoring candidates with min distance."""
    order = list(np.argsort(-scores))
    selected: list[int] = []

    for idx in order:
        if len(selected) >= n:
            break
        cand = pool[idx]
        if not any(np.linalg.norm(cand - pool[s]) < min_dist for s in selected):
            selected.append(idx)

    # Relax diversity if not enough candidates
    for idx in order:
        if len(selected) >= n:
            break
        if idx not in selected:
            selected.append(idx)

    return [pool[i] for i in selected[:n]]


# ── Public API ────────────────────────────────────────────────────────────────

def suggest_candidates(
    session: dict,
    n_candidates: int,
    axis_names: list[str],
    seed: int = 42,
) -> list[dict] | None:
    """
    Suggest n_candidates parameter dicts using Preferential BO.

    Returns None when there is insufficient comparison data (< 1 round).
    The caller falls back to axis-mutation logic in that case.
    """
    comparisons_data = session.get("comparisons", [])
    # Need ≥ 3 picks before GP has meaningful signal in high-dimensional space.
    # Rounds 1–3 fall back to axis bisection (binary search per axis).
    if len(comparisons_data) < 3:
        return None

    nodes = session.get("nodes", {})
    d = len(axis_names)
    if d == 0:
        return None

    # ── Build observed datapoints ──────────────────────────────────────────────
    param_to_idx: dict[tuple, int] = {}
    X_list: list[np.ndarray] = []

    def _idx(params: dict) -> int:
        key = tuple(round(float(params.get(a, 0.5)), 4) for a in axis_names)
        if key not in param_to_idx:
            param_to_idx[key] = len(X_list)
            X_list.append(np.array(key, dtype=float))
        return param_to_idx[key]

    comparison_pairs: list[tuple[int, int]] = []
    last_winner_params: dict = {}

    for comp in comparisons_data:
        winner_id = comp.get("winner", "")
        winner_node = nodes.get(winner_id)
        if not winner_node:
            continue
        w_idx = _idx(winner_node["params"])
        last_winner_params = winner_node["params"]
        for lid in comp.get("losers", []):
            loser_node = nodes.get(lid)
            if loser_node:
                l_idx = _idx(loser_node["params"])
                if w_idx != l_idx:
                    comparison_pairs.append((w_idx, l_idx))

    if len(comparison_pairs) < 1 or len(X_list) < 2:
        return None

    X = np.array(X_list, dtype=float)

    # ── Fit GP ────────────────────────────────────────────────────────────────
    gp = PreferenceGP()
    try:
        gp.fit(X, comparison_pairs)
    except Exception:
        return None

    # ── Build candidate pool ──────────────────────────────────────────────────
    best = np.array([float(last_winner_params.get(a, 0.5)) for a in axis_names])
    n_comp = len(comparisons_data)
    rng = np.random.default_rng(seed)
    pool = _build_pool(best, d, rng, n_comparisons=n_comp)

    # ── Score via UCB ─────────────────────────────────────────────────────────
    mu, var = gp.predict(pool)
    # Beta decays slowly — exploitation ramps up only after ~15 rounds of picks.
    # 3 picks → beta=3.05, 10 picks → beta=2.0, 20 picks → beta=1.2 (floor)
    beta = max(1.2, 3.5 - 0.15 * n_comp)
    scores = mu + beta * np.sqrt(np.maximum(var, 0.0))

    # ── Diverse top-N selection ───────────────────────────────────────────────
    selected_vecs = _diverse_top_n(pool, scores, n_candidates)

    # ── Convert to param dicts ────────────────────────────────────────────────
    result = []
    for vec in selected_vecs:
        params = {axis_names[i]: round(float(vec[i]), 4) for i in range(d)}
        result.append(params)

    return result
