# OI Flow × Bollinger Band — strategy check

**Period:** 12, 13, 14 Aug 2026 (NIFTY 1-minute OI Flow JSON)
**BB:** 20 SMA ± 2σ, offset 0. “At band” = touch / outside / within 5 pts.
**TFs:** 15M / 5M / 3M / 1M from spot lookback.
**Look-ahead:** none. At time T only bars with minutes ≤ T are used (OI, candle, TFs, BB).

## Proposed extra rule (stacked with OI)

- CALL BUY only if **4 Bull and NIFTY at BB bottom**
- PUT BUY only if **4 Bear and NIFTY at BB top**

## Verdict

| Check | Result | Times |
|-------|--------|-------|
| 4 Bull at BB **bottom** | **Not met** | **0** |
| 4 Bear at BB **top** | **Not met** | **0** |
| Combined stacked rule | **Not met on any of the 3 days** | **0** |

## How many times BB was hit *without* that rule

| | Times | 4 Bull | 4 Bear | Mixed TFs |
|--|------:|-------:|-------:|----------:|
| BB **top** | 184 | 103 | 0 | 81 |
| BB **bottom** | 221 | 0 | 114 | 107 |
| **Total BB top+bottom** | **405** | | | |
| Of which stacked rule met | **0** | | | |
| BB hit **without** stacked rule | **405** | | | |

What actually lines up: **4 Bull with BB top** (103) and **4 Bear with BB bottom** (114). That is the opposite of CE-at-bottom / PE-at-top.

## 2026-08-12  (09:15–15:30, 357 BB-ready minutes)

| Zone | Times | 4 Bull | 4 Bear | Mixed | Stacked rule |
|------|------:|-------:|-------:|------:|--------------|
| Top | 81 | 38 | 0 | 43 | 4 Bear @ top = **0** |
| Bottom | 92 | 0 | 50 | 42 | 4 Bull @ bottom = **0** |

