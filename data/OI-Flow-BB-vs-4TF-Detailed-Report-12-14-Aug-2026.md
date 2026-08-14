# OI Flow × Bollinger Band — detailed strategy report

**Prepared for:** strategy review (NIFTY OI Flow Tracker)
**Dates:** 12 Aug, 13 Aug, 14 Aug 2026 (IST)
**Data:** minute JSON tapes (`oi-flow-YYYY-MM-DD.json`). 13 Aug tape ends 11:50.

## 1. What was tested

**Live OI rules (already in engine)**
- PUT BUY: Put buying ≥ 2.5L + red candle (spot down) + 15/5/3/1 all Bear → PE
- CALL BUY: Put writing ≥ 2.5L + green candle (spot up) + 15/5/3/1 all Bull → CE
- Skip Put ΔOI > 30L · window 09:30–14:30

**Proposed BB stack (this report)**
- Extra CE filter: NIFTY spot at **BB bottom** (lower band)
- Extra PE filter: NIFTY spot at **BB top** (upper band)
- BB = 20-period SMA ± 2σ, offset 0, on 1-minute spot
- “At band” = touch, outside, or within 5 index points

**No look-ahead.** At minute T the script only uses rows with minutes ≤ T for spot, candle, TFs, OI Δ, and BB.

## 2. Verdict

| Question | Answer | Times |
| --- | --- | --- |
| Did **4 Bull + BB bottom** ever occur? (needed for stacked CE) | **No** | 0 |
| Did **4 Bear + BB top** ever occur? (needed for stacked PE) | **No** | 0 |
| Did the **stacked BB rule** ever meet? | **No — 0 fills** | 0 |
| How many times was BB top or bottom **without** that rule? | **All BB hits** | 405 |

## 3. BB hits vs 4TF (all 3 days)

| BB zone | Times | 4 Bull | 4 Bear | Mixed TFs | Stacked rule |
| --- | --- | --- | --- | --- | --- |
| TOP (upper) | 184 | 103 | 0 | 81 | 4 Bear @ top = **0** |
| BOTTOM (lower) | 221 | 0 | 114 | 107 | 4 Bull @ bottom = **0** |
| **Total** | **405** | 103 | 114 | 188 | **0** |

**What actually lines up (opposite of the proposed stack):**
- 4 Bull at BB **TOP**: **103** times
- 4 Bear at BB **BOTTOM**: **114** times

On 1-minute BB(20), the upper band is a bull event and the lower band is a bear event. That fights “buy CE at the bottom / PE at the top” when 4TF must also agree.

## 4. 2026-08-12 summary (09:15–15:30)

Tape bars: 376 · BB-ready (20+ spots): 357 · Mid-band (not at line): 184 · At top or bottom: 173

| Zone | Times | 4 Bull | 4 Bear | Mixed | Stacked YES |
| --- | --- | --- | --- | --- | --- |
| TOP | 81 | 38 | 0 | 43 | 0 |
| BOTTOM | 92 | 0 | 50 | 42 | 0 |

### Minute log

