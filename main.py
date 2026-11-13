"""
Botkeep strategy: Fundamental-augmented stock scoring with Codal data.
"""

import os
import json
from datetime import datetime

try:
    import alilnvest_codal as codal
except ImportError:
    codal = None

# ---------------------------------------------------------------------------
# Configuration — tune weights here
# ---------------------------------------------------------------------------
WEIGHTS = {
    "momentum": 0.25,
    "valuation": 0.20,
    "codal_fundamental": 0.35,   # Codal dimension weight
    "risk": 0.20,
}

CODAL_SUB_WEIGHTS = {
    "profitability": 0.35,
    "growth": 0.30,
    "activity": 0.20,
    "health": 0.15,
}

# Codal client configuration (conservative rate-limit friendly)
if codal:
    codal.configure(
        min_delay=2.0,
        max_delay=3.5,
        max_retries=2,
        symbol_min_delay=15.0,
        symbol_max_delay=20.0,
    )

# ---------------------------------------------------------------------------
# Codal fundamental scoring
# ---------------------------------------------------------------------------
def _safe_div(numerator, denominator, fallback=0.0):
    try:
        if denominator is None or denominator == 0:
            return fallback
        return numerator / denominator
    except Exception:
        return fallback

def _percentile_score(value, low, high):
    """Map a raw value linearly to 0–100 between low and high."""
    if value is None:
        return 50.0  # neutral when data is missing
    clipped = max(low, min(high, value))
    return ((clipped - low) / (high - low)) * 100.0

def get_codal_fundamental_score(symbol: str) -> dict:
    if not codal:
        return _neutral_codal_result("codal library not installed")

    try:
        income_reports = codal.income_statement(symbol, max_reports=4)
        balance_reports = codal.balance_sheet(symbol, max_reports=2)
    except Exception as exc:
        return _neutral_codal_result(f"codal fetch error: {exc}")

    if not income_reports or not balance_reports:
        return _neutral_codal_result("insufficient codal reports")

    latest_income = income_reports[0]
    prev_income = income_reports[1] if len(income_reports) > 1 else None
    latest_balance = balance_reports[0]

    # -- Extract fields
    revenue = getattr(latest_income, "operating_revenue", None) or getattr(latest_income, "revenue", None)
    net_profit = getattr(latest_income, "net_profit", None)
    total_equity = getattr(latest_balance, "total_equity", None) or getattr(latest_balance, "equity", None)
    total_debt = getattr(latest_balance, "total_liabilities", None) or getattr(latest_balance, "total_debt", None)
    current_assets = getattr(latest_balance, "current_assets", None)
    current_liabilities = getattr(latest_balance, "current_liabilities", None)

    # -- 1. Profitability
    net_margin = _safe_div(net_profit, revenue) * 100 if net_profit and revenue else None
    roe = _safe_div(net_profit, total_equity) * 100 if net_profit and total_equity else None
    profitability = (
        0.5 * _percentile_score(net_margin, 0, 30)
        + 0.5 * _percentile_score(roe, 0, 40)
    )

    # -- 2. Growth
    growth = 50.0
    if prev_income:
        prev_revenue = getattr(prev_income, "operating_revenue", None) or getattr(prev_income, "revenue", None)
        prev_profit = getattr(prev_income, "net_profit", None)
        rev_growth = _safe_div((revenue or 0) - (prev_revenue or 0), prev_revenue) * 100 if prev_revenue else None
        prof_growth = _safe_div((net_profit or 0) - (prev_profit or 0), prev_profit) * 100 if prev_profit else None
        growth = (
            0.5 * _percentile_score(rev_growth, -20, 50)
            + 0.5 * _percentile_score(prof_growth, -30, 80)
        )

    # -- 3. Activity (Monthly Sales)
    activity = 50.0
    try:
        monthly = codal.monthly_activity(symbol, max_reports=3)
        if monthly and len(monthly) >= 2:
            latest_sales = getattr(monthly[0], "sales_value", None) or getattr(monthly[0], "sales", None)
            prev_sales = getattr(monthly[1], "sales_value", None) or getattr(monthly[1], "sales", None)
            sales_growth = _safe_div((latest_sales or 0) - (prev_sales or 0), prev_sales) * 100 if prev_sales else None
            activity = _percentile_score(sales_growth, -30, 60)
    except Exception:
        pass

    # -- 4. Financial Health
    debt_to_equity = _safe_div(total_debt, total_equity) if total_debt and total_equity else None
    current_ratio = _safe_div(current_assets, current_liabilities) if current_assets and current_liabilities else None
    health = (
        0.5 * _percentile_score(-debt_to_equity if debt_to_equity is not None else None, -2.0, 0.0)
        + 0.5 * _percentile_score(current_ratio, 0.5, 3.0)
    )

    # -- Combine
    final_score = (
        CODAL_SUB_WEIGHTS["profitability"] * profitability
        + CODAL_SUB_WEIGHTS["growth"] * growth
        + CODAL_SUB_WEIGHTS["activity"] * activity
        + CODAL_SUB_WEIGHTS["health"] * health
    )

    return {
        "score": round(final_score, 2),
        "components": {
            "profitability": round(profitability, 2),
            "growth": round(growth, 2),
            "activity": round(activity, 2),
            "health": round(health, 2),
        },
        "raw": {
            "net_margin_pct": round(net_margin, 2) if net_margin is not None else None,
            "roe_pct": round(roe, 2) if roe is not None else None,
            "debt_to_equity": round(debt_to_equity, 3) if debt_to_equity is not None else None,
            "current_ratio": round(current_ratio, 2) if current_ratio is not None else None,
        },
    }