| Time | Spot | BB | 15M/5M/3M/1M | TF pack | Stacked rule | %B |
|------|------|----|--------------|---------|--------------|-----|
| 09:46 | 24,418.4 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.056 |
| 09:47 | 24,412.05 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.005 |
| 09:48 | 24,405.8 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.055 |
| 09:49 | 24,404.4 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.026 |
| 09:50 | 24,402.55 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.014 |
| 09:51 | 24,393.75 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.066 |
| 09:58 | 24,391.45 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.081 |
| 09:59 | 24,382.2 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0 |
| 10:00 | 24,377.9 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.012 |
| 10:01 | 24,374.4 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.022 |
| 10:02 | 24,373.8 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.063 |
| 10:04 | 24,365.25 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.027 |
| 10:05 | 24,364.8 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.063 |
| 10:19 | 24,377.15 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.963 |
| 10:20 | 24,373.15 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.806 |
| 10:21 | 24,374.7 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.884 |
| 10:22 | 24,377.65 | TOP | Bull/Bull/Flat/Bull | Mixed | No | 0.992 |
| 10:23 | 24,375.7 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.877 |
| 10:24 | 24,376.5 | TOP | Bull/Bear/Bull/Bull | Mixed | No | 0.867 |
| 10:25 | 24,375.85 | TOP | Bull/Bull/Bear/Bear | Mixed | No | 0.805 |
| 10:26 | 24,380.2 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.925 |
| 10:27 | 24,379.65 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.858 |
| 10:32 | 24,382 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.886 |
| 10:33 | 24,389.75 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.093 |
| 10:34 | 24,398.55 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.198 |
| 10:35 | 24,395.3 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 1.011 |
| 10:36 | 24,394.9 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.956 |
| 10:46 | 24,368.55 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.061 |
| 10:47 | 24,368.6 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.107 |
| 10:48 | 24,359.9 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.055 |
| 10:49 | 24,354.65 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.068 |
| 10:50 | 24,358.75 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.072 |
| 10:57 | 24,348.2 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.083 |
| 10:58 | 24,343.95 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.045 |
| 10:59 | 24,327.3 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.14 |
| 11:00 | 24,319.5 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.131 |
| 11:01 | 24,314.05 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.091 |
| 11:02 | 24,309.8 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.044 |
| 11:03 | 24,304 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.022 |
| 11:04 | 24,298.55 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.004 |
| 11:21 | 24,309.55 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.787 |
| 11:23 | 24,309.85 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.788 |
| 11:24 | 24,317.9 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.098 |
| 11:28 | 24,299.05 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.137 |
| 11:29 | 24,300.75 | BOTTOM | Flat/Bear/Bear/Bull | Mixed | No | 0.228 |
| 11:30 | 24,296.6 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.074 |
| 11:31 | 24,289.1 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.122 |
| 11:32 | 24,292.2 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.058 |
| 11:33 | 24,294.7 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.18 |
| 11:34 | 24,293.3 | BOTTOM | Bear/Bear/Bull/Bear | Mixed | No | 0.158 |
| 11:40 | 24,287.55 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.117 |
| 11:41 | 24,279.95 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.029 |
| 11:42 | 24,283.75 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.127 |
| 11:54 | 24,282.75 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.155 |
| 11:55 | 24,283.4 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.198 |
| 11:56 | 24,280.65 | BOTTOM | Bull/Bear/Bear/Bear | Mixed | No | 0.099 |
| 11:58 | 24,282.75 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.252 |
| 11:59 | 24,277.7 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.045 |
| 12:00 | 24,279.15 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.159 |
| 12:01 | 24,279.5 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.178 |
| 12:02 | 24,279.1 | BOTTOM | Bear/Bear/Bull/Flat | Mixed | No | 0.183 |
| 12:03 | 24,277.85 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.157 |
| 12:04 | 24,278.3 | BOTTOM | Bear/Bull/Bear/Flat | Mixed | No | 0.204 |
| 12:05 | 24,272.3 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.016 |
| 12:08 | 24,275.55 | BOTTOM | Bear/Bear/Bull/Bear | Mixed | No | 0.194 |
| 12:09 | 24,276.2 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.241 |
| 12:10 | 24,273.3 | BOTTOM | Bear/Bull/Bear/Bear | Mixed | No | 0.106 |
| 12:11 | 24,271.45 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.049 |
| 12:12 | 24,274.75 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.258 |
| 12:13 | 24,273.6 | BOTTOM | Bear/Bear/Flat/Bear | Mixed | No | 0.197 |
| 12:14 | 24,269.75 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.009 |
| 12:15 | 24,267.9 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.027 |
| 12:18 | 24,277.35 | TOP | Flat/Bull/Bull/Bull | Mixed | No | 0.633 |
| 12:19 | 24,279.95 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.813 |
| 12:20 | 24,277.35 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.63 |
| 12:22 | 24,277.15 | TOP | Bear/Bull/Bear/Bull | Mixed | No | 0.645 |
| 12:24 | 24,273.8 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.406 |
| 12:26 | 24,275.8 | TOP | Bull/Flat/Bull/Bull | Mixed | No | 0.571 |
| 12:27 | 24,278.65 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.832 |
| 12:28 | 24,276.45 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.631 |
| 12:29 | 24,279.2 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.845 |
| 12:30 | 24,281.4 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.956 |
| 12:31 | 24,279.6 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.787 |
| 12:32 | 24,280.75 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.837 |
| 12:33 | 24,281.45 | TOP | Bull/Bull/Flat/Bull | Mixed | No | 0.847 |
| 12:34 | 24,288.45 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.185 |
| 12:35 | 24,289.05 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.14 |
| 12:36 | 24,287.75 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.98 |
| 12:37 | 24,286.5 | TOP | Bull/Bull/Bear/Bear | Mixed | No | 0.863 |
| 12:38 | 24,285.4 | TOP | Bull/Bull/Bear/Bear | Mixed | No | 0.774 |
| 12:39 | 24,286.95 | TOP | Bull/Bear/Bear/Bull | Mixed | No | 0.823 |
| 12:40 | 24,289.8 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.908 |
| 12:41 | 24,290.8 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.901 |
| 12:42 | 24,298.5 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.097 |
| 12:47 | 24,276.45 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.097 |
| 12:55 | 24,276.55 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.011 |
| 12:56 | 24,272.35 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.074 |
| 12:57 | 24,272.45 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.017 |
| 12:58 | 24,271.5 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.05 |
| 12:59 | 24,273.4 | BOTTOM | Bear/Bear/Bull/Bull | Mixed | No | 0.162 |
| 13:14 | 24,283 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.759 |
| 13:15 | 24,287.75 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.982 |
| 13:16 | 24,286.9 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.894 |
| 13:17 | 24,293.7 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.153 |
| 13:18 | 24,293.1 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 1.054 |
| 13:19 | 24,298.55 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.173 |
| 13:20 | 24,296.7 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 1.005 |
| 13:21 | 24,295.55 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.904 |
| 13:25 | 24,296.65 | TOP | Bull/Flat/Bull/Bull | Mixed | No | 0.819 |
| 13:31 | 24,297.95 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.797 |
| 13:35 | 24,294.8 | TOP | Bear/Flat/Flat/Bull | Mixed | No | 0.58 |
| 13:36 | 24,297 | TOP | Bull/Bear/Bull/Bull | Mixed | No | 0.771 |
| 13:37 | 24,299.4 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.949 |
| 13:38 | 24,295.2 | TOP | Bull/Bull/Flat/Bear | Mixed | No | 0.539 |
| 13:39 | 24,289.4 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.042 |
| 13:40 | 24,293 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.391 |
| 13:41 | 24,295.3 | TOP | Flat/Bear/Flat/Bull | Mixed | No | 0.609 |
| 13:42 | 24,289.2 | BOTTOM | Bear/Bear/Flat/Bear | Mixed | No | 0.079 |
| 13:43 | 24,289.25 | BOTTOM | Bull/Bear/Bear/Flat | Mixed | No | 0.13 |
| 13:44 | 24,289.85 | BOTTOM | Bear/Flat/Bear/Bull | Mixed | No | 0.208 |
| 13:45 | 24,289.15 | BOTTOM | Bear/Bear/Flat/Bear | Mixed | No | 0.187 |
| 13:46 | 24,286.85 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.07 |
| 13:47 | 24,287.75 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.169 |
| 13:48 | 24,286.5 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.101 |
| 13:49 | 24,285.35 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.076 |
| 13:51 | 24,288.25 | BOTTOM | Bear/Bull/Bull/Bear | Mixed | No | 0.289 |
| 13:52 | 24,287.7 | BOTTOM | Bear/Flat/Bull/Bear | Mixed | No | 0.276 |
| 13:55 | 24,287.05 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.288 |
| 13:57 | 24,285.65 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.177 |
| 13:58 | 24,281.45 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.128 |
| 13:59 | 24,282.95 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.072 |
| 14:00 | 24,285.6 | BOTTOM | Bear/Bear/Flat/Bull | Mixed | No | 0.313 |
| 14:01 | 24,285.05 | BOTTOM | Bear/Bear/Bull/Bear | Mixed | No | 0.264 |
| 14:02 | 24,283.3 | BOTTOM | Bear/Bear/Flat/Bear | Mixed | No | 0.121 |
| 14:03 | 24,281.65 | BOTTOM | Bear/Flat/Bear/Bear | Mixed | No | 0.025 |
| 14:04 | 24,283.55 | BOTTOM | Bear/Bull/Bear/Bull | Mixed | No | 0.237 |
| 14:05 | 24,278.5 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.111 |
| 14:06 | 24,279.8 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.067 |
| 14:07 | 24,282.4 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.292 |
| 14:08 | 24,283.15 | BOTTOM | Bear/Bull/Bull/Bull | Mixed | No | 0.365 |
| 14:09 | 24,282.3 | BOTTOM | Bear/Bear/Bull/Bear | Mixed | No | 0.313 |
| 14:10 | 24,285.5 | TOP | Bear/Bull/Bull/Bull | Mixed | No | 0.587 |
| 14:12 | 24,280.45 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.197 |
| 14:13 | 24,280.55 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.229 |
| 14:14 | 24,278.45 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.076 |
| 14:15 | 24,279.35 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.189 |
| 14:16 | 24,283.35 | TOP | Bear/Flat/Bull/Bull | Mixed | No | 0.615 |
| 14:17 | 24,289.45 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.161 |
| 14:18 | 24,289.65 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 1.054 |
| 14:19 | 24,287.2 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.82 |
| 14:20 | 24,289.7 | TOP | Bull/Bull/Flat/Bull | Mixed | No | 0.961 |
| 14:21 | 24,288.1 | TOP | Bull/Bull/Bear/Bear | Mixed | No | 0.821 |
| 14:22 | 24,290.55 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.929 |
| 14:23 | 24,291.8 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.94 |
| 14:24 | 24,294.35 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.998 |
| 14:25 | 24,292.05 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.841 |
| 14:26 | 24,294.4 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.911 |
| 14:27 | 24,297.85 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.996 |
| 14:28 | 24,297.95 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.934 |
| 14:29 | 24,295.8 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.807 |
| 14:30 | 24,297.8 | TOP | Bull/Bull/Flat/Bull | Mixed | No | 0.849 |
| 14:31 | 24,307.25 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.086 |
| 14:32 | 24,303.55 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.908 |
| 14:33 | 24,327 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.304 |
| 14:34 | 24,329.5 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.172 |
| 14:35 | 24,322.8 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.969 |
| 14:53 | 24,332 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.935 |
| 14:54 | 24,344.4 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.267 |
| 14:55 | 24,373 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.427 |
| 14:56 | 24,366.4 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 1.12 |
| 14:58 | 24,364.45 | TOP | Bull/Bull/Bear/Bull | Mixed | No | 0.956 |
| 15:29 | 24,435.95 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.572 |
| 15:30 | 24,435.95 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 1.245 |