| Time | Spot | BB | Lower | Mid | Upper | %B | 15M | 5M | 3M | 1M | TF pack | Candle | Call ΔOI | Put ΔOI | OI (no 4TF/BB) | Stacked 4TF+BB | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 09:46 | 24,418.4 | BOTTOM | 24,415.92 | 24,437.95 | 24,459.98 | 0.056 | Bear | Bear | Bear | Bear | 4Bear | red | -65.87L | +2.29L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 09:47 | 24,412.05 | BOTTOM | 24,411.81 | 24,436.39 | 24,460.97 | 0.005 | Bear | Bear | Bear | Bear | 4Bear | red | +2.51L | -4.15L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 09:48 | 24,405.8 | BOTTOM | 24,408.57 | 24,433.57 | 24,458.57 | -0.055 | Bear | Bear | Bear | Bear | 4Bear | red | +7.44L | -12.45L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 09:49 | 24,404.4 | BOTTOM | 24,405.71 | 24,430.81 | 24,455.91 | -0.026 | Bear | Bear | Bear | Bear | 4Bear | red | +8.57L | -9.59L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 09:50 | 24,402.55 | BOTTOM | 24,403.25 | 24,428.06 | 24,452.86 | -0.014 | Bear | Bear | Bear | Bear | 4Bear | red | 0.00L | 0.00L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 09:51 | 24,393.75 | BOTTOM | 24,397.48 | 24,425.71 | 24,453.94 | -0.066 | Bear | Bear | Bear | Bear | 4Bear | red | +7.60L | -7.67L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 09:58 | 24,391.45 | BOTTOM | 24,387.12 | 24,413.91 | 24,440.7 | 0.081 | Bear | Bear | Bear | Bear | 4Bear | red | +1.51L | -1.36L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 09:59 | 24,382.2 | BOTTOM | 24,382.18 | 24,411.76 | 24,441.35 | 0 | Bear | Bear | Bear | Bear | 4Bear | red | +0.41L | -1.36L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:00 | 24,377.9 | BOTTOM | 24,377.15 | 24,409.31 | 24,441.47 | 0.012 | Bear | Bear | Bear | Bear | 4Bear | red | +5.08L | -12.70L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:01 | 24,374.4 | BOTTOM | 24,372.9 | 24,406.31 | 24,439.71 | 0.022 | Bear | Bear | Bear | Bear | 4Bear | red | -27.10L | +32.90L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:02 | 24,373.8 | BOTTOM | 24,369.58 | 24,403.3 | 24,437.01 | 0.063 | Bear | Bear | Bear | Bear | 4Bear | red | +5.20L | -5.31L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:04 | 24,365.25 | BOTTOM | 24,363.4 | 24,397 | 24,430.6 | 0.027 | Bear | Bear | Bear | Bear | 4Bear | red | +4.11L | -2.97L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:05 | 24,364.8 | BOTTOM | 24,360.65 | 24,393.83 | 24,427.01 | 0.063 | Bear | Bear | Bear | Flat | Mixed | red | +4.02L | -3.84L | WAIT | NO | BB hit, TFs mixed |
| 10:19 | 24,377.15 | TOP | 24,356.92 | 24,367.42 | 24,377.93 | 0.963 | Bull | Bull | Bull | Bull | 4Bull | green | +39.04L | -33.85L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:20 | 24,373.15 | TOP | 24,357.45 | 24,367.19 | 24,376.92 | 0.806 | Bull | Bull | Bull | Bear | Mixed | red | -36.24L | +33.07L | WAIT | NO | BB hit, TFs mixed |
| 10:21 | 24,374.7 | TOP | 24,357.42 | 24,367.2 | 24,376.98 | 0.884 | Bull | Bull | Bull | Bull | 4Bull | green | +0.95L | +3.71L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 10:22 | 24,377.65 | TOP | 24,356.97 | 24,367.39 | 24,377.81 | 0.992 | Bull | Bull | Flat | Bull | Mixed | green | +39.12L | -32.13L | WAIT | NO | BB hit, TFs mixed |
| 10:23 | 24,375.7 | TOP | 24,356.74 | 24,367.55 | 24,378.35 | 0.877 | Bull | Bull | Bull | Bear | Mixed | red | +1.87L | +3.92L | PUT BUY | NO | BB hit, TFs mixed |
| 10:24 | 24,376.5 | TOP | 24,356.69 | 24,368.11 | 24,379.53 | 0.867 | Bull | Bear | Bull | Bull | Mixed | green | +1.99L | +1.24L | WAIT | NO | BB hit, TFs mixed |
| 10:25 | 24,375.85 | TOP | 24,356.87 | 24,368.66 | 24,380.45 | 0.805 | Bull | Bull | Bear | Bear | Mixed | red | +0.78L | +1.11L | WAIT | NO | BB hit, TFs mixed |
| 10:26 | 24,380.2 | TOP | 24,356.8 | 24,369.44 | 24,382.09 | 0.925 | Bull | Bull | Bull | Bull | 4Bull | green | +0.63L | +2.48L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:27 | 24,379.65 | TOP | 24,356.91 | 24,370.16 | 24,383.4 | 0.858 | Bull | Bull | Bull | Bear | Mixed | red | +0.74L | +1.23L | WAIT | NO | BB hit, TFs mixed |
| 10:32 | 24,382 | TOP | 24,361.94 | 24,373.26 | 24,384.57 | 0.886 | Bull | Bull | Bull | Bull | 4Bull | green | +1.03L | +1.14L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:33 | 24,389.75 | TOP | 24,361.52 | 24,374.44 | 24,387.35 | 1.093 | Bull | Bull | Bull | Bull | 4Bull | green | -1.77L | +1.17L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:34 | 24,398.55 | TOP | 24,359.92 | 24,376.04 | 24,392.17 | 1.198 | Bull | Bull | Bull | Bull | 4Bull | green | -6.12L | -3.47L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:35 | 24,395.3 | TOP | 24,360.18 | 24,377.55 | 24,394.91 | 1.011 | Bull | Bull | Bull | Bear | Mixed | red | -9.55L | -0.67L | WAIT | NO | BB hit, TFs mixed |
| 10:36 | 24,394.9 | TOP | 24,362.1 | 24,379.25 | 24,396.4 | 0.956 | Bull | Bull | Bull | Flat | Mixed | red | -3.16L | +1.56L | WAIT | NO | BB hit, TFs mixed |
| 10:46 | 24,368.55 | BOTTOM | 24,366.59 | 24,382.6 | 24,398.61 | 0.061 | Bear | Bear | Bear | Bear | 4Bear | red | -39.53L | +32.82L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:47 | 24,368.6 | BOTTOM | 24,364.94 | 24,382.05 | 24,399.15 | 0.107 | Bear | Bear | Bear | Flat | Mixed | green | +1.44L | -1.52L | WAIT | NO | BB hit, TFs mixed |
| 10:48 | 24,359.9 | BOTTOM | 24,362.03 | 24,381.37 | 24,400.71 | -0.055 | Bear | Bear | Bear | Bear | 4Bear | red | +2.50L | -0.09L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:49 | 24,354.65 | BOTTOM | 24,357.73 | 24,380.26 | 24,402.8 | -0.068 | Bear | Bear | Bear | Bear | 4Bear | red | +0.82L | -6.16L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:50 | 24,358.75 | BOTTOM | 24,355.25 | 24,379.53 | 24,403.8 | 0.072 | Bear | Bear | Bear | Bull | Mixed | green | +3.63L | -3.11L | WAIT | NO | BB hit, TFs mixed |
| 10:57 | 24,348.2 | BOTTOM | 24,344.18 | 24,368.47 | 24,392.77 | 0.083 | Bear | Bear | Bear | Bear | 4Bear | red | +0.79L | +1.60L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:58 | 24,343.95 | BOTTOM | 24,341.76 | 24,366.16 | 24,390.56 | 0.045 | Bear | Bear | Bear | Bear | 4Bear | red | +1.12L | +1.17L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:59 | 24,327.3 | BOTTOM | 24,335.16 | 24,363.26 | 24,391.35 | -0.14 | Bear | Bear | Bear | Bear | 4Bear | red | +2.51L | -9.82L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:00 | 24,319.5 | BOTTOM | 24,327.91 | 24,359.93 | 24,391.96 | -0.131 | Bear | Bear | Bear | Bear | 4Bear | red | -121.90L | -53.92L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:01 | 24,314.05 | BOTTOM | 24,320.56 | 24,356.48 | 24,392.4 | -0.091 | Bear | Bear | Bear | Bear | 4Bear | red | +6.49L | +4.48L | PUT BUY | NO | Opposite: 4 Bear at BOTTOM |
| 11:02 | 24,309.8 | BOTTOM | 24,313.32 | 24,353.01 | 24,392.71 | -0.044 | Bear | Bear | Bear | Bear | 4Bear | red | +6.33L | +2.17L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:03 | 24,304 | BOTTOM | 24,305.94 | 24,349.34 | 24,392.75 | -0.022 | Bear | Bear | Bear | Bear | 4Bear | red | +7.31L | +0.30L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:04 | 24,298.55 | BOTTOM | 24,298.9 | 24,345.3 | 24,391.69 | -0.004 | Bear | Bear | Bear | Bear | 4Bear | red | +5.26L | +0.78L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:21 | 24,309.55 | TOP | 24,295.54 | 24,304.44 | 24,313.34 | 0.787 | Bull | Bull | Bull | Bull | 4Bull | green | +0.03L | +1.20L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:23 | 24,309.85 | TOP | 24,295.61 | 24,304.64 | 24,313.68 | 0.788 | Bull | Bull | Bull | Bull | 4Bull | green | -1.44L | +1.70L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:24 | 24,317.9 | TOP | 24,295.33 | 24,305.61 | 24,315.89 | 1.098 | Bull | Bull | Bull | Bull | 4Bull | green | -0.86L | -0.54L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:28 | 24,299.05 | BOTTOM | 24,296.43 | 24,305.99 | 24,315.55 | 0.137 | Bear | Bear | Bear | Bear | 4Bear | red | +1.53L | -0.31L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:29 | 24,300.75 | BOTTOM | 24,296.37 | 24,305.97 | 24,315.57 | 0.228 | Flat | Bear | Bear | Bull | Mixed | green | -0.70L | -0.11L | WAIT | NO | BB hit, TFs mixed |
| 11:30 | 24,296.6 | BOTTOM | 24,295.05 | 24,305.48 | 24,315.91 | 0.074 | Bear | Bear | Bear | Bear | 4Bear | red | +1.98L | +0.98L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:31 | 24,289.1 | BOTTOM | 24,292.1 | 24,304.36 | 24,316.63 | -0.122 | Bear | Bear | Bear | Bear | 4Bear | red | -0.10L | -1.87L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:32 | 24,292.2 | BOTTOM | 24,290.74 | 24,303.28 | 24,315.82 | 0.058 | Bear | Bear | Bear | Bull | Mixed | green | +1.83L | +1.18L | WAIT | NO | BB hit, TFs mixed |
| 11:33 | 24,294.7 | BOTTOM | 24,290.03 | 24,303.03 | 24,316.04 | 0.18 | Bear | Bear | Bear | Bull | Mixed | green | +1.21L | -1.35L | WAIT | NO | BB hit, TFs mixed |
| 11:34 | 24,293.3 | BOTTOM | 24,288.98 | 24,302.65 | 24,316.31 | 0.158 | Bear | Bear | Bull | Bear | Mixed | red | +0.51L | -1.72L | WAIT | NO | BB hit, TFs mixed |
| 11:40 | 24,287.55 | BOTTOM | 24,283.88 | 24,299.52 | 24,315.16 | 0.117 | Bear | Bear | Bear | Bear | 4Bear | red | -0.28L | -3.86L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:41 | 24,279.95 | BOTTOM | 24,280.94 | 24,298.04 | 24,315.14 | -0.029 | Bear | Bear | Bear | Bear | 4Bear | red | +0.84L | -2.43L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:42 | 24,283.75 | BOTTOM | 24,279.29 | 24,296.83 | 24,314.36 | 0.127 | Bear | Bear | Bear | Bull | Mixed | green | +1.85L | +1.15L | WAIT | NO | BB hit, TFs mixed |
| 11:54 | 24,282.75 | BOTTOM | 24,279.47 | 24,290.04 | 24,300.61 | 0.155 | Bear | Bear | Bear | Bear | 4Bear | red | +0.55L | +0.12L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:55 | 24,283.4 | BOTTOM | 24,279.64 | 24,289.12 | 24,298.61 | 0.198 | Bear | Bear | Bear | Bull | Mixed | green | +0.86L | -0.13L | WAIT | NO | BB hit, TFs mixed |
| 11:56 | 24,280.65 | BOTTOM | 24,278.74 | 24,288.35 | 24,297.96 | 0.099 | Bull | Bear | Bear | Bear | Mixed | red | -0.30L | -1.86L | WAIT | NO | BB hit, TFs mixed |
| 11:58 | 24,282.75 | BOTTOM | 24,278.23 | 24,287.21 | 24,296.19 | 0.252 | Bear | Bear | Bear | Bear | 4Bear | red | +2.29L | +0.18L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:59 | 24,277.7 | BOTTOM | 24,276.83 | 24,286.57 | 24,296.31 | 0.045 | Bear | Bear | Bear | Bear | 4Bear | red | +2.10L | -0.04L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:00 | 24,279.15 | BOTTOM | 24,275.9 | 24,286.15 | 24,296.4 | 0.159 | Bear | Bear | Bear | Bull | Mixed | green | +0.77L | +0.06L | WAIT | NO | BB hit, TFs mixed |
| 12:01 | 24,279.5 | BOTTOM | 24,275.82 | 24,286.13 | 24,296.43 | 0.178 | Bear | Bear | Bear | Flat | Mixed | green | +1.11L | +0.03L | WAIT | NO | BB hit, TFs mixed |
| 12:02 | 24,279.1 | BOTTOM | 24,275.18 | 24,285.9 | 24,296.61 | 0.183 | Bear | Bear | Bull | Flat | Mixed | red | +0.63L | +0.80L | WAIT | NO | BB hit, TFs mixed |
| 12:03 | 24,277.85 | BOTTOM | 24,274.31 | 24,285.57 | 24,296.83 | 0.157 | Bear | Bear | Bear | Bear | 4Bear | red | +2.14L | -1.10L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:04 | 24,278.3 | BOTTOM | 24,273.52 | 24,285.22 | 24,296.92 | 0.204 | Bear | Bull | Bear | Flat | Mixed | green | -0.53L | +0.57L | WAIT | NO | BB hit, TFs mixed |
| 12:05 | 24,272.3 | BOTTOM | 24,271.9 | 24,284.13 | 24,296.36 | 0.016 | Bear | Bear | Bear | Bear | 4Bear | red | -59.41L | +9.43L | PUT BUY | NO | Opposite: 4 Bear at BOTTOM |
| 12:08 | 24,275.55 | BOTTOM | 24,271.58 | 24,281.83 | 24,292.09 | 0.194 | Bear | Bear | Bull | Bear | Mixed | red | -1.11L | +0.13L | WAIT | NO | BB hit, TFs mixed |
| 12:09 | 24,276.2 | BOTTOM | 24,271.71 | 24,281.03 | 24,290.34 | 0.241 | Bear | Bear | Bear | Bull | Mixed | green | +1.16L | +0.88L | WAIT | NO | BB hit, TFs mixed |
| 12:10 | 24,273.3 | BOTTOM | 24,271.45 | 24,280.14 | 24,288.83 | 0.106 | Bear | Bull | Bear | Bear | Mixed | red | -58.76L | +9.14L | PUT BUY | NO | BB hit, TFs mixed |
| 12:11 | 24,271.45 | BOTTOM | 24,270.6 | 24,279.32 | 24,288.04 | 0.049 | Bear | Bear | Bear | Bear | 4Bear | red | +1.52L | +0.43L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:12 | 24,274.75 | BOTTOM | 24,270.53 | 24,278.71 | 24,286.89 | 0.258 | Bear | Bear | Bear | Bull | Mixed | green | +1.93L | -0.44L | WAIT | NO | BB hit, TFs mixed |
| 12:13 | 24,273.6 | BOTTOM | 24,270.76 | 24,277.98 | 24,285.2 | 0.197 | Bear | Bear | Flat | Bear | Mixed | red | +1.35L | -0.52L | WAIT | NO | BB hit, TFs mixed |
| 12:14 | 24,269.75 | BOTTOM | 24,269.62 | 24,277.33 | 24,285.04 | 0.009 | Bear | Bear | Bear | Bear | 4Bear | red | +0.80L | -1.85L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:15 | 24,267.9 | BOTTOM | 24,268.34 | 24,276.56 | 24,284.77 | -0.027 | Bear | Bear | Bear | Bear | 4Bear | red | -1.07L | -2.19L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:18 | 24,277.35 | TOP | 24,269.03 | 24,275.6 | 24,282.16 | 0.633 | Flat | Bull | Bull | Bull | Mixed | green | +0.45L | +1.00L | WAIT | NO | BB hit, TFs mixed |
| 12:19 | 24,279.95 | TOP | 24,268.93 | 24,275.71 | 24,282.49 | 0.813 | Bull | Bull | Bull | Bull | 4Bull | green | +1.54L | +0.21L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:20 | 24,277.35 | TOP | 24,268.98 | 24,275.62 | 24,282.26 | 0.63 | Bull | Bull | Bull | Bear | Mixed | red | +0.28L | +1.57L | WAIT | NO | BB hit, TFs mixed |
| 12:22 | 24,277.15 | TOP | 24,269.11 | 24,275.34 | 24,281.58 | 0.645 | Bear | Bull | Bear | Bull | Mixed | green | -0.17L | +0.09L | WAIT | NO | BB hit, TFs mixed |
| 12:24 | 24,273.8 | BOTTOM | 24,268.94 | 24,274.93 | 24,280.93 | 0.406 | Bear | Bear | Bear | Flat | Mixed | red | +1.79L | -1.14L | WAIT | NO | BB hit, TFs mixed |
| 12:26 | 24,275.8 | TOP | 24,269.22 | 24,274.98 | 24,280.75 | 0.571 | Bull | Flat | Bull | Bull | Mixed | green | -0.03L | +1.33L | WAIT | NO | BB hit, TFs mixed |
| 12:27 | 24,278.65 | TOP | 24,269.33 | 24,274.93 | 24,280.53 | 0.832 | Bull | Bull | Bull | Bull | 4Bull | green | -0.05L | +0.50L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:28 | 24,276.45 | TOP | 24,269.34 | 24,274.97 | 24,280.61 | 0.631 | Bull | Bull | Bull | Bear | Mixed | red | -0.34L | +0.26L | WAIT | NO | BB hit, TFs mixed |
| 12:29 | 24,279.2 | TOP | 24,269.21 | 24,275.12 | 24,281.03 | 0.845 | Bull | Bull | Bull | Bull | 4Bull | green | +0.19L | +1.21L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:30 | 24,281.4 | TOP | 24,269.09 | 24,275.53 | 24,281.97 | 0.956 | Bull | Bull | Bull | Bull | 4Bull | green | +0.43L | +0.40L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:31 | 24,279.6 | TOP | 24,269.55 | 24,275.94 | 24,282.32 | 0.787 | Bull | Bull | Bull | Bear | Mixed | red | +0.97L | -0.29L | WAIT | NO | BB hit, TFs mixed |
| 12:32 | 24,280.75 | TOP | 24,269.54 | 24,276.24 | 24,282.93 | 0.837 | Bull | Bull | Bull | Bull | 4Bull | green | +1.61L | -0.46L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:33 | 24,281.45 | TOP | 24,269.68 | 24,276.63 | 24,283.57 | 0.847 | Bull | Bull | Flat | Bull | Mixed | green | +1.02L | +0.35L | WAIT | NO | BB hit, TFs mixed |
| 12:34 | 24,288.45 | TOP | 24,269.61 | 24,277.56 | 24,285.51 | 1.185 | Bull | Bull | Bull | Bull | 4Bull | green | -1.93L | -0.74L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:35 | 24,289.05 | TOP | 24,270.47 | 24,278.62 | 24,286.77 | 1.14 | Bull | Bull | Bull | Bull | 4Bull | green | -3.18L | -0.97L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:36 | 24,287.75 | TOP | 24,270.47 | 24,279.29 | 24,288.11 | 0.98 | Bull | Bull | Bull | Bear | Mixed | red | -0.56L | +0.71L | WAIT | NO | BB hit, TFs mixed |
| 12:37 | 24,286.5 | TOP | 24,270.55 | 24,279.79 | 24,289.04 | 0.863 | Bull | Bull | Bear | Bear | Mixed | red | -0.75L | +1.61L | WAIT | NO | BB hit, TFs mixed |
| 12:38 | 24,285.4 | TOP | 24,270.71 | 24,280.19 | 24,289.68 | 0.774 | Bull | Bull | Bear | Bear | Mixed | red | +0.32L | +0.23L | WAIT | NO | BB hit, TFs mixed |
| 12:39 | 24,286.95 | TOP | 24,270.62 | 24,280.55 | 24,290.47 | 0.823 | Bull | Bear | Bear | Bull | Mixed | green | +0.10L | +1.10L | WAIT | NO | BB hit, TFs mixed |
| 12:40 | 24,289.8 | TOP | 24,270.58 | 24,281.17 | 24,291.75 | 0.908 | Bull | Bull | Bull | Bull | 4Bull | green | +0.79L | +0.89L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:41 | 24,290.8 | TOP | 24,270.83 | 24,281.91 | 24,293 | 0.901 | Bull | Bull | Bull | Bull | 4Bull | green | +0.53L | -0.90L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:42 | 24,298.5 | TOP | 24,269.99 | 24,282.98 | 24,295.97 | 1.097 | Bull | Bull | Bull | Bull | 4Bull | green | +2.11L | -1.74L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:47 | 24,276.45 | BOTTOM | 24,274.39 | 24,285.02 | 24,295.64 | 0.097 | Bear | Bear | Bear | Bear | 4Bear | red | +0.23L | -0.48L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:55 | 24,276.55 | BOTTOM | 24,276.34 | 24,285.73 | 24,295.11 | 0.011 | Bear | Bear | Bear | Bear | 4Bear | red | +0.69L | -0.79L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:56 | 24,272.35 | BOTTOM | 24,273.97 | 24,284.96 | 24,295.94 | -0.074 | Bear | Bear | Bear | Bear | 4Bear | red | -60.33L | +10.38L | PUT BUY | NO | Opposite: 4 Bear at BOTTOM |
| 12:57 | 24,272.45 | BOTTOM | 24,272.03 | 24,284.26 | 24,296.48 | 0.017 | Bear | Bear | Bear | Flat | Mixed | green | +1.30L | -0.07L | WAIT | NO | BB hit, TFs mixed |
| 12:58 | 24,271.5 | BOTTOM | 24,270.15 | 24,283.56 | 24,296.97 | 0.05 | Bear | Bear | Bear | Bear | 4Bear | red | +1.34L | -0.29L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:59 | 24,273.4 | BOTTOM | 24,268.87 | 24,282.88 | 24,296.89 | 0.162 | Bear | Bear | Bull | Bull | Mixed | green | +0.12L | -0.96L | WAIT | NO | BB hit, TFs mixed |
| 13:14 | 24,283 | TOP | 24,271.33 | 24,279.02 | 24,286.7 | 0.759 | Bull | Bull | Bull | Bull | 4Bull | green | +0.02L | +0.86L | WAIT | NO | Opposite: 4 Bull at TOP |
| 13:15 | 24,287.75 | TOP | 24,271.1 | 24,279.58 | 24,288.05 | 0.982 | Bull | Bull | Bull | Bull | 4Bull | green | -0.73L | -0.47L | WAIT | NO | Opposite: 4 Bull at TOP |
| 13:16 | 24,286.9 | TOP | 24,271.94 | 24,280.31 | 24,288.67 | 0.894 | Bull | Bull | Bull | Bear | Mixed | red | +0.46L | +0.62L | WAIT | NO | BB hit, TFs mixed |
| 13:17 | 24,293.7 | TOP | 24,271.93 | 24,281.37 | 24,290.8 | 1.153 | Bull | Bull | Bull | Bull | 4Bull | green | -2.57L | -0.23L | WAIT | NO | Opposite: 4 Bull at TOP |
| 13:18 | 24,293.1 | TOP | 24,272.83 | 24,282.45 | 24,292.06 | 1.054 | Bull | Bull | Bull | Bear | Mixed | red | -0.25L | -0.15L | WAIT | NO | BB hit, TFs mixed |
| 13:19 | 24,298.55 | TOP | 24,272.68 | 24,283.71 | 24,294.73 | 1.173 | Bull | Bull | Bull | Bull | 4Bull | green | -2.50L | -0.32L | WAIT | NO | Opposite: 4 Bull at TOP |
| 13:20 | 24,296.7 | TOP | 24,272.84 | 24,284.71 | 24,296.59 | 1.005 | Bull | Bull | Bull | Bear | Mixed | red | -0.34L | +0.50L | WAIT | NO | BB hit, TFs mixed |
| 13:21 | 24,295.55 | TOP | 24,273.3 | 24,285.6 | 24,297.91 | 0.904 | Bull | Bull | Bull | Bear | Mixed | red | -3.84L | +2.18L | WAIT | NO | BB hit, TFs mixed |
| 13:25 | 24,296.65 | TOP | 24,274.33 | 24,287.95 | 24,301.57 | 0.819 | Bull | Flat | Bull | Bull | Mixed | green | -0.05L | +0.37L | WAIT | NO | BB hit, TFs mixed |
| 13:31 | 24,297.95 | TOP | 24,281.22 | 24,291.72 | 24,302.21 | 0.797 | Bull | Bull | Bull | Bull | 4Bull | green | -0.58L | -0.27L | WAIT | NO | Opposite: 4 Bull at TOP |
| 13:35 | 24,294.8 | TOP | 24,288.27 | 24,293.9 | 24,299.54 | 0.58 | Bear | Flat | Flat | Bull | Mixed | green | -1.27L | +1.07L | WAIT | NO | BB hit, TFs mixed |
| 13:36 | 24,297 | TOP | 24,289.63 | 24,294.41 | 24,299.19 | 0.771 | Bull | Bear | Bull | Bull | Mixed | green | -1.58L | +0.89L | WAIT | NO | BB hit, TFs mixed |
| 13:37 | 24,299.4 | TOP | 24,289.46 | 24,294.69 | 24,299.93 | 0.949 | Bull | Bull | Bull | Bull | 4Bull | green | -1.48L | -2.19L | WAIT | NO | Opposite: 4 Bull at TOP |
| 13:38 | 24,295.2 | TOP | 24,289.61 | 24,294.8 | 24,299.99 | 0.539 | Bull | Bull | Flat | Bear | Mixed | red | +0.67L | -0.84L | WAIT | NO | BB hit, TFs mixed |
| 13:39 | 24,289.4 | BOTTOM | 24,288.95 | 24,294.34 | 24,299.73 | 0.042 | Bear | Bear | Bear | Bear | 4Bear | red | -1.73L | -0.47L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:40 | 24,293 | BOTTOM | 24,288.84 | 24,294.15 | 24,299.47 | 0.391 | Bear | Bear | Bear | Bull | Mixed | green | -1.49L | -0.25L | WAIT | NO | BB hit, TFs mixed |
| 13:41 | 24,295.3 | TOP | 24,288.84 | 24,294.14 | 24,299.44 | 0.609 | Flat | Bear | Flat | Bull | Mixed | green | +1.18L | +0.03L | WAIT | NO | BB hit, TFs mixed |
| 13:42 | 24,289.2 | BOTTOM | 24,288.31 | 24,293.99 | 24,299.66 | 0.079 | Bear | Bear | Flat | Bear | Mixed | red | +0.59L | -0.56L | WAIT | NO | BB hit, TFs mixed |
| 13:43 | 24,289.25 | BOTTOM | 24,287.69 | 24,293.72 | 24,299.75 | 0.13 | Bull | Bear | Bear | Flat | Mixed | green | +0.48L | +0.15L | WAIT | NO | BB hit, TFs mixed |
| 13:44 | 24,289.85 | BOTTOM | 24,287.25 | 24,293.5 | 24,299.76 | 0.208 | Bear | Flat | Bear | Bull | Mixed | green | +1.82L | -0.51L | WAIT | NO | BB hit, TFs mixed |
| 13:45 | 24,289.15 | BOTTOM | 24,286.77 | 24,293.13 | 24,299.48 | 0.187 | Bear | Bear | Flat | Bear | Mixed | red | +1.07L | -0.48L | WAIT | NO | BB hit, TFs mixed |
| 13:46 | 24,286.85 | BOTTOM | 24,285.9 | 24,292.68 | 24,299.46 | 0.07 | Bear | Bear | Bear | Bear | 4Bear | red | +1.69L | -0.10L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:47 | 24,287.75 | BOTTOM | 24,285.35 | 24,292.46 | 24,299.58 | 0.169 | Bear | Bear | Bear | Bull | Mixed | green | +1.01L | -0.24L | WAIT | NO | BB hit, TFs mixed |
| 13:48 | 24,286.5 | BOTTOM | 24,285.02 | 24,292.38 | 24,299.73 | 0.101 | Bear | Bear | Bear | Bear | 4Bear | red | +1.31L | -0.77L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:49 | 24,285.35 | BOTTOM | 24,284.14 | 24,292.1 | 24,300.05 | 0.076 | Bear | Bear | Bear | Bear | 4Bear | red | +0.31L | +0.03L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:51 | 24,288.25 | BOTTOM | 24,283.88 | 24,291.43 | 24,298.99 | 0.289 | Bear | Bull | Bull | Bear | Mixed | red | +0.21L | -0.69L | WAIT | NO | BB hit, TFs mixed |
| 13:52 | 24,287.7 | BOTTOM | 24,283.52 | 24,291.08 | 24,298.64 | 0.276 | Bear | Flat | Bull | Bear | Mixed | red | +0.04L | +0.46L | WAIT | NO | BB hit, TFs mixed |
| 13:55 | 24,287.05 | BOTTOM | 24,282.78 | 24,290.19 | 24,297.6 | 0.288 | Bear | Bear | Bear | Bear | 4Bear | red | +0.48L | -0.10L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:57 | 24,285.65 | BOTTOM | 24,283.77 | 24,289.09 | 24,294.41 | 0.177 | Bear | Bear | Bear | Bear | 4Bear | red | +0.78L | +0.07L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:58 | 24,281.45 | BOTTOM | 24,282.87 | 24,288.4 | 24,293.93 | -0.128 | Bear | Bear | Bear | Bear | 4Bear | red | +1.15L | -1.55L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:59 | 24,282.95 | BOTTOM | 24,282.08 | 24,288.08 | 24,294.07 | 0.072 | Bear | Bear | Bear | Bull | Mixed | green | -1.07L | -1.81L | WAIT | NO | BB hit, TFs mixed |
| 14:00 | 24,285.6 | BOTTOM | 24,282.07 | 24,287.71 | 24,293.35 | 0.313 | Bear | Bear | Flat | Bull | Mixed | green | +1.22L | -0.27L | WAIT | NO | BB hit, TFs mixed |
| 14:01 | 24,285.05 | BOTTOM | 24,282.65 | 24,287.19 | 24,291.74 | 0.264 | Bear | Bear | Bull | Bear | Mixed | red | -0.22L | -0.94L | WAIT | NO | BB hit, TFs mixed |
| 14:02 | 24,283.3 | BOTTOM | 24,282.16 | 24,286.9 | 24,291.64 | 0.121 | Bear | Bear | Flat | Bear | Mixed | red | +0.82L | +1.08L | WAIT | NO | BB hit, TFs mixed |
| 14:03 | 24,281.65 | BOTTOM | 24,281.39 | 24,286.52 | 24,291.65 | 0.025 | Bear | Flat | Bear | Bear | Mixed | red | +0.70L | +1.60L | WAIT | NO | BB hit, TFs mixed |
| 14:04 | 24,283.55 | BOTTOM | 24,281.16 | 24,286.21 | 24,291.25 | 0.237 | Bear | Bull | Bear | Bull | Mixed | green | +0.37L | -0.95L | WAIT | NO | BB hit, TFs mixed |
| 14:05 | 24,278.5 | BOTTOM | 24,279.8 | 24,285.67 | 24,291.54 | -0.111 | Bear | Bear | Bear | Bear | 4Bear | red | +0.30L | -0.25L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:06 | 24,279.8 | BOTTOM | 24,278.95 | 24,285.32 | 24,291.69 | 0.067 | Bear | Bear | Bear | Bull | Mixed | green | -1.35L | -2.59L | WAIT | NO | BB hit, TFs mixed |
| 14:07 | 24,282.4 | BOTTOM | 24,278.66 | 24,285.05 | 24,291.44 | 0.292 | Bear | Bear | Bear | Bull | Mixed | green | +0.11L | +0.76L | WAIT | NO | BB hit, TFs mixed |
| 14:08 | 24,283.15 | BOTTOM | 24,278.48 | 24,284.89 | 24,291.29 | 0.365 | Bear | Bull | Bull | Bull | Mixed | green | +0.64L | +0.27L | WAIT | NO | BB hit, TFs mixed |
| 14:09 | 24,282.3 | BOTTOM | 24,278.23 | 24,284.73 | 24,291.23 | 0.313 | Bear | Bear | Bull | Bear | Mixed | red | -0.40L | +1.49L | WAIT | NO | BB hit, TFs mixed |
| 14:10 | 24,285.5 | TOP | 24,278.56 | 24,284.47 | 24,290.39 | 0.587 | Bear | Bull | Bull | Bull | Mixed | green | +1.14L | -0.02L | WAIT | NO | BB hit, TFs mixed |
| 14:12 | 24,280.45 | BOTTOM | 24,278.22 | 24,283.88 | 24,289.54 | 0.197 | Bear | Bear | Bear | Bear | 4Bear | red | +0.49L | +0.30L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:13 | 24,280.55 | BOTTOM | 24,278.08 | 24,283.48 | 24,288.88 | 0.229 | Bear | Bear | Bear | Flat | Mixed | green | +2.18L | -2.87L | WAIT | NO | BB hit, TFs mixed |
| 14:14 | 24,278.45 | BOTTOM | 24,277.64 | 24,282.99 | 24,288.33 | 0.076 | Bear | Bear | Bear | Bear | 4Bear | red | +0.33L | +0.38L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:15 | 24,279.35 | BOTTOM | 24,277.38 | 24,282.6 | 24,287.82 | 0.189 | Bear | Bear | Bear | Bull | Mixed | green | +0.64L | -0.43L | WAIT | NO | BB hit, TFs mixed |
| 14:16 | 24,283.35 | TOP | 24,277.9 | 24,282.33 | 24,286.77 | 0.615 | Bear | Flat | Bull | Bull | Mixed | green | -0.18L | +0.02L | WAIT | NO | BB hit, TFs mixed |
| 14:17 | 24,289.45 | TOP | 24,277.28 | 24,282.52 | 24,287.76 | 1.161 | Bull | Bull | Bull | Bull | 4Bull | green | -0.81L | -0.75L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:18 | 24,289.65 | TOP | 24,276.87 | 24,282.93 | 24,288.99 | 1.054 | Bull | Bull | Bull | Flat | Mixed | green | -1.50L | -1.23L | WAIT | NO | BB hit, TFs mixed |
| 14:19 | 24,287.2 | TOP | 24,276.81 | 24,283.15 | 24,289.48 | 0.82 | Bull | Bull | Bull | Bear | Mixed | red | -0.70L | +0.36L | WAIT | NO | BB hit, TFs mixed |
| 14:20 | 24,289.7 | TOP | 24,276.47 | 24,283.35 | 24,290.23 | 0.961 | Bull | Bull | Flat | Bull | Mixed | green | -0.70L | +1.34L | WAIT | NO | BB hit, TFs mixed |
| 14:21 | 24,288.1 | TOP | 24,276.34 | 24,283.5 | 24,290.66 | 0.821 | Bull | Bull | Bear | Bear | Mixed | red | -1.82L | +0.39L | WAIT | NO | BB hit, TFs mixed |
| 14:22 | 24,290.55 | TOP | 24,276.08 | 24,283.86 | 24,291.65 | 0.929 | Bull | Bull | Bull | Bull | 4Bull | green | -0.77L | +0.92L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:23 | 24,291.8 | TOP | 24,275.93 | 24,284.37 | 24,292.81 | 0.94 | Bull | Bull | Bull | Bull | 4Bull | green | -0.71L | -0.26L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:24 | 24,294.35 | TOP | 24,275.43 | 24,284.91 | 24,294.39 | 0.998 | Bull | Bull | Bull | Bull | 4Bull | green | -3.38L | -0.07L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:25 | 24,292.05 | TOP | 24,276.11 | 24,285.59 | 24,295.07 | 0.841 | Bull | Bull | Bull | Bear | Mixed | red | -2.01L | +1.21L | WAIT | NO | BB hit, TFs mixed |
| 14:26 | 24,294.4 | TOP | 24,276.49 | 24,286.32 | 24,296.15 | 0.911 | Bull | Bull | Bull | Bull | 4Bull | green | -1.75L | +0.49L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:27 | 24,297.85 | TOP | 24,276.24 | 24,287.09 | 24,297.94 | 0.996 | Bull | Bull | Bull | Bull | 4Bull | green | -2.82L | +0.82L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:28 | 24,297.95 | TOP | 24,276.17 | 24,287.83 | 24,299.5 | 0.934 | Bull | Bull | Bull | Flat | Mixed | green | -2.84L | -0.02L | WAIT | NO | BB hit, TFs mixed |
| 14:29 | 24,295.8 | TOP | 24,276.64 | 24,288.51 | 24,300.37 | 0.807 | Bull | Bull | Bull | Bear | Mixed | red | -1.22L | +0.49L | WAIT | NO | BB hit, TFs mixed |
| 14:30 | 24,297.8 | TOP | 24,276.68 | 24,289.12 | 24,301.56 | 0.849 | Bull | Bull | Flat | Bull | Mixed | green | -1.00L | +0.51L | WAIT | NO | BB hit, TFs mixed |
| 14:31 | 24,307.25 | TOP | 24,275.85 | 24,290.3 | 24,304.76 | 1.086 | Bull | Bull | Bull | Bull | 4Bull | green | -3.47L | -0.95L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:32 | 24,303.55 | TOP | 24,276.65 | 24,291.46 | 24,306.27 | 0.908 | Bull | Bull | Bull | Bear | Mixed | red | -6.98L | -6.04L | WAIT | NO | BB hit, TFs mixed |
| 14:33 | 24,327 | TOP | 24,273.13 | 24,293.78 | 24,314.43 | 1.304 | Bull | Bull | Bull | Bull | 4Bull | green | +127.36L | +21.53L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:34 | 24,329.5 | TOP | 24,271.66 | 24,296.33 | 24,321 | 1.172 | Bull | Bull | Bull | Bull | 4Bull | green | -16.37L | -4.67L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:35 | 24,322.8 | TOP | 24,272.58 | 24,298.5 | 24,324.43 | 0.969 | Bull | Bull | Bull | Bear | Mixed | red | -142.60L | -19.75L | WAIT | NO | BB hit, TFs mixed |
| 14:53 | 24,332 | TOP | 24,313.88 | 24,323.57 | 24,333.26 | 0.935 | Bull | Bull | Bull | Bull | 4Bull | green | +126.73L | +22.04L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:54 | 24,344.4 | TOP | 24,311.22 | 24,324.31 | 24,337.41 | 1.267 | Bull | Bull | Bull | Bull | 4Bull | green | -10.88L | -2.09L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:55 | 24,373 | TOP | 24,301.93 | 24,326.83 | 24,351.72 | 1.427 | Bull | Bull | Bull | Bull | 4Bull | green | -17.96L | -3.99L | WAIT | NO | Opposite: 4 Bull at TOP |
| 14:56 | 24,366.4 | TOP | 24,299.12 | 24,329.15 | 24,359.18 | 1.12 | Bull | Bull | Bull | Bear | Mixed | red | -40.00L | -5.18L | WAIT | NO | BB hit, TFs mixed |
| 14:58 | 24,364.45 | TOP | 24,299.52 | 24,333.47 | 24,367.42 | 0.956 | Bull | Bull | Bear | Bull | Mixed | green | -1.66L | +0.58L | WAIT | NO | BB hit, TFs mixed |
| 15:29 | 24,435.95 | TOP | 24,333.21 | 24,365.88 | 24,398.56 | 1.572 | Bull | Bull | Bull | Bull | 4Bull | green | +91.59L | -51.31L | WAIT | NO | Opposite: 4 Bull at TOP |
| 15:30 | 24,435.95 | TOP | 24,325.46 | 24,369.85 | 24,414.23 | 1.245 | Bull | Bull | Bull | Flat | Mixed | doji | -3.92L | -2.62L | WAIT | NO | BB hit, TFs mixed |

