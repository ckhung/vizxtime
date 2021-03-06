/* jshint esversion: 6, loopfunc: true */
/* global console, alert, location, d3, $, Parser, queue, Blob, saveAs, md5 */

// http://javascriptissexy.com/oop-in-javascript-what-you-need-to-know/
// http://yehudakatz.com/2011/08/12/understanding-prototypes-in-javascript/
function Region(name) {
  this.name = name;
  // note: initialization of {} fields must occur
  // in the constructor, not in .prototype,
  // or else different objects will point to the
  // single same {} due to shallow copying from .prototype
  this.raw = [];
  this.ev = {};
  // re-evaluated in recalcRedraw() after each change of expressions
}

Region.prototype = {
  constructor: Region,
  show: true
};

var G = {
  viewBox: {},		// width and height of viewBox of #rsvg-box
  regTable: {},		// basic table for regions, may contain info about non-used regions
  regObjs: {},		// hash of region objects, keyed by region names
  lastFocus: null,	// the html input element that most recently received input focus
  domain: {},		// min and max of xAxis, yAxis, width
  time: {},		// time-related info
  scale: {},		// the scale objects for xAxis, yAxis, and width
  fn2Var: [],		// [field name] to [variable name] hash
  fnTree: {},		// field name tree for constructing the nested menu
  parsedSample: {},	// values of var's in sample data
  xtraFun: {		// extra functions for the (expression) Parser.
    'ZaBin': XFZaBin,
  },
  exprFields: { xAxis:null, yAxis:null, width:null }
			// expressions for xAxis, yAxis, and width
}; // global variables

var configFN = $.url(location.href).param('config');
if (! configFN) { configFN = 'config.json'; }
$.getJSON(configFN)
  .done(function(data) {
    G.config = {
      transition: 1000,
      opacity: 0.4,
      palette: 0,
      width: {
	min: 40,
	max: 80
      }
    };
    $.extend(true, G.config, data);
    if (! G.config.disp) { G.config.disp = G.config.dimExpr.region; }
    queue()
      .defer(d3.csv, G.config.filename.regions)
      .defer(d3.csv, G.config.filename.data)
      .awaitAll(init);
  })
  .fail(function( jqxhr, textStatus, error ) {
    var msg = 'failed reading config file "' + configFN + '"';
    alert(msg);
    throw new Error(msg);
  });

function genPalette(container) {
  var i, j, t;
  t = '';
  for (i=0; i<5; ++i) {
    t += '<tr>\n';
    for (j=0; j<8; ++j) {
      var s = '<td><input id="pal-@" type="radio" name="palette"' +
	'value="@" /><label for="pal-@" width="100%">@</label></td>\n';
      t += s.replace(/@/g, (100+i*8+j).toString().substr(1));
    }
    t += '</tr>\n';
  }
  container.append('table').html('<table>' + t + '</table>');
  $('#pal-00').attr('checked', 1);
}