## 2026-08-13  (09:15–11:50, 137 BB-ready minutes)

| Zone | Times | 4 Bull | 4 Bear | Mixed | Stacked rule |
|------|------:|-------:|-------:|------:|--------------|
| Top | 36 | 21 | 0 | 15 | 4 Bear @ top = **0** |
| Bottom | 26 | 0 | 17 | 9 | 4 Bull @ bottom = **0** |

| Time | Spot | BB | 15M/5M/3M/1M | TF pack | Stacked rule | %B |
|------|------|----|--------------|---------|--------------|-----|
| 09:44 | 24,349.2 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.915 |
| 09:49 | 24,351.55 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.915 |
| 09:55 | 24,354.65 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.877 |
| 10:05 | 24,342.4 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.18 |
| 10:07 | 24,353.3 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.769 |
| 10:08 | 24,345.4 | BOTTOM | Bull/Bear/Bull/Bear | Mixed | No | 0.255 |
| 10:09 | 24,343.85 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.188 |
| 10:10 | 24,337.9 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.062 |
| 10:11 | 24,336 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.047 |
| 10:12 | 24,333 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.061 |
| 10:18 | 24,332.95 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.034 |
| 10:21 | 24,334.35 | BOTTOM | Bear/Bear/Bull/Bear | Mixed | No | 0.16 |
| 10:24 | 24,328.6 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.02 |
| 10:25 | 24,329.05 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.096 |
| 10:26 | 24,327 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.062 |
| 10:28 | 24,328.3 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.141 |
| 10:29 | 24,326.9 | BOTTOM | Bear/Bear/Flat/Bear | Mixed | No | 0.123 |
| 10:30 | 24,318.85 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.084 |
| 10:31 | 24,312.95 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.124 |
| 10:32 | 24,314.95 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.02 |
| 10:43 | 24,330.8 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.811 |
| 10:44 | 24,330.3 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.777 |
| 10:45 | 24,330.15 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.764 |
| 10:46 | 24,330.6 | TOP | Bull/Bull/Flat/Flat | Mixed | No | 0.77 |
| 10:47 | 24,332.2 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.841 |
| 10:48 | 24,332.35 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.827 |
| 10:49 | 24,338.4 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.011 |
| 10:50 | 24,338.4 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.945 |
| 10:51 | 24,338.4 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.919 |
| 10:52 | 24,338.4 | TOP | Bull/Bull/Flat/Flat | Mixed | No | 0.896 |
| 10:53 | 24,343.9 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.037 |
| 10:54 | 24,343.65 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.973 |
| 10:55 | 24,342.55 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.888 |
| 10:56 | 24,342.5 | TOP | Bull/Bull/Bear/Flat | Mixed | No | 0.848 |
| 10:57 | 24,343.25 | TOP | Bull/Bull/Flat/Bull | Mixed | No | 0.839 |
| 11:02 | 24,331.5 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.201 |
| 11:03 | 24,327.35 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.025 |
| 11:04 | 24,327.4 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.054 |
| 11:05 | 24,324.45 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.023 |
| 11:06 | 24,322.7 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.024 |
| 11:07 | 24,320.55 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.019 |
| 11:08 | 24,316.9 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.04 |
| 11:09 | 24,319.9 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.105 |
| 11:21 | 24,325.05 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.661 |
| 11:22 | 24,320.6 | BOTTOM | Flat/Bull/Bull/Bear | Mixed | No | 0.37 |
| 11:23 | 24,320.6 | BOTTOM | Bull/Bull/Bear/Flat | Mixed | No | 0.39 |
| 11:24 | 24,328.25 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.05 |
| 11:25 | 24,328.25 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.988 |
| 11:26 | 24,328.25 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.929 |
| 11:27 | 24,331.95 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.065 |
| 11:28 | 24,333.3 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.05 |
| 11:29 | 24,334.65 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.024 |
| 11:30 | 24,339.95 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.123 |
| 11:31 | 24,342.1 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.077 |
| 11:32 | 24,346.8 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.093 |
| 11:33 | 24,346.95 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 1.002 |
| 11:34 | 24,347.9 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.955 |
| 11:35 | 24,347 | TOP | Bull/Bull/Flat/Bear | Mixed | No | 0.884 |
| 11:37 | 24,353.2 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.936 |
| 11:48 | 24,352.45 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.779 |
| 11:49 | 24,354.1 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.892 |
| 11:50 | 24,356.9 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.042 |