def _neutral_codal_result(reason: str) -> dict:
    return {
        "score": 50.0,
        "components": {"profitability": 50.0, "growth": 50.0, "activity": 50.0, "health": 50.0},
        "raw": {"note": reason},
    }

# ---------------------------------------------------------------------------
# Existing dimensions (REPLACE THESE WITH YOUR ACTUAL LOGIC)
# ---------------------------------------------------------------------------
def get_momentum_score(symbol: str) -> float:
    return 65.0 # Placeholder

def get_valuation_score(symbol: str) -> float:
    return 55.0 # Placeholder

def get_risk_score(symbol: str) -> float:
    return 70.0 # Placeholder

# ---------------------------------------------------------------------------
# Final composite score
# ---------------------------------------------------------------------------
def compute_final_score(symbol: str) -> dict:
    momentum = get_momentum_score(symbol)
    valuation = get_valuation_score(symbol)
    risk = get_risk_score(symbol)
    codal_result = get_codal_fundamental_score(symbol)

    final = (
        WEIGHTS["momentum"] * momentum
        + WEIGHTS["valuation"] * valuation
        + WEIGHTS["codal_fundamental"] * codal_result["score"]
        + WEIGHTS["risk"] * risk
    )

    return {
        "symbol": symbol,
        "timestamp": datetime.utcnow().isoformat(),
        "final_score": round(final, 2),
        "dimensions": {
            "momentum": round(momentum, 2),
            "valuation": round(valuation, 2),
            "codal_fundamental": codal_result["score"],
            "risk": round(risk, 2),
        },
        "codal_breakdown": codal_result["components"],
        "codal_raw": codal_result["raw"],
        "weights": WEIGHTS,
    }

def run_universe(symbols: list[str]) -> list[dict]:
    results = []
    for sym in symbols:
        print(f"Processing {sym}...")
        try:
            results.append(compute_final_score(sym))
        except Exception as exc:
            print(f"Error scoring {sym}: {exc}")
            results.append({"symbol": sym, "error": str(exc), "final_score": 0})
    results.sort(key=lambda r: r.get("final_score", 0), reverse=True)
    return results

if __name__ == "__main__":
    # Example universe — replace with your watchlist
    universe = ["فولاد", "خودرو", "شپدیس", "زاگرس", "اهرم"]
    
    print("Starting scoring process...")
    output = run_universe(universe)

    out_path = os.path.join(os.path.dirname(__file__), "scores.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Scored {len(output)} symbols → {out_path}")