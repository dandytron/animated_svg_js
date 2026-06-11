const CONFIG = {
  selectedClass:          'selected',
  defaultTotalDuration:   8,
  defaultElementDuration: 2,
  defaultFetchWidth:      720,
  testChartId:            'scatter_plot',

  // Registry of known Datawrapper series containers, one entry per chart type.
  // To add a new chart type, append an entry here — no other file needs to change.
  //
  //   rootId           — SVG group id that holds the series
  //   select: 'children' — each direct child matching childTag is one animatable element
  //   select: 'root'     — the container group itself is the single animatable element
  //   childTag         — (children mode) lowercase tag name to match; omit to accept any
  //   defaultAnimation — skip auto-detection and use this type (needed when the element
  //                      is a bare <path> or <g> with no inspectable children)
  chartRoots: [
    { rootId: 'lines-svg',      select: 'children', childTag: 'g'                                        },
    { rootId: 'areas-svg',      select: 'children', childTag: 'path', defaultAnimation: 'fade_in'        },
    { rootId: 'columns-svg',    select: 'children', childTag: 'g', defaultAnimation: 'grow_from_baseline' },
    { rootId: 'dots-svg',       select: 'root',                       defaultAnimation: 'pop_in'          },
    { rootId: 'area-fills-svg', select: 'root',                       defaultAnimation: 'fade_in'         },
  ],
};

// Escape backslashes and double-quotes in an id for use inside an [id="…"]
// attribute selector. Datawrapper ids contain spaces, so CSS.escape/#id
// selectors don't work. Defined once here (first script loaded) and shared
// globally by detect.js, animate.js, export.js, and app.js.
function _esc(id) {
  return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
