/*
 * 1日タイムスケジュール
 * 状態はすべて App オブジェクトにまとめ、グローバルには何も公開しない。
 */
(function () {
  'use strict';

  // ===== 定数 =====
  const STORAGE_KEY_EVENTS = 'schedule:v1';
  const STORAGE_KEY_SETTINGS = 'settings:v1';
  const DAY_RANGES = ['0-24', '4-28'];
  const DEFAULT_DAY_RANGE = '0-24';

  const MINUTES_PER_HOUR = 60;
  // 1日の長さ(表示範囲の終端ではない。終端は区切り時刻 + この長さで求める)
  const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
  const HOURS_PER_DAY = MINUTES_PER_DAY / MINUTES_PER_HOUR;
  const MS_PER_DAY = MINUTES_PER_DAY * 60 * 1000;

  const GRID_SLOT_MINUTES = 15;     // CSS変数 --slot-height が表す分数
  const SNAP_MINUTES = 15;          // タップ・ドラッグのスナップ単位
  const MIN_DRAG_DURATION = 15;     // ドラッグで作れる最短の長さ
  const NEW_EVENT_DURATION = 30;    // 新規作成時の長さ
  const LONG_PRESS_MS = 400;
  const TAP_MOVE_TOLERANCE = 10;    // これ以上指が動いたらタップとみなさない(px)
  const MOUSE_DRAG_THRESHOLD = 4;   // マウスでドラッグ開始とみなす移動量(px)
  const HANDLE_DRAG_THRESHOLD = 5;  // つまみで時刻変更を始める移動量(px)。それより前に長押しになれば移動
  const DRAG_MOVED_THRESHOLD = 3;   // ドラッグで「動かした」とみなす移動量(px)
  const AUTO_SCROLL_EDGE = 48;      // 自動スクロールが始まる上下端からの距離(px)
  const AUTO_SCROLL_MAX_SPEED = 16; // 1フレームあたりの最大スクロール量(px)
  const DEFAULT_SCROLL_HOUR = 7;    // 今日以外の日を開いたときに見せる時刻
  const NOW_SCROLL_MARGIN_MIN = 60; // 今日を開いたとき、現在時刻より何分上から見せるか
  const COMPACT_HEIGHT = 34;        // これより低いブロックはタイトル1行のみ(px)
  const BLOCK_PADDING_Y = 6;
  const TITLE_LINE_HEIGHT = 16;
  const TIME_LINE_HEIGHT = 15;
  const MEMO_LINE_HEIGHT = 14;
  const MAX_TITLE_LINES_WITH_MEMO = 2; // メモがあるときのタイトルの最大行数
  const MIN_COLUMNS = 3;            // 予定ブロックの横幅 = 全体の 1/MIN_COLUMNS(固定)
  const HORIZONTAL_DRAG_THRESHOLD = 12; // これ以上横に動かしたら左右の位置も変える(px)
  const MIN_TOP_HANDLE_HEIGHT = 16; // これより低いブロックには上端のつまみを出さない(移動できる場所を残す)(px)

  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const COLORS = [
    { id: 'blue', value: '#2563eb', name: '青' },
    { id: 'teal', value: '#0d9488', name: '青緑' },
    { id: 'green', value: '#16a34a', name: '緑' },
    { id: 'orange', value: '#ea580c', name: 'オレンジ' },
    { id: 'red', value: '#dc2626', name: '赤' },
    { id: 'pink', value: '#db2777', name: 'ピンク' },
    { id: 'purple', value: '#7c3aed', name: '紫' },
    { id: 'gray', value: '#475569', name: 'グレー' }
  ];
  const DEFAULT_COLOR = 'blue';
  const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
  const DIGITS_RE = /^\d{1,2}$/;

  // ===== 状態 =====
  const App = {
    settings: { dayRange: DEFAULT_DAY_RANGE },
    events: [],
    viewDay: 0,           // 表示中の日(1970-01-01 からの日数)
    lastToday: 0,         // 前回確認した「今日」
    slotHeight: 20,       // 15分あたりの高さ(px)。CSS変数から読む
    pointer: null,        // 予定ブロック上で押下中の操作(長押し待ち・ドラッグ中)
    tapStart: null,       // 直近の押下位置(クリックとドラッグの判別用)
    lastPointerType: '',  // 直近の押下の種類(右クリック削除を PC のマウスだけに限るため)
    reloading: false,     // 新しいバージョンへの切り替えで再読み込み中
    suppressClick: false, // ドラッグ直後のクリックを無視する
    autoScrollRaf: 0,
    nowTimer: 0,
    openSheet: null,      // 'editor' | 'settings' | null
    editor: { id: null, showOriginal: false },
    el: {}
  };

  // =====================================================================
  // 時刻の計算(表示処理とは分けておく)
  // 日時は「1970-01-01 0:00 からの壁時計上の通算分」で扱い、夏時間の影響を受けないようにする
  // =====================================================================

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // 年月日 → 日番号
  function dayIndexFromYmd(y, m, d) {
    return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
  }

  // 日番号 → 年月日と曜日
  function ymdFromDayIndex(day) {
    const dt = new Date(day * MS_PER_DAY);
    return {
      y: dt.getUTCFullYear(),
      m: dt.getUTCMonth() + 1,
      d: dt.getUTCDate(),
      wd: dt.getUTCDay()
    };
  }

  // 'YYYY-MM-DDTHH:mm' → 通算分(不正な値は NaN)
  function parseDateTime(str) {
    if (typeof str !== 'string') {
      return NaN;
    }
    const m = DATETIME_RE.exec(str);
    if (!m) {
      return NaN;
    }
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    if (hour >= HOURS_PER_DAY || minute >= MINUTES_PER_HOUR) {
      return NaN;
    }
    const day = dayIndexFromYmd(Number(m[1]), Number(m[2]), Number(m[3]));
    const abs = day * MINUTES_PER_DAY + hour * MINUTES_PER_HOUR + minute;
    // 2月31日のような存在しない日付を弾く
    if (formatDateTime(abs) !== str) {
      return NaN;
    }
    return abs;
  }

  // 通算分 → 'YYYY-MM-DDTHH:mm'
  function formatDateTime(abs) {
    const day = Math.floor(abs / MINUTES_PER_DAY);
    const rest = abs - day * MINUTES_PER_DAY;
    const ymd = ymdFromDayIndex(day);
    const h = Math.floor(rest / MINUTES_PER_HOUR);
    const mi = rest - h * MINUTES_PER_HOUR;
    return String(ymd.y).padStart(4, '0') + '-' + pad2(ymd.m) + '-' + pad2(ymd.d) +
      'T' + pad2(h) + ':' + pad2(mi);
  }

  // 現在時刻の通算分
  function nowAbs() {
    const d = new Date();
    const day = dayIndexFromYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return day * MINUTES_PER_DAY + d.getHours() * MINUTES_PER_HOUR + d.getMinutes();
  }

  // 設定値から1日の区切り時刻(時)を求める。'4-28' → 4
  function dayStartHour() {
    return parseInt(App.settings.dayRange.split('-')[0], 10);
  }

  // 区切り時刻を 0:00 からの分数で
  function dayStartMinutes() {
    return dayStartHour() * MINUTES_PER_HOUR;
  }

  // 指定日の表示範囲の開始(通算分)
  function rangeStartAbs(day) {
    return day * MINUTES_PER_DAY + dayStartMinutes();
  }

  // 通算分 → 表示範囲の開始からの経過分
  function absToRange(abs, day) {
    return abs - rangeStartAbs(day);
  }

  // 表示範囲の開始からの経過分 → 通算分
  function rangeToAbs(min, day) {
    return rangeStartAbs(day) + min;
  }

  // 通算分がどの日の画面に属するか(区切り時刻を考慮)
  function logicalDayOf(abs) {
    return Math.floor((abs - dayStartMinutes()) / MINUTES_PER_DAY);
  }

  // 「今日」(4:00〜28:00 モードでは 4:00 前なら前日)
  function todayDay() {
    return logicalDayOf(nowAbs());
  }

  // 表示範囲の開始からの経過分 → 表示用の時と分(4:00〜28:00 モードでは 24 以上になる)
  function rangeToDisplayParts(min) {
    const total = dayStartMinutes() + min;
    const h = Math.floor(total / MINUTES_PER_HOUR);
    return { h: h, m: total - h * MINUTES_PER_HOUR };
  }

  // 表示用の時と分 → 表示範囲の開始からの経過分
  function displayPartsToRange(h, m) {
    return h * MINUTES_PER_HOUR + m - dayStartMinutes();
  }

  // 表示範囲の開始からの経過分 → "H:MM"(例: 25:00)
  function formatRangeTime(min) {
    const p = rangeToDisplayParts(min);
    return p.h + ':' + pad2(p.m);
  }

  // 通算分 → 暦どおりの時と分(0〜23時)
  function absToClockParts(abs) {
    const day = Math.floor(abs / MINUTES_PER_DAY);
    const rest = abs - day * MINUTES_PER_DAY;
    const h = Math.floor(rest / MINUTES_PER_HOUR);
    return { day: day, h: h, m: rest - h * MINUTES_PER_HOUR };
  }

  // 日番号 → "9月29日"
  function formatMonthDay(day) {
    const ymd = ymdFromDayIndex(day);
    return ymd.m + '月' + ymd.d + '日';
  }

  // 分数 ⇔ タイムライン上の座標(px)
  function minutesToY(min) {
    return min * App.slotHeight / GRID_SLOT_MINUTES;
  }

  function yToMinutes(y) {
    return y * GRID_SLOT_MINUTES / App.slotHeight;
  }

  function snapRound(min) {
    return Math.round(min / SNAP_MINUTES) * SNAP_MINUTES;
  }

  function snapFloor(min) {
    return Math.floor(min / SNAP_MINUTES) * SNAP_MINUTES;
  }

  // =====================================================================
  // 予定データ
  // =====================================================================

  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'ev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function findEvent(id) {
    return App.events.find(function (ev) {
      return ev.id === id;
    });
  }

  function isValidColor(id) {
    return COLORS.some(function (c) {
      return c.id === id;
    });
  }

  function colorValue(id) {
    const found = COLORS.find(function (c) {
      return c.id === id;
    });
    if (found) {
      return found.value;
    }
    return COLORS[0].value;
  }

  function stringOrEmpty(value) {
    if (typeof value === 'string') {
      return value;
    }
    return '';
  }

  // 保存データを検証して正規化する(壊れた要素は捨てる)
  function sanitizeEvent(obj) {
    if (!obj || typeof obj !== 'object') {
      return null;
    }
    const s = parseDateTime(obj.start);
    const e = parseDateTime(obj.end);
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) {
      return null;
    }
    let id = obj.id;
    if (typeof id !== 'string' || id === '') {
      id = newId();
    }
    let color = obj.color;
    if (!isValidColor(color)) {
      color = DEFAULT_COLOR;
    }
    return {
      id: id,
      title: stringOrEmpty(obj.title),
      start: obj.start,
      end: obj.end,
      color: color,
      memo: stringOrEmpty(obj.memo),
      x: sanitizeX(obj.x)
    };
  }

  // 左右の位置: 0(左端)〜1(右端)。無い・壊れている場合は左端
  function sanitizeX(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0;
    }
    return clamp(value, 0, 1);
  }

  // 表示中の範囲と重なる予定を、範囲内の分数に変換して取り出す
  function visibleItems(day) {
    const rs = rangeStartAbs(day);
    const re = rs + MINUTES_PER_DAY;
    const items = [];
    App.events.forEach(function (ev) {
      const s = parseDateTime(ev.start);
      const e = parseDateTime(ev.end);
      if (s < re && e > rs) {
        items.push({
          ev: ev,
          start: Math.max(s, rs) - rs,
          end: Math.min(e, re) - rs,
          clipTop: s < rs,
          clipBottom: e > re
        });
      }
    });
    // 重なったときは、後から始まる予定が手前に来るように並べる
    return items.sort(function (a, b) {
      if (a.start !== b.start) {
        return a.start - b.start;
      }
      return (b.end - b.start) - (a.end - a.start);
    });
  }

  // =====================================================================
  // 保存(localStorage)
  // =====================================================================

  function setStorageWarning(show) {
    App.el.storageWarning.hidden = !show;
  }

  function loadEvents() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY_EVENTS);
    } catch (err) {
      setStorageWarning(true);
      return [];
    }
    if (!raw) {
      return [];
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return [];
    }
    if (!Array.isArray(data)) {
      return [];
    }
    return data.map(sanitizeEvent).filter(Boolean);
  }

  function saveEvents() {
    try {
      localStorage.setItem(STORAGE_KEY_EVENTS, JSON.stringify(App.events));
      setStorageWarning(false);
    } catch (err) {
      setStorageWarning(true);
    }
  }

  function loadSettings() {
    const settings = { dayRange: DEFAULT_DAY_RANGE };
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
    } catch (err) {
      setStorageWarning(true);
      return settings;
    }
    if (!raw) {
      return settings;
    }
    try {
      const data = JSON.parse(raw);
      if (data && DAY_RANGES.indexOf(data.dayRange) !== -1) {
        settings.dayRange = data.dayRange;
      }
    } catch (err) {
      // 壊れている場合は初期値のまま
    }
    return settings;
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(App.settings));
      setStorageWarning(false);
    } catch (err) {
      setStorageWarning(true);
    }
  }

  // =====================================================================
  // 描画
  // =====================================================================

  function readSlotHeight() {
    const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slot-height'));
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
    return 20;
  }

  function renderAll() {
    renderHeader();
    renderGrid();
    renderEvents();
    renderNowLine();
  }

  function renderHeader() {
    const ymd = ymdFromDayIndex(App.viewDay);
    const label = App.el.dateLabel;
    label.textContent = ymd.m + '月' + ymd.d + '日(';
    const wd = document.createElement('span');
    wd.textContent = WEEKDAYS[ymd.wd];
    if (ymd.wd === 0) {
      wd.className = 'wd-sun';
    } else if (ymd.wd === 6) {
      wd.className = 'wd-sat';
    }
    label.appendChild(wd);
    label.appendChild(document.createTextNode(')'));
    App.el.todayBtn.classList.toggle('is-today', App.viewDay === todayDay());
  }

  // 時刻ラベルとタイムラインの高さ
  function renderGrid() {
    App.el.day.style.height = minutesToY(MINUTES_PER_DAY) + 'px';
    const labels = App.el.hourLabels;
    labels.textContent = '';
    for (let h = 0; h <= HOURS_PER_DAY; h += 1) {
      const min = h * MINUTES_PER_HOUR;
      const label = document.createElement('div');
      label.className = 'hour-label';
      label.style.top = minutesToY(min) + 'px';
      label.textContent = formatRangeTime(min);
      labels.appendChild(label);
    }
  }

  function renderEvents() {
    const day = App.el.day;
    day.querySelectorAll('.event').forEach(function (el) {
      el.remove();
    });
    const items = visibleItems(App.viewDay);
    const fragment = document.createDocumentFragment();
    const elements = items.map(createEventElement);
    elements.forEach(function (el) {
      fragment.appendChild(el);
    });
    day.appendChild(fragment);
    // メモの行数は実際の余白を測って決めるので、画面に追加してから行う
    elements.forEach(fitEventMemo);
  }

  function createEventElement(item) {
    const el = document.createElement('div');
    el.className = 'event';
    el.dataset.id = item.ev.id;
    el.dataset.start = String(item.start);
    el.dataset.end = String(item.end);
    el.dataset.clipTop = String(item.clipTop);
    el.dataset.clipBottom = String(item.clipBottom);
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.style.setProperty('--ev-color', colorValue(item.ev.color));
    applyEventX(el, item.ev.x);

    const body = document.createElement('div');
    body.className = 'event-body';
    const title = document.createElement('div');
    title.className = 'event-title';
    if (item.ev.title === '') {
      title.textContent = 'タイトルなし';
      title.classList.add('is-empty');
    } else {
      title.textContent = item.ev.title;
    }
    const time = document.createElement('div');
    time.className = 'event-time';
    const memo = document.createElement('div');
    memo.className = 'event-memo';
    memo.textContent = item.ev.memo;
    memo.hidden = true;
    body.appendChild(title);
    body.appendChild(time);
    body.appendChild(memo);
    el.appendChild(body);

    // 上端・下端のつまみ(開始時刻・終了時刻の変更)
    ['top', 'bottom'].forEach(function (edge) {
      const handle = document.createElement('div');
      handle.className = 'resize-handle handle-' + edge;
      handle.dataset.edge = edge;
      handle.setAttribute('aria-hidden', 'true');
      el.appendChild(handle);
    });

    updateEventElement(el, item.start, item.end, item.clipTop, item.clipBottom);
    return el;
  }

  // 左右の位置: 横幅は 1/MIN_COLUMNS 固定。x = 0 で左端、1 で右端
  function applyEventX(el, x) {
    const width = '(100% - var(--event-gap-right)) / ' + MIN_COLUMNS;
    el.style.left = 'calc((100% - ' + width + ') * ' + x + ' + 1px)';
    el.style.width = 'calc(' + width + ' - 2px)';
  }

  // ブロックの横幅(px)
  function eventWidthPx() {
    const dayWidth = App.el.day.clientWidth;
    const gap = parseFloat(getComputedStyle(App.el.day).getPropertyValue('--event-gap-right'));
    let gapPx = 0;
    if (Number.isFinite(gap)) {
      gapPx = gap;
    }
    return (dayWidth - gapPx) / MIN_COLUMNS;
  }

  // 座標 ⇔ 左右の位置(x)の変換に使う、ブロックを動かせる横幅(px)
  function eventXRangePx() {
    return Math.max(0, App.el.day.clientWidth - eventWidthPx());
  }

  // .day 内のX座標 → その位置が中心になる左右の位置(x)
  function xFromCenterPx(centerPx) {
    const range = eventXRangePx();
    if (range <= 0) {
      return 0;
    }
    const left = clamp(centerPx - eventWidthPx() / 2, 0, range);
    return left / range;
  }

  // ブロックの位置・高さ・時刻表示を更新する(ドラッグ中も使う)
  function updateEventElement(el, start, end, clipTop, clipBottom) {
    const top = minutesToY(start);
    const height = Math.max(minutesToY(end) - top - 1, 1);
    el.style.top = top + 'px';
    el.style.height = height + 'px';
    el.classList.toggle('compact', height < COMPACT_HEIGHT);
    el.classList.toggle('no-top-handle', height < MIN_TOP_HANDLE_HEIGHT);
    el.classList.toggle('clip-top', clipTop);
    el.classList.toggle('clip-bottom', clipBottom);
    let lines = Math.max(1, Math.floor((height - BLOCK_PADDING_Y - TIME_LINE_HEIGHT) / TITLE_LINE_HEIGHT));
    if (el.querySelector('.event-memo').textContent !== '') {
      // メモを見せる余白を残すため、タイトルの行数を抑える
      lines = Math.min(lines, MAX_TITLE_LINES_WITH_MEMO);
    }
    el.style.setProperty('--title-lines', String(lines));

    let text = formatRangeTime(start) + '-' + formatRangeTime(end);
    if (clipTop) {
      text = '…' + text;
    }
    if (clipBottom) {
      text = text + '…';
    }
    el.querySelector('.event-time').textContent = text;
    el.setAttribute('aria-label', el.querySelector('.event-title').textContent + ' ' + text);
    if (el.isConnected) {
      fitEventMemo(el);
    }
  }

  // タイトルと時刻の下に余白があれば、入る行数だけメモを表示する
  function fitEventMemo(el) {
    const memo = el.querySelector('.event-memo');
    if (memo.textContent === '' || el.classList.contains('compact')) {
      memo.hidden = true;
      return;
    }
    memo.hidden = false;
    memo.style.maxHeight = '';
    const lines = Math.floor(memo.clientHeight / MEMO_LINE_HEIGHT);
    if (lines < 1) {
      memo.hidden = true;
      return;
    }
    memo.style.setProperty('--memo-lines', String(lines));
    // 改行を含むメモは行数制限だけでは次の行が覗くので、高さも行数分に揃える
    memo.style.maxHeight = (lines * MEMO_LINE_HEIGHT) + 'px';
  }

  function renderNowLine() {
    const line = App.el.nowLine;
    if (App.viewDay !== todayDay()) {
      line.hidden = true;
      return;
    }
    line.hidden = false;
    line.style.top = minutesToY(absToRange(nowAbs(), App.viewDay)) + 'px';
  }

  // タイムライン内での .day の上端位置(スクロール量に依存しない)
  function dayOffsetInTimeline() {
    const timeline = App.el.timeline;
    return App.el.day.getBoundingClientRect().top - timeline.getBoundingClientRect().top + timeline.scrollTop;
  }

  // 起動時・日付切替時のスクロール位置
  function scrollToDefault() {
    let targetMin;
    if (App.viewDay === todayDay()) {
      targetMin = absToRange(nowAbs(), App.viewDay) - NOW_SCROLL_MARGIN_MIN;
    } else {
      targetMin = DEFAULT_SCROLL_HOUR * MINUTES_PER_HOUR - dayStartMinutes();
      if (targetMin < 0) {
        targetMin += MINUTES_PER_DAY;
      }
    }
    App.el.timeline.scrollTop = Math.max(0, minutesToY(targetMin) + dayOffsetInTimeline() - 8);
  }

  // 画面上端に見えている時刻(通算分)
  function topVisibleAbs() {
    const y = App.el.timeline.scrollTop - dayOffsetInTimeline();
    return rangeToAbs(yToMinutes(y), App.viewDay);
  }

  function scrollToAbs(abs) {
    const min = absToRange(abs, App.viewDay);
    App.el.timeline.scrollTop = Math.max(0, minutesToY(min) + dayOffsetInTimeline());
  }

  // 1分ごとに現在時刻の線を更新する(分の変わり目に合わせる)
  function scheduleNowTick() {
    clearTimeout(App.nowTimer);
    const now = new Date();
    const wait = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50;
    App.nowTimer = setTimeout(function () {
      renderNowLine();
      renderHeader();
      scheduleNowTick();
    }, wait);
  }

  // =====================================================================
  // 日付の切り替え
  // =====================================================================

  function goToDay(day) {
    cancelPointer();
    App.viewDay = day;
    renderAll();
    scrollToDefault();
  }

  // アプリに戻ってきたとき、日付が変わっていれば今日へ移る
  function onResume() {
    const today = todayDay();
    if (today !== App.lastToday && App.viewDay === App.lastToday && App.openSheet === null) {
      App.lastToday = today;
      goToDay(today);
      return;
    }
    App.lastToday = today;
    renderNowLine();
    renderHeader();
    scheduleNowTick();
  }

  // =====================================================================
  // タイムライン上の操作
  // =====================================================================

  // 画面上のY座標 → .day 内のY座標
  function dayY(clientY) {
    return clientY - App.el.day.getBoundingClientRect().top;
  }

  function distance(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
  }

  // 空いている場所をタップしたとき、その位置に予定を作る(左右はタップした位置が中心になるように置く)
  function createEventAt(xPx, y) {
    const start = clamp(snapFloor(yToMinutes(y)), 0, MINUTES_PER_DAY - SNAP_MINUTES);
    const end = Math.min(start + NEW_EVENT_DURATION, MINUTES_PER_DAY);
    const ev = {
      id: newId(),
      title: '',
      start: formatDateTime(rangeToAbs(start, App.viewDay)),
      end: formatDateTime(rangeToAbs(end, App.viewDay)),
      color: DEFAULT_COLOR,
      memo: '',
      x: xFromCenterPx(xPx)
    };
    App.events.push(ev);
    saveEvents();
    renderEvents();
    openEditor(ev.id, true);
  }

  function onDayPointerDown(e) {
    if (!e.isPrimary) {
      return;
    }
    App.lastPointerType = e.pointerType;
    if (e.pointerType === 'mouse' && e.button !== 0) {
      return;
    }
    cancelPointer();
    App.suppressClick = false;
    App.tapStart = { x: e.clientX, y: e.clientY };

    const block = e.target.closest('.event');
    if (!block) {
      return;
    }
    const p = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      el: block,
      id: block.dataset.id,
      mode: 'move',         // 'move' | 'resize-top' | 'resize-bottom'
      handleMode: '',       // つまみを押したとき、動かしたら始める時刻変更のモード
      active: false,
      moved: false,         // 縦に動かした(時刻が変わる)
      horizontal: false,    // 横に動かした(左右の位置が変わる)
      timer: 0,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      origLeftPx: block.offsetLeft - 1,
      xRangePx: eventXRangePx(),
      curX: 0,
      anchorY: dayY(e.clientY),
      origStart: Number(block.dataset.start),
      origEnd: Number(block.dataset.end),
      clipTop: block.dataset.clipTop === 'true',
      clipBottom: block.dataset.clipBottom === 'true',
      curStart: 0,
      curEnd: 0
    };
    p.curStart = p.origStart;
    p.curEnd = p.origEnd;
    App.pointer = p;

    // 上端・下端のつまみ: 長押しする前に動かせば開始・終了時刻の変更。長押しすれば移動(下の長押し処理)
    const handle = e.target.closest('.resize-handle');
    if (handle) {
      e.preventDefault();
      p.handleMode = 'resize-' + handle.dataset.edge;
    } else if (e.pointerType === 'mouse') {
      // マウスは押したまま動かせばドラッグ開始(テキスト選択を防ぐ)
      e.preventDefault();
      return;
    }
    // 長押しで移動モード(どこを押していても移動になる)
    p.timer = setTimeout(function () {
      p.timer = 0;
      if (App.pointer === p && !p.active) {
        p.mode = 'move';
        activateDrag();
      }
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e) {
    const p = App.pointer;
    if (!p || e.pointerId !== p.pointerId) {
      return;
    }
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    if (!p.active) {
      const moved = distance(p.startX, p.startY, e.clientX, e.clientY);
      if (p.handleMode !== '') {
        // つまみを長押しする前に動かした = 時刻変更
        if (moved > HANDLE_DRAG_THRESHOLD) {
          clearTimeout(p.timer);
          p.timer = 0;
          p.mode = p.handleMode;
          activateDrag();
        }
      } else if (p.pointerType === 'mouse') {
        if (moved > MOUSE_DRAG_THRESHOLD) {
          activateDrag();
        }
      } else if (moved > TAP_MOVE_TOLERANCE) {
        // 長押し前に指が動いた = スクロール
        cancelPointer();
      }
      return;
    }
    e.preventDefault();
    updateDrag();
  }

  function onPointerUp(e) {
    const p = App.pointer;
    if (!p || e.pointerId !== p.pointerId) {
      return;
    }
    if (p.active) {
      finishDrag(true);
      App.suppressClick = true;
      return;
    }
    cancelPointer();
  }

  function onPointerCancel(e) {
    const p = App.pointer;
    if (!p || e.pointerId !== p.pointerId) {
      return;
    }
    cancelPointer();
  }

  // 押下中の操作を取り消す(ドラッグ中なら元に戻す)
  function cancelPointer() {
    const p = App.pointer;
    if (!p) {
      return;
    }
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = 0;
    }
    if (p.active) {
      finishDrag(false);
      return;
    }
    App.pointer = null;
  }

  function activateDrag() {
    const p = App.pointer;
    p.active = true;
    App.suppressClick = true;
    p.el.classList.add('dragging');
    if (p.pointerType !== 'mouse' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(10);
    }
    updateDrag();
    startAutoScroll();
  }

  // ポインタ位置から移動先・長さを計算してブロックに反映する
  function updateDrag() {
    const p = App.pointer;
    const dy = dayY(p.lastY) - p.anchorY;
    if (Math.abs(dy) >= DRAG_MOVED_THRESHOLD) {
      p.moved = true;
    }
    if (p.moved) {
      const delta = yToMinutes(dy);
      if (p.mode === 'move') {
        const duration = p.origEnd - p.origStart;
        const start = clamp(snapRound(p.origStart + delta), 0, MINUTES_PER_DAY - duration);
        p.curStart = start;
        p.curEnd = start + duration;
      } else if (p.mode === 'resize-top') {
        // 上端: 開始時刻を変える(最短15分)
        const maxStart = Math.max(p.origEnd - MIN_DRAG_DURATION, 0);
        p.curStart = clamp(snapRound(p.origStart + delta), 0, maxStart);
        p.curEnd = p.origEnd;
      } else {
        // 下端: 終了時刻を変える(最短15分)
        const minEnd = Math.min(p.origStart + MIN_DRAG_DURATION, MINUTES_PER_DAY);
        p.curStart = p.origStart;
        p.curEnd = clamp(snapRound(p.origEnd + delta), minEnd, MINUTES_PER_DAY);
      }
    }
    if (p.mode === 'move') {
      updateDragX(p);
    }
    // 動かした時点で表示中の範囲内に収まるので、続きの印は外す
    updateEventElement(p.el, p.curStart, p.curEnd, p.clipTop && !p.moved, p.clipBottom && !p.moved);
  }

  // 横方向: 一定以上横に動かしたら、指(マウス)に合わせて左右の位置を自由に変える
  function updateDragX(p) {
    const dx = p.lastX - p.startX;
    if (!p.horizontal && Math.abs(dx) >= HORIZONTAL_DRAG_THRESHOLD) {
      p.horizontal = true;
    }
    if (!p.horizontal) {
      return;
    }
    const left = clamp(p.origLeftPx + dx, 0, p.xRangePx);
    p.curX = 0;
    if (p.xRangePx > 0) {
      p.curX = left / p.xRangePx;
    }
    applyEventX(p.el, p.curX);
  }

  function finishDrag(commit) {
    const p = App.pointer;
    App.pointer = null;
    stopAutoScroll();
    if (commit && (p.moved || p.horizontal)) {
      const ev = findEvent(p.id);
      if (ev) {
        if (p.moved) {
          ev.start = formatDateTime(rangeToAbs(p.curStart, App.viewDay));
          ev.end = formatDateTime(rangeToAbs(p.curEnd, App.viewDay));
        }
        if (p.horizontal) {
          ev.x = p.curX;
        }
        saveEvents();
      }
    }
    // ドロップ時に再レイアウト
    renderEvents();
  }

  // ドラッグ中、上下端に近づいたら自動スクロールする
  function startAutoScroll() {
    if (!App.autoScrollRaf) {
      App.autoScrollRaf = requestAnimationFrame(autoScrollStep);
    }
  }

  function stopAutoScroll() {
    if (App.autoScrollRaf) {
      cancelAnimationFrame(App.autoScrollRaf);
      App.autoScrollRaf = 0;
    }
  }

  function autoScrollStep() {
    const p = App.pointer;
    if (!p || !p.active) {
      App.autoScrollRaf = 0;
      return;
    }
    const timeline = App.el.timeline;
    const rect = timeline.getBoundingClientRect();
    let speed = 0;
    if (p.lastY < rect.top + AUTO_SCROLL_EDGE) {
      speed = -AUTO_SCROLL_MAX_SPEED * Math.min(1, (rect.top + AUTO_SCROLL_EDGE - p.lastY) / AUTO_SCROLL_EDGE);
    } else if (p.lastY > rect.bottom - AUTO_SCROLL_EDGE) {
      speed = AUTO_SCROLL_MAX_SPEED * Math.min(1, (p.lastY - (rect.bottom - AUTO_SCROLL_EDGE)) / AUTO_SCROLL_EDGE);
    }
    if (speed !== 0) {
      const before = timeline.scrollTop;
      let step = Math.round(speed);
      if (step === 0) {
        step = Math.sign(speed);
      }
      timeline.scrollTop = before + step;
      if (timeline.scrollTop !== before) {
        updateDrag();
      }
    }
    App.autoScrollRaf = requestAnimationFrame(autoScrollStep);
  }

  // タップ(クリック)はここで処理する。iOS で入力欄へのフォーカスが効くよう click を使う
  function onDayClick(e) {
    if (App.suppressClick) {
      App.suppressClick = false;
      return;
    }
    const block = e.target.closest('.event');
    if (block) {
      openEditor(block.dataset.id, false);
      return;
    }
    if (e.target !== App.el.day) {
      return;
    }
    if (App.tapStart && distance(App.tapStart.x, App.tapStart.y, e.clientX, e.clientY) > TAP_MOVE_TOLERANCE) {
      return;
    }
    createEventAt(e.clientX - App.el.day.getBoundingClientRect().left, dayY(e.clientY));
  }

  function onDayKeyDown(e) {
    const block = e.target.closest('.event');
    if (!block) {
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openEditor(block.dataset.id, false);
    }
  }

  // =====================================================================
  // シート
  // =====================================================================

  function sheetElement(name) {
    if (name === 'editor') {
      return App.el.editorSheet;
    }
    return App.el.settingsSheet;
  }

  function openSheet(name) {
    if (App.openSheet !== null && App.openSheet !== name) {
      closeSheet();
    }
    App.openSheet = name;
    App.el.backdrop.hidden = false;
    const sheet = sheetElement(name);
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
  }

  function closeSheet() {
    if (App.openSheet === null) {
      return;
    }
    const sheet = sheetElement(App.openSheet);
    if (sheet.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    App.el.backdrop.hidden = true;
    App.openSheet = null;
    App.editor.id = null;
  }

  // iOS でキーボードが出たとき、シートがキーボードに隠れないように持ち上げる
  function updateKeyboardOffset() {
    const vv = window.visualViewport;
    if (!vv) {
      return;
    }
    const layoutHeight = document.documentElement.clientHeight;
    const offset = Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb-offset', offset + 'px');
  }

  // ===== 編集シート =====

  function openEditor(id, isNew) {
    const ev = findEvent(id);
    if (!ev) {
      return;
    }
    const rs = rangeStartAbs(App.viewDay);
    const s = parseDateTime(ev.start);
    const e = parseDateTime(ev.end);
    App.editor.id = id;
    // 範囲の境目をまたぐ予定は、本来の日付と時刻を表示する
    App.editor.showOriginal = s < rs || e > rs + MINUTES_PER_DAY;

    App.el.editTitle.value = ev.title;
    App.el.editMemo.value = ev.memo;
    App.el.timeHint.textContent = '入力できる範囲: ' + formatRangeTime(0) + '〜' +
      formatRangeTime(MINUTES_PER_DAY) + '(' + formatRangeTime(MINUTES_PER_DAY) + ' は終了のみ)';
    fillTimeFields(ev);
    setTimeError('', []);
    renderSwatches(ev.color);
    openSheet('editor');
    if (isNew) {
      App.el.editTitle.focus({ preventScroll: true });
    }
  }

  function setTimeFieldPair(hourInput, minInput, h, m) {
    hourInput.value = String(h);
    minInput.value = pad2(m);
  }

  function fillTimeFields(ev) {
    const el = App.el;
    const s = parseDateTime(ev.start);
    const e = parseDateTime(ev.end);
    if (App.editor.showOriginal) {
      const sc = absToClockParts(s);
      const ec = absToClockParts(e);
      el.startDate.textContent = formatMonthDay(sc.day);
      el.endDate.textContent = formatMonthDay(ec.day);
      el.startDate.hidden = false;
      el.endDate.hidden = false;
      setTimeFieldPair(el.startHour, el.startMin, sc.h, sc.m);
      setTimeFieldPair(el.endHour, el.endMin, ec.h, ec.m);
      return;
    }
    el.startDate.hidden = true;
    el.endDate.hidden = true;
    const sp = rangeToDisplayParts(absToRange(s, App.viewDay));
    const ep = rangeToDisplayParts(absToRange(e, App.viewDay));
    setTimeFieldPair(el.startHour, el.startMin, sp.h, sp.m);
    setTimeFieldPair(el.endHour, el.endMin, ep.h, ep.m);
  }

  function setTimeError(message, invalidInputs) {
    const el = App.el;
    [el.startHour, el.startMin, el.endHour, el.endMin].forEach(function (input) {
      input.classList.toggle('invalid', invalidInputs.indexOf(input) !== -1);
    });
    el.timeError.textContent = message;
    el.timeError.hidden = message === '';
  }

  function parseNumberField(input) {
    const text = input.value.trim();
    if (!DIGITS_RE.test(text)) {
      return NaN;
    }
    return Number(text);
  }

  // 時刻欄を読み取り、範囲内の分数に変換して検証する
  function readTimeFields() {
    const el = App.el;
    const sh = parseNumberField(el.startHour);
    const sm = parseNumberField(el.startMin);
    const eh = parseNumberField(el.endHour);
    const em = parseNumberField(el.endMin);
    const result = { ok: false, error: '', invalid: [], start: 0, end: 0 };

    const blanks = [];
    [[el.startHour, sh], [el.startMin, sm], [el.endHour, eh], [el.endMin, em]].forEach(function (pair) {
      if (Number.isNaN(pair[1])) {
        blanks.push(pair[0]);
      }
    });
    if (blanks.length > 0) {
      result.error = '時刻は数字で入力してください';
      result.invalid = blanks;
      return result;
    }
    if (sm >= MINUTES_PER_HOUR || em >= MINUTES_PER_HOUR) {
      result.error = '分は 0〜59 で入力してください';
      if (sm >= MINUTES_PER_HOUR) {
        result.invalid.push(el.startMin);
      }
      if (em >= MINUTES_PER_HOUR) {
        result.invalid.push(el.endMin);
      }
      return result;
    }
    const start = displayPartsToRange(sh, sm);
    const end = displayPartsToRange(eh, em);
    if (start < 0 || start >= MINUTES_PER_DAY) {
      result.error = '開始は ' + formatRangeTime(0) + '〜' + formatRangeTime(MINUTES_PER_DAY - 1) + ' で入力してください';
      result.invalid = [el.startHour, el.startMin];
      return result;
    }
    if (end <= 0 || end > MINUTES_PER_DAY) {
      result.error = '終了は ' + formatRangeTime(1) + '〜' + formatRangeTime(MINUTES_PER_DAY) + ' で入力してください';
      result.invalid = [el.endHour, el.endMin];
      return result;
    }
    if (start >= end) {
      result.error = '終了は開始より後の時刻にしてください';
      result.invalid = [el.endHour, el.endMin];
      return result;
    }
    result.ok = true;
    result.start = start;
    result.end = end;
    return result;
  }

  function onTimeInput(e) {
    const el = App.el;
    const ev = findEvent(App.editor.id);
    if (!ev) {
      return;
    }
    if (App.editor.showOriginal) {
      // 境目をまたぐ予定を編集し始めたら、触っていない側を表示中の範囲内に収めた値に置き換える
      const rs = rangeStartAbs(App.viewDay);
      const visStart = Math.max(parseDateTime(ev.start), rs) - rs;
      const visEnd = Math.min(parseDateTime(ev.end), rs + MINUTES_PER_DAY) - rs;
      App.editor.showOriginal = false;
      el.startDate.hidden = true;
      el.endDate.hidden = true;
      if (e.target === el.startHour || e.target === el.startMin) {
        const ep = rangeToDisplayParts(visEnd);
        setTimeFieldPair(el.endHour, el.endMin, ep.h, ep.m);
      } else {
        const sp = rangeToDisplayParts(visStart);
        setTimeFieldPair(el.startHour, el.startMin, sp.h, sp.m);
      }
    }
    const r = readTimeFields();
    if (!r.ok) {
      setTimeError(r.error, r.invalid);
      return;
    }
    setTimeError('', []);
    ev.start = formatDateTime(rangeToAbs(r.start, App.viewDay));
    ev.end = formatDateTime(rangeToAbs(r.end, App.viewDay));
    saveEvents();
    renderEvents();
  }

  function onTitleInput() {
    const ev = findEvent(App.editor.id);
    if (!ev) {
      return;
    }
    ev.title = App.el.editTitle.value;
    saveEvents();
    renderEvents();
  }

  function onTitleKeyDown(e) {
    // 日本語変換の確定 Enter では閉じない
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      App.el.editTitle.blur();
    }
  }

  function onMemoInput() {
    const ev = findEvent(App.editor.id);
    if (!ev) {
      return;
    }
    ev.memo = App.el.editMemo.value;
    saveEvents();
    renderEvents();
  }

  function buildSwatches() {
    const wrap = App.el.swatches;
    COLORS.forEach(function (c) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch';
      btn.dataset.color = c.id;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', c.name);
      btn.style.setProperty('--sw', c.value);
      wrap.appendChild(btn);
    });
  }

  function renderSwatches(selected) {
    App.el.swatches.querySelectorAll('.swatch').forEach(function (btn) {
      btn.setAttribute('aria-checked', String(btn.dataset.color === selected));
    });
  }

  function onSwatchClick(e) {
    const btn = e.target.closest('.swatch');
    if (!btn) {
      return;
    }
    const ev = findEvent(App.editor.id);
    if (!ev) {
      return;
    }
    ev.color = btn.dataset.color;
    renderSwatches(ev.color);
    saveEvents();
    renderEvents();
  }

  // 確認ダイアログを出してから予定を削除する。削除したら true
  function confirmAndDeleteEvent(id) {
    if (!findEvent(id)) {
      return false;
    }
    if (!window.confirm('この予定を削除しますか?')) {
      return false;
    }
    App.events = App.events.filter(function (ev) {
      return ev.id !== id;
    });
    saveEvents();
    renderEvents();
    return true;
  }

  function onDeleteClick() {
    if (confirmAndDeleteEvent(App.editor.id)) {
      closeSheet();
    }
  }

  // PC のみ: 予定ブロックを右クリックで削除する(タッチの長押しでは何もしない)
  function onTimelineContextMenu(e) {
    // 長押しやブラウザのメニューは常に出さない
    e.preventDefault();
    if (App.lastPointerType !== 'mouse') {
      return;
    }
    const block = e.target.closest('.event');
    if (!block) {
      return;
    }
    cancelPointer();
    confirmAndDeleteEvent(block.dataset.id);
  }

  // ===== 設定シート =====

  function renderSettings() {
    App.el.rangeSegment.querySelectorAll('button').forEach(function (btn) {
      btn.setAttribute('aria-checked', String(btn.dataset.range === App.settings.dayRange));
    });
  }

  function setDayRange(range) {
    if (DAY_RANGES.indexOf(range) === -1 || range === App.settings.dayRange) {
      return;
    }
    const wasToday = App.viewDay === todayDay();
    const topAbs = topVisibleAbs();
    App.settings.dayRange = range;
    saveSettings();
    if (wasToday) {
      App.viewDay = todayDay();
      App.lastToday = App.viewDay;
    }
    renderSettings();
    renderAll();
    // 切り替え前と同じ時刻が見えるようにする
    scrollToAbs(topAbs);
  }

  function onSegmentClick(e) {
    const btn = e.target.closest('button[data-range]');
    if (btn) {
      setDayRange(btn.dataset.range);
    }
  }

  // =====================================================================
  // 初期化
  // =====================================================================

  function cacheElements() {
    const byId = function (id) {
      return document.getElementById(id);
    };
    App.el = {
      timeline: byId('timeline'),
      day: byId('day'),
      hourLabels: byId('hour-labels'),
      nowLine: byId('now-line'),
      dateLabel: byId('date-label'),
      prevBtn: byId('prev-day'),
      nextBtn: byId('next-day'),
      todayBtn: byId('today-btn'),
      settingsBtn: byId('settings-btn'),
      storageWarning: byId('storage-warning'),
      backdrop: byId('sheet-backdrop'),
      editorSheet: byId('editor-sheet'),
      editorClose: byId('editor-close'),
      editTitle: byId('edit-title'),
      editMemo: byId('edit-memo'),
      startDate: byId('start-date'),
      endDate: byId('end-date'),
      startHour: byId('start-hour'),
      startMin: byId('start-min'),
      endHour: byId('end-hour'),
      endMin: byId('end-min'),
      timeHint: byId('time-hint'),
      timeError: byId('time-error'),
      swatches: byId('swatches'),
      deleteBtn: byId('editor-delete'),
      settingsSheet: byId('settings-sheet'),
      settingsClose: byId('settings-close'),
      rangeSegment: byId('range-segment')
    };
  }

  function bindEvents() {
    const el = App.el;

    el.prevBtn.addEventListener('click', function () {
      goToDay(App.viewDay - 1);
    });
    el.nextBtn.addEventListener('click', function () {
      goToDay(App.viewDay + 1);
    });
    el.todayBtn.addEventListener('click', function () {
      goToDay(todayDay());
    });
    el.settingsBtn.addEventListener('click', function () {
      renderSettings();
      openSheet('settings');
    });

    // タイムライン
    el.day.addEventListener('pointerdown', onDayPointerDown);
    el.day.addEventListener('click', onDayClick);
    el.day.addEventListener('keydown', onDayKeyDown);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    // ドラッグ中はスクロールさせない(iOS はここで止める必要がある)
    document.addEventListener('touchmove', function (e) {
      if (App.pointer && App.pointer.active) {
        e.preventDefault();
      }
    }, { passive: false });
    // 長押しでメニューを出さない。PC の右クリックは予定の削除
    el.timeline.addEventListener('contextmenu', onTimelineContextMenu);

    // シート共通
    el.backdrop.addEventListener('click', closeSheet);
    el.editorClose.addEventListener('click', closeSheet);
    el.settingsClose.addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (App.openSheet !== null) {
          closeSheet();
          return;
        }
        cancelPointer();
      }
    });

    // 編集シート
    el.editTitle.addEventListener('input', onTitleInput);
    el.editTitle.addEventListener('keydown', onTitleKeyDown);
    el.editMemo.addEventListener('input', onMemoInput);
    [el.startHour, el.startMin, el.endHour, el.endMin].forEach(function (input) {
      input.addEventListener('input', onTimeInput);
      // タップしたら中身を全選択して、数字キーボードでそのまま打ち直せるようにする
      // (iOS は focus 直後の選択が効かないことがあるので、少し遅らせてもう一度選択する)
      input.addEventListener('focus', function () {
        input.select();
        setTimeout(function () {
          if (document.activeElement === input) {
            input.setSelectionRange(0, input.value.length);
          }
        }, 0);
      });
    });
    el.swatches.addEventListener('click', onSwatchClick);
    el.deleteBtn.addEventListener('click', onDeleteClick);

    // 設定シート
    el.rangeSegment.addEventListener('click', onSegmentClick);

    // アプリに戻ってきたとき
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        onResume();
      }
    });
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) {
        onResume();
      }
    });

    // 別のタブで変更されたとき
    window.addEventListener('storage', function (e) {
      if (e.key === STORAGE_KEY_EVENTS) {
        App.events = loadEvents();
        renderEvents();
      }
    });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateKeyboardOffset);
      window.visualViewport.addEventListener('scroll', updateKeyboardOffset);
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') {
      return;
    }
    // 新しいバージョンの Service Worker に切り替わったら、一度だけ読み込み直して最新のファイルを使う
    // (初回インストール時は元々制御されていないので読み込み直さない)
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController && !App.reloading) {
        App.reloading = true;
        location.reload();
      }
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {
        // 登録に失敗してもアプリは動く
      });
    });
  }

  function init() {
    cacheElements();
    App.slotHeight = readSlotHeight();
    App.settings = loadSettings();
    App.events = loadEvents();
    App.viewDay = todayDay();
    App.lastToday = App.viewDay;
    buildSwatches();
    bindEvents();
    renderSettings();
    renderAll();
    scrollToDefault();
    scheduleNowTick();
    registerServiceWorker();
  }

  init();
})();
