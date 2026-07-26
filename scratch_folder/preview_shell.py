"""Shared chrome for the draft preview pages.

Both pilots render the same way — a masthead, a transport bar with a scrubber,
one black-plated sheet per chart, then a findings panel. Only the copy and the
inlined SVGs differ, so the shell lives here rather than being pasted into each
build script.
"""

CSS = """
  /* Cool graphite ground biased toward the SPR chart's navy. The chart sheets
     stay black in both themes: the previews plate the graphic so the white type
     is legible, while the shipped SVGs carry no backdrop at all. */
  :root {
    --ground:#e8ebef; --surface:#fff; --line:#ccd2da; --line-soft:#dfe4ea;
    --ink:#171a1f; --ink-mid:#5a626d; --ink-dim:#8b929c;
    --navy:#0a4286; --rust:#e6550d;
    --shadow:0 1px 2px rgba(16,24,40,.06), 0 8px 24px rgba(16,24,40,.06);
    --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    color-scheme:light;
  }
  @media (prefers-color-scheme:dark){
    :root{--ground:#14171c;--surface:#1c2027;--line:#2c323b;--line-soft:#242932;
      --ink:#e3e8ef;--ink-mid:#9aa3af;--ink-dim:#6b7480;
      --navy:#7aa7e0;--rust:#ff8340;
      --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
      color-scheme:dark;}
  }
  :root[data-theme="dark"]{--ground:#14171c;--surface:#1c2027;--line:#2c323b;
    --line-soft:#242932;--ink:#e3e8ef;--ink-mid:#9aa3af;--ink-dim:#6b7480;
    --navy:#7aa7e0;--rust:#ff8340;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);color-scheme:dark;}
  :root[data-theme="light"]{--ground:#e8ebef;--surface:#fff;--line:#ccd2da;
    --line-soft:#dfe4ea;--ink:#171a1f;--ink-mid:#5a626d;--ink-dim:#8b929c;
    --navy:#0a4286;--rust:#e6550d;
    --shadow:0 1px 2px rgba(16,24,40,.06), 0 8px 24px rgba(16,24,40,.06);
    color-scheme:light;}

  body{margin:0;background:var(--ground);color:var(--ink);
    font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased;}
  .page{max-width:940px;margin:0 auto;padding:40px 24px 72px;
    display:flex;flex-direction:column;gap:22px;}

  .masthead{display:flex;flex-direction:column;gap:6px;}
  .eyebrow{font:500 11px/1 var(--mono);letter-spacing:.1em;
    text-transform:uppercase;color:var(--ink-dim);}
  .masthead h1{font-size:27px;font-weight:620;letter-spacing:-.02em;margin:0;
    text-wrap:balance;}
  .standfirst{margin:0;max-width:62ch;color:var(--ink-mid);}
  .backlink{font:500 12px/1 var(--mono);color:var(--ink-dim);text-decoration:none;}
  .backlink:hover{color:var(--navy);}

  .transport{position:sticky;top:0;z-index:5;display:flex;align-items:center;
    gap:16px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);
    border-radius:10px;padding:12px 16px;box-shadow:var(--shadow);}
  button{font:500 14px/1 var(--sans);background:var(--ink);color:var(--ground);
    border:0;border-radius:7px;padding:10px 18px;cursor:pointer;transition:opacity .15s;}
  button:hover{opacity:.85;}
  button:focus-visible{outline:2px solid var(--navy);outline-offset:2px;}
  .scrub{display:flex;align-items:center;gap:10px;flex:1;min-width:240px;}
  .scrub label{font:500 11px/1 var(--mono);letter-spacing:.08em;
    text-transform:uppercase;color:var(--ink-dim);}
  input[type=range]{flex:1;accent-color:var(--navy);min-width:120px;}
  input[type=range]:focus-visible{outline:2px solid var(--navy);outline-offset:3px;}
  .clock{font:500 13px/1 var(--mono);font-variant-numeric:tabular-nums;
    color:var(--ink-mid);min-width:4.5ch;text-align:right;}
  .hint{font-size:13px;color:var(--ink-dim);}

  .sheet{background:var(--surface);border:1px solid var(--line);border-radius:10px;
    box-shadow:var(--shadow);overflow:hidden;}
  .sheet-hd{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
    padding:14px 18px;border-bottom:1px solid var(--line-soft);}
  .sheet-hd h2{font-size:15px;font-weight:600;margin:0;letter-spacing:-.01em;}
  .idx{font:600 11px/1 var(--mono);color:var(--ink-dim);letter-spacing:.06em;}
  .technique{margin-left:auto;font:500 11px/1 var(--mono);
    border:1px solid currentColor;border-radius:999px;padding:5px 10px;}
  .technique.draw{color:var(--rust);}
  .technique.wipe{color:var(--navy);}
  .technique.camera{color:var(--ink-mid);}
  .stage{background:#000;padding:0;overflow-x:auto;}
  .stage svg{display:block;margin:0 auto;}
  /* A 9:16 frame at full width would be taller than most screens. */
  .stage.vertical svg{width:auto;max-height:78vh;}

  /* Each chart drives itself — the sequences run to different lengths, so a
     single shared scrubber could only ever be right for one of them. */
  .deck{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
    padding:11px 16px;border-top:1px solid var(--line-soft);}
  .deck button{padding:7px 14px;font-size:13px;}
  .deck input[type=range]{flex:1;min-width:140px;}
  .deck .clock{font:500 12px/1 var(--mono);font-variant-numeric:tabular-nums;
    color:var(--ink-mid);min-width:5.5ch;text-align:right;}
  .deck .len{font:500 11px/1 var(--mono);color:var(--ink-dim);
    letter-spacing:.06em;text-transform:uppercase;}

  .findings{background:var(--surface);border:1px solid var(--line);
    border-radius:10px;padding:22px 24px;display:flex;flex-direction:column;gap:18px;}
  .findings h3{font:500 11px/1 var(--mono);letter-spacing:.1em;
    text-transform:uppercase;color:var(--ink-dim);margin:0;}
  .finding{display:flex;flex-direction:column;gap:4px;}
  .finding b{font-weight:600;}
  .finding p{margin:0;color:var(--ink-mid);max-width:68ch;}
  code{font:12.5px var(--mono);background:var(--line-soft);padding:1.5px 5px;
    border-radius:4px;color:var(--ink);}
  table{width:100%;border-collapse:collapse;font-size:14px;}
  th,td{text-align:left;padding:9px 12px 9px 0;
    border-bottom:1px solid var(--line-soft);vertical-align:top;}
  th{font:500 11px/1.4 var(--mono);letter-spacing:.06em;
    text-transform:uppercase;color:var(--ink-dim);}
  td:first-child{color:var(--ink-mid);white-space:nowrap;}
  tr:last-child th,tr:last-child td{border-bottom:0;}
  .num{font-variant-numeric:tabular-nums;}

  @media (prefers-reduced-motion:reduce){*{transition:none !important;}}
"""

