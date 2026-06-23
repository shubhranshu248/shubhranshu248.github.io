/* ============================================================
   THE VISUAL DIARY — runtime gallery engine
   - Reads the Google Sheet LIVE on every page load (gviz CSV).
   - Shows ONLY rows that have a non-empty "Used Caption".
   - Builds each card as photos/<slug>/<New Filename> + caption.
   - Nothing about the photos is hardcoded here.
   ============================================================ */

(function () {
  "use strict";

  /* ---- CONFIG ---- */
  var SHEET_ID = "1p1N08hWsxhnSXB8NVbLjy48Yk_bAYQyfeEWqhlAv6mk";
  var SHEET_CSV_URL =
    "https://docs.google.com/spreadsheets/d/" + SHEET_ID +
    "/gviz/tq?tqx=out:csv&gid=0";

  // Display order + human descriptions for category pages.
  // Slugs are derived by slugify() so they always match the Sheet's
  // "Category Folder" values and the photos/<slug>/ folders.
  var CATEGORIES = [
    { name: "Flowers & Botanicals",        blurb: "Petals, leaves and the quiet architecture of things that grow." },
    { name: "Skies, Sunsets & the Moon",   blurb: "Light at the edges of the day, and the moon keeping watch." },
    { name: "Landscapes & Scenery",        blurb: "Wider views — land, water and distance held still for a moment." },
    { name: "Animals & Birds",             blurb: "Small lives, caught mid-gesture." },
    { name: "Architecture & Urban",        blurb: "Streets, structures and the geometry people leave behind." },
    { name: "Still Life & Details",        blurb: "The close and the overlooked, given room to be seen." }
  ];

  var COLS = {
    original: "Original Filename",
    file:     "New Filename",
    category: "Category Folder",
    caption:  "Used Caption",
    date:     "Date Added"
  };

  /* ---- UTIL ---- */
  function slugify(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/&/g, " ")
      .replace(/,/g, " ")
      .trim()
      .replace(/\s+/g, "-");
  }

  function catBySlug(slug) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (slugify(CATEGORIES[i].name) === slug) return CATEGORIES[i];
    }
    return null;
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Fisher–Yates shuffle (returns a new array) — used so the gallery
  // order is fresh on every visit / refresh.
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---- CSV PARSER (handles quotes, commas, newlines, "" escapes) ---- */
  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = 0;
    var c, next;
    // strip a leading BOM if present
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    while (i < text.length) {
      c = text[i];
      if (inQuotes) {
        if (c === '"') {
          next = text[i + 1];
          if (next === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    // flush last field/row
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  function rowsToObjects(matrix) {
    if (!matrix.length) return [];
    var header = matrix[0].map(function (h) { return h.trim(); });
    var out = [];
    for (var r = 1; r < matrix.length; r++) {
      var cells = matrix[r];
      if (cells.length === 1 && cells[0].trim() === "") continue; // blank line
      var obj = {};
      for (var c = 0; c < header.length; c++) {
        obj[header[c]] = (cells[c] != null ? cells[c] : "").trim();
      }
      out.push(obj);
    }
    return out;
  }

  /* ---- DATA ---- */
  function fetchPhotos() {
    return fetch(SHEET_CSV_URL, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("Sheet HTTP " + res.status);
        return res.text();
      })
      .then(function (txt) {
        var objs = rowsToObjects(parseCSV(txt));
        // keep only fully-published rows: have a file AND a caption
        return objs
          .map(function (o) {
            return {
              file: o[COLS.file] || "",
              category: o[COLS.category] || "",
              slug: slugify(o[COLS.category] || ""),
              caption: o[COLS.caption] || "",
              date: o[COLS.date] || ""
            };
          })
          .filter(function (o) { return o.file && o.caption; });
      });
  }

  /* ---- LIGHTBOX (shared) — with zoom & pan inspector ---- */
  var Lightbox = (function () {
    var node, imgEl, capEl, counterEl, zoomEl, stageEl;
    var set = [];
    var idx = 0;

    // zoom/pan state
    var scale = 1, tx = 0, ty = 0;
    var MIN = 1, MAX = 6;
    var dragging = false, lastX = 0, lastY = 0;
    var pinchDist = 0;

    function build() {
      if (node) return;
      node = el("div", "lightbox");
      node.innerHTML =
        '<div class="lb-counter"></div>' +
        '<div class="lb-zoom" aria-hidden="true">100%</div>' +
        '<button class="lb-close" aria-label="Close">&times;</button>' +
        '<button class="lb-btn lb-prev" aria-label="Previous">&#8249;</button>' +
        '<div class="lightbox__stage">' +
          '<img class="lightbox__img" alt="" draggable="false">' +
          '<div class="lightbox__cap"></div>' +
        '</div>' +
        '<button class="lb-btn lb-next" aria-label="Next">&#8250;</button>' +
        '<div class="lb-hint">Scroll to zoom &middot; drag or arrow keys to move &middot; double-click to toggle</div>';
      document.body.appendChild(node);
      imgEl = node.querySelector(".lightbox__img");
      capEl = node.querySelector(".lightbox__cap");
      counterEl = node.querySelector(".lb-counter");
      zoomEl = node.querySelector(".lb-zoom");
      stageEl = node.querySelector(".lightbox__stage");

      node.querySelector(".lb-close").addEventListener("click", close);
      node.querySelector(".lb-prev").addEventListener("click", function (e) { e.stopPropagation(); step(-1); });
      node.querySelector(".lb-next").addEventListener("click", function (e) { e.stopPropagation(); step(1); });
      node.addEventListener("click", function (e) { if (e.target === node || e.target === stageEl) close(); });

      // wheel = zoom toward cursor
      node.addEventListener("wheel", onWheel, { passive: false });
      // drag = pan (when zoomed)
      imgEl.addEventListener("mousedown", onDown);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      // touch: 1-finger pan, 2-finger pinch zoom
      imgEl.addEventListener("touchstart", onTouchStart, { passive: false });
      imgEl.addEventListener("touchmove", onTouchMove, { passive: false });
      imgEl.addEventListener("touchend", onUp);
      // double-click toggles zoom at the point
      imgEl.addEventListener("dblclick", onDblClick);

      document.addEventListener("keydown", onKey);
    }

    function clampPan() {
      if (scale <= 1) { tx = 0; ty = 0; return; }
      var rect = imgEl.getBoundingClientRect();
      var baseW = rect.width / scale, baseH = rect.height / scale;
      var maxX = baseW * (scale - 1) / 2;
      var maxY = baseH * (scale - 1) / 2;
      if (tx > maxX) tx = maxX; else if (tx < -maxX) tx = -maxX;
      if (ty > maxY) ty = maxY; else if (ty < -maxY) ty = -maxY;
    }

    function apply(animate) {
      imgEl.style.transition = (animate ? "transform .25s var(--ease)" : "transform 0s") +
        ", opacity .35s var(--ease)";
      imgEl.style.transform = "translate(" + tx.toFixed(2) + "px," + ty.toFixed(2) + "px) scale(" + scale + ")";
      var zoomed = scale > 1.001;
      imgEl.classList.toggle("is-zoomed", zoomed);
      node.classList.toggle("has-zoom", zoomed);
      if (zoomEl) zoomEl.textContent = Math.round(scale * 100) + "%";
    }

    function zoomAt(cx, cy, factor, animate) {
      var rect = imgEl.getBoundingClientRect();
      var dx = cx - (rect.left + rect.width / 2);
      var dy = cy - (rect.top + rect.height / 2);
      var newScale = Math.min(MAX, Math.max(MIN, scale * factor));
      var k = newScale / scale;
      if (k === 1) return;
      tx -= (k - 1) * dx;
      ty -= (k - 1) * dy;
      scale = newScale;
      clampPan();
      apply(animate);
    }

    function resetZoom(animate) { scale = 1; tx = 0; ty = 0; apply(animate); }

    function onWheel(e) {
      if (!node.classList.contains("open")) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15, false);
    }
    function onDown(e) {
      if (scale <= 1) return;
      e.preventDefault();
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      imgEl.classList.add("is-grabbing");
    }
    function onMove(e) {
      if (!dragging) return;
      tx += e.clientX - lastX; ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      clampPan(); apply(false);
    }
    function onUp() { dragging = false; imgEl.classList.remove("is-grabbing"); }

    function touchDist(e) { var a = e.touches[0], b = e.touches[1]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
    function onTouchStart(e) {
      if (e.touches.length === 2) { pinchDist = touchDist(e); }
      else if (e.touches.length === 1 && scale > 1) { dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }
    }
    function onTouchMove(e) {
      if (e.touches.length === 2) {
        e.preventDefault();
        var d = touchDist(e), a = e.touches[0], b = e.touches[1];
        if (pinchDist) zoomAt((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2, d / pinchDist, false);
        pinchDist = d;
      } else if (dragging && e.touches.length === 1) {
        e.preventDefault();
        tx += e.touches[0].clientX - lastX; ty += e.touches[0].clientY - lastY;
        lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
        clampPan(); apply(false);
      }
    }
    function onDblClick(e) {
      e.preventDefault();
      if (scale > 1) resetZoom(true);
      else zoomAt(e.clientX, e.clientY, 2.6, true);
    }

    function onKey(e) {
      if (!node.classList.contains("open")) return;
      if (e.key === "Escape") { close(); return; }
      var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      if (scale > 1) {
        var s = 80;
        if (e.key === "ArrowLeft") { tx += s; clampPan(); apply(true); e.preventDefault(); }
        else if (e.key === "ArrowRight") { tx -= s; clampPan(); apply(true); e.preventDefault(); }
        else if (e.key === "ArrowUp") { ty += s; clampPan(); apply(true); e.preventDefault(); }
        else if (e.key === "ArrowDown") { ty -= s; clampPan(); apply(true); e.preventDefault(); }
        else if (e.key === "0") resetZoom(true);
        else if (e.key === "+" || e.key === "=") zoomAt(cx, cy, 1.3, true);
        else if (e.key === "-" || e.key === "_") zoomAt(cx, cy, 1 / 1.3, true);
      } else {
        if (e.key === "ArrowLeft") step(-1);
        else if (e.key === "ArrowRight") step(1);
        else if (e.key === "+" || e.key === "=") zoomAt(cx, cy, 1.4, true);
      }
    }

    function render() {
      var item = set[idx];
      if (!item) return;
      resetZoom(false);
      imgEl.classList.remove("ready");
      var pre = new Image();
      pre.onload = function () { imgEl.src = pre.src; imgEl.classList.add("ready"); };
      pre.src = item.src;
      capEl.innerHTML = escapeHtml(item.caption) +
        '<span class="meta">' + escapeHtml(item.category) +
        (item.date ? " &middot; " + escapeHtml(item.date) : "") + '</span>';
      counterEl.textContent = (idx + 1) + " / " + set.length;
      node.querySelector(".lb-prev").style.visibility = set.length > 1 ? "visible" : "hidden";
      node.querySelector(".lb-next").style.visibility = set.length > 1 ? "visible" : "hidden";
    }

    function step(d) { idx = (idx + d + set.length) % set.length; render(); }

    function open(items, start) {
      build();
      set = items; idx = start || 0;
      node.classList.add("open");
      document.body.style.overflow = "hidden";
      render();
      // next frame -> trigger the open transition
      requestAnimationFrame(function () { node.classList.add("show"); });
    }
    function close() {
      if (!node) return;
      node.classList.remove("show");
      document.body.style.overflow = "";
      setTimeout(function () { node.classList.remove("open"); resetZoom(false); }, 260);
    }
    return { open: open };
  })();

  /* ---- REVEAL ON SCROLL ---- */
  function revealTiles(container) {
    var tiles = container.querySelectorAll(".tile");
    if (!("IntersectionObserver" in window)) {
      tiles.forEach(function (t) { t.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    tiles.forEach(function (t) { io.observe(t); });
  }

  /* ---- RENDER: HOMEPAGE ---- */
  function renderHome(photos) {
    // Hero: pick a random published photo as the cinematic backdrop.
    var heroImg = document.getElementById("heroImg");
    var heroFallback = document.getElementById("heroFallback");
    var heroCredit = document.getElementById("heroCredit");
    if (heroImg && photos.length) {
      var pick = photos[Math.floor(Math.random() * photos.length)];
      var src = "photos/" + pick.slug + "/" + pick.file;
      var probe = new Image();
      probe.onload = function () {
        heroImg.style.backgroundImage = "url('" + src + "')";
        heroImg.classList.add("is-on");
        if (heroFallback) heroFallback.style.opacity = "0";
        if (heroCredit) heroCredit.textContent = pick.category;
      };
      probe.src = src;
    }

    // Category previews
    var grid = document.getElementById("catGrid");
    if (!grid) return;
    grid.innerHTML = "";
    var byCat = {};
    photos.forEach(function (p) {
      (byCat[p.slug] = byCat[p.slug] || []).push(p);
    });

    CATEGORIES.forEach(function (cat) {
      var slug = slugify(cat.name);
      var list = byCat[slug] || [];
      var a = el("a", "cat-card");
      a.href = slug + ".html";
      var cover = el("div", list.length ? "cat-card__img" : "cat-card__placeholder");
      if (list.length) {
        var cov = list[Math.floor(Math.random() * list.length)];
        cover.style.backgroundImage =
          "url('photos/" + slug + "/" + cov.file + "')";
      }
      var count = list.length
        ? (list.length + " photograph" + (list.length === 1 ? "" : "s"))
        : "Coming soon";
      a.appendChild(cover);
      a.appendChild(el("div", "cat-card__scrim"));
      a.appendChild(el("div", "cat-card__arrow", "&#8599;"));
      a.appendChild(el("div", "cat-card__label",
        "<h3>" + escapeHtml(cat.name) + "</h3><span>" + count + "</span>"));
      grid.appendChild(a);
    });
  }

  /* ---- RENDER: CATEGORY PAGE ---- */
  function renderCategory(photos, slug) {
    var list = shuffle(photos.filter(function (p) { return p.slug === slug; }));
    var countEl = document.getElementById("catCount");
    var gal = document.getElementById("gallery");
    if (!gal) return;

    if (countEl) {
      countEl.textContent = list.length
        ? (list.length + " photograph" + (list.length === 1 ? "" : "s"))
        : "";
    }

    if (!list.length) {
      gal.innerHTML =
        '<div class="state">' +
          '<h3>Nothing here yet</h3>' +
          '<p>Photographs in this collection appear as soon as they’re captioned. ' +
          'Check back soon.</p>' +
        '</div>';
      return;
    }

    var masonry = el("div", "masonry");
    var items = list.map(function (p) {
      return { src: "photos/" + p.slug + "/" + p.file, caption: p.caption, category: p.category, date: p.date };
    });

    list.forEach(function (p, i) {
      var src = "photos/" + p.slug + "/" + p.file;
      var tile = el("div", "tile");
      tile.innerHTML =
        '<img loading="lazy" src="' + src + '" alt="' + escapeHtml(p.caption) + '">' +
        '<div class="tile__cap">' + escapeHtml(p.caption) + '</div>';
      tile.addEventListener("click", function () { Lightbox.open(items, i); });
      masonry.appendChild(tile);
    });

    gal.innerHTML = "";
    gal.appendChild(masonry);
    revealTiles(masonry);
  }

  /* ---- ERROR STATE ---- */
  function showError(targetId) {
    var t = document.getElementById(targetId);
    if (!t) return;
    t.innerHTML =
      '<div class="state">' +
        '<h3>Couldn’t load the gallery</h3>' +
        '<p>The photo list is read live from a Google Sheet. ' +
        'If this persists, check that the Sheet is shared as “Anyone with the link” and published to the web, then refresh.</p>' +
      '</div>';
  }

  /* ---- NAV (mobile) ---- */
  function initNav() {
    var btn = document.querySelector(".nav-toggle");
    var nav = document.getElementById("primaryNav");
    if (btn && nav) {
      btn.addEventListener("click", function () { nav.classList.toggle("open"); });
      nav.querySelectorAll("a").forEach(function (a) {
        a.addEventListener("click", function () { nav.classList.remove("open"); });
      });
    }
  }

  /* ---- BOOT ---- */
  function boot() {
    initNav();
    var page = document.body.getAttribute("data-page");
    var slug = document.body.getAttribute("data-slug");

    fetchPhotos()
      .then(function (photos) {
        if (page === "home") renderHome(photos);
        else if (page === "category") renderCategory(photos, slug);
      })
      .catch(function (err) {
        console.error("[Visual Diary]", err);
        if (page === "home") {
          // hero fallback stays visible; still render category cards as placeholders
          renderHome([]);
        } else if (page === "category") {
          showError("gallery");
        }
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