function init(error, data) {
  /******************* received input data files *******************/
  if (error) { return console.warn(error); }

  organizeData(data);
  console.log(G);

  d3.select('#region-file').text(G.config.filename.regions);
  d3.select('#data-file').text(G.config.filename.data);
  ['region', 'time', 'color'].forEach(function(k) {
    d3.select('#'+k+'-field').property('value', G.config.dimExpr[k]);
  });
  genPalette(d3.select('#palette-field'));
  Object.keys(G.exprFields).forEach(function(k) {
    d3.select('#'+k+'-field').property('value', G.config.dimExpr[k]);
  });
  $('.editable').focus(function () {
    if (G.lastFocus) { G.lastFocus.removeClass('active'); }
    G.lastFocus = $(this);
    G.lastFocus.addClass('active');
  });

  var sample = {};
  sample.region = G.regObjs[Object.keys(G.regObjs)[0]];
  sample.time = 0;
  sample.data = sample.region.raw[sample.time];

//G.sample = sample;
  var fnlist = Object.keys(sample.data).filter(function (d) {
    return d != G.config.dimExpr['region'] &&
      d != G.config.dimExpr['time'];
  });
//G.fnlist = fnlist;
  fnlist.sort(function(a,b) {
    var n = a.length - b.length;
    return n ? -n : a.localeCompare(b);
  });
  // reverse sort by string length, then sort by locale,
  // so that longer names appear earlier.
  // e.g. "mno:pqr:xyz" appears earlier than "pqr:xyz",
  // which appears earlier than "pqr"
  // Thus more specific names are substituted first
  // in variable substitutions

  fnlist.forEach(function (fn, i) {
    i = i + 10000;
    G.fn2Var[fn] = 'VxT' + i.toString().substr(1);
    G.parsedSample[G.fn2Var[fn]] = (sample.data[fn] || NaN);
  });

  for (var fn in G.fn2Var) {
    var par = G.fnTree;
    fn.split(':').forEach(function (seg) {
      if (! (seg in par)) { par[seg] = {}; }
      par = par[seg];
    });
  }

  $('#data-field-names').html(genNestedList(G.fnTree));
  $('#data-field-names > ul').attr('id', 'fn-menu').menu();

  var mx = G.time.labels.length-1;
  G.time.slider = d3.slider().axis(true).min(0).max(mx)
    .step(1).value(mx).on('slide', toTime);
  d3.select('#time-slider').call(G.time.slider);
  d3.select('#time-text').text(G.time.labels[mx]);

  var gpzoom = d3.behavior.zoom()
    .scaleExtent([0.2, 8])
    .on('zoom', function () {
      d3.select('#viz-canvas').attr('transform', 'translate(' +
        d3.event.translate + ')scale(' + d3.event.scale + ')');
    });

  // http://bl.ocks.org/cpdean/7a71e687dd5a80f6fd57
  // https://stackoverflow.com/questions/16265123/resize-svg-when-window-is-resized-in-d3-js (responsive svg)
  d3.select('#rsvg-box svg')
    .call(gpzoom)
    .append('g')
    .attr('id', 'viz-canvas');
  G.canvas = d3.select('#viz-canvas');

  var VB = d3.select('#rsvg-box svg')
    .attr('viewBox').split(' ').map(parseFloat);
  G.viewBox = { width: VB[2], height: VB[3] };

  G.canvas.append('g').attr('id', 'xAxis');
  G.canvas.append('g').attr('id', 'yAxis');

  d3.select('#rsvg-box svg')
    .append('text')
    .attr('id', 'xlabel')
    .attr('x', G.viewBox.width/2)
    .attr('y', G.viewBox.height-2);
  d3.select('#rsvg-box svg')
    .append('text')
    .attr('id', 'ylabel')
    .attr('transform', 'translate(18,' + G.viewBox.height/2 + ') rotate(-90)');

  $('#region-selector').slideReveal({
    trigger: $('#rs-trigger'),
    push: true,
    position: 'right',
    width: '25%',
  });

  for (var name in G.regObjs) {
    var reg = G.regObjs[name];
    // http://stackoverflow.com/questions/1443233/easier-way-to-get-a-jquery-object-from-appended-element
    var button = $('<button class="region">' + name + '</button> ').appendTo($('#region-selector'));
    reg.button = button;
    // no need for this: reg.button = $('#region-selector button:last-child');

    // https://api.jquery.com/data/
    button.data('region', reg);
  }

  $('#region-selector button.region').click(function() {
    var reg = G.regObjs[$(this).text()];
    reg.show = ! reg.show;
    reg.circle.attr('visibility', reg.show ? 'visible' : 'hidden');
    paintButton($(this));
  });

  recalcRedraw();
}

function organizeData(data) {
  // field name for "region", field name for "time"
  var name, reg, i, k, region,
    regionFN = G.config.dimExpr['region'],
    timeFN = G.config.dimExpr['time'],
    colorFN = G.config.dimExpr['color'];

  data[0].forEach(function (d) {
    name = String(d[regionFN]);
    // skip empty rows
    if (! name) { return; }
    d.color = d[colorFN];
    if (! d.color) { d.color = '#000'; }
    delete d[regionFN];
    delete d[colorFN];
    G.regTable[name] = d;
  });

  G.time.labels = data[1].map(function (d) {
    return d[G.config.dimExpr['time']];
  }).filter(function(v, i, self) {
    // https://stackoverflow.com/questions/1960473/get-all-unique-values-in-a-javascript-array-remove-duplicates
    return self.indexOf(v) == i;
  }).sort();
  G.time.l2i = {}; // label-to-index converter
  for (i=0; i<G.time.labels.length; ++i) {
    G.time.l2i[G.time.labels[i]] = i;
  }
  // from now on, use time indices instead of time labels

  // initialize G.regObjs from the data file
  data[1].forEach(function (d) {
    name = String(d[regionFN]);
    // skip empty rows and incomplete rows
    if (! (name && d[timeFN])) { return; }
    if (! (name in G.regTable)) {
      console.log('ignoring unknown region "' + name + '"');
      return;
    }
    if (! (name in G.regObjs)) { G.regObjs[name] = new Region(name); }
    G.regObjs[name].raw[G.time.l2i[d[timeFN]]] = d;
    G.regObjs[name].prop = G.regTable[name];
  });

  // join the regions file into the .raw field of region objects
  for (name in G.regObjs) {
    reg = G.regObjs[name];
    for (i=0; i<G.time.labels.length; ++i) {
      for (k in reg.prop) {
	reg.raw[i][k] = reg.prop[k];
      }
    }
  }

}