# Each sheet drives its own SVG. The page-level button just replays them all
# together, which is the only thing a shared control can honestly do when the
# sequences are different lengths.
SCRIPT = """
  document.querySelectorAll('.sheet').forEach(sheet => {
    const svg   = sheet.querySelector('.stage svg');
    const range = sheet.querySelector('input[type=range]');
    const clock = sheet.querySelector('.clock');
    const play  = sheet.querySelector('[data-play]');
    if (!svg) return;
    let following = true;

    const show = t => clock.textContent = t.toFixed(2) + 's';

    const restart = () => {
      following = true;
      svg.setCurrentTime(0);
      svg.unpauseAnimations();
    };
    play.addEventListener('click', restart);
    sheet.restart = restart;

    range.addEventListener('input', () => {
      following = false;
      const t = +range.value;
      svg.pauseAnimations();
      svg.setCurrentTime(t);
      show(t);
    });

    (function tick() {
      if (following) {
        const t = Math.min(svg.getCurrentTime(), +range.max);
        range.value = t;
        show(t);
      }
      requestAnimationFrame(tick);
    })();
  });

  document.getElementById('play-all').addEventListener('click', () => {
    document.querySelectorAll('.sheet').forEach(s => s.restart && s.restart());
  });
"""


def sheet(idx, heading, technique, technique_class, svg_markup, duration,
          vertical=False):
    """One chart, with its own play/scrub deck.

    `duration` is that sequence's own length — the scrubber is scaled to it, so
    the whole slider travel is useful however long or short the chart runs.
    """
    return (
        f'<section class="sheet" data-dur="{duration}">'
        f'<div class="sheet-hd">'
        f'<span class="idx">{idx}</span><h2>{heading}</h2>'
        f'<span class="technique {technique_class}">{technique}</span></div>'
        f'<div class="stage{" vertical" if vertical else ""}">{svg_markup}</div>'
        f'<div class="deck">'
        f'<button type="button" data-play>Replay</button>'
        f'<input type="range" min="0" max="{duration}" step="0.01" value="0" '
        f'aria-label="{heading} timeline">'
        f'<span class="clock">0.00s</span>'
        f'<span class="len">/ {duration:g}s</span>'
        f'</div></section>'
    )


def finding(title, body):
    return f'<div class="finding"><b>{title}</b><p>{body}</p></div>'


def page(title, eyebrow, standfirst, sheets, findings, backlink=True):
    """Assemble a full body-only page (no doctype/head/body wrapper)."""
    back = '<a class="backlink" href="/">&larr; all drafts</a>' if backlink else ""
    return f"""<title>{title}</title>
<style>{CSS}</style>
<div class="page">
  <header class="masthead">
    {back}
    <span class="eyebrow">{eyebrow}</span>
    <h1>{title}</h1>
    <p class="standfirst">{standfirst}</p>
  </header>

  <div class="transport">
    <button id="play-all" type="button">Replay all</button>
    <span class="hint">Each chart has its own timeline below it.</span>
  </div>

  {"".join(sheets)}

  <section class="findings">
    <h3>What the pilot found</h3>
    {"".join(findings)}
  </section>
</div>
<script>{SCRIPT}</script>
"""


def standalone(body, title):
    """Wrap a body-only page for opening over file:// or serving statically."""
    return (
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
        '<meta name="robots" content="noindex, nofollow">\n'
        f"<title>{title}</title>\n</head>\n<body>\n{body}\n</body>\n</html>\n"
    )