## 4. 2026-08-13 summary (09:15–11:50)

Tape bars: 156 · BB-ready (20+ spots): 137 · Mid-band (not at line): 75 · At top or bottom: 62

| Zone | Times | 4 Bull | 4 Bear | Mixed | Stacked YES |
| --- | --- | --- | --- | --- | --- |
| TOP | 36 | 21 | 0 | 15 | 0 |
| BOTTOM | 26 | 0 | 17 | 9 | 0 |

### Minute log

| Time | Spot | BB | Lower | Mid | Upper | %B | 15M | 5M | 3M | 1M | TF pack | Candle | Call ΔOI | Put ΔOI | OI (no 4TF/BB) | Stacked 4TF+BB | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 09:44 | 24,349.2 | TOP | 24,315.96 | 24,334.11 | 24,352.27 | 0.915 | Bull | Bull | Bull | Bull | 4Bull | green | +1.44L | +3.29L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 09:49 | 24,351.55 | TOP | 24,316.45 | 24,335.62 | 24,354.8 | 0.915 | Bull | Bull | Bull | Bull | 4Bull | green | -0.02L | +5.54L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 09:55 | 24,354.65 | TOP | 24,326.19 | 24,342.41 | 24,358.62 | 0.877 | Bull | Bull | Bull | Bull | 4Bull | green | +1.30L | +1.80L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:05 | 24,342.4 | BOTTOM | 24,339.24 | 24,347.99 | 24,356.74 | 0.18 | Bear | Bear | Bear | Bear | 4Bear | red | +1.36L | -0.20L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:07 | 24,353.3 | TOP | 24,340.65 | 24,348.87 | 24,357.09 | 0.769 | Bull | Bull | Bull | Bull | 4Bull | green | +1.53L | +3.39L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 10:08 | 24,345.4 | BOTTOM | 24,341.54 | 24,349.1 | 24,356.65 | 0.255 | Bull | Bear | Bull | Bear | Mixed | red | -0.01L | +1.28L | WAIT | NO | BB hit, TFs mixed |
| 10:09 | 24,343.85 | BOTTOM | 24,340.92 | 24,348.71 | 24,356.5 | 0.188 | Bear | Bear | Bear | Bear | 4Bear | red | +1.06L | -1.96L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:10 | 24,337.9 | BOTTOM | 24,339.03 | 24,348.12 | 24,357.2 | -0.062 | Bear | Bear | Bear | Bear | 4Bear | red | +0.69L | -0.19L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:11 | 24,336 | BOTTOM | 24,336.97 | 24,347.38 | 24,357.79 | -0.047 | Bear | Bear | Bear | Bear | 4Bear | red | +0.92L | +2.21L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:12 | 24,333 | BOTTOM | 24,334.47 | 24,346.57 | 24,358.67 | -0.061 | Bear | Bear | Bear | Bear | 4Bear | red | -1.25L | -3.08L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:18 | 24,332.95 | BOTTOM | 24,332.15 | 24,344 | 24,355.84 | 0.034 | Bear | Bear | Bear | Bear | 4Bear | red | +1.47L | +1.72L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:21 | 24,334.35 | BOTTOM | 24,330.65 | 24,342.18 | 24,353.71 | 0.16 | Bear | Bear | Bull | Bear | Mixed | red | +0.62L | +2.12L | WAIT | NO | BB hit, TFs mixed |
| 10:24 | 24,328.6 | BOTTOM | 24,328.13 | 24,340.19 | 24,352.24 | 0.02 | Bear | Bear | Bear | Bear | 4Bear | red | +2.95L | -4.13L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:25 | 24,329.05 | BOTTOM | 24,326.58 | 24,339.52 | 24,352.46 | 0.096 | Bear | Bear | Bear | Flat | Mixed | green | +1.76L | -2.64L | WAIT | NO | BB hit, TFs mixed |
| 10:26 | 24,327 | BOTTOM | 24,325.39 | 24,338.32 | 24,351.25 | 0.062 | Bear | Bear | Bear | Bear | 4Bear | red | +2.83L | -0.16L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:28 | 24,328.3 | BOTTOM | 24,325.12 | 24,336.37 | 24,347.63 | 0.141 | Bear | Bear | Bear | Bear | 4Bear | red | +1.46L | +0.02L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:29 | 24,326.9 | BOTTOM | 24,324.1 | 24,335.53 | 24,346.95 | 0.123 | Bear | Bear | Flat | Bear | Mixed | red | +1.66L | +0.59L | WAIT | NO | BB hit, TFs mixed |
| 10:30 | 24,318.85 | BOTTOM | 24,321.1 | 24,334.57 | 24,348.04 | -0.084 | Bear | Bear | Bear | Bear | 4Bear | red | -120.95L | -21.92L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:31 | 24,312.95 | BOTTOM | 24,317.01 | 24,333.42 | 24,349.83 | -0.124 | Bear | Bear | Bear | Bear | 4Bear | red | +1.26L | -8.94L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:32 | 24,314.95 | BOTTOM | 24,314.24 | 24,332.52 | 24,350.8 | 0.02 | Bear | Bear | Bear | Bull | Mixed | green | +3.44L | -5.38L | WAIT | NO | BB hit, TFs mixed |
| 10:43 | 24,330.8 | TOP | 24,314.76 | 24,324.65 | 24,334.54 | 0.811 | Bull | Bull | Bull | Bull | 4Bull | green | -0.99L | +0.95L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:44 | 24,330.3 | TOP | 24,314.68 | 24,324.73 | 24,334.78 | 0.777 | Bull | Bull | Bull | Flat | Mixed | red | -0.61L | -0.51L | WAIT | NO | BB hit, TFs mixed |
| 10:45 | 24,330.15 | TOP | 24,314.63 | 24,324.79 | 24,334.94 | 0.764 | Bull | Bull | Bull | Flat | Mixed | red | +0.20L | +0.66L | WAIT | NO | BB hit, TFs mixed |
| 10:46 | 24,330.6 | TOP | 24,314.54 | 24,324.97 | 24,335.4 | 0.77 | Bull | Bull | Flat | Flat | Mixed | green | +0.95L | -0.81L | WAIT | NO | BB hit, TFs mixed |
| 10:47 | 24,332.2 | TOP | 24,314.47 | 24,325.01 | 24,335.54 | 0.841 | Bull | Bull | Bull | Bull | 4Bull | green | +0.46L | +2.01L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:48 | 24,332.35 | TOP | 24,314.28 | 24,325.21 | 24,336.14 | 0.827 | Bull | Bull | Bull | Flat | Mixed | green | -1.41L | -1.19L | WAIT | NO | BB hit, TFs mixed |
| 10:49 | 24,338.4 | TOP | 24,313.44 | 24,325.79 | 24,338.13 | 1.011 | Bull | Bull | Bull | Bull | 4Bull | green | -0.17L | -0.24L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:50 | 24,338.4 | TOP | 24,313.7 | 24,326.76 | 24,339.83 | 0.945 | Bull | Bull | Bull | Flat | Mixed | doji | 0.00L | 0.00L | WAIT | NO | BB hit, TFs mixed |
| 10:51 | 24,338.4 | TOP | 24,315.66 | 24,328.03 | 24,340.41 | 0.919 | Bull | Bull | Bull | Flat | Mixed | doji | 0.00L | 0.00L | WAIT | NO | BB hit, TFs mixed |
| 10:52 | 24,338.4 | TOP | 24,317.59 | 24,329.21 | 24,340.82 | 0.896 | Bull | Bull | Flat | Flat | Mixed | doji | 0.00L | 0.00L | WAIT | NO | BB hit, TFs mixed |
| 10:53 | 24,343.9 | TOP | 24,317.76 | 24,330.36 | 24,342.96 | 1.037 | Bull | Bull | Bull | Bull | 4Bull | green | -8.08L | +6.34L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 10:54 | 24,343.65 | TOP | 24,318.84 | 24,331.59 | 24,344.34 | 0.973 | Bull | Bull | Bull | Flat | Mixed | red | -0.79L | +3.78L | PUT BUY | NO | BB hit, TFs mixed |
| 10:55 | 24,342.55 | TOP | 24,319.84 | 24,332.62 | 24,345.41 | 0.888 | Bull | Bull | Bull | Bear | Mixed | red | -1.15L | +2.28L | WAIT | NO | BB hit, TFs mixed |
| 10:56 | 24,342.5 | TOP | 24,320.62 | 24,333.52 | 24,346.43 | 0.848 | Bull | Bull | Bear | Flat | Mixed | red | -3.87L | +2.56L | PUT BUY | NO | BB hit, TFs mixed |
| 10:57 | 24,343.25 | TOP | 24,321.32 | 24,334.39 | 24,347.46 | 0.839 | Bull | Bull | Flat | Bull | Mixed | green | -1.54L | +3.69L | CALL BUY | NO | BB hit, TFs mixed |
| 11:02 | 24,331.5 | BOTTOM | 24,327.57 | 24,337.36 | 24,347.15 | 0.201 | Bear | Bear | Bear | Bear | 4Bear | red | +0.04L | +3.76L | PUT BUY | NO | Opposite: 4 Bear at BOTTOM |
| 11:03 | 24,327.35 | BOTTOM | 24,326.84 | 24,337.19 | 24,347.54 | 0.025 | Bear | Bear | Bear | Bear | 4Bear | red | -1.57L | -0.40L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:04 | 24,327.4 | BOTTOM | 24,326.24 | 24,337.04 | 24,347.84 | 0.054 | Bear | Bear | Bear | Flat | Mixed | green | -0.08L | -0.46L | WAIT | NO | BB hit, TFs mixed |
| 11:05 | 24,324.45 | BOTTOM | 24,324.99 | 24,336.76 | 24,348.53 | -0.023 | Bear | Bear | Bear | Bear | 4Bear | red | -124.28L | -21.05L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:06 | 24,322.7 | BOTTOM | 24,323.33 | 24,336.36 | 24,349.4 | -0.024 | Bear | Bear | Bear | Bear | 4Bear | red | +0.38L | -5.52L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:07 | 24,320.55 | BOTTOM | 24,321.12 | 24,335.78 | 24,350.44 | -0.019 | Bear | Bear | Bear | Bear | 4Bear | red | +2.20L | -1.97L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:08 | 24,316.9 | BOTTOM | 24,318.23 | 24,335.01 | 24,351.79 | -0.04 | Bear | Bear | Bear | Bear | 4Bear | red | +3.69L | -10.06L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:09 | 24,319.9 | BOTTOM | 24,316.15 | 24,334.08 | 24,352.01 | 0.105 | Bear | Bear | Bear | Bull | Mixed | green | +3.79L | -2.15L | WAIT | NO | BB hit, TFs mixed |
| 11:21 | 24,325.05 | TOP | 24,315.47 | 24,322.72 | 24,329.97 | 0.661 | Bull | Bull | Bull | Bull | 4Bull | green | +130.50L | +14.46L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 11:22 | 24,320.6 | BOTTOM | 24,316.11 | 24,322.18 | 24,328.24 | 0.37 | Flat | Bull | Bull | Bear | Mixed | red | -128.56L | -14.81L | WAIT | NO | BB hit, TFs mixed |
| 11:23 | 24,320.6 | BOTTOM | 24,316.23 | 24,321.84 | 24,327.45 | 0.39 | Bull | Bull | Bear | Flat | Mixed | doji | 0.00L | 0.00L | WAIT | NO | BB hit, TFs mixed |
| 11:24 | 24,328.25 | TOP | 24,316.09 | 24,321.88 | 24,327.67 | 1.05 | Bull | Bull | Bull | Bull | 4Bull | green | +128.65L | +15.33L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 11:25 | 24,328.25 | TOP | 24,315.73 | 24,322.07 | 24,328.41 | 0.988 | Bull | Bull | Bull | Flat | Mixed | doji | 0.00L | 0.00L | WAIT | NO | BB hit, TFs mixed |
| 11:26 | 24,328.25 | TOP | 24,315.46 | 24,322.35 | 24,329.23 | 0.929 | Bull | Bull | Bull | Flat | Mixed | doji | 0.00L | 0.00L | WAIT | NO | BB hit, TFs mixed |
| 11:27 | 24,331.95 | TOP | 24,314.92 | 24,322.92 | 24,330.91 | 1.065 | Bull | Bull | Bull | Bull | 4Bull | green | +1.32L | +0.02L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:28 | 24,333.3 | TOP | 24,315.05 | 24,323.74 | 24,332.43 | 1.05 | Bull | Bull | Bull | Bull | 4Bull | green | 0.00L | 0.00L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:29 | 24,334.65 | TOP | 24,314.77 | 24,324.47 | 24,334.18 | 1.024 | Bull | Bull | Bull | Bull | 4Bull | green | 0.00L | 0.00L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:30 | 24,339.95 | TOP | 24,313.4 | 24,325.22 | 24,337.05 | 1.123 | Bull | Bull | Bull | Bull | 4Bull | green | -2.28L | +0.74L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:31 | 24,342.1 | TOP | 24,312.08 | 24,326.01 | 24,339.94 | 1.077 | Bull | Bull | Bull | Bull | 4Bull | green | -4.15L | +2.81L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 11:32 | 24,346.8 | TOP | 24,310.66 | 24,327.19 | 24,343.73 | 1.093 | Bull | Bull | Bull | Bull | 4Bull | green | -2.95L | +1.63L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:33 | 24,346.95 | TOP | 24,309.79 | 24,328.34 | 24,346.89 | 1.002 | Bull | Bull | Bull | Flat | Mixed | green | 0.00L | 0.00L | WAIT | NO | BB hit, TFs mixed |
| 11:34 | 24,347.9 | TOP | 24,309.85 | 24,329.76 | 24,349.68 | 0.955 | Bull | Bull | Bull | Bull | 4Bull | green | -7.89L | +8.43L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 11:35 | 24,347 | TOP | 24,310.48 | 24,331.14 | 24,351.81 | 0.884 | Bull | Bull | Flat | Bear | Mixed | red | 0.00L | 0.00L | WAIT | NO | BB hit, TFs mixed |
| 11:37 | 24,353.2 | TOP | 24,312.33 | 24,334.16 | 24,356 | 0.936 | Bull | Bull | Bull | Bull | 4Bull | green | -3.76L | +3.25L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 11:48 | 24,352.45 | TOP | 24,338.5 | 24,347.46 | 24,356.41 | 0.779 | Bull | Bull | Bull | Bull | 4Bull | green | +0.06L | +0.96L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:49 | 24,354.1 | TOP | 24,341.19 | 24,348.43 | 24,355.67 | 0.892 | Bull | Bull | Bull | Bull | 4Bull | green | +0.69L | +0.17L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:50 | 24,356.9 | TOP | 24,342.24 | 24,349.28 | 24,356.31 | 1.042 | Bull | Bull | Bull | Bull | 4Bull | green | +0.53L | +0.56L | WAIT | NO | Opposite: 4 Bull at TOP |