## 2026-08-14  (09:15–14:47, 314 BB-ready minutes)

| Zone | Times | 4 Bull | 4 Bear | Mixed | Stacked rule |
|------|------:|-------:|-------:|------:|--------------|
| Top | 67 | 44 | 0 | 23 | 4 Bear @ top = **0** |
| Bottom | 103 | 0 | 47 | 56 | 4 Bull @ bottom = **0** |

| Time | Spot | BB | 15M/5M/3M/1M | TF pack | Stacked rule | %B |
|------|------|----|--------------|---------|--------------|-----|
| 09:36 | 24,333.75 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.876 |
| 09:38 | 24,339.65 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.991 |
| 09:39 | 24,341.8 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.972 |
| 09:54 | 24,332 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.239 |
| 09:55 | 24,326.15 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.043 |
| 09:56 | 24,331.7 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.245 |
| 10:00 | 24,343.75 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.81 |
| 10:01 | 24,346.2 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.88 |
| 10:02 | 24,344.8 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.787 |
| 10:03 | 24,350.85 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.975 |
| 10:04 | 24,348.95 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.862 |
| 10:05 | 24,350.7 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.889 |
| 10:08 | 24,352.85 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.897 |
| 10:10 | 24,353.65 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.855 |
| 10:11 | 24,358.2 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.94 |
| 10:17 | 24,342.4 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.245 |
| 10:19 | 24,339.7 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.069 |
| 10:20 | 24,337.05 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.003 |
| 10:21 | 24,335.4 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.003 |
| 10:22 | 24,336.25 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.09 |
| 10:23 | 24,335.6 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.115 |
| 10:24 | 24,334.25 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.115 |
| 10:25 | 24,334.9 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.176 |
| 10:27 | 24,332.2 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.155 |
| 10:31 | 24,327.4 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.073 |
| 10:32 | 24,312.8 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.278 |
| 10:33 | 24,303.75 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.263 |
| 10:34 | 24,303.6 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | -0.11 |
| 10:35 | 24,307.6 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.046 |
| 10:49 | 24,335 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.936 |
| 10:51 | 24,335.35 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.906 |
| 10:52 | 24,336.35 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.882 |
| 10:54 | 24,337 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.865 |
| 10:59 | 24,317.3 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.055 |
| 11:00 | 24,310.8 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.092 |
| 11:01 | 24,308.95 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.066 |
| 11:02 | 24,308.9 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.006 |
| 11:17 | 24,318.95 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.709 |
| 11:18 | 24,322.15 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.962 |
| 11:19 | 24,323.8 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.998 |
| 11:20 | 24,327.65 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.105 |
| 11:21 | 24,326.85 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.997 |
| 11:22 | 24,330.7 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.103 |
| 11:23 | 24,326.25 | TOP | Bull/Bull/Bear/Bear | Mixed | No | 0.837 |
| 11:24 | 24,326.8 | TOP | Bull/Bull/Flat/Bull | Mixed | No | 0.828 |
| 11:30 | 24,315.25 | BOTTOM | Flat/Bear/Bear/Bear | Mixed | No | 0.208 |
| 11:31 | 24,312.45 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.103 |
| 11:38 | 24,313.9 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.15 |
| 11:44 | 24,327.35 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.988 |
| 11:45 | 24,327.85 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.989 |
| 11:46 | 24,329.6 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.043 |
| 11:47 | 24,336.2 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.181 |
| 11:48 | 24,332.75 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.955 |
| 11:53 | 24,333.05 | TOP | Bull/Flat/Bull/Bull | Mixed | No | 0.841 |
| 11:56 | 24,333.6 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.789 |
| 12:01 | 24,325.3 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.248 |
| 12:02 | 24,322.9 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.056 |
| 12:03 | 24,324.15 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.118 |
| 12:04 | 24,322.65 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.058 |
| 12:05 | 24,321.85 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.061 |
| 12:07 | 24,333.55 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.871 |
| 12:08 | 24,338.2 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.094 |
| 12:09 | 24,335 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.857 |
| 12:10 | 24,335.95 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.866 |
| 12:11 | 24,338.45 | TOP | Bull/Bull/Flat/Bull | Mixed | No | 0.939 |
| 12:12 | 24,342.1 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.02 |
| 12:13 | 24,339.5 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.87 |
| 12:14 | 24,340.55 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.873 |
| 12:15 | 24,342.5 | TOP | Bull/Bull/Flat/Bull | Mixed | No | 0.896 |
| 12:16 | 24,342.7 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.865 |
| 12:17 | 24,343.45 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.848 |
| 12:19 | 24,346.1 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.85 |
| 12:20 | 24,348.65 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.88 |
| 12:24 | 24,351 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.855 |
| 12:25 | 24,352.6 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.913 |
| 12:26 | 24,349.4 | TOP | Bull/Bull/Flat/Bear | Mixed | No | 0.78 |
| 12:32 | 24,342.5 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.246 |
| 12:33 | 24,342.3 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.201 |
| 12:34 | 24,344.5 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.351 |
| 12:35 | 24,342.55 | BOTTOM | Bear/Bear/Flat/Bear | Mixed | No | 0.18 |
| 12:36 | 24,344.05 | BOTTOM | Bear/Bear/Bull/Bull | Mixed | No | 0.3 |
| 12:37 | 24,341 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.065 |
| 12:38 | 24,341.9 | BOTTOM | Bear/Flat/Bear/Bull | Mixed | No | 0.164 |
| 12:39 | 24,343.55 | BOTTOM | Bear/Bear/Flat/Bull | Mixed | No | 0.311 |
| 12:40 | 24,341.95 | BOTTOM | Bear/Bear/Bull/Bear | Mixed | No | 0.215 |
| 12:41 | 24,340.95 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.174 |
| 12:42 | 24,335.25 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.1 |
| 12:43 | 24,334.6 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.037 |
| 12:44 | 24,336.6 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.116 |
| 12:45 | 24,336.65 | BOTTOM | Bear/Bear/Bull/Flat | Mixed | No | 0.135 |
| 12:46 | 24,336.75 | BOTTOM | Bear/Bear/Bull/Flat | Mixed | No | 0.168 |
| 12:47 | 24,338.25 | BOTTOM | Bear/Bull/Bull/Bull | Mixed | No | 0.29 |
| 12:49 | 24,344.55 | TOP | Flat/Bull/Bull/Bull | Mixed | No | 0.755 |
| 12:50 | 24,346 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.873 |
| 12:51 | 24,348.1 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.983 |
| 12:52 | 24,349 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.973 |
| 12:53 | 24,349.95 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.961 |
| 12:54 | 24,348.75 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.863 |
| 12:55 | 24,349.5 | TOP | Bull/Bull/Flat/Bull | Mixed | No | 0.863 |
| 12:56 | 24,350.2 | TOP | Bull/Bull/Flat/Bull | Mixed | No | 0.862 |
| 12:57 | 24,350.65 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.843 |
| 13:07 | 24,344.5 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.26 |
| 13:08 | 24,342.3 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.058 |
| 13:09 | 24,342 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | -0.026 |
| 13:10 | 24,342.55 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.081 |
| 13:11 | 24,343.95 | BOTTOM | Bear/Bear/Bull/Bull | Mixed | No | 0.241 |
| 13:12 | 24,344.05 | BOTTOM | Bear/Flat/Bull/Flat | Mixed | No | 0.274 |
| 13:13 | 24,343.35 | BOTTOM | Bear/Bull/Bull/Bear | Mixed | No | 0.235 |
| 13:14 | 24,345.55 | BOTTOM | Flat/Bull/Bull/Bull | Mixed | No | 0.458 |
| 13:15 | 24,345.75 | BOTTOM | Bear/Bull/Bull/Flat | Mixed | No | 0.495 |
| 13:16 | 24,345.65 | BOTTOM | Bear/Bull/Bull/Flat | Mixed | No | 0.509 |
| 13:17 | 24,341.8 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.092 |
| 13:18 | 24,344.45 | BOTTOM | Bear/Bull/Bear/Bull | Mixed | No | 0.435 |
| 13:19 | 24,345.3 | BOTTOM | Bear/Flat/Flat/Bull | Mixed | No | 0.543 |
| 13:20 | 24,343.85 | BOTTOM | Bear/Bear/Bull/Bear | Mixed | No | 0.374 |
| 13:21 | 24,344.35 | BOTTOM | Bear/Bear/Flat/Flat | Mixed | No | 0.471 |
| 13:22 | 24,344.9 | BOTTOM | Flat/Bull/Flat/Bull | Mixed | No | 0.581 |
| 13:23 | 24,343.9 | BOTTOM | Bull/Bear/Flat/Bear | Mixed | No | 0.429 |
| 13:24 | 24,343.05 | BOTTOM | Bull/Bear/Bear/Bear | Mixed | No | 0.287 |
| 13:25 | 24,344.1 | BOTTOM | Bull/Flat/Bear/Bull | Mixed | No | 0.509 |
| 13:26 | 24,338.75 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.266 |
| 13:27 | 24,338.7 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | -0.109 |
| 13:28 | 24,338.95 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.002 |
| 13:29 | 24,341.75 | BOTTOM | Bear/Bear/Bull/Bull | Mixed | No | 0.329 |
| 13:30 | 24,340 | BOTTOM | Bear/Bear/Bull/Bear | Mixed | No | 0.159 |
| 13:31 | 24,340 | BOTTOM | Bear/Bull/Bull/Flat | Mixed | No | 0.192 |
| 13:32 | 24,338.9 | BOTTOM | Bear/Flat/Bear/Bear | Mixed | No | 0.125 |
| 13:33 | 24,334.55 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.127 |
| 13:34 | 24,332.85 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.111 |
| 13:35 | 24,330.25 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.127 |
| 13:36 | 24,329 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.075 |
| 13:37 | 24,330.2 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.058 |
| 13:40 | 24,348.3 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.949 |
| 13:41 | 24,352.3 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.051 |
| 13:42 | 24,350.85 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.946 |
| 13:43 | 24,352.4 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.952 |
| 13:44 | 24,355.85 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.996 |
| 13:45 | 24,357.5 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 0.977 |
| 13:46 | 24,383.4 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.299 |
| 13:47 | 24,389.55 | TOP | Bull/Bull/Bull/Bull | 4Bull | No | 1.182 |
| 13:48 | 24,379.75 | TOP | Bull/Bull/Bull/Bear | Mixed | No | 0.954 |
| 14:13 | 24,385.55 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.215 |
| 14:15 | 24,382.8 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.11 |
| 14:16 | 24,384.15 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.163 |
| 14:18 | 24,385.4 | BOTTOM | Bear/Flat/Bull/Bear | Mixed | No | 0.219 |
| 14:19 | 24,382.15 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.121 |
| 14:20 | 24,378.55 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.043 |
| 14:21 | 24,378.7 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.102 |
| 14:22 | 24,376.2 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.058 |
| 14:23 | 24,373.1 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.006 |
| 14:24 | 24,376.7 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.147 |
| 14:25 | 24,377.15 | BOTTOM | Bear/Bear/Bull/Flat | Mixed | No | 0.191 |
| 14:27 | 24,375.65 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.18 |
| 14:28 | 24,371.45 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.051 |
| 14:29 | 24,372.25 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.126 |
| 14:30 | 24,372.5 | BOTTOM | Bear/Bear/Bear/Flat | Mixed | No | 0.166 |
| 14:31 | 24,372.7 | BOTTOM | Bear/Bear/Bull/Flat | Mixed | No | 0.199 |
| 14:32 | 24,372.7 | BOTTOM | Bear/Bear/Flat/Flat | Mixed | No | 0.225 |
| 14:34 | 24,371.7 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.223 |
| 14:36 | 24,371.15 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.239 |
| 14:38 | 24,367.45 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | -0.018 |
| 14:39 | 24,370.35 | BOTTOM | Bear/Bear/Bear/Bull | Mixed | No | 0.208 |
| 14:40 | 24,369.15 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.139 |
| 14:41 | 24,371.45 | BOTTOM | Bear/Flat/Bull/Bull | Mixed | No | 0.358 |
| 14:42 | 24,372.8 | TOP | Bear/Bear/Bull/Bull | Mixed | No | 0.505 |
| 14:43 | 24,372.9 | TOP | Bull/Bull/Bull/Flat | Mixed | No | 0.516 |
| 14:44 | 24,371.05 | BOTTOM | Bear/Bull/Flat/Bear | Mixed | No | 0.349 |
| 14:45 | 24,369.45 | BOTTOM | Bear/Flat/Bear/Bear | Mixed | No | 0.196 |
| 14:46 | 24,371.45 | BOTTOM | Bear/Flat/Bear/Bull | Mixed | No | 0.455 |
| 14:47 | 24,369.1 | BOTTOM | Bear/Bear/Bear/Bear | 4Bear | No | 0.126 |

---
Live paper engine remains: Put ΔOI ≥ 2.5L + green/red candle + **4 Bull → CE / 4 Bear → PE**. BB stacked CE-at-lower / PE-at-upper is **not** enabled (0 fills on this tape).

