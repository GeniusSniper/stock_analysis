# data/

The auto-trader on `simulation.html` writes its files here once you link this
folder (button: **Link data folder** in the Auto-trader panel — pick this
`data` folder when the browser asks; Chromium browsers only, and the page
must be served from Live Server / localhost for folder access to work).

Files it maintains automatically:

| File | What's inside |
|---|---|
| `auto_trader_life.json` | Its full life: rules, status, learned weights, open positions, journal, equity curve |
| `journal.csv` | Every closed trade: entry/exit dates and prices, strategy, shares, P&L |
| `equity_curve.csv` | Account value over simulated time (date, value) |

The files are rewritten at every checkpoint (quarterly progress, stop, and
when it catches up to the present). Virtual money — educational only.