## 4. 2026-08-14 summary (09:15–14:47)

Tape bars: 333 · BB-ready (20+ spots): 314 · Mid-band (not at line): 144 · At top or bottom: 170

| Zone | Times | 4 Bull | 4 Bear | Mixed | Stacked YES |
| --- | --- | --- | --- | --- | --- |
| TOP | 67 | 44 | 0 | 23 | 0 |
| BOTTOM | 103 | 0 | 47 | 56 | 0 |

### Minute log

| Time | Spot | BB | Lower | Mid | Upper | %B | 15M | 5M | 3M | 1M | TF pack | Candle | Call ΔOI | Put ΔOI | OI (no 4TF/BB) | Stacked 4TF+BB | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 09:36 | 24,333.75 | TOP | 24,307.05 | 24,322.29 | 24,337.54 | 0.876 | Bull | Bull | Bull | Bull | 4Bull | green | +2.82L | +16.67L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 09:38 | 24,339.65 | TOP | 24,306.15 | 24,323.05 | 24,339.95 | 0.991 | Bull | Bull | Bull | Bull | 4Bull | green | +4.67L | +5.83L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 09:39 | 24,341.8 | TOP | 24,305.54 | 24,324.19 | 24,342.83 | 0.972 | Bull | Bull | Bull | Bull | 4Bull | green | -4.59L | +10.35L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 09:54 | 24,332 | BOTTOM | 24,327.37 | 24,337.06 | 24,346.76 | 0.239 | Bear | Bear | Bear | Bear | 4Bear | red | -1.82L | +2.27L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 09:55 | 24,326.15 | BOTTOM | 24,327.01 | 24,336.99 | 24,346.98 | -0.043 | Bear | Bear | Bear | Bear | 4Bear | red | -0.87L | +2.27L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 09:56 | 24,331.7 | BOTTOM | 24,326.73 | 24,336.89 | 24,347.05 | 0.245 | Bear | Bear | Bear | Bull | Mixed | green | -2.02L | -5.89L | WAIT | NO | BB hit, TFs mixed |
| 10:00 | 24,343.75 | TOP | 24,327.29 | 24,337.45 | 24,347.6 | 0.81 | Bull | Bull | Bull | Bull | 4Bull | green | +2.36L | +3.85L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 10:01 | 24,346.2 | TOP | 24,327.26 | 24,338.02 | 24,348.77 | 0.88 | Bull | Bull | Bull | Bull | 4Bull | green | +2.01L | +5.44L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 10:02 | 24,344.8 | TOP | 24,327.29 | 24,338.42 | 24,349.55 | 0.787 | Bull | Bull | Bull | Bear | Mixed | red | +5.58L | +0.03L | WAIT | NO | BB hit, TFs mixed |
| 10:03 | 24,350.85 | TOP | 24,326.97 | 24,339.21 | 24,351.46 | 0.975 | Bull | Bull | Bull | Bull | 4Bull | green | -6.47L | +7.61L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 10:04 | 24,348.95 | TOP | 24,328.04 | 24,340.18 | 24,352.31 | 0.862 | Bull | Bull | Bull | Bear | Mixed | red | -4.79L | -2.75L | WAIT | NO | BB hit, TFs mixed |
| 10:05 | 24,350.7 | TOP | 24,328.77 | 24,341.11 | 24,353.45 | 0.889 | Bull | Bull | Bull | Bull | 4Bull | green | -0.20L | +5.74L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 10:08 | 24,352.85 | TOP | 24,328.63 | 24,342.13 | 24,355.64 | 0.897 | Bull | Bull | Bull | Bull | 4Bull | green | -3.43L | +3.91L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 10:10 | 24,353.65 | TOP | 24,328.33 | 24,343.13 | 24,357.94 | 0.855 | Bull | Bull | Bull | Bull | 4Bull | green | +0.62L | +4.34L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 10:11 | 24,358.2 | TOP | 24,327.91 | 24,344.03 | 24,360.15 | 0.94 | Bull | Bull | Bull | Bull | 4Bull | green | -0.36L | +2.16L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:17 | 24,342.4 | BOTTOM | 24,337.58 | 24,347.41 | 24,357.24 | 0.245 | Bear | Bear | Bear | Bear | 4Bear | red | +2.90L | +3.23L | PUT BUY | NO | Opposite: 4 Bear at BOTTOM |
| 10:19 | 24,339.7 | BOTTOM | 24,338.43 | 24,347.64 | 24,356.85 | 0.069 | Bear | Bear | Bear | Bear | 4Bear | red | +2.67L | -1.64L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:20 | 24,337.05 | BOTTOM | 24,337.12 | 24,347.31 | 24,357.49 | -0.003 | Bear | Bear | Bear | Bear | 4Bear | red | -0.50L | +3.54L | PUT BUY | NO | Opposite: 4 Bear at BOTTOM |
| 10:21 | 24,335.4 | BOTTOM | 24,335.33 | 24,346.77 | 24,358.2 | 0.003 | Bear | Bear | Bear | Bear | 4Bear | red | -0.07L | +4.47L | PUT BUY | NO | Opposite: 4 Bear at BOTTOM |
| 10:22 | 24,336.25 | BOTTOM | 24,334.04 | 24,346.34 | 24,358.64 | 0.09 | Bear | Bear | Bear | Bull | Mixed | green | +4.20L | +4.14L | CALL BUY | NO | BB hit, TFs mixed |
| 10:23 | 24,335.6 | BOTTOM | 24,332.61 | 24,345.58 | 24,358.54 | 0.115 | Bear | Bear | Bear | Bear | 4Bear | red | -0.62L | +0.72L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:24 | 24,334.25 | BOTTOM | 24,331.08 | 24,344.84 | 24,358.6 | 0.115 | Bear | Bear | Bear | Bear | 4Bear | red | +2.77L | +0.21L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:25 | 24,334.9 | BOTTOM | 24,329.92 | 24,344.05 | 24,358.18 | 0.176 | Bear | Bear | Bear | Bull | Mixed | green | +1.85L | -1.18L | WAIT | NO | BB hit, TFs mixed |
| 10:27 | 24,332.2 | BOTTOM | 24,327.44 | 24,342.75 | 24,358.06 | 0.155 | Bear | Bear | Bear | Bear | 4Bear | red | +4.08L | +1.09L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:31 | 24,327.4 | BOTTOM | 24,325.56 | 24,338.21 | 24,350.86 | 0.073 | Bear | Bear | Bear | Bear | 4Bear | red | +1.80L | -0.34L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:32 | 24,312.8 | BOTTOM | 24,321.15 | 24,336.17 | 24,351.2 | -0.278 | Bear | Bear | Bear | Bear | 4Bear | red | +1.97L | -14.23L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:33 | 24,303.75 | BOTTOM | 24,314.18 | 24,334 | 24,353.82 | -0.263 | Bear | Bear | Bear | Bear | 4Bear | red | +10.22L | -14.96L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 10:34 | 24,303.6 | BOTTOM | 24,308.73 | 24,331.97 | 24,355.2 | -0.11 | Bear | Bear | Bear | Flat | Mixed | red | +13.79L | -26.84L | WAIT | NO | BB hit, TFs mixed |
| 10:35 | 24,307.6 | BOTTOM | 24,305.33 | 24,330.14 | 24,354.94 | 0.046 | Bear | Bear | Bear | Bull | Mixed | green | +14.23L | -12.42L | WAIT | NO | BB hit, TFs mixed |
| 10:49 | 24,335 | TOP | 24,302.54 | 24,319.87 | 24,337.21 | 0.936 | Bull | Bull | Bull | Bull | 4Bull | green | +0.55L | +0.47L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:51 | 24,335.35 | TOP | 24,301.83 | 24,320.34 | 24,338.84 | 0.906 | Bull | Bull | Bull | Bull | 4Bull | green | -3.39L | +4.82L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 10:52 | 24,336.35 | TOP | 24,302.1 | 24,321.51 | 24,340.93 | 0.882 | Bull | Bull | Bull | Bull | 4Bull | green | -0.50L | +0.97L | WAIT | NO | Opposite: 4 Bull at TOP |
| 10:54 | 24,337 | TOP | 24,307.76 | 24,324.66 | 24,341.57 | 0.865 | Bull | Bull | Bull | Bull | 4Bull | green | -4.34L | +5.53L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 10:59 | 24,317.3 | BOTTOM | 24,315.94 | 24,328.26 | 24,340.59 | 0.055 | Bear | Bear | Bear | Bear | 4Bear | red | -4.29L | +4.78L | PUT BUY | NO | Opposite: 4 Bear at BOTTOM |
| 11:00 | 24,310.8 | BOTTOM | 24,313.42 | 24,327.7 | 24,341.98 | -0.092 | Bear | Bear | Bear | Bear | 4Bear | red | -1.74L | -6.41L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:01 | 24,308.95 | BOTTOM | 24,311.08 | 24,327.18 | 24,343.28 | -0.066 | Bear | Bear | Bear | Bear | 4Bear | red | +6.40L | -14.11L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:02 | 24,308.9 | BOTTOM | 24,308.68 | 24,326.53 | 24,344.39 | 0.006 | Bear | Bear | Bear | Flat | Mixed | red | +8.90L | -7.89L | WAIT | NO | BB hit, TFs mixed |
| 11:17 | 24,318.95 | TOP | 24,308.37 | 24,315.83 | 24,323.29 | 0.709 | Bull | Bull | Bull | Bull | 4Bull | green | +0.04L | -8.72L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:18 | 24,322.15 | TOP | 24,308.75 | 24,315.71 | 24,322.68 | 0.962 | Bull | Bull | Bull | Bull | 4Bull | green | +4.40L | -1.59L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:19 | 24,323.8 | TOP | 24,308.25 | 24,316.04 | 24,323.82 | 0.998 | Bull | Bull | Bull | Bull | 4Bull | green | +2.03L | +0.22L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:20 | 24,327.65 | TOP | 24,307.98 | 24,316.88 | 24,325.78 | 1.105 | Bull | Bull | Bull | Bull | 4Bull | green | -3.96L | -4.42L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:21 | 24,326.85 | TOP | 24,308.64 | 24,317.78 | 24,326.91 | 0.997 | Bull | Bull | Bull | Bear | Mixed | red | -0.72L | +2.62L | PUT BUY | NO | BB hit, TFs mixed |
| 11:22 | 24,330.7 | TOP | 24,309.05 | 24,318.86 | 24,328.68 | 1.103 | Bull | Bull | Bull | Bull | 4Bull | green | -2.41L | +1.00L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:23 | 24,326.25 | TOP | 24,309.04 | 24,319.33 | 24,329.61 | 0.837 | Bull | Bull | Bear | Bear | Mixed | red | -4.84L | +2.26L | WAIT | NO | BB hit, TFs mixed |
| 11:24 | 24,326.8 | TOP | 24,308.97 | 24,319.74 | 24,330.51 | 0.828 | Bull | Bull | Flat | Bull | Mixed | green | +0.51L | +5.25L | CALL BUY | NO | BB hit, TFs mixed |
| 11:30 | 24,315.25 | BOTTOM | 24,311.04 | 24,321.18 | 24,331.32 | 0.208 | Flat | Bear | Bear | Bear | Mixed | red | +3.65L | -9.64L | WAIT | NO | BB hit, TFs mixed |
| 11:31 | 24,312.45 | BOTTOM | 24,310.24 | 24,320.95 | 24,331.65 | 0.103 | Bear | Bear | Bear | Bear | 4Bear | red | +2.82L | -4.87L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:38 | 24,313.9 | BOTTOM | 24,310.79 | 24,321.14 | 24,331.48 | 0.15 | Bear | Bear | Bear | Bear | 4Bear | red | +0.63L | +1.28L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 11:44 | 24,327.35 | TOP | 24,311.8 | 24,319.67 | 24,327.54 | 0.988 | Bull | Bull | Bull | Bull | 4Bull | green | -3.63L | -0.21L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:45 | 24,327.85 | TOP | 24,311.53 | 24,319.78 | 24,328.03 | 0.989 | Bull | Bull | Bull | Flat | Mixed | green | -5.06L | -2.48L | WAIT | NO | BB hit, TFs mixed |
| 11:46 | 24,329.6 | TOP | 24,311.06 | 24,319.95 | 24,328.84 | 1.043 | Bull | Bull | Bull | Bull | 4Bull | green | +0.20L | +4.48L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 11:47 | 24,336.2 | TOP | 24,309.35 | 24,320.72 | 24,332.09 | 1.181 | Bull | Bull | Bull | Bull | 4Bull | green | -4.17L | +0.21L | WAIT | NO | Opposite: 4 Bull at TOP |
| 11:48 | 24,332.75 | TOP | 24,308.89 | 24,321.38 | 24,333.88 | 0.955 | Bull | Bull | Bull | Bear | Mixed | red | -4.86L | +4.33L | PUT BUY | NO | BB hit, TFs mixed |
| 11:53 | 24,333.05 | TOP | 24,313.22 | 24,325 | 24,336.79 | 0.841 | Bull | Flat | Bull | Bull | Mixed | green | +2.40L | +0.66L | WAIT | NO | BB hit, TFs mixed |
| 11:56 | 24,333.6 | TOP | 24,314.89 | 24,326.75 | 24,338.6 | 0.789 | Bull | Bull | Bull | Bull | 4Bull | green | +0.08L | +2.30L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:01 | 24,325.3 | BOTTOM | 24,321.79 | 24,328.87 | 24,335.95 | 0.248 | Bear | Bear | Bear | Bear | 4Bear | red | +2.63L | +1.64L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:02 | 24,322.9 | BOTTOM | 24,322.14 | 24,328.94 | 24,335.74 | 0.056 | Bear | Bear | Bear | Bear | 4Bear | red | -1.15L | +2.33L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:03 | 24,324.15 | BOTTOM | 24,322.63 | 24,329.05 | 24,335.47 | 0.118 | Bear | Bear | Bear | Bull | Mixed | green | -1.11L | +0.85L | WAIT | NO | BB hit, TFs mixed |
| 12:04 | 24,322.65 | BOTTOM | 24,321.85 | 24,328.82 | 24,335.78 | 0.058 | Bear | Bear | Bear | Bear | 4Bear | red | +1.04L | -0.31L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:05 | 24,321.85 | BOTTOM | 24,320.92 | 24,328.52 | 24,336.11 | 0.061 | Bear | Bear | Bear | Bear | 4Bear | red | +1.10L | -0.95L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:07 | 24,333.55 | TOP | 24,321.12 | 24,328.26 | 24,335.39 | 0.871 | Bull | Bull | Bull | Bull | 4Bull | green | +4.45L | -11.75L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:08 | 24,338.2 | TOP | 24,320.38 | 24,328.53 | 24,336.67 | 1.094 | Bull | Bull | Bull | Bull | 4Bull | green | +1.95L | +0.52L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:09 | 24,335 | TOP | 24,320.22 | 24,328.84 | 24,337.46 | 0.857 | Bull | Bull | Bull | Bear | Mixed | red | +3.35L | +0.38L | WAIT | NO | BB hit, TFs mixed |
| 12:10 | 24,335.95 | TOP | 24,320.13 | 24,329.26 | 24,338.39 | 0.866 | Bull | Bull | Bull | Bull | 4Bull | green | -0.23L | +3.20L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 12:11 | 24,338.45 | TOP | 24,319.73 | 24,329.7 | 24,339.67 | 0.939 | Bull | Bull | Flat | Bull | Mixed | green | -2.65L | +2.35L | WAIT | NO | BB hit, TFs mixed |
| 12:12 | 24,342.1 | TOP | 24,318.96 | 24,330.3 | 24,341.65 | 1.02 | Bull | Bull | Bull | Bull | 4Bull | green | -3.44L | -1.84L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:13 | 24,339.5 | TOP | 24,318.64 | 24,330.62 | 24,342.61 | 0.87 | Bull | Bull | Bull | Bear | Mixed | red | -2.75L | +1.05L | WAIT | NO | BB hit, TFs mixed |
| 12:14 | 24,340.55 | TOP | 24,318.32 | 24,331.06 | 24,343.8 | 0.873 | Bull | Bull | Bull | Bull | 4Bull | green | +0.99L | +4.83L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 12:15 | 24,342.5 | TOP | 24,318.04 | 24,331.69 | 24,345.35 | 0.896 | Bull | Bull | Flat | Bull | Mixed | green | -1.09L | +2.91L | CALL BUY | NO | BB hit, TFs mixed |
| 12:16 | 24,342.7 | TOP | 24,317.69 | 24,332.15 | 24,346.61 | 0.865 | Bull | Bull | Bull | Flat | Mixed | green | -6.21L | +4.44L | CALL BUY | NO | BB hit, TFs mixed |
| 12:17 | 24,343.45 | TOP | 24,317.66 | 24,332.86 | 24,348.06 | 0.848 | Bull | Bull | Bull | Bull | 4Bull | green | -3.61L | +3.12L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 12:19 | 24,346.1 | TOP | 24,318.33 | 24,334.66 | 24,350.99 | 0.85 | Bull | Bull | Bull | Bull | 4Bull | green | -0.49L | -0.60L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:20 | 24,348.65 | TOP | 24,318.74 | 24,335.74 | 24,352.75 | 0.88 | Bull | Bull | Bull | Bull | 4Bull | green | -14.04L | +0.11L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:24 | 24,351 | TOP | 24,326.26 | 24,340.73 | 24,355.2 | 0.855 | Bull | Bull | Bull | Bull | 4Bull | green | +0.15L | +3.99L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 12:25 | 24,352.6 | TOP | 24,329.74 | 24,342.26 | 24,354.79 | 0.913 | Bull | Bull | Bull | Bull | 4Bull | green | -1.85L | +3.12L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 12:26 | 24,349.4 | TOP | 24,332.62 | 24,343.38 | 24,354.14 | 0.78 | Bull | Bull | Flat | Bear | Mixed | red | -8.89L | +2.32L | WAIT | NO | BB hit, TFs mixed |
| 12:32 | 24,342.5 | BOTTOM | 24,339.23 | 24,345.88 | 24,352.52 | 0.246 | Bear | Bear | Bear | Bear | 4Bear | red | -4.71L | +1.91L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:33 | 24,342.3 | BOTTOM | 24,339.81 | 24,346.01 | 24,352.22 | 0.201 | Bear | Bear | Bear | Flat | Mixed | red | -1.64L | +1.81L | WAIT | NO | BB hit, TFs mixed |
| 12:34 | 24,344.5 | BOTTOM | 24,340.48 | 24,346.21 | 24,351.94 | 0.351 | Bear | Bear | Bear | Bull | Mixed | green | +0.75L | +0.13L | WAIT | NO | BB hit, TFs mixed |
| 12:35 | 24,342.55 | BOTTOM | 24,340.49 | 24,346.21 | 24,351.94 | 0.18 | Bear | Bear | Flat | Bear | Mixed | red | +2.92L | -4.26L | WAIT | NO | BB hit, TFs mixed |
| 12:36 | 24,344.05 | BOTTOM | 24,340.7 | 24,346.28 | 24,351.87 | 0.3 | Bear | Bear | Bull | Bull | Mixed | green | +1.01L | +4.33L | CALL BUY | NO | BB hit, TFs mixed |
| 12:37 | 24,341 | BOTTOM | 24,340.23 | 24,346.16 | 24,352.09 | 0.065 | Bear | Bear | Bear | Bear | 4Bear | red | +2.36L | +0.20L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:38 | 24,341.9 | BOTTOM | 24,339.88 | 24,346.04 | 24,352.2 | 0.164 | Bear | Flat | Bear | Bull | Mixed | green | -1.84L | +2.47L | WAIT | NO | BB hit, TFs mixed |
| 12:39 | 24,343.55 | BOTTOM | 24,339.65 | 24,345.91 | 24,352.17 | 0.311 | Bear | Bear | Flat | Bull | Mixed | green | -0.00L | +0.32L | WAIT | NO | BB hit, TFs mixed |
| 12:40 | 24,341.95 | BOTTOM | 24,339.22 | 24,345.58 | 24,351.93 | 0.215 | Bear | Bear | Bull | Bear | Mixed | red | +1.57L | -4.28L | WAIT | NO | BB hit, TFs mixed |
| 12:41 | 24,340.95 | BOTTOM | 24,338.65 | 24,345.27 | 24,351.88 | 0.174 | Bear | Bear | Bear | Bear | 4Bear | red | +1.01L | +1.61L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:42 | 24,335.25 | BOTTOM | 24,336.82 | 24,344.67 | 24,352.53 | -0.1 | Bear | Bear | Bear | Bear | 4Bear | red | -1.90L | +0.26L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:43 | 24,334.6 | BOTTOM | 24,335.25 | 24,343.94 | 24,352.62 | -0.037 | Bear | Bear | Bear | Bear | 4Bear | red | -4.69L | +0.38L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 12:44 | 24,336.6 | BOTTOM | 24,334.61 | 24,343.22 | 24,351.82 | 0.116 | Bear | Bear | Bear | Bull | Mixed | green | -0.37L | +1.00L | WAIT | NO | BB hit, TFs mixed |
| 12:45 | 24,336.65 | BOTTOM | 24,334.51 | 24,342.42 | 24,350.33 | 0.135 | Bear | Bear | Bull | Flat | Mixed | green | +0.69L | -3.49L | WAIT | NO | BB hit, TFs mixed |
| 12:46 | 24,336.75 | BOTTOM | 24,334.19 | 24,341.78 | 24,349.38 | 0.168 | Bear | Bear | Bull | Flat | Mixed | green | +1.85L | -1.61L | WAIT | NO | BB hit, TFs mixed |
| 12:47 | 24,338.25 | BOTTOM | 24,333.87 | 24,341.43 | 24,348.99 | 0.29 | Bear | Bull | Bull | Bull | Mixed | green | +1.94L | -4.32L | WAIT | NO | BB hit, TFs mixed |
| 12:49 | 24,344.55 | TOP | 24,333.92 | 24,340.96 | 24,348 | 0.755 | Flat | Bull | Bull | Bull | Mixed | green | -4.35L | -12.82L | WAIT | NO | BB hit, TFs mixed |
| 12:50 | 24,346 | TOP | 24,334.07 | 24,340.9 | 24,347.73 | 0.873 | Bull | Bull | Bull | Bull | 4Bull | green | +1.83L | +3.70L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 12:51 | 24,348.1 | TOP | 24,333.75 | 24,341.04 | 24,348.34 | 0.983 | Bull | Bull | Bull | Bull | 4Bull | green | +3.72L | +4.90L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 12:52 | 24,349 | TOP | 24,333.3 | 24,341.37 | 24,349.44 | 0.973 | Bull | Bull | Bull | Bull | 4Bull | green | +0.58L | +1.80L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:53 | 24,349.95 | TOP | 24,332.86 | 24,341.75 | 24,350.64 | 0.961 | Bull | Bull | Bull | Bull | 4Bull | green | -2.90L | +1.42L | WAIT | NO | Opposite: 4 Bull at TOP |
| 12:54 | 24,348.75 | TOP | 24,332.63 | 24,341.97 | 24,351.3 | 0.863 | Bull | Bull | Bull | Bear | Mixed | red | +0.35L | +1.93L | WAIT | NO | BB hit, TFs mixed |
| 12:55 | 24,349.5 | TOP | 24,332.41 | 24,342.31 | 24,352.21 | 0.863 | Bull | Bull | Flat | Bull | Mixed | green | -3.66L | +4.45L | CALL BUY | NO | BB hit, TFs mixed |
| 12:56 | 24,350.2 | TOP | 24,332.16 | 24,342.62 | 24,353.08 | 0.862 | Bull | Bull | Flat | Bull | Mixed | green | +0.81L | +2.40L | WAIT | NO | BB hit, TFs mixed |
| 12:57 | 24,350.65 | TOP | 24,332.11 | 24,343.1 | 24,354.1 | 0.843 | Bull | Bull | Bull | Flat | Mixed | green | -0.84L | +2.63L | CALL BUY | NO | BB hit, TFs mixed |
| 13:07 | 24,344.5 | BOTTOM | 24,341.73 | 24,347.06 | 24,352.39 | 0.26 | Bear | Bear | Bear | Bear | 4Bear | red | +0.68L | +0.40L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:08 | 24,342.3 | BOTTOM | 24,342.81 | 24,347.23 | 24,351.64 | -0.058 | Bear | Bear | Bear | Bear | 4Bear | red | -2.23L | -1.71L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:09 | 24,342 | BOTTOM | 24,342.26 | 24,347.1 | 24,351.94 | -0.026 | Bear | Bear | Bear | Flat | Mixed | red | -3.30L | +1.13L | WAIT | NO | BB hit, TFs mixed |
| 13:10 | 24,342.55 | BOTTOM | 24,341.71 | 24,346.93 | 24,352.15 | 0.081 | Bear | Bear | Bear | Bull | Mixed | green | -0.80L | +1.44L | WAIT | NO | BB hit, TFs mixed |
| 13:11 | 24,343.95 | BOTTOM | 24,341.37 | 24,346.72 | 24,352.07 | 0.241 | Bear | Bear | Bull | Bull | Mixed | green | +0.04L | -1.32L | WAIT | NO | BB hit, TFs mixed |
| 13:12 | 24,344.05 | BOTTOM | 24,341.11 | 24,346.47 | 24,351.83 | 0.274 | Bear | Flat | Bull | Flat | Mixed | green | +0.93L | -2.78L | WAIT | NO | BB hit, TFs mixed |
| 13:13 | 24,343.35 | BOTTOM | 24,340.87 | 24,346.14 | 24,351.42 | 0.235 | Bear | Bull | Bull | Bear | Mixed | red | -0.45L | +2.97L | PUT BUY | NO | BB hit, TFs mixed |
| 13:14 | 24,345.55 | BOTTOM | 24,340.84 | 24,345.98 | 24,351.12 | 0.458 | Flat | Bull | Bull | Bull | Mixed | green | +0.59L | +0.01L | WAIT | NO | BB hit, TFs mixed |
| 13:15 | 24,345.75 | BOTTOM | 24,340.92 | 24,345.79 | 24,350.67 | 0.495 | Bear | Bull | Bull | Flat | Mixed | green | -0.31L | +0.33L | WAIT | NO | BB hit, TFs mixed |
| 13:16 | 24,345.65 | BOTTOM | 24,341.13 | 24,345.57 | 24,350.01 | 0.509 | Bear | Bull | Bull | Flat | Mixed | red | +0.34L | -0.03L | WAIT | NO | BB hit, TFs mixed |
| 13:17 | 24,341.8 | BOTTOM | 24,341.05 | 24,345.12 | 24,349.2 | 0.092 | Bear | Bear | Bear | Bear | 4Bear | red | +1.88L | +0.67L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:18 | 24,344.45 | BOTTOM | 24,341.06 | 24,344.96 | 24,348.85 | 0.435 | Bear | Bull | Bear | Bull | Mixed | green | -3.52L | -1.15L | WAIT | NO | BB hit, TFs mixed |
| 13:19 | 24,345.3 | BOTTOM | 24,341.07 | 24,344.97 | 24,348.86 | 0.543 | Bear | Flat | Flat | Bull | Mixed | green | -0.34L | +0.84L | WAIT | NO | BB hit, TFs mixed |
| 13:20 | 24,343.85 | BOTTOM | 24,341.37 | 24,344.68 | 24,348 | 0.374 | Bear | Bear | Bull | Bear | Mixed | red | +0.61L | +0.66L | WAIT | NO | BB hit, TFs mixed |
| 13:21 | 24,344.35 | BOTTOM | 24,341.47 | 24,344.52 | 24,347.58 | 0.471 | Bear | Bear | Flat | Flat | Mixed | green | -0.05L | +1.23L | WAIT | NO | BB hit, TFs mixed |
| 13:22 | 24,344.9 | BOTTOM | 24,341.55 | 24,344.43 | 24,347.32 | 0.581 | Flat | Bull | Flat | Bull | Mixed | green | -0.58L | +1.35L | WAIT | NO | BB hit, TFs mixed |
| 13:23 | 24,343.9 | BOTTOM | 24,341.64 | 24,344.28 | 24,346.91 | 0.429 | Bull | Bear | Flat | Bear | Mixed | red | -0.45L | +0.48L | WAIT | NO | BB hit, TFs mixed |
| 13:24 | 24,343.05 | BOTTOM | 24,341.64 | 24,344.1 | 24,346.56 | 0.287 | Bull | Bear | Bear | Bear | Mixed | red | -0.62L | -0.10L | WAIT | NO | BB hit, TFs mixed |
| 13:25 | 24,344.1 | BOTTOM | 24,341.63 | 24,344.06 | 24,346.48 | 0.509 | Bull | Flat | Bear | Bull | Mixed | green | -0.06L | -0.46L | WAIT | NO | BB hit, TFs mixed |
| 13:26 | 24,338.75 | BOTTOM | 24,340.47 | 24,343.7 | 24,346.94 | -0.266 | Bear | Bear | Bear | Bear | 4Bear | red | +0.48L | -1.55L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:27 | 24,338.7 | BOTTOM | 24,339.54 | 24,343.41 | 24,347.29 | -0.109 | Bear | Bear | Bear | Flat | Mixed | red | -3.18L | -1.79L | WAIT | NO | BB hit, TFs mixed |
| 13:28 | 24,338.95 | BOTTOM | 24,338.93 | 24,343.25 | 24,347.56 | 0.002 | Bear | Bear | Bear | Flat | Mixed | green | +0.18L | +4.25L | CALL BUY | NO | BB hit, TFs mixed |
| 13:29 | 24,341.75 | BOTTOM | 24,338.9 | 24,343.24 | 24,347.57 | 0.329 | Bear | Bear | Bull | Bull | Mixed | green | +0.55L | +2.35L | WAIT | NO | BB hit, TFs mixed |
| 13:30 | 24,340 | BOTTOM | 24,338.56 | 24,343.11 | 24,347.66 | 0.159 | Bear | Bear | Bull | Bear | Mixed | red | -0.53L | +0.23L | WAIT | NO | BB hit, TFs mixed |
| 13:31 | 24,340 | BOTTOM | 24,338.18 | 24,342.91 | 24,347.64 | 0.192 | Bear | Bull | Bull | Flat | Mixed | doji | +1.07L | -3.02L | WAIT | NO | BB hit, TFs mixed |
| 13:32 | 24,338.9 | BOTTOM | 24,337.65 | 24,342.65 | 24,347.66 | 0.125 | Bear | Flat | Bear | Bear | Mixed | red | -0.02L | -0.20L | WAIT | NO | BB hit, TFs mixed |
| 13:33 | 24,334.55 | BOTTOM | 24,336.11 | 24,342.21 | 24,348.32 | -0.127 | Bear | Bear | Bear | Bear | 4Bear | red | +0.01L | -6.61L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:34 | 24,332.85 | BOTTOM | 24,334.44 | 24,341.58 | 24,348.72 | -0.111 | Bear | Bear | Bear | Bear | 4Bear | red | -0.96L | -2.96L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:35 | 24,330.25 | BOTTOM | 24,332.39 | 24,340.8 | 24,349.21 | -0.127 | Bear | Bear | Bear | Bear | 4Bear | red | +1.02L | -5.16L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:36 | 24,329 | BOTTOM | 24,330.42 | 24,339.97 | 24,349.52 | -0.075 | Bear | Bear | Bear | Bear | 4Bear | red | -3.25L | -8.24L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 13:37 | 24,330.2 | BOTTOM | 24,328.99 | 24,339.39 | 24,349.79 | 0.058 | Bear | Bear | Bear | Bull | Mixed | green | +3.94L | -3.89L | WAIT | NO | BB hit, TFs mixed |
| 13:40 | 24,348.3 | TOP | 24,328.28 | 24,338.83 | 24,349.38 | 0.949 | Bull | Bull | Bull | Bull | 4Bull | green | +0.07L | -5.64L | WAIT | NO | Opposite: 4 Bull at TOP |
| 13:41 | 24,352.3 | TOP | 24,327.35 | 24,339.22 | 24,351.1 | 1.051 | Bull | Bull | Bull | Bull | 4Bull | green | +4.33L | -9.91L | WAIT | NO | Opposite: 4 Bull at TOP |
| 13:42 | 24,350.85 | TOP | 24,326.83 | 24,339.52 | 24,352.22 | 0.946 | Bull | Bull | Bull | Bear | Mixed | red | +1.14L | +3.13L | PUT BUY | NO | BB hit, TFs mixed |
| 13:43 | 24,352.4 | TOP | 24,326.17 | 24,339.95 | 24,353.72 | 0.952 | Bull | Bull | Bull | Bull | 4Bull | green | -3.13L | +5.59L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 13:44 | 24,355.85 | TOP | 24,325.2 | 24,340.59 | 24,355.97 | 0.996 | Bull | Bull | Bull | Bull | 4Bull | green | -7.66L | +0.51L | WAIT | NO | Opposite: 4 Bull at TOP |
| 13:45 | 24,357.5 | TOP | 24,324.24 | 24,341.26 | 24,358.28 | 0.977 | Bull | Bull | Bull | Bull | 4Bull | green | -5.14L | -0.90L | WAIT | NO | Opposite: 4 Bull at TOP |
| 13:46 | 24,383.4 | TOP | 24,318.52 | 24,343.49 | 24,368.46 | 1.299 | Bull | Bull | Bull | Bull | 4Bull | green | -8.54L | +5.25L | CALL BUY | NO | Opposite: 4 Bull at TOP |
| 13:47 | 24,389.55 | TOP | 24,314.13 | 24,346.03 | 24,377.93 | 1.182 | Bull | Bull | Bull | Bull | 4Bull | green | -112.56L | -12.75L | WAIT | NO | Opposite: 4 Bull at TOP |
| 13:48 | 24,379.75 | TOP | 24,313.17 | 24,348.07 | 24,382.98 | 0.954 | Bull | Bull | Bull | Bear | Mixed | red | -24.29L | +11.02L | PUT BUY | NO | BB hit, TFs mixed |
| 14:13 | 24,385.55 | BOTTOM | 24,380.9 | 24,391.72 | 24,402.55 | 0.215 | Bear | Bear | Bear | Bear | 4Bear | red | -0.25L | +1.17L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:15 | 24,382.8 | BOTTOM | 24,380.33 | 24,391.56 | 24,402.78 | 0.11 | Bear | Bear | Bear | Bear | 4Bear | red | +0.11L | -1.77L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:16 | 24,384.15 | BOTTOM | 24,380.53 | 24,391.61 | 24,402.69 | 0.163 | Bear | Bear | Bear | Bull | Mixed | green | -1.75L | +3.19L | CALL BUY | NO | BB hit, TFs mixed |
| 14:18 | 24,385.4 | BOTTOM | 24,380.57 | 24,391.61 | 24,402.66 | 0.219 | Bear | Flat | Bull | Bear | Mixed | red | +4.70L | -5.13L | WAIT | NO | BB hit, TFs mixed |
| 14:19 | 24,382.15 | BOTTOM | 24,379.31 | 24,391.06 | 24,402.81 | 0.121 | Bear | Bear | Bear | Bear | 4Bear | red | -2.47L | +0.24L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:20 | 24,378.55 | BOTTOM | 24,377.46 | 24,390.22 | 24,402.97 | 0.043 | Bear | Bear | Bear | Bear | 4Bear | red | -2.18L | +6.24L | PUT BUY | NO | Opposite: 4 Bear at BOTTOM |
| 14:21 | 24,378.7 | BOTTOM | 24,375.96 | 24,389.34 | 24,402.72 | 0.102 | Bear | Bear | Bear | Flat | Mixed | green | +0.41L | -0.91L | WAIT | NO | BB hit, TFs mixed |
| 14:22 | 24,376.2 | BOTTOM | 24,374.64 | 24,388.11 | 24,401.59 | 0.058 | Bear | Bear | Bear | Bear | 4Bear | red | +0.75L | -3.55L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:23 | 24,373.1 | BOTTOM | 24,373.27 | 24,386.67 | 24,400.06 | -0.006 | Bear | Bear | Bear | Bear | 4Bear | red | -2.28L | -4.12L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:24 | 24,376.7 | BOTTOM | 24,373.06 | 24,385.46 | 24,397.86 | 0.147 | Bear | Bear | Bear | Bull | Mixed | green | +0.09L | +0.17L | WAIT | NO | BB hit, TFs mixed |
| 14:25 | 24,377.15 | BOTTOM | 24,372.6 | 24,384.53 | 24,396.45 | 0.191 | Bear | Bear | Bull | Flat | Mixed | green | +1.75L | -0.39L | WAIT | NO | BB hit, TFs mixed |
| 14:27 | 24,375.65 | BOTTOM | 24,371.58 | 24,382.92 | 24,394.25 | 0.18 | Bear | Bear | Bear | Bear | 4Bear | red | +2.69L | -1.64L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:28 | 24,371.45 | BOTTOM | 24,370.27 | 24,381.91 | 24,393.54 | 0.051 | Bear | Bear | Bear | Bear | 4Bear | red | +0.73L | -0.53L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:29 | 24,372.25 | BOTTOM | 24,369.3 | 24,381.01 | 24,392.72 | 0.126 | Bear | Bear | Bear | Bull | Mixed | green | -4.87L | -2.53L | WAIT | NO | BB hit, TFs mixed |
| 14:30 | 24,372.5 | BOTTOM | 24,368.73 | 24,380.09 | 24,391.45 | 0.166 | Bear | Bear | Bear | Flat | Mixed | green | -0.46L | -1.02L | WAIT | NO | BB hit, TFs mixed |
| 14:31 | 24,372.7 | BOTTOM | 24,368.37 | 24,379.24 | 24,390.11 | 0.199 | Bear | Bear | Bull | Flat | Mixed | green | +1.21L | -1.53L | WAIT | NO | BB hit, TFs mixed |
| 14:32 | 24,372.7 | BOTTOM | 24,367.97 | 24,378.5 | 24,389.02 | 0.225 | Bear | Bear | Flat | Flat | Mixed | doji | -0.03L | -4.28L | WAIT | NO | BB hit, TFs mixed |
| 14:34 | 24,371.7 | BOTTOM | 24,367.33 | 24,377.12 | 24,386.92 | 0.223 | Bear | Bear | Bear | Bear | 4Bear | red | -2.23L | -1.88L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:36 | 24,371.15 | BOTTOM | 24,366.73 | 24,375.97 | 24,385.2 | 0.239 | Bear | Bear | Bear | Bear | 4Bear | red | +1.14L | -0.20L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:38 | 24,367.45 | BOTTOM | 24,367.68 | 24,374.34 | 24,381 | -0.018 | Bear | Bear | Bear | Bear | 4Bear | red | +4.10L | -3.97L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:39 | 24,370.35 | BOTTOM | 24,367.93 | 24,373.75 | 24,379.58 | 0.208 | Bear | Bear | Bear | Bull | Mixed | green | -0.94L | -0.49L | WAIT | NO | BB hit, TFs mixed |
| 14:40 | 24,369.15 | BOTTOM | 24,367.56 | 24,373.28 | 24,379 | 0.139 | Bear | Bear | Bear | Bear | 4Bear | red | +1.70L | -4.03L | WAIT | NO | Opposite: 4 Bear at BOTTOM |
| 14:41 | 24,371.45 | BOTTOM | 24,367.73 | 24,372.92 | 24,378.11 | 0.358 | Bear | Flat | Bull | Bull | Mixed | green | -1.32L | -6.57L | WAIT | NO | BB hit, TFs mixed |
| 14:42 | 24,372.8 | TOP | 24,367.78 | 24,372.75 | 24,377.72 | 0.505 | Bear | Bear | Bull | Bull | Mixed | green | +2.21L | -1.80L | WAIT | NO | BB hit, TFs mixed |
| 14:43 | 24,372.9 | TOP | 24,367.77 | 24,372.74 | 24,377.71 | 0.516 | Bull | Bull | Bull | Flat | Mixed | green | +0.22L | -3.14L | WAIT | NO | BB hit, TFs mixed |
| 14:44 | 24,371.05 | BOTTOM | 24,367.79 | 24,372.46 | 24,377.13 | 0.349 | Bear | Bull | Flat | Bear | Mixed | red | +1.24L | -6.72L | WAIT | NO | BB hit, TFs mixed |
| 14:45 | 24,369.45 | BOTTOM | 24,367.76 | 24,372.07 | 24,376.39 | 0.196 | Bear | Flat | Bear | Bear | Mixed | red | -0.63L | -2.83L | WAIT | NO | BB hit, TFs mixed |
| 14:46 | 24,371.45 | BOTTOM | 24,368.33 | 24,371.76 | 24,375.18 | 0.455 | Bear | Flat | Bear | Bull | Mixed | green | -2.29L | -4.98L | WAIT | NO | BB hit, TFs mixed |
| 14:47 | 24,369.1 | BOTTOM | 24,368.32 | 24,371.43 | 24,374.54 | 0.126 | Bear | Bear | Bear | Bear | 4Bear | red | +2.42L | -3.06L | WAIT | NO | Opposite: 4 Bear at BOTTOM |

## 5. Method notes

- 13 Aug JSON is incomplete (09:15–11:50 only). Afternoon BB hits that day are not in this file.
- OI (no 4TF/BB) is the raw Put-ΔOI + candle decision on that same bar, for context only. It is not a live fill.
- Live paper engine today still uses OI + 4 Bull CE / 4 Bear PE. BB stack is **not** live, because it never met on this tape.