function genNestedList(fnTree, level) {
  if (! level) { level = 0; }
  var prefix = '  '.repeat(level), r = prefix + '<ul>\n';
  Object.keys(fnTree).sort().forEach(function (n) {
    r += prefix + '<li class="fn-segment">';
    if (fnTree[n] && typeof fnTree[n] === 'object' &&
      Object.keys(fnTree[n]).length > 0) {
      r += '<div class="fn-segment">' + n +
	'</div>' + genNestedList(fnTree[n], level+1);
    } else {
      r += '<div class="fn-segment" onclick="pasteFieldName(this)">' + n + '</div>';
    }
    r += '</li>\n';
  });
  return r + prefix + '</ul>';
}

function pasteFieldName(div) {
  if (! G.lastFocus) { return; }
  const fields = ['xAxis-field', 'yAxis-field', 'width-field'];
  if (fields.indexOf(G.lastFocus.attr('id')) < 0) { return; }
  div = $(div);
  var fieldName = div.text();
  do {
    div = div.parent('li').parent('ul').parent('li').children('div');
    if (div.length < 1) { break; }
    fieldName = div.text() + ':' + fieldName;
  } while (1);
  console.log(fieldName);
  var f = G.lastFocus;
  var s = f.val();
  f.val(
    s.substring(0,f.prop('selectionStart')) +
    fieldName +
    s.substring(f.prop('selectionEnd'), s.length)
  );
  G.lastFocus.focus();
}

function recalcRedraw() {
  var rawExpr, expr, field, name, reg, region, i, fn, k;
  for (field in G.exprFields) {
    G.domain[field] = { max: -9e99, min: 9e99 };
    rawExpr = expr = d3.select('#'+field+'-field').property('value');
    Object.keys(G.fn2Var).forEach(function (fn) {
      expr = expr.replace(new RegExp(fn, 'g'), G.fn2Var[fn]);
    });
    // http://javascript.info/tutorial/exceptions
    try {
      G.exprFields[field] = Parser.parse(expr);
      $.extend(G.exprFields[field].functions, G.xtraFun);
      G.exprFields[field].evaluate(G.parsedSample);
    } catch(e) {
      alert('Failed parsing "' + field + '" field:\n[ ' + expr + ' ]\n' + e.toString());
      return;
    }
    G.config.dimExpr[field] = rawExpr;
  }

  var palette = parseInt($('input[name=palette]:checked').val());
  for (name in G.regObjs) {
    reg = G.regObjs[name];
    var col = reg.prop.color;
    if (col.match(/#?(\w\w)(\w\w)(\w\w)$/) || col.match(/#?(\w)(\w)(\w)$/)) {
      reg.rgbcolor = col;
    } else {
      var m5 = md5(col);
      reg.rgbcolor = '#' + (m5 + m5).substring(palette, palette+3);
      // https://github.com/blueimp/JavaScript-MD5
    }
    paintButton(reg.button);
    for (i=0; i<G.time.labels.length; ++i) {
      reg.ev[i] = {};
      if (typeof reg.raw[i] == 'undefined') {
	reg.raw[i] = {};
      }
      var subst = {};
      for (fn in reg.raw[i]) {
	subst[G.fn2Var[fn]] = reg.raw[i][fn];
      }
      for (field in G.exprFields) {
	try {
	  var v = parseFloat(G.exprFields[field].evaluate(subst));
	  if (v > G.domain[field].max) { G.domain[field].max = v; }
	  if (v < G.domain[field].min) { G.domain[field].min = v; }
	  reg.ev[i][field] = v;
	} catch(e) {
	  console.log('Failed evaluating "' + field + '" field for ' + G.time.labels[i] + ',' + region + '\n' + e.toString());
	}
      }
      reg.disp = G.config.disp.replace(G.config.dimExpr.region, reg.name);
      for (field in reg.prop) {
        reg.disp = reg.disp.replace(field, reg.prop[field]);
      }
      var now = reg.ev[i];
      now.opac =
	isNaN(now.xAxis) || isNaN(now.yAxis) || isNaN(now.width) ?
	0 : G.config.opacity;
    }
  }

  d3.select('#xlabel').text(G.config.dimExpr['xAxis']);
  d3.select('#ylabel').text(G.config.dimExpr['yAxis']);

  // http://stackoverflow.com/questions/9589768/using-an-associative-array-as-data-for-d3
  var circles = G.canvas.selectAll('.region').data(d3.entries(G.regObjs));
  circles.exit().remove();
  circles.enter()
    .append('circle')
    .attr('cx', G.viewBox.width/2)
    .attr('cy', G.viewBox.height/2)
    .attr('r', 10)
    .style('fill', '#fff')
    .classed('region', true)
    .append('svg:title')
    .classed('tooltip', true);
  circles.each(function (d) { d.value.circle = d3.select(this); });

  // https://stackoverflow.com/questions/16919280/how-to-update-axis-using-d3-js
  G.scale.xAxis = d3.scale.linear()
    .range([G.viewBox.width * 0.2, G.viewBox.width * 0.8])
    .domain([G.domain.xAxis.min, G.domain.xAxis.max]);
  G.scale.yAxis = d3.scale.linear()
    .range([G.viewBox.height * 0.8, G.viewBox.height * 0.2])
    .domain([G.domain.yAxis.min, G.domain.yAxis.max]);
  G.scale.width = d3.scale.linear()
    .range([G.config.width.min, G.config.width.max])
    .domain([G.domain.width.min, G.domain.width.max]);
  var xAxis, yAxis;
  xAxis = d3.svg.axis().scale(G.scale.xAxis).orient('top');
  yAxis = d3.svg.axis().scale(G.scale.yAxis).orient('right');
  G.canvas.select('#xAxis')
    .attr('transform', 'translate(0,'+(G.viewBox.height-60)+')')
    .call(xAxis);
  G.canvas.select('#yAxis')
    .attr('transform', 'translate(40,0)')
    .call(yAxis);
  G.canvas.select('#xAxis')
    .selectAll('text')
    .attr('transform',' ');

  redraw();
}

function redraw() {
  var now = G.time.slider.value();
  G.canvas.selectAll('.region')
    .transition()
    .duration(G.config.transition)
    .attr('cx', function(d) { return G.scale.xAxis(d.value.ev[now].xAxis); })
    .attr('cy', function(d) { return G.scale.yAxis(d.value.ev[now].yAxis); })
    .attr('r', function(d) { return G.scale.width(d.value.ev[now].width) / 2; })
    .style('fill', function(d) { return d.value.rgbcolor; })
    .style('fill-opacity', function(d) { return d.value.ev[now].opac; })
    .select('.tooltip')
    .text(function(d) {
      var n = d.value.ev[now];
      var msg = d.value.disp + '\n' +
	'x:' + n.xAxis + '\n' +
	'y:' + n.yAxis + '\n' +
	'w:' + n.width;
      return msg;
    });
}

function paintButton(button) {
  var reg = button.data('region');
  button.css('background-color', reg.show ?
    rgba(reg.rgbcolor, G.config.opacity) :
    $('#region-selector').css('background-color')
  );
}

function toTime(evt, value) {
  d3.select('#time-text').text(G.time.labels[value]);
  G.now = value;
  redraw();
}

// https://stackoverflow.com/questions/21647928/javascript-unicode-string-to-hex
String.prototype.hexEncode = function(){
  var hex, i, result = '';
  for (i=0; i<this.length; i++) {
    hex = this.charCodeAt(i).toString(16);
    result += ('000'+hex).slice(-4);
  }
  return result;
};

function selRegionAll() {
  $('#region-selector button.region').each(function () {
    var r = $(this).text();
    if (! G.regObjs[r].show) { $(this).click(); }
  });
}

function selRegionInvert() {
  $('#region-selector button.region').click();
}

function XFZaBin(p, N, mu) {
  // Normal approximation to Binomial
  // https://onlinecourses.science.psu.edu/stat414/node/179
  return (p-mu) / Math.sqrt(mu*(1-mu)/N);
}

function saveConfig() {
  // http://www.javascripture.com/Blob
  var blob = new Blob(
    [JSON.stringify(G.config, null, 2)],
    {type: 'application/json', endings: 'native'}
  );
  saveAs(blob, 'config.json');
}

function saveDrawing() {
  // http://techslides.com/save-svg-as-an-image
  var blob = new Blob(
    [$('#rsvg-box svg').parent().html()],
    {type: 'image/svg+xml', endings: 'native'}
  );
  saveAs(blob, 'vizxtime.svg');
}

function rgba(hex, alpha) {
  var m = hex.match(/#?(\w\w)(\w\w)(\w\w)$/);
  if (! m) { m = hex.match(/#?(\w)(\w)(\w)$/); }
  var color = 'rgba(' + parseInt(m[1],16) + ',' + parseInt(m[2],16) +
    ',' + parseInt(m[3],16) + ',' + alpha + ')';
  return color;
}

